const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  let ffmpegOk = false;
  try { execSync('ffmpeg -version', { stdio: 'pipe' }); ffmpegOk = true; } catch (e) {}
  res.json({ status: 'ok', ffmpeg: ffmpegOk, version: '3.0.0' });
});

// ============================================================
// HELPERS
// ============================================================
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const request = proto.get(url, { timeout: 120000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} downloading ${url.slice(0, 80)}`));
      }
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Download timeout')); });
  });
}

function saveBase64ToFile(b64, destPath) {
  let raw = b64;
  if (raw.startsWith('data:')) raw = raw.split(',')[1] || raw;
  fs.writeFileSync(destPath, Buffer.from(raw, 'base64'));
  return destPath;
}

async function generateImage(prompt, destPath, apiKey, size = '1536x1024', quality = 'low') {
  const body = JSON.stringify({
    model: 'gpt-image-1',
    prompt,
    n: 1,
    size,
    quality,
    output_format: 'png'
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const b64 = parsed.data?.[0]?.b64_json;
          if (!b64) return reject(new Error('No b64_json in OpenAI response'));
          saveBase64ToFile(b64, destPath);
          resolve(destPath);
        } catch (e) { reject(new Error('Failed to parse OpenAI response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// MAIN RENDER ENDPOINT (v3 — generates images server-side)
// ============================================================
app.post('/render', async (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const workDir = path.join('/tmp', `job-${jobId}`);

  try {
    fs.mkdirSync(workDir, { recursive: true });

    const { tracks, imagePrompts, openaiApiKey, crossfadeSec = 2, output = {} } = req.body;

    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'No tracks provided' });
    }

    const resolution = output.resolution || '1920x1080';
    const [width, height] = resolution.split('x').map(Number);
    const fps = output.fps || 24;
    const imageSize = output.imageSize || '1536x1024';
    const imageQuality = output.imageQuality || 'low';

    console.log(`[${jobId}] Starting render: ${tracks.length} tracks`);

    // ── Step 1: Download audio tracks ──
    console.log(`[${jobId}] Downloading ${tracks.length} audio tracks...`);
    const trackPaths = [];
    for (let i = 0; i < tracks.length; i++) {
      const audioPath = path.join(workDir, `track_${String(i).padStart(3, '0')}.mp3`);
      await downloadFile(tracks[i].url, audioPath);
      trackPaths.push({ path: audioPath, durationSeconds: tracks[i].durationSeconds || 240 });
      console.log(`[${jobId}]   Track ${i + 1}/${tracks.length} downloaded`);
    }

    // ── Step 2: Generate or download images ──
    const imagePaths = [];
    const prompts = imagePrompts || [];

    for (let i = 0; i < tracks.length; i++) {
      const imgPath = path.join(workDir, `img_${String(i).padStart(3, '0')}.png`);

      if (tracks[i].imageUrl && tracks[i].imageUrl.startsWith('http')) {
        // Pre-generated image URL
        console.log(`[${jobId}]   Image ${i + 1}: downloading from URL...`);
        await downloadFile(tracks[i].imageUrl, imgPath);
      } else if (tracks[i].imageB64) {
        // Pre-generated base64
        console.log(`[${jobId}]   Image ${i + 1}: decoding base64...`);
        saveBase64ToFile(tracks[i].imageB64, imgPath);
      } else if (prompts[i] && openaiApiKey) {
        // Generate on the server
        console.log(`[${jobId}]   Image ${i + 1}: generating via OpenAI...`);
        await generateImage(prompts[i], imgPath, openaiApiKey, imageSize, imageQuality);
        console.log(`[${jobId}]   Image ${i + 1}: generated!`);
      } else {
        // Fallback: solid color placeholder
        console.log(`[${jobId}]   Image ${i + 1}: generating placeholder...`);
        const colors = ['#2d1b0e', '#1a2e1a', '#0e1b2d', '#2d0e1b', '#1b2d0e'];
        const color = colors[i % colors.length];
        execSync(`ffmpeg -y -f lavfi -i "color=c=${color}:s=${width}x${height}:d=1" -frames:v 1 "${imgPath}"`,
          { stdio: 'pipe', timeout: 10000 });
      }
      imagePaths.push({ path: imgPath, durationSeconds: trackPaths[i]?.durationSeconds || 240 });
    }

    // ── Step 3: Concatenate audio ──
    console.log(`[${jobId}] Concatenating audio...`);
    let audioOutputPath;
    if (trackPaths.length === 1) {
      audioOutputPath = trackPaths[0].path;
    } else {
      const audioListFile = path.join(workDir, 'audio_list.txt');
      fs.writeFileSync(audioListFile, trackPaths.map(t => `file '${t.path}'`).join('\n'));
      audioOutputPath = path.join(workDir, 'combined_audio.mp3');
      execSync(`ffmpeg -y -f concat -safe 0 -i "${audioListFile}" -c:a libmp3lame -q:a 2 "${audioOutputPath}"`,
        { stdio: 'pipe', timeout: 300000 });
    }

    // ── Step 4: Get audio duration ──
    const probeResult = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioOutputPath}"`,
      { stdio: 'pipe', timeout: 30000 }
    ).toString().trim();
    const audioDuration = parseFloat(probeResult) || 3600;
    console.log(`[${jobId}] Total audio duration: ${audioDuration}s`);

    // ── Step 5: Build slideshow ──
    console.log(`[${jobId}] Building slideshow...`);
    const concatContent = imagePaths.map(img =>
      `file '${img.path}'\nduration ${img.durationSeconds}`
    ).join('\n') + `\nfile '${imagePaths[imagePaths.length - 1].path}'`;
    const concatFile = path.join(workDir, 'images.txt');
    fs.writeFileSync(concatFile, concatContent);

    // ── Step 6: Assemble final video ──
    console.log(`[${jobId}] Assembling final video...`);
    const outputPath = path.join(workDir, `output_${jobId}.mp4`);
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${concatFile}" ` +
      `-i "${audioOutputPath}" ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps}" ` +
      `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 192k ` +
      `-t ${audioDuration} ` +
      `-shortest ` +
      `-movflags +faststart ` +
      `"${outputPath}"`,
      { stdio: 'pipe', timeout: 900000 }
    );

    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    console.log(`[${jobId}] Done! ${fileSizeMB}MB`);

    // Serve video via download endpoint
    const videoUrl = `https://${req.headers.host}/download/${jobId}`;
    app.locals[`job_${jobId}`] = outputPath;

    // Clean up after 30 min
    setTimeout(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); delete app.locals[`job_${jobId}`]; } catch (e) {}
    }, 30 * 60 * 1000);

    res.json({
      status: 'complete',
      url: videoUrl,
      videoUrl: videoUrl,
      jobId,
      duration: audioDuration,
      fileSizeMB: parseFloat(fileSizeMB),
      trackCount: tracks.length,
      imageCount: imagePaths.length
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message, jobId });
  }
});

// ============================================================
// DOWNLOAD ENDPOINT
// ============================================================
app.get('/download/:jobId', (req, res) => {
  const outputPath = app.locals[`job_${req.params.jobId}`];
  if (!outputPath || !fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'Video not found or expired' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="ambient_${req.params.jobId}.mp4"`);
  fs.createReadStream(outputPath).pipe(res);
});

app.listen(PORT, () => {
  console.log(`FFmpeg Video Assembly v3.0 running on port ${PORT}`);
});
