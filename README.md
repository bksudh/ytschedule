# YouTube Live Streaming Scheduler 📺🚀

A simple, full‑stack solution to upload pre‑recorded videos and schedule automated YouTube Live streams. It includes a modern ES6+ frontend, an Express/MongoDB backend, FFmpeg for media probing, Traefik for routing, and Docker for easy deployment.

---

## ✨ Features

- Upload videos with validation and progress tracking
- Schedule streams and automatically start when due
- Manual controls: start, stop, delete, retry
- Dynamic video list with search, filters, and formatting
- Edit video details (title, schedule, RTMP URL/key)
- Real‑time status updates and auto‑refresh
- Toast notifications and user‑friendly error handling
- Health endpoint showing DB status and active streams
- Environment‑aware frontend config (dev/prod)

---

## 🧰 Tech Stack

- Node.js + Express
- MongoDB (Mongoose)
- FFmpeg/ffprobe (via `fluent-ffmpeg`)
- Traefik v2 (reverse proxy, HTTPS)
- Nginx (static frontend serving)
- Docker & Docker Compose
- Vanilla JS (ES6+) frontend

---

## ✅ Prerequisites

- Node.js 18+ and npm (for local dev)
- Docker 20+ and Docker Compose v2 (for containerized deployment)
- FFmpeg/ffprobe installed and available on PATH
  - Verify: `ffmpeg -version` and `ffprobe -version`
- Git

Optional (for production):
- A domain pointed to your server (for Traefik + Let’s Encrypt)

---

## ⚙️ Installation

1) Clone the repository

```bash
git clone https://github.com/yourname/youtube-live-scheduler.git
cd youtube-live-scheduler
```

2) Environment setup

- Copy the example and customize

```bash
cp .env.example .env
```

- Edit `.env` with your values (MongoDB URI, allowed origins, domain, ACME email). See comments inside `.env`.

3) Create the shared Docker network

```bash
docker network create web
```

4) Run with Docker Compose

```bash
docker compose up -d
```

- Frontend: `http://localhost` (or `https://localhost` if routed through Traefik)
- Backend API: `http://localhost:3000/api`
- Traefik dashboard (dev only): `http://localhost:8080`

Local development (without Docker):
- Backend: `cd backend && npm install && npm run dev`
- Frontend dev preview: `node frontend/dev-server.js` then open `http://localhost:5174/`

---

## 🧭 Usage Guide

### 1) Get YouTube RTMP credentials 🔑

- RTMP ingest URL: typically `rtmp://a.rtmp.youtube.com/live2`
- Stream key: from YouTube Live Control Room
- Help: https://support.google.com/youtube/answer/2474026

### 2) Upload a video 📤

- Open the app and use the “Upload Video” form
- Max size: 5GB (configurable)
- Allowed formats: mp4, avi, mov, mkv, flv
- Progress bar shows upload progress

### 3) Schedule the stream 🗓️

- Pick a date/time in the schedule field
- The scheduler checks every minute and starts due streams automatically

### 4) Manual start/stop ▶️⏹️

- Use the “Start”/“Stop” buttons on each video card
- You can also delete completed/failed/cancelled streams

---

## 🔌 API (Brief)

Base URL: `http://localhost:3000/api`

- `GET /health` — health status `{ status, db, streams, uptime }`
- `GET /videos` — list videos (supports `status`, `limit`, `skip`)
- `GET /videos/:id` — get single video
- `POST /videos/upload` — upload new video (fields: `video`, `title`, `scheduleTime`, `rtmpUrl`, `streamKey`)
- `POST /videos/` — legacy upload (fields: `file`, `title`, `scheduleTime|scheduledAt`, `rtmpUrl`, `streamKey`)
- `PUT /videos/:id` — update video (title, scheduleTime, rtmpUrl, streamKey)
- `POST /videos/:id/stream/start` — start streaming (optional `force`)
- `POST /videos/:id/stream/stop` — stop streaming
- `GET /videos/:id/stream/status` — current stream status
- `DELETE /videos/:id` — delete video (and file)
- `POST /videos/test-rtmp` — check RTMP reachability

Example: upload via `curl` (legacy)

