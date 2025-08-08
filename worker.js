import crypto from "crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fetch from "node-fetch";
import Redis from "ioredis";

const {
  REDIS_URL,
  DO_ACCESS_KEY,
  DO_SECRET_KEY,
  SPACES_REGION = "ams3",
  SPACES_BUCKET = "700days",
  OUT_FOLDER = "uploads-desktop"
} = process.env;

const endpoint = `${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com`;

/** Generate a presigned GET URL for an object */
function presignGet(key, ttl = 1800) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const stringToSign = ["GET", "", "", String(expires), `/${SPACES_BUCKET}/${key}`].join("\n");
  const signature = crypto.createHmac("sha1", DO_SECRET_KEY).update(stringToSign).digest("base64");
  return `https://${endpoint}/${key}?AWSAccessKeyId=${DO_ACCESS_KEY}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
}

/** Generate a presigned PUT URL for an object */
function presignPut(key, contentType, ttl = 1800) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const stringToSign = ["PUT", "", contentType, String(expires), `/${SPACES_BUCKET}/${key}`].join("\n");
  const signature = crypto.createHmac("sha1", DO_SECRET_KEY).update(stringToSign).digest("base64");
  return `https://${endpoint}/${key}?AWSAccessKeyId=${DO_ACCESS_KEY}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
}

/** Build ffmpeg args based on preset */
function ffmpegArgs(inPath, outPath, preset) {
  const vf =
    preset === "720p" ? "scale='min(1280,iw)':'-2'" :
    preset === "1080p" ? "scale='min(1920,iw)':'-2'" :
    "scale=iw:ih";
  return [
    "-y", "-i", inPath,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath
  ];
}

/** Process one job: download, transcode, upload, update Redis */
async function processJob(redis, job, raw) {
  const jobKey = `transcode:job:${job.id}`;
  await redis.hset(jobKey, { status: "processing", startedAt: new Date().toISOString() });

  const inKey = job.key;
  const outKey = inKey.replace(/^uploads\//, `${OUT_FOLDER}/`);

  const inUrl = presignGet(inKey);
  const outUrl = presignPut(outKey, "video/mp4");

  const inPath = `/tmp/in-${job.id}.mp4`;
  const outPath = `/tmp/out-${job.id}.mp4`;

  try {
    // 1) Download
    const resp = await fetch(inUrl);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    await fs.writeFile(inPath, Buffer.from(await resp.arrayBuffer()));

    // 2) Transcode with ffmpeg
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ffmpegArgs(inPath, outPath, job.preset), { stdio: "inherit" });
      p.on("exit", code => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
    });

    // 3) Upload
    const outBuf = await fs.readFile(outPath);
    const putRes = await fetch(outUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: outBuf
    });
    if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

    // 4) Mark done
    await redis.hset(jobKey, {
      status: "done",
      finishedAt: new Date().toISOString(),
      outputKey: outKey
    });
  } catch (err) {
    const attempts = Number(await redis.hincrby(jobKey, "attempts", 1)) || 0;
    await redis.hset(jobKey, { status: "error", error: String(err) });
    if (attempts < 3) {
      // retry by re-queueing
      await redis.lpush("transcode:queue", raw);
    }
  } finally {
    // cleanup temp files
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

/** Main loop: block on Redis queue, process jobs */
async function main() {
  if (!REDIS_URL || !DO_ACCESS_KEY || !DO_SECRET_KEY) {
    console.error("Missing required environment variables");
    process.exit(1);
  }
  const redis = new Redis(REDIS_URL, { tls: {} });

  while (true) {
    const res = await redis.brpop("transcode:queue", 10);
    if (!res) continue;
    const [, raw] = res;
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      continue;
    }
    await processJob(redis, job, raw);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
