/**
 * Railway FFmpeg Service v4.0 — Async Render
 *
 * Architecture:
 *   POST /render      → validates, returns {status: "queued", renderId} immediately
 *   GET  /status/:id  → returns job status: queued | rendering | complete | error
 *   GET  /download/:f → serves the final MP4
 *   GET  /health      → service health check
 *
 * Why async:
 *   Railway has a 15-minute HTTP request limit. A 3-track 60-minute video
 *   with server-side image generation exceeds that. The old synchronous
 *   /render endpoint caused SSL connection drops every time.
 *
 * n8n integration:
 *   Node 12 POSTs to /render, gets back renderId immediately.
 *   New polling loop checks GET /status/:id until complete or error.
 *   Same pattern as the Suno polling loop.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { execFile, spawn } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_STATIC_URL || '';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';

// ============================================================
// In-memory job store
// ============================================================
const jobs = new Map();

function getJob(id) { return jobs.get(id) || null; }

function setJob(id, data) {
  jobs.set(id, { ...data, updatedAt: Date.now() });
  if (jobs.size > 50) {
    const keys = [...jobs.keys()];
    for (let i = 0; i < keys.length - 50; i++) {
      jobs.delete(keys[i]);
    }
  }
}

// ============================================================
// Utility functions
// ============================================================

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function makeRenderId() {
  return crypto.randomBytes(10).toString('hex');
}

function safeName(name, fallback = 'track') {
  return String(name || fallback)
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || fallback;
}

function validatePayload(body) {
  if (!body || !Array.isArray(body.tracks) || body.tracks.length === 0) {
    throw new Error('Request must include a non-empty tracks[] array');
  }
  for (const [i, track] of body.tracks.entries()) {
    // Accept either urls[] array or single url
    const hasUrls = Array.isArray(track.urls) && track.urls.length > 0;
    const hasUrl = track.url && typeof track.url === 'string';
    if (!hasUrls && !hasUrl) throw new Error(`tracks[${i}] needs url or urls[]`);
    if (!track.imagePrompt) throw new Error(`tracks[${i}].imagePrompt is required`);
    // durationSeconds is now optional — 0 means "use actual audio length"
  }
}

async function downloadFile(url, outPath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
  });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function concatAudioFiles(audioPaths, outPath) {
  if (audioPaths.length === 1) {
    // Just copy the single file
    await fsp.copyFile(audioPaths[0], outPath);
    return;
  }
  // Build ffmpeg concat list
  const listPath = outPath + '.list.txt';
  const text = audioPaths.map(p => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n');
  await fsp.writeFile(listPath, text);
  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ]);
  try { await fsp.unlink(listPath); } catch(_) {}
}

const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

async function generateImage({ geminiApiKey, openaiApiKey, prompt, size, quality, outPath }) {
  // Prefer NanoBanana 2 (Gemini) if key provided, fallback to OpenAI
  if (geminiApiKey) {
    return generateImageGemini({ apiKey: geminiApiKey, prompt, outPath });
  }
  if (openaiApiKey) {
    return generateImageOpenAI({ apiKey: openaiApiKey, prompt, size, quality, outPath });
  }
  throw new Error('No image API key provided (need geminiApiKey or openaiApiKey)');
}

async function generateImageGemini({ apiKey, prompt, outPath }) {
  const url = `${GEMINI_API_URL}/${GEMINI_IMAGE_MODEL}:generateContent`;
  
  async function callGemini(promptText) {
    const response = await axios({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      data: {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig: { aspectRatio: '16:9' },
        },
      },
      timeout: 60000,
    });
    
    // Find image part in response
    const candidates = response.data?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part?.inlineData?.data) {
          return Buffer.from(part.inlineData.data, 'base64');
        }
      }
    }
    return null;
  }

  // Try full prompt
  try {
    const buffer = await callGemini(prompt);
    if (buffer) {
      await fsp.writeFile(outPath, buffer);
      console.log(`[image] NanoBanana 2 generated: ${outPath}`);
      return;
    }
    throw new Error('No image data in Gemini response');
  } catch (err) {
    const msg = String(err?.message || err?.response?.data?.error?.message || '');
    if (!msg.includes('safety') && !msg.includes('SAFETY') && !msg.includes('blocked') && !msg.includes('BLOCKED')) {
      throw err;
    }
    console.log(`[image] Gemini safety block, retrying simplified...`);
  }

  // Retry with simplified prompt
  const simplified = prompt.split('.')[0].trim() + '. Warm cozy illustration, golden ambient lighting.';
  console.log(`[image] Simplified: ${simplified.slice(0, 80)}...`);
  const buffer = await callGemini(simplified);
  if (!buffer) throw new Error('Gemini failed even with simplified prompt');
  await fsp.writeFile(outPath, buffer);
}

async function generateImageOpenAI({ apiKey, prompt, size, quality, outPath }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  
  try {
    const result = await client.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
      quality,
      output_format: 'png',
    });
    const image = result?.data?.[0];
    if (!image?.b64_json) throw new Error('OpenAI: no b64_json');
    await fsp.writeFile(outPath, Buffer.from(image.b64_json, 'base64'));
    return;
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('safety') && !msg.includes('rejected')) throw err;
    console.log(`[image] OpenAI safety rejection, retrying simplified...`);
  }

  const simplified = prompt.split('.')[0].trim() + '. Warm editorial illustration, cozy lighting.';
  const result = await client.images.generate({
    model: OPENAI_IMAGE_MODEL,
    prompt: simplified,
    size,
    quality,
    output_format: 'png',
  });
  const image = result?.data?.[0];
  if (!image?.b64_json) throw new Error('OpenAI failed even with simplified prompt');
  await fsp.writeFile(outPath, Buffer.from(image.b64_json, 'base64'));
}

async function probeDurationSeconds(filePath) {
  const { stdout } = await execFileAsync(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const n = Number(String(stdout).trim());
  return Number.isFinite(n) ? n : 0;
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

function buildImageVideoFilter(resolution, durationSeconds) {
  const [width, height] = String(resolution || '1920x1080').split('x').map(Number);
  const totalFrames = Math.ceil((durationSeconds || 120) * 24);
  
  // Ken Burns: slow zoom from 1.0x to 1.15x over the full duration
  // zoompan creates motion from a still image — much more engaging than static
  // We generate at higher resolution (scale up first) then zoompan crops/zooms within it
  return [
    `scale=${width * 2}:${height * 2}`,
    `zoompan=z='min(zoom+0.00015,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=24`,
    'format=yuv420p',
  ].join(',');
}

async function createSegmentVideo({ imagePath, audioPath, durationSeconds, resolution, fps, outPath, fadeInSec = 0, fadeOutSec = 0 }) {
  const vf = buildImageVideoFilter(resolution, durationSeconds);
  
  // Build audio filter for fades
  const audioFilters = [];
  if (fadeInSec > 0) {
    audioFilters.push(`afade=t=in:d=${fadeInSec}`);
  }
  if (fadeOutSec > 0) {
    const fadeStart = Math.max(0, durationSeconds - fadeOutSec);
    audioFilters.push(`afade=t=out:st=${fadeStart}:d=${fadeOutSec}`);
  }

  // Build video filter — Ken Burns zoompan + fades
  const videoFilters = [vf];
  if (fadeInSec > 0) {
    videoFilters.push(`fade=t=in:d=${fadeInSec}`);
  }
  if (fadeOutSec > 0) {
    const fadeStart = Math.max(0, durationSeconds - fadeOutSec);
    videoFilters.push(`fade=t=out:st=${fadeStart}:d=${fadeOutSec}`);
  }

  const args = [
    '-y',
    '-i', imagePath,
    '-i', audioPath,
    '-t', String(durationSeconds),
    '-vf', videoFilters.join(','),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-threads', '2',
  ];

  if (audioFilters.length > 0) {
    args.push('-af', audioFilters.join(','));
  }

  args.push(outPath);
  await runFfmpeg(args);
}

async function concatSegmentsHardCut(segmentPaths, outPath) {
  const listPath = path.join(path.dirname(outPath), 'segments.txt');
  const text = segmentPaths.map(p => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n');
  await fsp.writeFile(listPath, text);
  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ]);
}

function buildCrossfadeFilter(segmentDurations, crossfadeSec) {
  if (segmentDurations.length < 2) return { filter: '', vLabel: '0:v', aLabel: '0:a' };
  const parts = [];
  let currentV = '0:v';
  let currentA = '0:a';
  let priorCombined = segmentDurations[0];
  for (let i = 1; i < segmentDurations.length; i += 1) {
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    const offset = Math.max(0, priorCombined - crossfadeSec);
    parts.push(`[${currentV}][${i}:v]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset}[${vOut}]`);
    parts.push(`[${currentA}][${i}:a]acrossfade=d=${crossfadeSec}[${aOut}]`);
    currentV = vOut;
    currentA = aOut;
    priorCombined = priorCombined + segmentDurations[i] - crossfadeSec;
  }
  return { filter: parts.join(';'), vLabel: currentV, aLabel: currentA };
}

async function concatSegmentsCrossfade(segmentPaths, segmentDurations, crossfadeSec, outPath) {
  const inputs = [];
  for (const p of segmentPaths) inputs.push('-i', p);
  const { filter, vLabel, aLabel } = buildCrossfadeFilter(segmentDurations, crossfadeSec);
  await runFfmpeg([
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', `[${vLabel}]`,
    '-map', `[${aLabel}]`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    outPath,
  ]);
}

function buildPublicUrl(filePath) {
  const fileName = path.basename(filePath);
  if (BASE_URL) {
    const base = BASE_URL.replace(/\/$/, '');
    const url = `${base}/download/${fileName}`;
    return url.startsWith('http') ? url : `https://${url}`;
  }
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (domain) return `https://${domain}/download/${fileName}`;
  return `/download/${fileName}`;
}

// ============================================================
// Background render worker
// ============================================================

async function processRenderJob(id, body) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `render-${id}-`));

  try {
    const { tracks, output = {}, crossfadeSec = 0, openaiApiKey, geminiApiKey } = body;
    const imageSize = output.imageSize || '1536x1024';
    const imageQuality = output.imageQuality || 'low';
    const resolution = output.resolution || '1920x1080';
    const fps = Number(output.fps || 24);

    await ensureDir(DOWNLOAD_DIR);

    const segmentPaths = [];
    const segmentDurations = [];
    const generatedImages = [];

    for (const [index, track] of tracks.entries()) {
      const trackName = safeName(track.trackName, `track_${index + 1}`);
      const audioPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.mp3`);
      const imagePath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.png`);
      const segmentPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.mp4`);

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: downloading audio`,
        trackCount: tracks.length,
      });

      // Download all audio variations for this track
      const audioUrls = Array.isArray(track.urls) && track.urls.length > 0
        ? track.urls
        : [track.url];
      
      const downloadedAudioPaths = [];
      for (const [ai, aUrl] of audioUrls.entries()) {
        const partPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}_part${ai + 1}.mp3`);
        console.log(`[render:${id}] downloading audio ${ai + 1}/${audioUrls.length} for track ${index + 1}`);
        await downloadFile(aUrl, partPath);
        downloadedAudioPaths.push(partPath);
      }

      // Concatenate all audio parts into one file
      if (downloadedAudioPaths.length > 1) {
        console.log(`[render:${id}] concatenating ${downloadedAudioPaths.length} audio parts for track ${index + 1}`);
        await concatAudioFiles(downloadedAudioPaths, audioPath);
      } else {
        await fsp.copyFile(downloadedAudioPaths[0], audioPath);
      }

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: generating image`,
        trackCount: tracks.length,
      });

      console.log(`[render:${id}] generating image for track ${index + 1}`);
      await generateImage({
        geminiApiKey,
        openaiApiKey,
        prompt: track.imagePrompt,
        size: imageSize,
        quality: imageQuality,
        outPath: imagePath,
      });

      const requestedDuration = Number(track.durationSeconds || 0);
      const probedAudioDuration = await probeDurationSeconds(audioPath);
      // Use actual audio duration (sum of all variations) — no more looping
      const durationSeconds = probedAudioDuration > 0 ? probedAudioDuration : requestedDuration;
      if (durationSeconds <= 0) {
        throw new Error(`Could not determine duration for track ${index + 1}`);
      }

      console.log(`[render:${id}] track ${index + 1}: ${audioUrls.length} variations, total audio ${probedAudioDuration.toFixed(0)}s`);

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: encoding video segment`,
        trackCount: tracks.length,
      });

      console.log(`[render:${id}] building segment video for track ${index + 1}`);
      
      // Fade logic: 3s fade-in on first track, 3s fade-out on last track
      // Middle tracks get both fade-in and fade-out for smooth transitions
      const isFirst = index === 0;
      const isLast = index === tracks.length - 1;
      const FADE_SEC = 3;
      
      await createSegmentVideo({
        imagePath,
        audioPath,
        durationSeconds,
        resolution,
        fps,
        outPath: segmentPath,
        fadeInSec: isFirst ? 0 : FADE_SEC,
        fadeOutSec: isLast ? FADE_SEC + 2 : FADE_SEC,
      });

      segmentPaths.push(segmentPath);
      segmentDurations.push(durationSeconds);
      generatedImages.push({
        trackNumber: track.trackNumber || index + 1,
        trackName: track.trackName || '',
        prompt: track.imagePrompt,
        durationSeconds,
      });
    }

    setJob(id, {
      status: 'rendering',
      progress: 'concatenating segments',
      trackCount: tracks.length,
    });

    const finalName = `${id}.mp4`;
    const finalPath = path.join(DOWNLOAD_DIR, finalName);

    if (segmentPaths.length === 1 || Number(crossfadeSec) <= 0) {
      console.log(`[render:${id}] concatenating with hard cuts`);
      await concatSegmentsHardCut(segmentPaths, finalPath);
    } else {
      console.log(`[render:${id}] concatenating with crossfades (${crossfadeSec}s)`);
      await concatSegmentsCrossfade(segmentPaths, segmentDurations, Number(crossfadeSec), finalPath);
    }

    const publicUrl = buildPublicUrl(finalPath);
    console.log(`[render:${id}] complete: ${publicUrl}`);

    setJob(id, {
      status: 'complete',
      url: publicUrl,
      trackCount: tracks.length,
      generatedImages,
    });

  } catch (error) {
    console.error(`[render:${id}] FAILED:`, error?.message || error);
    setJob(id, {
      status: 'error',
      error: String(error?.message || 'Unknown render error').slice(0, 500),
    });
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

// ============================================================
// API Endpoints
// ============================================================

app.get('/health', (_req, res) => {
  res.json({ ok: true, imageModel: GEMINI_IMAGE_MODEL, fallbackModel: OPENAI_IMAGE_MODEL, version: '5.0.0', async: true, kenBurns: true });
});

app.get('/download/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  return res.download(filePath);
});

app.post('/render', (req, res) => {
  const id = makeRenderId();

  try {
    validatePayload(req.body);

    if (!req.body.openaiApiKey && !req.body.geminiApiKey) {
      return res.status(400).json({ status: 'error', error: 'geminiApiKey or openaiApiKey is required' });
    }

    setJob(id, {
      status: 'queued',
      progress: 'accepted, starting render',
      trackCount: req.body.tracks.length,
    });

    // Fire and forget — render runs in background
    processRenderJob(id, req.body).catch((err) => {
      console.error(`[render:${id}] Unhandled:`, err);
      setJob(id, { status: 'error', error: 'Unhandled render failure' });
    });

    return res.json({
      status: 'queued',
      renderId: id,
      trackCount: req.body.tracks.length,
    });

  } catch (error) {
    return res.status(400).json({
      status: 'error',
      renderId: id,
      error: error?.message || 'Validation failed',
    });
  }
});

app.get('/status/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ status: 'not_found', renderId: req.params.id });
  }
  return res.json({
    renderId: req.params.id,
    status: job.status,
    progress: job.progress || null,
    url: job.url || null,
    error: job.error || null,
    trackCount: job.trackCount || null,
    generatedImages: job.generatedImages || null,
  });
});

app.listen(PORT, async () => {
  await ensureDir(DOWNLOAD_DIR);
  console.log(`FFmpeg render service v5.0 (NanoBanana 2 + Ken Burns) listening on ${PORT}`);
});