```bash
curl -X POST http://localhost:3000/api/videos \
  -F "file=@/path/to/video.mp4" \
  -F "title=My Stream" \
  -F "scheduleTime=2025-01-01T10:00:00Z" \
  -F "rtmpUrl=rtmp://a.rtmp.youtube.com/live2" \
  -F "streamKey=YOUR_STREAM_KEY"
```

---

## 🛠️ Configuration

- See `.env.example` and `.env` for all variables
- Key variables:
  - `NODE_ENV` — `development` or `production`
  - `PORT` — backend port (default 3000)
  - `MONGODB_URI` — MongoDB connection URI
  - `VIDEOS_PATH` — where uploads are stored (e.g., `/app/videos`)
  - `MAX_UPLOAD_SIZE` — in bytes (5GB = `5368709120`)
  - `ALLOWED_ORIGINS` / `CORS_ORIGINS` — comma‑separated allowed frontend origins
  - Traefik: `DOMAIN`, `ACME_EMAIL`

Frontend auto‑detects environment and uses:
- `API_URL`/`API_BASE`
- `REFRESH_INTERVAL`
- `MAX_FILE_SIZE`
- `ALLOWED_FORMATS`

---

## 🧩 Project Structure

```
ytsch/
├─ backend/                # Express API, Mongoose models, stream utils
│  ├─ server.js            # App entrypoint, health, routing, DB connection
│  ├─ routes/videos.js     # Uploads, listing, stream controls, delete
│  ├─ models/Video.js      # Video schema, validations, virtuals
│  ├─ utils/streamer.js    # Start/stop stream orchestration
│  ├─ middleware/errorHandler.js # AppError + error responses
│  └─ Dockerfile           # Backend image
├─ frontend/               # Static frontend (ES6+, no framework)
│  ├─ index.html           # UI markup
│  ├─ js/config.js         # Env‑aware config
│  ├─ js/app.js            # Main app logic
│  └─ css/style.css        # Styles, toasts, grid, components
├─ traefik/                # Traefik static/dynamic config
│  ├─ traefik.yml          # Entry points, providers, logging, ACME
│  └─ dynamic-config.yml   # Optional, per‑service rules
├─ nginx/nginx.conf        # Frontend server config
├─ docker-compose.yml      # Multi‑service stack
├─ videos/                 # Uploaded video storage (volume)
├─ .env / .env.example     # Environment variables
└─ .gitignore              # Ignore rules
```

---

## 🧪 Troubleshooting

### Common errors

- `413 Request Entity Too Large` — increase Nginx `client_max_body_size` (already set to 5GB in `nginx.conf`).
- `CORS` errors — update `ALLOWED_ORIGINS` and `CORS_ORIGINS` in `.env` to include your frontend origin (e.g., `http://localhost:5174`).
- Aborted fetch or `500` on `/api/videos` — when MongoDB is disconnected, the backend now returns `[]` quickly. Verify `MONGODB_URI` and Mongo health.
- Duplicate key (`11000`) — resolve unique index conflicts; backend maps to `409`.
- Validation errors — ensure required fields (title, scheduleTime, RTMP URL, stream key) are correct; backend maps to `400`.

### FFmpeg issues

- Ensure `ffmpeg` and `ffprobe` are installed and accessible on PATH.
- On Linux: `sudo apt-get install -y ffmpeg`
- In containers: install FFmpeg in your backend image or mount it in.

### MongoDB connection problems

- Verify URI: `MONGODB_URI=mongodb://mongo:27017/youtube-scheduler`
- Check container health: `docker ps`, `docker logs mongo`
- Ensure the `web` network exists and services are attached.

### Traefik / HTTPS

- Set `DOMAIN` and `ACME_EMAIL` for Let’s Encrypt.
- Ensure DNS points to your host.
- Check dashboard at `http://localhost:8080` (dev only) for router status.

## 🏁 Production Deployment

This repository includes a hardened production stack in `docker-compose.prod.yml` with:

- HTTPS termination with Let’s Encrypt via Traefik
- No dev bind mounts; images are built for backend and frontend
- Health checks for all services
- Logging with rotation (`json-file` driver)
- Resource limits (Swarm `deploy.resources` section)
- Automatic restarts and MongoDB backups
- Security hardening: read-only FS, dropped capabilities, no-new-privileges

