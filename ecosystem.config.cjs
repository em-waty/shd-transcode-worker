// ecosystem.config.js
module.exports = {
  apps: [{
    name: "shd-transcode-worker",
    // Path on the droplet where the script lives
    script: "/root/worker/worker-hls-and-mp4.js",
    time: true
  }]
}
