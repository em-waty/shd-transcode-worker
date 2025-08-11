// ecosystem.config.cjs  (CommonJS, works even if app is ESM)
module.exports = {
  apps: [
    {
      name: "shd-transcode-worker",
      script: "worker-hls-and-mp4.js",
      cwd: "/root/worker",
      exec_mode: "cluster",   // or "fork"
      instances: 1,
      interpreter: "node",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
