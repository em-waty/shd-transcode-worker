// PM2 config (CommonJS) — no secrets here
module.exports = {
  apps: [{
    name: "shd-transcode-worker",
    script: "/root/worker/worker-hls-and-mp4.js",
    instances: 1,
    autorestart: true,
    watch: false,
    time: true
  }]
};
