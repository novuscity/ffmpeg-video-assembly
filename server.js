const express = require('express');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Increase body size limit for base64 images (each ~2-4MB)
app.use(express.json({ limit: '200mb' }));

// Health check
app.get('/health', (req, res) => {
  let ffmpegOk = false;
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    ffmpegOk = true;
  } catch (e) { /* */ }
  res.json({ status: 'ok', ffmpeg: ffmpegOk });
});

// Download a file from URL to local path
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const request = proto.get(url, { timeout: 120000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
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

// Save base64 data to a file
function saveBase64ToFile(base64Data, destPath) {
  // Strip data URI prefix if present
  let raw = base64Data;
  if (raw.startsWith('data:')) {
    raw = raw.split(',')[1] || raw;
  }
  const buffer = Buffer.from(raw, 'base64');
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

// Resolve an image source: either download URL or decode base64
async function resolveImage(imageObj, destPath) {
  if (imageObj.url && imageObj.url.startsWith('http')) {
    return downloadFile(imageObj.url, destPath);
  }
  if (imageObj.b64 || imageObj.base64 || imageObj.b64_json) {
    const data = imageObj.b64 || imageObj.base64 || imageObj.b64_json;
    return saveBase64ToFile(data, destPath);
  }
  if (imageObj.url && imageObj.url.startsWith('data:')) {
    // Data URI
    const raw = imageObj.url.split(',')[1];
    return saveBase64ToFile(raw, destPath);
  }
  throw new Error('Image has no url, b64, base64, or b64_json field');
}

// Main render endpoint
app.post('/render', async (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const workDir = path.join('/tmp', `job-${jobId}`);
  
  try {
    fs.mkdirSync(workDir, { recursive: true });
    
    const { images, tracks, crossfadeSec = 2, output = {} } = req.body;
    
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'No audio tracks provided' });
    }
    
    const resolution = output.resolution || '1920x1080';
    const [width, height] = resolution.split('x').map(Number);
    const fps = output.fps || 24;
    
    console.log(`[${jobId}] Starting render: ${images.length} images, ${tracks.length} tracks`);
    
    // Step 1: Download/decode all images
    console.log(`[${jobId}] Downloading/decoding images...`);
    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const ext = 'png';
      const imgPath = path.join(workDir, `img_${String(i).padStart(3, '0')}.${ext}`);
      await resolveImage(images[i], imgPath);
      imagePaths.push({ path: imgPath, durationSeconds: images[i].durationSeconds || 240 });
      console.log(`[${jobId}] Image ${i + 1}/${images.length} ready`);
    }
    
    // Step 2: Download all audio tracks
    console.log(`[${jobId}] Downloading audio tracks...`);
    const trackPaths = [];
    for (let i = 0; i < tracks.length; i++) {
      const audioPath = path.join(workDir, `track_${String(i).padStart(3, '0')}.mp3`);
      await downloadFile(tracks[i].url, audioPath);
      trackPaths.push({ path: audioPath, durationSeconds: tracks[i].durationSeconds || 240 });
      console.log(`[${jobId}] Track ${i + 1}/${tracks.length} ready`);
    }
    
    // Step 3: Build FFmpeg slideshow from images
    // Create a concat file for images with durations
    console.log(`[${jobId}] Building slideshow...`);
    const concatContent = imagePaths.map(img => 
      `file '${img.path}'\nduration ${img.durationSeconds}`
    ).join('\n') + `\nfile '${imagePaths[imagePaths.length - 1].path}'`; // last image repeated for concat demuxer
    
    const concatFile = path.join(workDir, 'images.txt');
    fs.writeFileSync(concatFile, concatContent);
    
    // Step 4: Concatenate audio tracks with crossfade
    console.log(`[${jobId}] Concatenating audio...`);
    let audioOutputPath;
    
    if (trackPaths.length === 1) {
      audioOutputPath = trackPaths[0].path;
    } else {
      // Build complex filter for audio crossfade
      const audioInputs = trackPaths.map((t, i) => `-i "${t.path}"`).join(' ');
      
      // Simple concat (crossfade is complex with many tracks, use concat filter)
      const audioListFile = path.join(workDir, 'audio_list.txt');
      const audioListContent = trackPaths.map(t => `file '${t.path}'`).join('\n');
      fs.writeFileSync(audioListFile, audioListContent);
      
      audioOutputPath = path.join(workDir, 'combined_audio.mp3');
      execSync(
        `ffmpeg -y -f concat -safe 0 -i "${audioListFile}" -c:a libmp3lame -q:a 2 "${audioOutputPath}"`,
        { stdio: 'pipe', timeout: 300000 }
      );
      console.log(`[${jobId}] Audio concatenated`);
    }
    
    // Step 5: Get audio duration to match video length
    const probeResult = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioOutputPath}"`,
      { stdio: 'pipe', timeout: 30000 }
    ).toString().trim();
    const audioDuration = parseFloat(probeResult) || 3600;
    console.log(`[${jobId}] Audio duration: ${audioDuration}s`);
    
    // Step 6: Assemble final video (slideshow + audio)
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
      { stdio: 'pipe', timeout: 900000 } // 15 min timeout
    );
    
    console.log(`[${jobId}] Video assembled!`);
    
    // Step 7: Get file size
    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    console.log(`[${jobId}] Output size: ${fileSizeMB}MB`);
    
    // Step 8: Return the video as a download or serve it
    // For now, serve it directly. In production, upload to cloud storage.
    const videoUrl = `https://${req.headers.host}/download/${jobId}`;
    
    // Store the path for the download endpoint
    app.locals[`job_${jobId}`] = outputPath;
    
    // Clean up after 30 minutes
    setTimeout(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        delete app.locals[`job_${jobId}`];
        console.log(`[${jobId}] Cleaned up`);
      } catch (e) { /* */ }
    }, 30 * 60 * 1000);
    
    res.json({
      status: 'complete',
      url: videoUrl,
      videoUrl: videoUrl,
      jobId,
      duration: audioDuration,
      fileSizeMB: parseFloat(fileSizeMB),
      imageCount: images.length,
      trackCount: tracks.length
    });
    
  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    // Clean up on error
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* */ }
    res.status(500).json({ error: err.message, jobId });
  }
});

// Download endpoint - serves the rendered video
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
  console.log(`FFmpeg Video Assembly service running on port ${PORT}`);
});
