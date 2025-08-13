// ecosystem.config.cjs
module.exports = {
  apps: [
    // 1) Your existing transcoder worker (unchanged)
    {
      name: "shd-transcode-worker",
      script: "/root/worker/worker-hls-and-mp4.js",
      cwd: "/root/worker",
      exec_mode: "cluster",
      instances: 1,
      interpreter: "node",
      node_args: ["--enable-source-maps", "--env-file=/root/worker/.env"],
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: ""
      }
    },

    // 2) New: HTTP enqueue gateway (small Express API)
    {
      name: "enqueue-api",
      script: "/root/worker/enqueue-api.js",
      cwd: "/root/worker",
      // a lightweight API is fine in "fork" mode, but cluster 1 also works
      exec_mode: "fork",
      instances: 1,
      interpreter: "node",
      node_args: ["--enable-source-maps", "--env-file=/root/worker/.env"],
      env: {
        NODE_ENV: "production",
        // PORT, ENQUEUE_TOKEN, REDIS_URL, QUEUE_KEY come from /root/worker/.env
        // Example .env:
        //   PORT=4001
        //   ENQUEUE_TOKEN=your-long-secret
        //   REDIS_URL=rediss://user:pass@host:port
        //   QUEUE_KEY=shd:transcode:jobs
      }
    }
  ]
};
