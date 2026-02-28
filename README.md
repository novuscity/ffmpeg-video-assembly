# FFmpeg Video Assembly Microservice

Tiny HTTP service for the Ambient AI Video Factory v9.0 pipeline.  
Takes image URLs + audio track URLs → assembles a slideshow MP4 → returns download URL.

## What it does

1. Downloads all images and audio tracks
2. Concatenates audio with crossfade transitions  
3. Builds a slideshow video (each image displays for its track's duration)
4. Crossfades between images
5. Uploads the final MP4 to file.io (temporary) or your cloud storage
6. Returns the download URL

## Deploy to Railway (Free Tier)

```bash
# 1. Push this folder to GitHub
git init && git add . && git commit -m "FFmpeg microservice"
gh repo create ffmpeg-video-assembly --public --source=. --push

# 2. Go to railway.app → New Project → Deploy from GitHub
# 3. Select your repo — Railway auto-detects the Dockerfile
# 4. Copy the public URL (e.g. https://ffmpeg-video-assembly.up.railway.app)
# 5. Paste into n8n node "02 Flatten & Config" → ffmpegServiceUrl
#    Value: https://ffmpeg-video-assembly.up.railway.app/render
```

## API

### POST /render

```json
{
  "images": [
    {"url": "https://example.com/image1.jpg", "durationSeconds": 240},
    {"url": "https://example.com/image2.jpg", "durationSeconds": 240}
  ],
  "tracks": [
    {"url": "https://example.com/track1.mp3", "durationSeconds": 240},
    {"url": "https://example.com/track2.mp3", "durationSeconds": 240}
  ],
  "crossfadeSec": 2,
  "output": {
    "format": "mp4",
    "resolution": "1920x1080",
    "fps": 24
  }
}
```

**Response:**
```json
{
  "status": "complete",
  "url": "https://file.io/abc123",
  "durationSec": 480,
  "sizeMB": 45.2,
  "trackCount": 2,
  "imageCount": 2
}
```

### GET /health

Returns `{"status": "ok", "ffmpeg": true}`

## Production Notes

- **File hosting:** The default uses file.io (temporary, 1 download). For production, replace `uploadToFileIo()` in server.js with your own S3/R2/GCS upload.
- **Timeouts:** 60-min videos take ~5-10 minutes to assemble. The n8n HTTP Request node has a 10-min timeout configured.
- **Memory:** A 60-min 1080p MP4 is ~500MB. Railway free tier gives 512MB RAM — may need the $5/mo plan for 60-min videos. Render.com free tier is similar.
- **Alternative:** DigitalOcean $5/mo droplet (1GB RAM) handles it easily.
