# shd-transcode-worker

A Node.js worker for **video transcoding** and **thumbnail generation** on DigitalOcean Spaces.

This worker:
- Downloads videos from Spaces via **pre-signed GET**
- Transcodes to:
  - MP4 (H.264/AAC)
  - HLS (`.m3u8` + `.ts` segments)
- Generates **AVIF thumbnails** at:
  - 0 seconds (`-thumb-0.avif`)
  - 10 seconds (`-thumb-10.avif`)
- Uploads all outputs back to Spaces via **pre-signed PUT**
- Saves output keys and CDN URLs to Redis

## Requirements
- Node.js 18+
- ffmpeg (with libx264, aac, and libaom-av1 support)
- Redis (standalone or managed)
- DigitalOcean Spaces bucket & API keys

## Environment Variables

| Variable               | Description                                             | Default |
|------------------------|---------------------------------------------------------|---------|
| `REDIS_URL`            | Redis connection string                                 | -       |
| `DO_ACCESS_KEY`        | DigitalOcean Spaces Access Key                          | -       |
| `DO_SECRET_KEY`        | DigitalOcean Spaces Secret Key                          | -       |
| `SPACES_REGION`        | Spaces region                                           | `ams3`  |
| `SPACES_BUCKET`        | Bucket name                                             | `700days` |
| `OUT_FOLDER`           | Output folder prefix in Spaces                          | `uploads-shd` |
| `CONCURRENCY`          | Number of worker loops to run in parallel               | `1`     |
| `FETCH_TIMEOUT_MS`     | Timeout for downloads/uploads (ms)                      | `60000` |
| `MAX_FETCH_RETRIES`    | Retries for downloads/uploads                           | `3`     |
| `BACKOFF_BASE_MS`      | Base delay for exponential backoff (ms)                  | `500`   |
| `OUTPUT_MP4`           | Enable MP4 output (`true`/`false`)                       | `true`  |
| `OUTPUT_HLS`           | Enable HLS output (`true`/`false`)                       | `true`  |
| `HLS_RENDITIONS`       | Comma-separated list of renditions (1080p,720p,480p)     | `1080p,720p,480p` |
| `HLS_SEGMENT_SECONDS`  | HLS segment length (seconds)                             | `4`     |
| `CDN_BASE`             | Public CDN base URL                                      | `https://700days.ams3.cdn.digitaloceanspaces.com` |
| `THUMBS_ENABLE`        | Enable AVIF thumbnail generation (`true`/`false`)       | `true`  |
| `THUMB_WIDTH`          | Thumbnail width (maintains aspect ratio)                 | `1280`  |

## Installation
```bash
git clone https://github.com/yourusername/shd-transcode-worker.git
cd shd-transcode-worker
npm install
