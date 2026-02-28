// FFmpeg Video Assembly Microservice for Ambient AI Video Factory v9.0
// Accepts image URLs + audio track URLs → assembles slideshow MP4 → returns download URL
// Deploy to Railway, Render.com, or any Docker host

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3000;
const WORK_DIR = path.join(os.tmpdir(), 'ffmpeg-work');

// Ensure work directory exists
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Download a file from URL to local path
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Main render function
async function renderVideo(req) {
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { images, tracks, crossfadeSec = 2, output = {} } = req;
    const resolution = output.resolution || '1920x1080';
    const fps = output.fps || 24;

    if (!images || images.length === 0) throw new Error('No images provided');
    if (!tracks || tracks.length === 0) throw new Error('No tracks provided');

    log(`Job ${jobId}: ${images.length} images, ${tracks.length} tracks`);

    // Step 1: Download all images
    log(`Job ${jobId}: Downloading ${images.length} images...`);
    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const ext = images[i].url.match(/\.(png|jpg|jpeg|webp)/i)?.[1] || 'jpg';
      const dest = path.join(jobDir, `img_${String(i).padStart(3, '0')}.${ext}`);
      await downloadFile(images[i].url, dest);
      imagePaths.push({ path: dest, duration: images[i].durationSeconds || 240 });
      log(`  Image ${i + 1}/${images.length} downloaded`);
    }

    // Step 2: Download all audio tracks
    log(`Job ${jobId}: Downloading ${tracks.length} audio tracks...`);
    const trackPaths = [];
    for (let i = 0; i < tracks.length; i++) {
      const ext = tracks[i].url.match(/\.(mp3|wav|m4a|ogg)/i)?.[1] || 'mp3';
      const dest = path.join(jobDir, `track_${String(i).padStart(3, '0')}.${ext}`);
      await downloadFile(tracks[i].url, dest);
      trackPaths.push({ path: dest, duration: tracks[i].durationSeconds || 240 });
      log(`  Track ${i + 1}/${tracks.length} downloaded`);
    }

    // Step 3: Concatenate audio tracks with crossfade
    log(`Job ${jobId}: Concatenating audio with ${crossfadeSec}s crossfades...`);
    const concatAudioPath = path.join(jobDir, 'concat_audio.mp3');

    if (trackPaths.length === 1) {
      // Single track — just copy
      fs.copyFileSync(trackPaths[0].path, concatAudioPath);
    } else {
      // Build FFmpeg complex filter for crossfade concatenation
      let inputs = trackPaths.map(t => `-i "${t.path}"`).join(' ');
      let filterParts = [];
      let currentLabel = '[0:a]';

      for (let i = 1; i < trackPaths.length; i++) {
        const outLabel = i < trackPaths.length - 1 ? `[a${i}]` : '[aout]';
        filterParts.push(
          `${currentLabel}[${i}:a]acrossfade=d=${crossfadeSec}:c1=tri:c2=tri${outLabel}`
        );
        currentLabel = outLabel;
      }

      // If only 2 tracks, the output is already [aout]
      // For 1 track we already handled it above
      const filterStr = filterParts.join(';');
      const ffCmd = `ffmpeg -y ${inputs} -filter_complex "${filterStr}" -map "[aout]" -c:a libmp3lame -b:a 192k "${concatAudioPath}"`;

      log(`  Running: ${ffCmd.slice(0, 200)}...`);
      execSync(ffCmd, { timeout: 300000, stdio: 'pipe' });
    }
    log(`Job ${jobId}: Audio concatenation complete`);

    // Step 4: Build slideshow video from images
    // Each image shows for its duration, with crossfade transitions
    log(`Job ${jobId}: Building slideshow video...`);
    const outputPath = path.join(jobDir, 'output.mp4');
    const [w, h] = resolution.split('x').map(Number);

    if (imagePaths.length === 1) {
      // Single image — static video
      const ffCmd = `ffmpeg -y -loop 1 -i "${imagePaths[0].path}" -i "${concatAudioPath}" ` +
        `-c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest ` +
        `-vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2" ` +
        `-pix_fmt yuv420p -r ${fps} "${outputPath}"`;
      execSync(ffCmd, { timeout: 900000, stdio: 'pipe' });
    } else {
      // Multi-image slideshow with crossfades
      let inputs = imagePaths.map(img => `-loop 1 -t ${img.duration} -i "${img.path}"`).join(' ');

      // Build crossfade filter chain
      let vFilterParts = [];
      // First, scale all images
      for (let i = 0; i < imagePaths.length; i++) {
        vFilterParts.push(
          `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`
        );
      }

      // Then chain xfade transitions
      let currentLabel = '[v0]';
      let offset = imagePaths[0].duration - crossfadeSec;

      for (let i = 1; i < imagePaths.length; i++) {
        const outLabel = i < imagePaths.length - 1 ? `[vx${i}]` : '[vout]';
        vFilterParts.push(
          `${currentLabel}[v${i}]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset}${outLabel}`
        );
        currentLabel = outLabel;
        if (i < imagePaths.length - 1) {
          offset += imagePaths[i].duration - crossfadeSec;
        }
      }

      const vFilterStr = vFilterParts.join(';');
      const ffCmd = `ffmpeg -y ${inputs} -i "${concatAudioPath}" ` +
        `-filter_complex "${vFilterStr}" ` +
        `-map "[vout]" -map ${imagePaths.length}:a ` +
        `-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k ` +
        `-pix_fmt yuv420p -shortest "${outputPath}"`;

      log(`  Running FFmpeg (this may take several minutes for 60-min video)...`);
      execSync(ffCmd, { timeout: 1800000, stdio: 'pipe' }); // 30 min timeout
    }

    log(`Job ${jobId}: Video assembly complete`);

    // Step 5: Get file size and duration
    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    log(`Job ${jobId}: Output: ${sizeMB} MB`);

    // Step 6: Upload to temporary file hosting
    // Using file.io for simplicity — replace with your own S3/GCS/R2 bucket in production
    log(`Job ${jobId}: Uploading to file hosting...`);

    const uploadUrl = await uploadToFileIo(outputPath);
    log(`Job ${jobId}: Upload complete → ${uploadUrl}`);

    // Cleanup
    fs.rmSync(jobDir, { recursive: true, force: true });

    return {
      status: 'complete',
      url: uploadUrl,
      durationSec: imagePaths.reduce((s, img) => s + img.duration, 0),
      sizeMB: parseFloat(sizeMB),
      trackCount: trackPaths.length,
      imageCount: imagePaths.length
    };

  } catch (err) {
    // Cleanup on error
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
    throw err;
  }
}

// Upload file to file.io (temporary hosting — replace with S3/R2 for production)
function uploadToFileIo(filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);

    const options = {
      hostname: 'file.io',
      path: '/?expires=1d',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 600000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.link) {
            resolve(json.link);
          } else {
            reject(new Error(`file.io upload failed: ${data}`));
          }
        } catch (e) {
          reject(new Error(`file.io response parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ffmpeg: true }));
    return;
  }

  // Render endpoint
  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        log(`Render request received: ${request.images?.length || 0} images, ${request.tracks?.length || 0} tracks`);

        const result = await renderVideo(request);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        log(`ERROR: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  log(`FFmpeg microservice listening on port ${PORT}`);
  // Verify FFmpeg is installed
  try {
    const version = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
    log(`FFmpeg: ${version}`);
  } catch (e) {
    log('WARNING: FFmpeg not found! Install it or use the Docker image.');
  }
});
