// /root/worker/enqueue-api.js
import express from "express";
import Redis from "ioredis";
import { z } from "zod";
import crypto from "node:crypto";

const {
  REDIS_URL,
  QUEUE_KEY = "shd:transcode:jobs",
  ENQUEUE_TOKEN,              // set this in env
  PORT = 4001,
} = process.env;

if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!ENQUEUE_TOKEN) throw new Error("Missing ENQUEUE_TOKEN");

const app = express();
app.use(express.json({ limit: "1mb" }));

const JobSchema = z.object({
  spaceKey: z.string().min(1),
  originalFilename: z.string().optional(),
  contentType: z.string().optional(),
  outFolder: z.string().default("uploads-shd"),
});

const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 6000,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

app.get("/health", (_, res) => res.json({ ok: true, service: "enqueue-api" }));

app.post("/enqueue", async (req, res) => {
  try {
    const token = req.header("x-enqueue-token");
    if (token !== ENQUEUE_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const parsed = JobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ ok: false, error: "Invalid payload", details: parsed.error.flatten() });
    }

    if (!redis.status || redis.status === "end") await redis.connect();

    const job = {
      jobId: crypto.randomUUID(),
      type: "transcode",
      createdAt: new Date().toISOString(),
      ...parsed.data,
    };

    await redis.lpush(QUEUE_KEY, JSON.stringify(job));
    return res.status(201).json({ ok: true, jobId: job.jobId });
  } catch (err) {
    try { await redis.quit(); } catch {}
    return res.status(500).json({ ok: false, error: "Enqueue failed", details: String(err?.message || err) });
  }
});

app.listen(Number(PORT), () => {
  console.log(`[enqueue-api] listening on :${PORT}`);
});
