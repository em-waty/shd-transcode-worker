module.exports = {
  apps: [
    {
      name: "shd-transcode-worker",
      script: "worker-hls-and-mp4.js",
      cwd: "/root/worker",
      exec_mode: "cluster",
      instances: 1,
      interpreter: "node",
      // Add --env-file to load .env without dotenv
      interpreter_args: "--enable-source-maps --env-file=/root/worker/.env",
      env: { NODE_ENV: "production" }
    }
  ]
};
