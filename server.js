/**
 * Railway FFmpeg Service v6.0 — Single Cinemagraph
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
  // Prefer NanoBanana 2 (Gemini) if key provided
  if (geminiApiKey) {
    try {
      return await generateImageGemini({ apiKey: geminiApiKey, prompt, outPath });
    } catch (err) {
      const msg = String(err?.message || '');
      if (openaiApiKey) {
        console.log(`[image] Gemini failed (${msg.slice(0, 100)}), falling back to OpenAI...`);
        return generateImageOpenAI({ apiKey: openaiApiKey, prompt, size, quality, outPath });
      }
      throw err;
    }
  }
  if (openaiApiKey) {
    return generateImageOpenAI({ apiKey: openaiApiKey, prompt, size, quality, outPath });
  }
  throw new Error('No image API key provided (need geminiApiKey or openaiApiKey)');
}

async function generateImageGemini({ apiKey, prompt, outPath }) {
  const url = `${GEMINI_API_URL}/${GEMINI_IMAGE_MODEL}:generateContent`;
  
  async function callGemini(promptText, attempt = 1) {
    try {
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
    } catch (err) {
      const status = err?.response?.status || 0;
      // Retry on 429 (rate limit) and 503 (overloaded) with exponential backoff
      if ((status === 429 || status === 503) && attempt <= 2) {
        const waitSec = Math.min(15 * attempt, 30);
        console.log(`[image] Gemini ${status} rate limit, waiting ${waitSec}s (attempt ${attempt}/2)...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return callGemini(promptText, attempt + 1);
      }
      throw err;
    }
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
// Runway Image-to-Video (Cinemagraph) via kie.ai
// ============================================================

async function makeImagePublic(imagePath, renderId) {
  const fileName = `img_${renderId}_${path.basename(imagePath)}`;
  const publicPath = path.join(DOWNLOAD_DIR, fileName);
  await fsp.copyFile(imagePath, publicPath);
  return buildPublicUrl(publicPath);
}

async function generateVideoClip({ kieApiKey, imageUrl, motionPrompt, duration = 10, outPath }) {
  console.log(`[runway] Submitting i2v: "${motionPrompt.slice(0, 80)}..."`);
  const submitRes = await axios({
    method: 'POST',
    url: 'https://api.kie.ai/api/v1/runway/generate',
    headers: { 'Authorization': `Bearer ${kieApiKey}`, 'Content-Type': 'application/json' },
    data: { prompt: motionPrompt, imageUrl, duration, quality: '720p', aspectRatio: '16:9', waterMark: '' },
    timeout: 30000,
  });
  const taskId = submitRes.data?.data?.taskId;
  if (!taskId) throw new Error('Runway no taskId: ' + JSON.stringify(submitRes.data).slice(0, 200));
  console.log(`[runway] taskId: ${taskId}, polling...`);

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const res = await axios({ method: 'GET',
        url: `https://api.kie.ai/api/v1/runway/record-detail?taskId=${taskId}`,
        headers: { 'Authorization': `Bearer ${kieApiKey}` }, timeout: 15000 });
      const d = res.data?.data;
      if (d?.state === 'success' && d?.videoInfo?.videoUrl) {
        console.log(`[runway] Done! Downloading clip...`);
        await downloadFile(d.videoInfo.videoUrl, outPath);
        return true;
      }
      if (d?.state === 'fail') throw new Error('Runway failed: ' + (d?.failMsg || 'unknown'));
      console.log(`[runway] ${d?.state || '?'} (${i + 1}/20)`);
    } catch (e) { if (e.message.includes('Runway failed')) throw e; console.log(`[runway] poll err: ${e.message}`); }
  }
  throw new Error('Runway timeout after 20 polls');
}

async function createSegmentFromClip({ clipPath, audioPath, durationSeconds, resolution, outPath, fadeInSec = 0, fadeOutSec = 0 }) {
  const [w, h] = String(resolution || '1920x1080').split('x').map(Number);
  const vf = [`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`];
  if (fadeInSec > 0) vf.push(`fade=t=in:d=${fadeInSec}`);
  if (fadeOutSec > 0) vf.push(`fade=t=out:st=${Math.max(0, durationSeconds - fadeOutSec)}:d=${fadeOutSec}`);
  const af = [];
  if (fadeInSec > 0) af.push(`afade=t=in:d=${fadeInSec}`);
  if (fadeOutSec > 0) af.push(`afade=t=out:st=${Math.max(0, durationSeconds - fadeOutSec)}:d=${fadeOutSec}`);
  const args = ['-y', '-stream_loop', '-1', '-i', clipPath, '-i', audioPath,
    '-t', String(durationSeconds), '-map', '0:v', '-map', '1:a',
    '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-threads', '2', '-shortest'];
  if (af.length > 0) args.push('-af', af.join(','));
  args.push(outPath);
  await runFfmpeg(args);
}

// ============================================================
// Background render worker
// ============================================================

async function processRenderJob(id, body) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `render-${id}-`));

  try {
    const { tracks, output = {}, crossfadeSec = 0, openaiApiKey, geminiApiKey, kieApiKey } = body;
    const imageSize = output.imageSize || '1536x1024';
    const imageQuality = output.imageQuality || 'low';
    const resolution = output.resolution || '1920x1080';

    await ensureDir(DOWNLOAD_DIR);

    // ========== STEP 1: Download ALL audio from all tracks, concatenate ==========
    setJob(id, { status: 'rendering', progress: 'downloading all audio', trackCount: tracks.length });

    const allAudioParts = [];
    for (const [index, track] of tracks.entries()) {
      const audioUrls = Array.isArray(track.urls) && track.urls.length > 0 ? track.urls : [track.url];
      for (const [ai, aUrl] of audioUrls.entries()) {
        const partPath = path.join(tempDir, `audio_t${index + 1}_v${ai + 1}.mp3`);
        console.log(`[render:${id}] downloading track ${index + 1} variation ${ai + 1}`);
        await downloadFile(aUrl, partPath);
        allAudioParts.push(partPath);
      }
    }

    const masterAudioPath = path.join(tempDir, 'master_audio.mp3');
    console.log(`[render:${id}] concatenating ${allAudioParts.length} audio files...`);
    await concatAudioFiles(allAudioParts, masterAudioPath);

    const totalDuration = await probeDurationSeconds(masterAudioPath);
    if (totalDuration <= 0) throw new Error('Could not determine total audio duration');
    console.log(`[render:${id}] total audio: ${totalDuration.toFixed(0)}s (${(totalDuration / 60).toFixed(1)}min)`);

    // ========== STEP 2: Generate ONE image ==========
    setJob(id, { status: 'rendering', progress: 'generating image', trackCount: tracks.length });

    const imagePrompt = tracks[0]?.imagePrompt || 'warm cozy artisan workspace, golden light, editorial illustration';
    const imagePath = path.join(tempDir, 'scene.png');
    console.log(`[render:${id}] generating image...`);
    await generateImage({ geminiApiKey, openaiApiKey, prompt: imagePrompt, size: imageSize, quality: imageQuality, outPath: imagePath });

    // ========== STEP 3: Generate cinemagraph OR Ken Burns ==========
    const finalVideoPath = path.join(DOWNLOAD_DIR, `${id}.mp4`);
    const motionPrompt = tracks[0]?.motionPrompt || '';
    let usedCinemagraph = false;

    if (kieApiKey && motionPrompt) {
      setJob(id, { status: 'rendering', progress: 'generating living photo (Runway)', trackCount: tracks.length });
      try {
        const clipPath = path.join(tempDir, 'clip.mp4');
        console.log(`[render:${id}] making image public for Runway...`);
        const publicImageUrl = await makeImagePublic(imagePath, id);
        console.log(`[render:${id}] image URL: ${publicImageUrl}`);

        await generateVideoClip({ kieApiKey, imageUrl: publicImageUrl, motionPrompt, duration: 10, outPath: clipPath });

        setJob(id, { status: 'rendering', progress: 'looping cinemagraph + muxing audio', trackCount: tracks.length });
        console.log(`[render:${id}] looping clip for ${totalDuration.toFixed(0)}s...`);
        await createSegmentFromClip({
          clipPath, audioPath: masterAudioPath, durationSeconds: totalDuration,
          resolution, outPath: finalVideoPath, fadeInSec: 0, fadeOutSec: 5,
        });
        usedCinemagraph = true;
        console.log(`[render:${id}] cinemagraph complete!`);
      } catch (runwayErr) {
        console.log(`[render:${id}] Runway failed (${runwayErr.message}), falling back to Ken Burns`);
      }
    }

    if (!usedCinemagraph) {
      setJob(id, { status: 'rendering', progress: 'encoding Ken Burns video', trackCount: tracks.length });
      console.log(`[render:${id}] Ken Burns fallback for ${totalDuration.toFixed(0)}s`);
      await createSegmentVideo({
        imagePath, audioPath: masterAudioPath, durationSeconds: totalDuration,
        resolution, fps: 24, outPath: finalVideoPath, fadeInSec: 0, fadeOutSec: 5,
      });
    }

    const publicUrl = buildPublicUrl(finalVideoPath);
    console.log(`[render:${id}] complete: ${publicUrl}`);
    setJob(id, { status: 'complete', url: publicUrl, trackCount: tracks.length });

  } catch (error) {
    console.error(`[render:${id}] FAILED:`, error?.message || error);
    setJob(id, { status: 'error', error: String(error?.message || 'Unknown render error').slice(0, 500) });
  } finally {
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, imageModel: GEMINI_IMAGE_MODEL, fallbackModel: OPENAI_IMAGE_MODEL, version: '6.0.0', async: true, cinemagraph: true });
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
    if (req.body.kieApiKey && req.body.tracks?.[0]?.motionPrompt) {
      console.log('[render] Cinemagraph mode: single living photo for full duration');
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
  console.log(`FFmpeg render service v6.0 (Cinemagraph + Ken Burns fallback) listening on ${PORT}`);
});
