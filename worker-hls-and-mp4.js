// worker-hls-and-mp4.js
// Streaming + timeouts + retries + multi-rendition HLS + MP4, uploads to DigitalOcean Spaces via SigV2
// Now with AVIF thumbnails at t=0s and t=10s ( -thumb-0.avif / -thumb-10.avif )
// This version requires Node to be started with: --env-file=/root/worker/.env

import crypto from 'crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import Redis from 'ioredis';

/* =====================
   ENV & DEFAULTS
   ===================== */
const {
  REDIS_URL,
  DO_ACCESS_KEY,
  DO_SECRET_KEY,
  SPACES_REGION = 'ams3',
  SPACES_BUCKET = '700days',
  OUT_FOLDER = 'uploads-shd',

  CONCURRENCY = '1',
  FETCH_TIMEOUT_MS = '60000',
  MAX_FETCH_RETRIES = '3',
  BACKOFF_BASE_MS = '500',

  // Output toggles
  OUTPUT_MP4 = 'true',
  OUTPUT_HLS = 'true',
  HLS_RENDITIONS = '1080p,720p,480p',
  HLS_SEGMENT_SECONDS = '4',

  CDN_BASE = 'https://700days.ams3.cdn.digitaloceanspaces.com',

  THUMBS_ENABLE = 'true',
  THUMB_WIDTH = '1280',

  // job status retention
  JOB_TTL_SEC = String(3 * 24 * 3600), // 3 days

  // NEW: make outputs under OUT_FOLDER public at upload time
  PUBLIC_OUTPUTS = 'true'
} = process.env;

