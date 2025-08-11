module.exports = {
  apps: [
    {
      name: "shd-transcode-worker",
      script: "worker-hls-and-mp4.js",
      cwd: "/root/worker",        // make sure this is your project folder
      exec_mode: "cluster",       // or "fork"
      instances: 1,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
