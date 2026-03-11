/**
 * Railway FFmpeg Service Patch Draft — candidate server.js
 *
 * Purpose:
 * - Accept render requests where each track carries its own imagePrompt.
 * - Generate one image per track.
 * - Pair each image with its corresponding audio segment.
 * - Concatenate or crossfade the segments into one MP4.
 * - Return a stable response contract that n8n can consume.
 *
 * IMPORTANT:
 * - This is a production-oriented draft for Opus 4.6 to audit before merge.
 * - It assumes an Express app, ffmpeg/ffprobe availability, and writable temp storage.
 * - It preserves gpt-image-1 as the default model to match the current project docs,
 *   but allows OPENAI_IMAGE_MODEL to be overridden later.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { execFile } = require('child_process');
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

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function renderId() {
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
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = '';
    // Only keep last 4KB of stderr (progress lines are noise, errors are at the end)
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
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    outPath,
  ]);
}

async function buildPublicUrl(filePath) {
  const fileName = path.basename(filePath);
  if (BASE_URL) {
    const base = BASE_URL.replace(/\/$/, '');
    const url = `${base}/download/${fileName}`;
    // Ensure protocol is present
    return url.startsWith('http') ? url : `https://${url}`;
  }
  // Fallback: construct from RAILWAY_PUBLIC_DOMAIN if available
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (domain) return `https://${domain}/download/${fileName}`;
  return `/download/${fileName}`;
}

app.get('/health', async (_req, res) => {
  res.json({ ok: true, imageModel: OPENAI_IMAGE_MODEL });
});

app.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  return res.download(filePath);
});

app.post('/render', async (req, res) => {
  const startedAt = Date.now();
  const id = renderId();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `render-${id}-`));

  try {
    validatePayload(req.body);

    const { tracks, output = {}, crossfadeSec = 0, openaiApiKey } = req.body;
    const imageSize = output.imageSize || '1536x1024';
    const imageQuality = output.imageQuality || 'low';
    const resolution = output.resolution || '1920x1080';
    const fps = Number(output.fps || 24);

    if (!openaiApiKey) {
      throw new Error('openaiApiKey is required');
    }

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

      console.log(`[render:${id}] downloading audio for track ${index + 1}`);
      await downloadFile(track.url, audioPath);

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
        console.log(`[render:${id}] track ${index + 1}: audio is ${probedAudioDuration.toFixed(0)}s but segment target is ${requestedDuration}s — audio will loop`);
      }

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
        localImageFile: path.basename(imagePath),
        durationSeconds,
      });
    }

    const finalName = `${id}.mp4`;
    const finalPath = path.join(DOWNLOAD_DIR, finalName);

    if (segmentPaths.length === 1 || Number(crossfadeSec) <= 0) {
      console.log(`[render:${id}] concatenating with hard cuts`);
      await concatSegmentsHardCut(segmentPaths, finalPath);
    } else {
      console.log(`[render:${id}] concatenating with crossfades (${crossfadeSec}s)`);
      await concatSegmentsCrossfade(segmentPaths, segmentDurations, Number(crossfadeSec), finalPath);
    }

    const publicUrl = await buildPublicUrl(finalPath);
    const durationMs = Date.now() - startedAt;

    return res.json({
      status: 'complete',
      renderId: id,
      url: publicUrl,
      trackCount: tracks.length,
      generatedImages,
      elapsedMs: durationMs,
    });
  } catch (error) {
    console.error(`[render:${id}]`, error);
    return res.status(500).json({
      status: 'error',
      renderId: id,
      error: error?.message || 'Unknown render error',
    });
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch (_) {
      // ignore temp cleanup failures
    }
  }
});

app.listen(PORT, async () => {
  await ensureDir(DOWNLOAD_DIR);
  console.log(`FFmpeg render service listening on ${PORT}`);
});
