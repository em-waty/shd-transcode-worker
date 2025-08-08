# shd-transcode-worker

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and fill in your credentials.
3. `npm start` (or configure systemd/service)

## Jobs

- Push to `transcode:queue` with `{ id, key, preset }`
- Worker will process and write to `OUT_FOLDER`