const REQUIRED_ENV = ['REDIS_URL', 'DO_ACCESS_KEY', 'DO_SECRET_KEY'];
function validateEnv() {
  const missing = REQUIRED_ENV.filter(
    (k) => !process.env[k] || String(process.env[k]).trim() === ''
  );
  console.log('[worker] boot', {
    cwd: process.cwd(),
    node: process.version,
    env: {
      REDIS_URL: !!REDIS_URL,
      DO_ACCESS_KEY: !!DO_ACCESS_KEY,
      DO_SECRET_KEY: !!DO_SECRET_KEY,
      SPACES_REGION,
      SPACES_BUCKET,
      OUT_FOLDER,
      PUBLIC_OUTPUTS
    }
  });
  if (missing.length) {
    console.error('[worker] Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
}
validateEnv();

const endpoint = `${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com`;
const CDN_BASE_URL = (CDN_BASE || '').replace(/\/$/, '');

/* =====================
   Status helpers (Redis)
   ===================== */
function statusKey(jobId) {
  return `transcode:job:${jobId}`;
}

async function setStatus(redis, jobId, fields) {
  const key = statusKey(jobId);
  await redis.hset(key, fields);
  await redis.expire(key, Number(JOB_TTL_SEC));
}

/* =====================
   Safety: normalize object keys
   ===================== */
function normalizeKey(key) {
  // force forward slashes, remove leading slash, prevent path traversal
  const s = String(key).replace(/\\/g, '/').replace(/^\/+/, '');
  if (s.includes('..')) throw new Error('invalid key');
  return s;
}

/* =====================
   UTIL: S3 SigV2 presign (Spaces)
   ===================== */
function presignGet(key, ttl = 1800) {
  const k = normalizeKey(key);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const stringToSign = ['GET', '', '', String(expires), `/${SPACES_BUCKET}/${k}`].join('\n');
  const signature = crypto.createHmac('sha1', DO_SECRET_KEY).update(stringToSign).digest('base64');
  return `https://${endpoint}/${k}?AWSAccessKeyId=${DO_ACCESS_KEY}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
}

/**
 * SigV2 presign for PUT that correctly canonicalizes and signs x-amz-* headers.
 * Any x-amz-* headers you intend to send MUST be included here, or the signature will not match.
 */
function presignPut(key, contentType, ttl = 1800, amzHeaders = {}) {
  const k = normalizeKey(key);
  const expires = Math.floor(Date.now() / 1000) + ttl;

  // Canonicalize x-amz-* headers: lowercase keys, trim, collapse spaces, sort by header name
  const canonAmz = Object.entries(amzHeaders)
    .map(([hk, hv]) => [String(hk).toLowerCase().trim(), String(hv).trim().replace(/\s+/g, ' ')])
    .filter(([hk]) => hk.startsWith('x-amz-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hk, hv]) => `${hk}:${hv}\n`)
    .join('');

  const stringToSign = [
    'PUT',
    '',                               // Content-MD5
    contentType || '',                // Content-Type
    String(expires),
    `${canonAmz}/${SPACES_BUCKET}/${k}`
  ].join('\n');

  const signature = crypto.createHmac('sha1', DO_SECRET_KEY).update(stringToSign).digest('base64');

  const url = new URL(`https://${endpoint}/${k}`);
  url.searchParams.set('AWSAccessKeyId', DO_ACCESS_KEY);
  url.searchParams.set('Expires', String(expires));
  url.searchParams.set('Signature', encodeURIComponent(signature));

  return { url: url.toString(), signedAmzHeaders: amzHeaders };
}

/* =====================
   UTIL: sleep, backoff, fetch with timeout+retries
   ===================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(attempt, base = Number(BACKOFF_BASE_MS)) {
  const expo = base * Math.pow(2, attempt);
  return Math.floor(expo / 2 + (Math.random() * expo) / 2); // jitter
}

async function fetchWithTimeout(
  url,
  opts = {},
  {
    timeoutMs = Number(FETCH_TIMEOUT_MS),
    maxRetries = Number(MAX_FETCH_RETRIES),
    // Retry on 5xx or network error; treat 4xx as fatal by default
    retryOn = (res) => res.status >= 500,
    onAttempt = () => {}
  } = {}
) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    onAttempt(attempt);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(t);
      if (!retryOn(res)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
    }
    await sleep(backoffDelay(attempt));
  }
  throw lastErr;
}

/* =====================
   FFmpeg arg builders
   ===================== */
function scaleFilter(width) {
  // Keep aspect ratio; use -2 for computed height to keep mod2
  return `scale='min(${width},iw)':-2`;
}

function mp4Args(inPath, outPath, r) {
  return [
    '-y',
    '-i', inPath,
    '-vf', scaleFilter(r.width),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(r.crf),
    '-maxrate', String(r.maxrate),
    '-bufsize', String(r.bufsize),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', String(r.ab),
    '-movflags', '+faststart',
    outPath
  ];
}

function hlsArgs(inPath, outDir, label, r) {
  const playlist = path.join(outDir, label, 'index.m3u8');
  const segments = path.join(outDir, label, 'segment_%03d.ts');
  return [
    '-y',
    '-i', inPath,
    '-vf', scaleFilter(r.width),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(r.crf),
    '-maxrate', String(r.maxrate),
    '-bufsize', String(r.bufsize),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', String(r.ab),
    '-start_number', '0',
    '-hls_time', String(Number(HLS_SEGMENT_SECONDS)),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', segments,
    playlist
  ];
}

/* =====================
   Thumbnails (AVIF)
   ===================== */
function thumbArgs(inPath, outPath, whenSec) {
  // -ss before -i for faster seek; -frames:v 1 grabs a single frame
  // Using libaom-av1 still-picture mode for AVIF; adjust quality with -crf (0 best, 63 worst)
  return [
    '-y',
    '-ss', String(whenSec),
    '-i', inPath,
    '-frames:v', '1',
    '-vf', `scale='min(${Number(THUMB_WIDTH)},iw)':-2:force_original_aspect_ratio=decrease`,
    '-c:v', 'libaom-av1',
    '-still-picture', '1',
    '-crf', '32',
    outPath
  ];
}

async function generateThumb(inPath, outPath, whenSec) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', thumbArgs(inPath, outPath, whenSec), { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg thumb ${whenSec}s exit ${code}`))));
  });
}

/* =====================
   HLS Master playlist writer
   ===================== */
