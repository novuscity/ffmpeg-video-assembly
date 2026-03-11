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
const OpenAI = require('openai');

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
    if (!track.url) throw new Error(`tracks[${i}].url is required`);
    if (!track.imagePrompt) throw new Error(`tracks[${i}].imagePrompt is required`);
    if (!track.durationSeconds || Number(track.durationSeconds) <= 0) {
      throw new Error(`tracks[${i}].durationSeconds must be > 0`);
    }
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

async function generateImage({ client, prompt, size, quality, outPath }) {
  const result = await client.images.generate({
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size,
    quality,
    output_format: 'png',
  });
  const image = result?.data?.[0];
  if (!image?.b64_json) {
    throw new Error('OpenAI image response did not include b64_json');
  }
  const buffer = Buffer.from(image.b64_json, 'base64');
  await fsp.writeFile(outPath, buffer);
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

function buildImageVideoFilter(resolution) {
  const [width, height] = String(resolution || '1920x1080').split('x').map(Number);
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'format=yuv420p',
  ].join(',');
}

async function createSegmentVideo({ imagePath, audioPath, durationSeconds, resolution, fps, outPath }) {
  const vf = buildImageVideoFilter(resolution);
  await runFfmpeg([
    '-y',
    '-loop', '1',
    '-framerate', String(fps || 1),
    '-i', imagePath,
    '-stream_loop', '-1',
    '-i', audioPath,
    '-t', String(durationSeconds),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    outPath,
  ]);
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
    const { tracks, output = {}, crossfadeSec = 0, openaiApiKey } = body;
    const imageSize = output.imageSize || '1536x1024';
    const imageQuality = output.imageQuality || 'low';
    const resolution = output.resolution || '1920x1080';
    const fps = Number(output.fps || 24);

    await ensureDir(DOWNLOAD_DIR);
    const client = new OpenAI({ apiKey: openaiApiKey });

    const segmentPaths = [];
    const segmentDurations = [];
    const generatedImages = [];

    for (const [index, track] of tracks.entries()) {
      const trackName = safeName(track.trackName, `track_${index + 1}`);
      const audioPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.audio`);
      const imagePath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.png`);
      const segmentPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}_${trackName}.mp4`);

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: downloading audio`,
        trackCount: tracks.length,
      });

      console.log(`[render:${id}] downloading audio for track ${index + 1}`);
      await downloadFile(track.url, audioPath);

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: generating image`,
        trackCount: tracks.length,
      });

      console.log(`[render:${id}] generating image for track ${index + 1}`);
      await generateImage({
        client,
        prompt: track.imagePrompt,
        size: imageSize,
        quality: imageQuality,
        outPath: imagePath,
      });

      const requestedDuration = Number(track.durationSeconds || 0);
      const probedAudioDuration = await probeDurationSeconds(audioPath);
      const durationSeconds = requestedDuration > 0 ? requestedDuration : probedAudioDuration;
      if (durationSeconds <= 0) {
        throw new Error(`Could not determine duration for track ${index + 1}`);
      }

      if (probedAudioDuration > 0 && requestedDuration > 0 && probedAudioDuration < requestedDuration * 0.9) {
        console.log(`[render:${id}] track ${index + 1}: audio is ${probedAudioDuration.toFixed(0)}s but target is ${requestedDuration}s — audio will loop`);
      }

      setJob(id, {
        status: 'rendering',
        progress: `track ${index + 1}/${tracks.length}: encoding video segment`,
        trackCount: tracks.length,
      });

      console.log(`[render:${id}] building segment video for track ${index + 1}`);
      await createSegmentVideo({
        imagePath,
        audioPath,
        durationSeconds,
        resolution,
        fps,
        outPath: segmentPath,
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
  res.json({ ok: true, imageModel: OPENAI_IMAGE_MODEL, version: '4.0.0', async: true });
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

    if (!req.body.openaiApiKey) {
      return res.status(400).json({ status: 'error', error: 'openaiApiKey is required' });
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
  console.log(`FFmpeg render service v4.0 (async) listening on ${PORT}`);
});
