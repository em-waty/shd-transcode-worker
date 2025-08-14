// /root/worker/ecosystem.config.cjs
module.exports = {
  apps: [
    // 1) Transcode worker
    {
      name: "shd-transcode-worker",
      script: "/root/worker/worker-hls-and-mp4.js",
      cwd: "/root/worker",
      exec_mode: "cluster",
      instances: 1,
      interpreter: "node",
      node_args: ["--enable-source-maps"],
      env_file: "/root/worker/.env",          // PM2 loads your .env automatically
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: ""                       // ensure no global -r preloads
      },
      watch: false,
      autorestart: true
      max_memory_restart: "150M" // ⬅ restart if memory > 150 MB
    },

    // 2) New: HTTP enqueue gateway (small Express API)
    // Purpose: accept POST /enqueue and push jobs into Redis without exposing Redis to clients.
    // Keep this if you want to enqueue via HTTP from other services, CLIs, or your website.
    {
      name: "enqueue-api",
      script: "/root/worker/enqueue-api.js",
      cwd: "/root/worker",
      exec_mode: "fork",
      instances: 1,
      interpreter: "node",
      node_args: ["--enable-source-maps"],
      env_file: "/root/worker/.env",           // uses ENQUEUE_TOKEN, PORT, QUEUE_KEY, REDIS_URL
      env: {
        NODE_ENV: "production"
      },
      watch: false,
      autorestart: true
    }
  ]
};