async function writeMasterPlaylist(masterPath, variants) {
  // variants: [{ label, bandwidth, resolution, uri }]
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const v of variants) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`);
    lines.push(v.uri);
  }
  await fs.mkdir(path.dirname(masterPath), { recursive: true });
  await fs.writeFile(masterPath, lines.join('\n'));
}

/* =====================
   Upload helpers
   ===================== */
function guessContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.ts') return 'video/MP2T';
  if (ext === '.m4s') return 'video/mp4'; // CMAF segments
  if (ext === '.avif') return 'image/avif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function uploadFile(localPath, outKey) {
  const stat = await fs.stat(localPath);
  const ct = guessContentType(localPath);

  // Only make public if desired and under OUT_FOLDER prefix
  const makePublic = (PUBLIC_OUTPUTS === 'true') && outKey.startsWith(`${OUT_FOLDER}/`);
  const amz = makePublic ? { 'x-amz-acl': 'public-read' } : {};

  // presign with the same x-amz-* headers you'll send
  const { url, signedAmzHeaders } = presignPut(outKey, ct, 1800, amz);

  const headers = {
    'Content-Type': ct,
    'Content-Length': String(stat.size),
    ...signedAmzHeaders // includes x-amz-acl when enabled
  };

  const res = await fetchWithTimeout(
    url,
    { method: 'PUT', headers, body: createReadStream(localPath) },
    { onAttempt: (a) => console.log(`[upload] ${outKey} attempt ${a + 1}`) }
  );
  if (!res.ok) throw new Error(`upload failed ${res.status} for ${outKey}`);
}

async function uploadDirectory(localDir, prefixKey) {
  // Walk dir recursively and upload each file preserving relative paths
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const rel = path.relative(localDir, full).split(path.sep).join('/');
        const key = `${prefixKey}/${rel}`;
        await uploadFile(full, key);
      }
    }
  }
  await walk(localDir);
}

/* =====================
   Download helper (streamed)
   ===================== */
async function streamedDownload(inUrl, destPath, jobId) {
  const res = await fetchWithTimeout(inUrl, {}, {
    onAttempt: (a) => console.log(`[job ${jobId}] download attempt ${a + 1}`)
  });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(res.body, createWriteStream(destPath));
}

/* =====================
   Job processing
   ===================== */
async function processJob(redis, job, raw) {
  if (!job || !job.id || !job.key) return;

  const inKey = normalizeKey(job.key);
  const outBase = inKey.replace(/^uploads\//, `${OUT_FOLDER}/`); // e.g. uploads/foo.mp4 -> uploads-shd/foo.mp4
  const inUrl = presignGet(inKey);

  const tmpDir = `/tmp/job-${job.id}`;
  const inPath = path.join(tmpDir, 'input.mp4');
  const mp4OutPath = path.join(tmpDir, 'output.mp4');
  const hlsDir = path.join(tmpDir, 'hls');

  // Thumbs temp files
  const thumb0Path = path.join(tmpDir, 'thumb-0.avif');
  const thumb10Path = path.join(tmpDir, 'thumb-10.avif');

  // Choose rendition for MP4 (highest from configured list)
  const labels = HLS_RENDITIONS.split(',').map((s) => s.trim()).filter(Boolean);
  const firstValid = labels.find((l) => RENDITIONS[l]);
  const mp4Rendition = RENDITIONS[firstValid || '720p']; // fallback 720p

  try {
    // Mark processing
    await setStatus(redis, job.id, {
      status: 'processing',
      startedAt: new Date().toISOString(),
      key: job.key
    });

    // 1) Download source
    await streamedDownload(inUrl, inPath, job.id);

    // 1b) Thumbnails (optional)
    let thumbKey0 = null, thumbKey10 = null;
    if (THUMBS_ENABLE === 'true') {
      await generateThumb(inPath, thumb0Path, 0);
      await generateThumb(inPath, thumb10Path, 10);
      const baseNoExt = outBase.replace(/\.mp4$/i, '');
      thumbKey0 = `${baseNoExt}-thumb-0.avif`;
      thumbKey10 = `${baseNoExt}-thumb-10.avif`;
      await uploadFile(thumb0Path, thumbKey0);
      await uploadFile(thumb10Path, thumbKey10);
    }

    // 2) MP4 output (optional)
    let outputKeyMp4 = null;
    if (OUTPUT_MP4 === 'true') {
      await new Promise((resolve, reject) => {
        const args = mp4Args(inPath, mp4OutPath, mp4Rendition);
        console.log(`[job ${job.id}] ffmpeg mp4:`, args.join(' '));
        const p = spawn('ffmpeg', args, { stdio: 'inherit' });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mp4 exit ${code}`))));
      });
      outputKeyMp4 = outBase.replace(/\.mp4$/i, '') + '.mp4';
      await uploadFile(mp4OutPath, outputKeyMp4);
    }

    // 3) HLS outputs (optional): run one ffmpeg per rendition, then write master
    let outputKeyHlsMaster = null;
    if (OUTPUT_HLS === 'true') {
      await fs.mkdir(hlsDir, { recursive: true });
      const hlsVariants = [];
      for (const label of labels) {
        const r = RENDITIONS[label];
        if (!r) continue;
        const outSub = path.join(hlsDir, label);
        await fs.mkdir(outSub, { recursive: true });
        const args = hlsArgs(inPath, hlsDir, label, r);
        console.log(`[job ${job.id}] ffmpeg hls ${label}:`, args.join(' '));
        await new Promise((resolve, reject) => {
          const p = spawn('ffmpeg', args, { stdio: 'inherit' });
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg hls ${label} exit ${code}`))));
        });
        // Collect variant info for master playlist
        hlsVariants.push({
          label,
          bandwidth: r.maxrate, // approximation for BANDWIDTH
        resolution: `${r.width}x${r.height}`,
          uri: `${label}/index.m3u8`,
        });
      }
      // Write master.m3u8 at hls root
      const masterPath = path.join(hlsDir, 'master.m3u8');
      await writeMasterPlaylist(masterPath, hlsVariants);

      // Upload HLS tree under base without .mp4
      const baseNoExt = outBase.replace(/\.mp4$/i, '');
      await uploadDirectory(hlsDir, baseNoExt);
      outputKeyHlsMaster = `${baseNoExt}/master.m3u8`;
    }

    // 4) Done: include public CDN URLs and thumbs
    await setStatus(redis, job.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      outputKeyMp4: outputKeyMp4 || '',
      outputKeyHls: outputKeyHlsMaster || '',
      publicUrlMp4: outputKeyMp4 ? `${CDN_BASE_URL}/${outputKeyMp4}` : '',
      publicUrlHls: outputKeyHlsMaster ? `${CDN_BASE_URL}/${outputKeyHlsMaster}` : '',
      thumbKey0: thumbKey0 || '',
      thumbKey10: thumbKey10 || '',
      publicThumbUrl0: thumbKey0 ? `${CDN_BASE_URL}/${thumbKey0}` : '',
      publicThumbUrl10: thumbKey10 ? `${CDN_BASE_URL}/${thumbKey10}` : ''
    });

  } catch (err) {
    console.error(`[job ${job.id}] error:`, err);
    const key = statusKey(job.id);
    const attempts = Number((await redis.hincrby(key, 'attempts', 1)) || 0);

    await setStatus(redis, job.id, {
      status: 'failed',
      error: String(err),
      failedAt: new Date().toISOString()
    });

    if (attempts < 3) {
      await sleep(backoffDelay(attempts));
      await redis.lpush('transcode:queue', raw);
    }
  } finally {
    // cleanup temp dir
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/* =====================
   RENDITION MAP
   ===================== */
const RENDITIONS = {
  '1080p': { width: 1920, height: 1080, crf: 22, maxrate: 6000000, bufsize: 12000000, ab: 128000 },
  '720p':  { width: 1280, height: 720,  crf: 23, maxrate: 3500000, bufsize: 7000000,  ab: 128000 },
  '480p':  { width: 854,  height: 480,  crf: 24, maxrate: 1800000, bufsize: 3600000,  ab: 96000  }
};

/* =====================
   Redis preflight (ping + set/get)
   ===================== */
async function preflightRedis() {
  const useTls = REDIS_URL.startsWith('rediss://');
  const client = new Redis(REDIS_URL, useTls ? { tls: {}, maxRetriesPerRequest: 1 } : { maxRetriesPerRequest: 1 });
  try {
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error('unexpected PING reply: ' + pong);
    await client.set('healthcheck', 'ok', 'EX', 10);
    const v = await client.get('healthcheck');
    console.log('✅ Redis preflight OK (PING & SET/GET):', v);
  } finally {
    client.disconnect();
  }
}

/* =====================
   Worker loop with concurrency
   ===================== */
async function startWorker(id, redis) {
  console.log(`[worker ${id}] started`);
  while (true) {
    try {
      const res = await redis.brpop('transcode:queue', 10);
      if (!res) continue;
      const [, raw] = res;
      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        continue;
      }

      // Ensure every job has an id
      if (!job.id) job.id = crypto.randomUUID();

      await processJob(redis, job, raw);
    } catch (e) {
      console.error(`[worker ${id}] loop error:`, e);
      await sleep(500);
    }
  }
}

/* =====================
   Main
   ===================== */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

async function main() {
  // Fail fast if preflight cannot reach Redis with credentials/TLS
  await preflightRedis();

  const useTls = REDIS_URL.startsWith('rediss://');
  const redis = new Redis(REDIS_URL, useTls ? { tls: {} } : undefined);

  const shutdown = async () => {
    console.log('Shutting down...');
    try { await redis.quit(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const n = Math.max(1, Number(CONCURRENCY));
  await Promise.all(Array.from({ length: n }, (_, i) => startWorker(i + 1, redis)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