### Prerequisites

- DNS A/AAAA record for your domain pointing to the host (`DOMAIN`)
- Open ports `80` and `443` to the host (firewall/NAT)
- `.env` configured with at least:
  - `DOMAIN=your.domain.com`
  - `ACME_EMAIL=you@example.com`
  - `CORS_ORIGINS=https://your.domain.com`
  - `VIDEOS_PATH` (optional; defaults internally)
  - `MONGODB_URI` (used by backup service; also provided via secret below)

### Secrets

To avoid exposing sensitive values (like `MONGODB_URI`) via environment variables, the production stack reads `MONGODB_URI` from a Docker secret.

- Create secrets directory: `mkdir -p secrets`
- Store Mongo URI: `echo "mongodb://mongo:27017/ytsch" > secrets/mongodb_uri.txt`
  - Use your actual URI (with credentials if applicable)

### Let’s Encrypt Storage

Traefik stores certificates in the `traefik_letsencrypt` volume and writes to `/letsencrypt/acme.json` inside the container. Ensure:

- Ports `80` and `443` reach the host
- DNS is correctly set for `DOMAIN`

### Build and Deploy (Production)

1. Ensure the external Docker network exists: `docker network create web` (one time)
2. Build images: `docker compose -f docker-compose.prod.yml build`
3. Launch stack: `docker compose -f docker-compose.prod.yml up -d`
4. Verify health:
   - `docker compose -f docker-compose.prod.yml ps`
   - `docker compose -f docker-compose.prod.yml logs traefik backend frontend mongo --tail=100`
5. Check HTTPS: visit `https://$DOMAIN`

### Notes on Resource Limits

- The `deploy.resources.limits` section is enforced under Docker Swarm. Under plain Docker Compose, limits are advisory. For strict enforcement without Swarm, consider equivalent `docker run` flags or migrate to Swarm.

### MongoDB Backups

- A `mongo-backup` sidecar runs `mongodump` daily and prunes backups older than 7 days.
- Backups are stored in the `mongo_backups` volume. Retrieve with:
  - `docker compose -f docker-compose.prod.yml run --rm mongo-backup sh -c 'ls -la /backup'`

### Security Hardening

- Read-only filesystem for services, with writes only to mounted volumes
- Dropped Linux capabilities and `no-new-privileges` enabled
- Traefik dashboard is disabled in production

### Switch Between Dev and Prod

- Development: `docker compose up -d` (local bind mounts and dev ports)
- Production: `docker compose -f docker-compose.prod.yml up -d` (no dev mounts, HTTPS, backups)

If you change `.env` values (e.g., `DOMAIN`, `ACME_EMAIL`, `CORS_ORIGINS`), restart the stack.

## 🧪 Integration Test

A cross‑platform Node script validates the full workflow and error paths.

- What it covers:
  - Starts the dev stack via Docker Compose
  - Waits for Traefik, MongoDB, backend, and frontend to become healthy
  - Spins up a temporary RTMP server on the `web` network
  - Generates `sample.mp4` via FFmpeg inside the backend and copies it to host
  - Uploads and schedules the video (2 minutes ahead)
  - Verifies listing, waits for automatic streaming, checks status
  - Stops the stream, verifies final status, deletes the video
  - Error cases: invalid format, missing RTMP credentials, invalid schedule time
  - Writes `integration-report.json` and cleans up temporary resources

### Run the test

Prereqs: Docker, Docker Compose v2, `curl` available on PATH, and the external network `web` (create once: `docker network create web`).

```bash
node scripts/integration-test.js
```

Expect ~3–5 minutes runtime due to the 2‑minute schedule and cron cadence.

---

## 🤝 Contributing

- Fork and create a feature branch
- Follow existing code style and keep changes focused
- Add helpful comments/JSDoc where it improves clarity
- Open a PR with a clear description and screenshots/logs where relevant

Local dev:

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend preview
cd ..
node frontend/dev-server.js
open http://localhost:5174/
```

---

## 📄 License

MIT — You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of this software, provided that the copyright notice and permission notice are included in all copies.

---

## 🙌 Acknowledgements

- YouTube Live streaming docs
- FFmpeg project
- Express & Mongoose communities
- Traefik maintainers#   y t s c h  
 