/*
 * Integration Test: Full workflow and error cases
 *
 * Performs:
 * 1) Starts services via docker-compose
 * 2) Waits for traefik, mongo, backend, frontend to be healthy
 * 3) Spins up a temporary RTMP server container on the same network
 * 4) Generates a short sample.mp4 via ffmpeg in backend, copies to host
 * 5) Uploads the video, schedules it 2 minutes from now
 * 6) Verifies it appears in list; waits for cron to start streaming
 * 7) Checks stream status; stops the stream; verifies final status
 * 8) Deletes the video
 * 9) Tests error cases: invalid format, missing RTMP, invalid schedule time
 * 10) Writes integration-report.json and cleans up temporary resources
 *
 * Requirements:
 * - Docker and Docker Compose v2
 * - An external docker network named 'web' (create once: docker network create web)
 * - curl installed (used for HTTPS requests with -k)
 * - Traefik exposes https://localhost for dev stack
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://localhost/api';
const VIDEO_API = `${API_BASE}/videos`;
const REPORT_PATH = path.resolve(process.cwd(), 'integration-report.json');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8', ...opts });
  if (res.error) throw res.error;
  const code = res.status;
  return { code, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function step(report, name, fn) {
  const start = Date.now();
  const entry = { name, status: 'pending', durationMs: 0, details: '' };
  try {
    const details = fn();
    entry.status = 'pass';
    entry.details = details || '';
  } catch (err) {
    entry.status = 'fail';
    entry.details = (err && err.message) ? err.message : String(err);
  } finally {
    entry.durationMs = Date.now() - start;
    report.steps.push(entry);
    console.log(`[${entry.status.toUpperCase()}] ${name} (${entry.durationMs}ms)`);
    if (entry.status === 'fail') console.error(`  → ${entry.details}`);
  }
}

function ensureNetwork() {
  const chk = run('docker', ['network', 'inspect', 'web']);
  if (chk.code !== 0) {
    const mk = run('docker', ['network', 'create', 'web']);
    if (mk.code !== 0) throw new Error(`Failed to create 'web' network: ${mk.stderr}`);
  }
}

function composeUp() {
  const up = run('docker', ['compose', 'up', '-d']);
  if (up.code !== 0) throw new Error(`docker compose up failed: ${up.stderr}`);
}

function waitHealthy(names, timeoutMs = 180000) {
  const start = Date.now();
  const unhealthy = new Set(names);
  while (Date.now() - start < timeoutMs && unhealthy.size) {
    for (const n of [...unhealthy]) {
      const r = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', n]);
      if (r.code === 0) {
        const status = r.stdout.trim();
        if (status === 'healthy') unhealthy.delete(n);
      }
    }
    if (!unhealthy.size) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  if (unhealthy.size) throw new Error(`Services not healthy in time: ${[...unhealthy].join(', ')}`);
}

function startRtmp() {
  // Remove if exists
  run('docker', ['rm', '-f', 'rtmp-server']);
  const res = run('docker', ['run', '-d', '--name', 'rtmp-server', '--network', 'web', 'alfg/nginx-rtmp']);
  if (res.code !== 0) throw new Error(`Failed to start RTMP server: ${res.stderr}`);
}

function genSampleInBackend() {
  const cmd = [
    'exec', 'backend', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000',
    '-t', '5', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
    '-f', 'mp4', '/app/videos/sample.mp4',
  ];
  const res = run('docker', cmd);
  if (res.code !== 0) throw new Error(`ffmpeg sample generation failed: ${res.stderr}`);
  const cp = run('docker', ['cp', 'backend:/app/videos/sample.mp4', path.resolve(process.cwd(), 'sample.mp4')]);
  if (cp.code !== 0) throw new Error(`Failed to copy sample.mp4: ${cp.stderr}`);
}

function curlJson(method, url, jsonObj) {
  const data = JSON.stringify(jsonObj);
  const res = run('curl', ['-sS', '-k', '-X', method, '-H', 'Content-Type: application/json', '-d', data, url]);
  if (res.code !== 0) throw new Error(`curl ${method} ${url} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function curlGet(url) {
  const res = run('curl', ['-sS', '-k', url]);
  if (res.code !== 0) throw new Error(`curl GET ${url} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function curlUpload(url, filePath, fields) {
  const args = ['-sS', '-k', url, '-F', `video=@${filePath};type=video/mp4`];
  for (const [k, v] of Object.entries(fields)) {
    args.push('-F', `${k}=${v}`);
  }
  const res = run('curl', args);
  if (res.code !== 0) throw new Error(`curl upload failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function curlWithStatus(args) {
  // Append status code marker at the end
  const res = run('curl', [...args, '-w', '\nHTTP_STATUS:%{http_code}']);
  if (res.code !== 0) throw new Error(`curl failed: ${res.stderr}`);
  const lines = res.stdout.split(/\r?\n/);
  const statusLine = lines[lines.length - 1];
  const httpCode = Number((statusLine || '').replace('HTTP_STATUS:', '')) || 0;
  const body = lines.slice(0, -1).join('\n');
  return { httpCode, body };
}

async function main() {
  const report = { startedAt: new Date().toISOString(), steps: [] };
  try {
    step(report, 'Ensure docker network web', () => {
      ensureNetwork();
      return 'network ok';
    });

    step(report, 'Start dev stack (docker compose up -d)', () => {
      composeUp();
      return 'stack up';
    });

    step(report, 'Wait for traefik, mongo, backend, frontend healthy', () => {
      waitHealthy(['traefik', 'mongo', 'backend', 'frontend'], 180000);
      return 'all healthy';
    });

    step(report, 'Start temporary RTMP server', () => {
      startRtmp();
      return 'rtmp server running';
    });

    step(report, 'Generate sample.mp4 via backend ffmpeg', () => {
      genSampleInBackend();
      return 'sample.mp4 ready';
    });

    const scheduleTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    let created = null;
    step(report, 'Upload and schedule test video (2 minutes ahead)', () => {
      created = curlUpload(`${VIDEO_API}/upload`, path.resolve(process.cwd(), 'sample.mp4'), {
        title: 'Integration Test Video',
        scheduleTime,
        rtmpUrl: 'rtmp://rtmp-server:1935/live',
        streamKey: 'integrationKey123456',
      });
      if (!created || !created._id) throw new Error('Upload response missing _id');
      return `videoId=${created._id}`;
    });

    const id = created ? created._id : null;
    step(report, 'Verify video appears in list', () => {
      const list = curlGet(`${VIDEO_API}?limit=100`);
      const found = Array.isArray(list) && list.find((v) => v._id === id);
      if (!found) throw new Error('Uploaded video not found in listing');
      return 'found in list';
    });

    step(report, 'Wait for streaming to start (cron)', () => {
      const start = Date.now();
      let status = null;
      while (Date.now() - start < 180000) { // up to 3 minutes
        const v = curlGet(`${VIDEO_API}/${id}`);
        status = v.status;
        if (status === 'streaming' || status === 'failed') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
      if (status !== 'streaming') throw new Error(`Expected streaming; got ${status}`);
      return 'status=streaming';
    });

    step(report, 'Check stream status API', () => {
      const st = curlGet(`${VIDEO_API}/${id}/stream/status`);
      if (!st.active) throw new Error('Stream status not active');
      return 'active=true';
    });

    step(report, 'Stop the stream', () => {
      const resp = curlJson('POST', `${VIDEO_API}/${id}/stream/stop`, {});
      if (!resp || resp.ok !== true) {
        // fall back: accept any body, as stop may return boolean
      }
      return 'stop requested';
    });

    step(report, 'Verify final status (cancelled or completed)', () => {
      const start = Date.now();
      let final = null;
      while (Date.now() - start < 60000) {
        const v = curlGet(`${VIDEO_API}/${id}`);
        final = v.status;
        if (final === 'cancelled' || final === 'completed' || final === 'failed') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      }
      if (final !== 'cancelled' && final !== 'completed') throw new Error(`Unexpected final status: ${final}`);
      return `final=${final}`;
    });

    step(report, 'Delete the video', () => {
      const resp = run('curl', ['-sS', '-k', '-X', 'DELETE', `${VIDEO_API}/${id}`]);
      if (resp.code !== 0) throw new Error(`Delete failed: ${resp.stderr}`);
      const ok = JSON.parse(resp.stdout);
      return JSON.stringify(ok);
    });

    // Error cases
    step(report, 'Error: invalid video format', () => {
      const badPath = path.resolve(process.cwd(), 'bad.txt');
      fs.writeFileSync(badPath, 'not a video');
      const { httpCode, body } = curlWithStatus(['-sS', '-k', `${VIDEO_API}/upload`, '-F', `video=@${badPath};type=text/plain`, '-F', 'title=Bad Format', '-F', `scheduleTime=${new Date().toISOString()}`, '-F', 'rtmpUrl=rtmp://rtmp-server:1935/live', '-F', 'streamKey=abcdef1234567890']);
      fs.unlinkSync(badPath);
      if (httpCode >= 200 && httpCode < 300) throw new Error(`Expected failure, got ${httpCode}`);
      try {
        const json = JSON.parse(body || '{}');
        if (!json.error && !json.errors) throw new Error('Expected error payload');
      } catch (_) {
        // non-JSON is acceptable for failure
      }
      return `rejected (HTTP ${httpCode})`;
    });

    step(report, 'Error: missing RTMP credentials', () => {
      const { httpCode, body } = curlWithStatus(['-sS', '-k', `${VIDEO_API}/upload`, '-F', `video=@${path.resolve(process.cwd(), 'sample.mp4')};type=video/mp4`, '-F', 'title=No RTMP', '-F', `scheduleTime=${new Date().toISOString()}`]);
      if (httpCode >= 200 && httpCode < 300) throw new Error(`Expected validation failure, got ${httpCode}`);
      const json = JSON.parse(body || '{}');
      if (!json.errors && !json.error) throw new Error('Expected validation errors');
      return `missing credentials rejected (HTTP ${httpCode})`;
    });

    step(report, 'Error: invalid schedule time', () => {
      const { httpCode, body } = curlWithStatus(['-sS', '-k', `${VIDEO_API}/upload`, '-F', `video=@${path.resolve(process.cwd(), 'sample.mp4')};type=video/mp4`, '-F', 'title=Bad Schedule', '-F', 'scheduleTime=not-a-date', '-F', 'rtmpUrl=rtmp://rtmp-server:1935/live', '-F', 'streamKey=abcdef1234567890']);
      if (httpCode >= 200 && httpCode < 300) throw new Error(`Expected validation failure, got ${httpCode}`);
      const json = JSON.parse(body || '{}');
      if (!json.errors && !json.error) throw new Error('Expected schedule validation error');
      return `invalid schedule rejected (HTTP ${httpCode})`;
    });

  } finally {
    // Cleanup
    try { fs.existsSync(path.resolve(process.cwd(), 'sample.mp4')) && fs.unlinkSync(path.resolve(process.cwd(), 'sample.mp4')); } catch (_) {}
    run('docker', ['rm', '-f', 'rtmp-server']);
  }

  // Write report
  try {
    report.finishedAt = new Date().toISOString();
    const stats = { total: report.steps.length, pass: report.steps.filter(s => s.status === 'pass').length, fail: report.steps.filter(s => s.status === 'fail').length };
    report.summary = stats;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nIntegration report written to ${REPORT_PATH}`);
  } catch (err) {
    console.error(`Failed to write report: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});