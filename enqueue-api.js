// enqueue-api.js
// Minimal enqueue API that matches the worker's expected job shape.
// Worker expects: queue "transcode:queue", payload: { id, key }

import express from "express";
import Redis from "ioredis";
import { z } from "zod";
import crypto from "node:crypto";

const {
  REDIS_URL,
  QUEUE_KEY = "transcode:queue",     // <-- match worker
  ENQUEUE_TOKEN,                      // set this in .env
  PORT = 4001,
} = process.env;

if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!ENQUEUE_TOKEN) throw new Error("Missing ENQUEUE_TOKEN");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Accept either { spaceKey } or { key }; normalize to { key }
const PayloadSchema = z.object({
  key: z.string().min(1).optional(),
  spaceKey: z.string().min(1).optional(),
  // Optional extras you may want to send along for your own auditing
  originalFilename: z.string().optional(),
  contentType: z.string().optional(),
  outFolder: z.string().optional(), // worker uses OUT_FOLDER env; this is informational
}).refine((d) => d.key || d.spaceKey, { message: "Provide 'key' or 'spaceKey'" });

const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 6000,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

app.get("/health", async (_req, res) => {
  try {
    if (!redis.status || redis.status === "end") await redis.connect();
    const pong = await redis.ping();
    return res.json({ ok: true, service: "enqueue-api", redis: pong === "PONG" });
  } catch (e) {
    return res.status(503).json({ ok: false, service: "enqueue-api", redis: false, error: String(e?.message || e) });
  }
});

app.post("/enqueue", async (req, res) => {
  try {
    const token = req.header("x-enqueue-token");
    if (token !== ENQUEUE_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const parsed = PayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ ok: false, error: "Invalid payload", details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const key = body.key || body.spaceKey;

    if (!redis.status || redis.status === "end") await redis.connect();

    const job = {
      id: crypto.randomUUID(),           // <-- match worker
      key,                               // <-- match worker
      type: "transcode",
      createdAt: new Date().toISOString(),
      // Keep non-breaking extras for your own tracking (worker ignores them)
      originalFilename: body.originalFilename || "",
      contentType: body.contentType || "",
      outFolder: body.outFolder || "",
    };

    await redis.lpush(QUEUE_KEY, JSON.stringify(job));
    console.log(`[enqueue-api] queued job ${job.id} -> ${QUEUE_KEY} (${key})`);

    return res.status(201).json({ ok: true, id: job.id, queue: QUEUE_KEY });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Enqueue failed", details: String(err?.message || err) });
  }
});

app.listen(Number(PORT), () => {
  console.log(`[enqueue-api] listening on :${PORT}, queue=${QUEUE_KEY}`);
});
