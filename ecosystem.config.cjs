module.exports = {
  apps: [
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
        NODE_OPTIONS: ""   // ensure no global -r preloads
      }
    }
  ]
};
