const ffmpeg = require('../utils/ffmpeg');
const fs = require('fs');
const path = require('path');
const Video = require('../models/Video');
const { insertStreamEvent, updateVideoProgress, syncVideo } = require('./supabase');
const ytdl = require('ytdl-core');
let ytdlp = null;
try {
  // Optional: yt-dlp fallback for robust URL resolution
  ytdlp = require('yt-dlp-exec');
} catch (_) {}
if (!ytdlp) {
  try { ytdlp = require('youtube-dl-exec'); } catch (_) {}
}
// Runtime configuration for yt-dlp and input headers
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_PATH || '';
const YTDLP_USER_AGENT = process.env.YTDLP_USER_AGENT || 'Mozilla/5.0';
const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || '';
const YTDLP_SOURCE_ADDRESS = process.env.YTDLP_SOURCE_ADDRESS || '';
const { spawn } = require('child_process');

// Optional cookie header support for ytdl-core
let COOKIES_HEADER = '';
try {
  if (YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)) {
    const txt = fs.readFileSync(YTDLP_COOKIES, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean).filter(l => !l.startsWith('#'));
    const pairs = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6];
        if (name && value) pairs.push(`${name}=${value}`);
      }
    }
    if (pairs.length) COOKIES_HEADER = pairs.join('; ');
  }
} catch (_) {}

async function resolveViaYtdlpBin(url) {
  return new Promise((resolve) => {
    try {
      const args = ['-g', '-f', 'best[height<=1080]/best'];
      // Add cookies and UA if configured to bypass YouTube bot checks
      if (YTDLP_COOKIES) args.push('--cookies', YTDLP_COOKIES);
      if (YTDLP_USER_AGENT) args.push('--user-agent', YTDLP_USER_AGENT);
      // Quiet and tolerant
      args.push('--no-warnings', '--no-check-certificates', '-q');
      // Optional extractor args and source address
      if (YTDLP_EXTRACTOR_ARGS) args.push('--extractor-args', YTDLP_EXTRACTOR_ARGS);
      if (YTDLP_SOURCE_ADDRESS) args.push('--source-address', YTDLP_SOURCE_ADDRESS);
      // Finally, the URL
      args.push(url);
      let bin = 'yt-dlp';
      // Allow custom env override or local binary
      const envBin = process.env.YTDLP_BIN || process.env.YT_DLP_BIN;
      const localBin = path.resolve(__dirname, '../bin/yt-dlp.exe');
      if (envBin && envBin.trim()) bin = envBin.trim();
      else if (fs.existsSync(localBin)) bin = localBin;

      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => { out += String(d || ''); });
      p.on('close', (code) => {
        if (code === 0) {
          const u = out.trim().split(/\r?\n/)[0] || '';
          resolve(u || null);
        } else {
          resolve(null);
        }
      });
      p.on('error', () => resolve(null));
    } catch (_) {
      resolve(null);
    }
  });
}

function parseTimemark(t) {
  try {
    if (!t) return 0;
    const parts = String(t).split(':');
    if (parts.length === 3) {
      const h = Number(parts[0]) || 0;
      const m = Number(parts[1]) || 0;
      const s = Number(parts[2]) || 0;
      return h * 3600 + m * 60 + s;
    }
    return Number(t) || 0;
  } catch (_) {
    return 0;
  }
}

function buildOutputUrl(rtmpUrl, streamKey) {
  if (typeof rtmpUrl !== 'string' || !/^rtmps?:\/\//i.test(rtmpUrl)) {
    throw new Error('Invalid RTMP URL');
  }
  if (typeof streamKey !== 'string' || streamKey.trim().length < 8) {
    throw new Error('Invalid stream key');
  }
  return rtmpUrl.endsWith('/') ? `${rtmpUrl}${streamKey}` : `${rtmpUrl}/${streamKey}`;
}

const OUT_WIDTH = Number(process.env.STREAM_OUT_WIDTH || 1280);
const OUT_FPS = Number(process.env.STREAM_OUT_FPS || 30);
const OUT_BV = String(process.env.STREAM_OUT_BV || '2000k');
const OUT_MAXRATE = String(process.env.STREAM_OUT_MAXRATE || '2200k');
const OUT_BUFSIZE = String(process.env.STREAM_OUT_BUFSIZE || '4400k');
const OUT_TUNE = String(process.env.STREAM_OUT_TUNE || 'zerolatency');

class Streamer {
  constructor() {
    this.activeStreams = new Map(); // videoId -> { command, startedAt, progress, lastUpdateMs, stopped, outputUrl }
    this.lastStreamErrors = new Map(); // id -> last error message
    this.globalOverlay = {};
    this.globalOverlayPrev = {};
    this.overlayFiles = new Map();
    this.lastOverlays = new Map();
  }

  static hexToFFColor(hex, alpha = 1) {
    const h = String(hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    const a = Math.max(0, Math.min(1, Number(alpha || 1)));
    return `0x${h}@${a}`;
  }

  static buildNowLiveFilters(nl, files) {
    if (!nl || !nl.show) return [];
    const pos = String(nl.pos || 'tl');
    const isLeft = pos.includes('l') || pos === 'custom';
    const isTop = pos.includes('t') || pos === 'custom';
    const xExpr = isLeft ? '8' : '(w-text_w-8)';
    const yBase = Math.max(0, Number(nl.y) || 0);
    const yExpr = isTop ? `(8+${yBase})` : `(h-text_h-8-${yBase})`;
    const labelSize = Math.max(10, Number(nl.labelSize) || 18);
    const labelColor = (nl.labelColor || '#ffffff');
    const labelBg = Streamer.hexToFFColor(nl.labelBg || '#ff0000', Number(nl.labelOpa || 0.8));
    const lines = String(nl.items || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const itemSize = Math.max(10, Number(nl.itemSize) || 16);
    const itemColor = (nl.itemColor || '#ffffff');
    const itemBg = Streamer.hexToFFColor('#000000', 0.25);

    const filters = [];
    const labelFile = files && files.label ? files.label : null;
    if (labelFile) {
      filters.push(`drawtext=textfile='${labelFile}':reload=1:fontsize=${labelSize}:fontcolor=${Streamer.hexToFFColor(labelColor, 1)}:x=${xExpr}:y=${yExpr}:box=1:boxcolor=${labelBg}:boxborderw=0`);
    } else {
      filters.push(`drawtext=text='${(nl.text || 'NOW LIVE').replace(/[:\\]/g, '\\$&')}':fontsize=${labelSize}:fontcolor=${Streamer.hexToFFColor(labelColor, 1)}:x=${xExpr}:y=${yExpr}:box=1:boxcolor=${labelBg}:boxborderw=0`);
    }
    const maxItems = files && Array.isArray(files.items) ? files.items.length : lines.length;
    for (let i = 0; i < maxItems; i++) {
      const yItemExpr = isTop ? `((${yExpr})+text_h+4+${i}*(${itemSize}+6))` : `((${yExpr})-${i}*(${itemSize}+6)-(${itemSize}+6))`;
      const itemFile = files && files.items && files.items[i] ? files.items[i] : null;
      if (itemFile) {
        filters.push(`drawtext=textfile='${itemFile}':reload=1:fontsize=${itemSize}:fontcolor=${Streamer.hexToFFColor(itemColor, 1)}:x=${xExpr}:y=${yItemExpr}:box=1:boxcolor=${itemBg}:boxborderw=0`);
      } else if (i < lines.length) {
        const line = lines[i].replace(/[:\\]/g, '\\$&');
        filters.push(`drawtext=text='${line}':fontsize=${itemSize}:fontcolor=${Streamer.hexToFFColor(itemColor, 1)}:x=${xExpr}:y=${yItemExpr}:box=1:boxcolor=${itemBg}:boxborderw=0`);
      }
    }
    return filters;
  }

  static buildVfChain(baseScale, overlayConfig, files) {
    const chain = [baseScale];
    const nlFilters = Streamer.buildNowLiveFilters(overlayConfig && overlayConfig.nowLive, files && files.nowLive ? files.nowLive : files);
    chain.push(...nlFilters);
    const tkFilters = Streamer.buildTickerFilters(overlayConfig && overlayConfig.ticker, files && files.ticker ? { ticker: files.ticker } : files);
    chain.push(...tkFilters);
    return chain.join(',');
  }
  setGlobalOverlay(overlay) {
    this.globalOverlayPrev = this.globalOverlay || {};
    this.globalOverlay = overlay || {};
  }
  getGlobalOverlay() {
    return this.globalOverlay || {};
  }
  getOrCreateOverlayFiles(id, overlay) {
    const safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const baseDir = path.join(process.cwd(), 'overlay_files', safeId);
    try { fs.mkdirSync(baseDir, { recursive: true }); } catch (_) {}
    const nl = (overlay && overlay.nowLive) || {};
    const tk = (overlay && overlay.ticker) || {};
    const labelPath = path.join(baseDir, 'label.txt');
    const items = String(nl.items || '').split(/\r?\n/).map(s => s.trim());
    const maxItems = 8;
    const itemPaths = [];
    for (let i = 0; i < maxItems; i++) {
      const p = path.join(baseDir, `item_${i}.txt`);
      itemPaths.push(p);
    }
    const tickerPath = path.join(baseDir, 'ticker.txt');
    try { fs.writeFileSync(labelPath, String(nl.text || 'NOW LIVE'), 'utf8'); } catch (_) {}
    for (let i = 0; i < itemPaths.length; i++) {
      const content = items[i] || '';
      try { fs.writeFileSync(itemPaths[i], String(content), 'utf8'); } catch (_) {}
    }
    try { fs.writeFileSync(tickerPath, String(tk.text || tk.items || ''), 'utf8'); } catch (_) {}
    const norm = (p) => String(p).replace(/\\/g, '/');
    const files = { label: norm(labelPath), items: itemPaths.map(norm), nowLive: { label: norm(labelPath), items: itemPaths.map(norm) }, ticker: norm(tickerPath) };
    this.overlayFiles.set(safeId, files);
    return files;
  }
  updateOverlayForId(id, overlay) {
    const safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const files = this.overlayFiles.get(safeId) || this.getOrCreateOverlayFiles(safeId, overlay || {});
    const nl = (overlay && overlay.nowLive) || {};
    const tk = (overlay && overlay.ticker) || {};
    try { fs.writeFileSync(String(files.label).replace(/^file:/, ''), String(nl.text || ''), 'utf8'); } catch (_) {}
    const lines = String(nl.items || '').split(/\r?\n/).map(s => s.trim());
    for (let i = 0; i < (files.items || []).length; i++) {
      const content = lines[i] || '';
      const p = String(files.items[i]).replace(/^file:/, '');
      try { fs.writeFileSync(p, content, 'utf8'); } catch (_) {}
    }
    try {
      const tp = String(files.ticker || '').replace(/^file:/, '');
      if (tp) fs.writeFileSync(tp, String(tk.text || tk.items || ''), 'utf8');
    } catch (_) {}
    this.overlayFiles.set(safeId, files);
    const prev = this.lastOverlays.get(safeId) || {};
    const prevNlShow = !!(prev.nowLive && prev.nowLive.show);
    const prevTkShow = !!(prev.ticker && prev.ticker.show);
    const nextNlShow = !!(overlay && overlay.nowLive && overlay.nowLive.show);
    const nextTkShow = !!(overlay && overlay.ticker && overlay.ticker.show);
    const toggled = (prevNlShow !== nextNlShow) || (prevTkShow !== nextTkShow);
    this.lastOverlays.set(safeId, overlay || {});
    if (toggled) {
      if (safeId === 'live') {
        try { this.restartActiveExternalStreams(overlay || {}); } catch (_) {}
      } else {
        try { this.restartVideoStream(safeId); } catch (_) {}
      }
    }
    return files;
  }
  updateLiveOverlay(overlay) {
    return this.updateOverlayForId('live', overlay || {});
  }
  updateOverlayForVideo(id, overlay) {
    return this.updateOverlayForId(String(id), overlay || {});
  }
  async restartVideoStream(id) {
    const vid = String(id);
    const entry = this.activeStreams.get(vid);
    if (!entry) return false;
    try {
      entry.stopped = true;
      const cmd = entry.command;
      if (cmd && cmd.ffmpegProc && cmd.ffmpegProc.stdin) {
        try { cmd.ffmpegProc.stdin.write('q'); } catch (_) {}
      }
      try { cmd.kill('SIGINT'); } catch (_) {}
      this.activeStreams.delete(vid);
    } catch (_) {}
    try { await this.startStream(vid); } catch (_) {}
    return true;
  }
  async restartActiveExternalStreams(overlay) {
    const items = Array.from(this.activeStreams.entries());
    for (const [key, entry] of items) {
      if (!entry || !entry.external || !key.startsWith('url:')) continue;
      const out = String(entry.outputUrl || '');
      const idx = out.lastIndexOf('/');
      const base = idx > 0 ? out.substring(0, idx) : out;
      const sk = idx > 0 ? out.substring(idx + 1) : '';
      try {
        try { await this.stopExternalStream(key); } catch (_) {}
        try { await this.startUrlStream(entry.sourceUrl, { rtmpUrl: base, streamKey: sk, overlay }); } catch (_) {}
      } catch (_) {}
    }
  }
  static buildTickerFilters(tk, files) {
    const arr = [];
    const show = !!(tk && tk.show);
    if (!show) return arr;
    const speed = Math.max(10, Number(tk && tk.speed) || 80);
    const size = Math.max(12, Number(tk && tk.size) || 18);
    const color = (tk && tk.color) || '#ffffff';
    const bg = (tk && tk.bg) || '#000000';
    const opa = Math.max(0, Math.min(1, Number(tk && tk.opa) || 0.35));
    const yBase = Math.max(0, Number(tk && tk.y) || 0);
    const bandH = size + 12;
    const bandY = `(h-${bandH}-8-${yBase})`;
    arr.push(`drawbox=x=0:y=${bandY}:w=w:h=${bandH}:color=${Streamer.hexToFFColor(bg, opa)}:t=fill`);
    const tickerFile = files && (files.ticker || (files.nowLive && files.nowLive.label)) ? (files.ticker || (files.nowLive && files.nowLive.label)) : null;
    const txtOpt = tickerFile ? `textfile='${String(tickerFile).replace(/\\/g,'/')}'` : `text='${String((tk && tk.text) || '').replace(/[:\\]/g, '\\$&')}'`;
    const xExpr = `(w-mod(t*${speed},(w+text_w)))`;
    const yExpr = `(h-text_h-8-${yBase})`;
    const alphaColor = Streamer.hexToFFColor(color, show ? 1 : 0);
    arr.push(`drawtext=${txtOpt}:reload=1:fontsize=${size}:fontcolor=${alphaColor}:x=${xExpr}:y=${yExpr}:box=0`);
    if (tk && tk.showTime) {
      const timeColor = Streamer.hexToFFColor((tk.timeColor || '#000000'), 1);
      const timeBg = Streamer.hexToFFColor((tk.timeBg || '#ffff00'), 1);
      arr.push(`drawtext=expansion=strftime:text='%{localtime:%I\\:%M %p}':fontsize=${size}:fontcolor=${timeColor}:x=8:y=${yExpr}:box=1:boxcolor=${timeBg}:boxborderw=0`);
    }
    return arr;
  }

  getAllActiveStreams() {
    return Array.from(this.activeStreams.keys());
  }

  /**
   * Start an external stream directly from a source URL (YouTube supported).
   * Returns a streamId that can be used to query or stop the stream.
   */
  async startUrlStream(sourceUrl, opts = {}) {
    const url = String(sourceUrl || '').trim();
    if (!url) throw new Error('sourceUrl is required');

    const useRtmpUrl = opts.rtmpUrl;
    const useStreamKey = opts.streamKey;
    const outputUrl = buildOutputUrl(useRtmpUrl, useStreamKey);

    const isYouTube = /youtube\.com\/watch\?v=|youtu\.be\//i.test(url);
    let inputStreamOrUrl = url;
    let directResolvedUrl = null;

    if (isYouTube) {
      if (ytdlp) {
        try {
          const ytdlpOpts = {
            getUrl: true,
            format: 'best[height<=1080]/best',
            noWarnings: true,
            noCheckCertificates: true,
            quiet: true,
            userAgent: YTDLP_USER_AGENT,
          };
          if (YTDLP_COOKIES) ytdlpOpts.cookies = YTDLP_COOKIES;
          if (YTDLP_EXTRACTOR_ARGS) ytdlpOpts.extractorArgs = YTDLP_EXTRACTOR_ARGS;
          if (YTDLP_SOURCE_ADDRESS) ytdlpOpts.sourceAddress = YTDLP_SOURCE_ADDRESS;
          const out = await ytdlp(url, ytdlpOpts);
          directResolvedUrl = Array.isArray(out) ? (out[0] || '').trim() : String(out || '').trim();
        } catch (err) {
          console.warn(`[Streamer] yt-dlp resolve failed: ${err.message}`);
        }
      }
      if (!directResolvedUrl) {
        try { directResolvedUrl = await resolveViaYtdlpBin(url); } catch (_) {}
      }
      inputStreamOrUrl = directResolvedUrl || url;
    }

    const inputOpts = ['-re', '-thread_queue_size', '4096', '-user_agent', YTDLP_USER_AGENT, '-protocol_whitelist', 'file,http,https,tcp,tls', '-rw_timeout', '15000000'];
    const liveFiles = this.getOrCreateOverlayFiles('live', opts.overlay || this.getGlobalOverlay());
    const outputOpts = [
      '-preset veryfast',
      `-r ${OUT_FPS}`,
      `-b:v ${OUT_BV}`,
      `-maxrate ${OUT_MAXRATE}`,
      `-bufsize ${OUT_BUFSIZE}`,
      `-g ${OUT_FPS * 2}`,
      '-pix_fmt yuv420p',
      `-tune ${OUT_TUNE}`,
      '-profile:v high',
      '-level 4.1',
      '-flvflags no_duration_filesize',
      '-max_muxing_queue_size 1024',
      '-rtmp_live live',
      `-vf ${Streamer.buildVfChain(`scale=${OUT_WIDTH}:-2:force_original_aspect_ratio=decrease`, opts.overlay || this.getGlobalOverlay(), liveFiles)}`,
    ];

    const streamId = `url:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const makeInput = () => {
      if (directResolvedUrl && typeof directResolvedUrl === 'string') return directResolvedUrl;
      if (isYouTube) {
        try {
          return ytdl(url, {
            quality: 'highest',
            filter: 'audioandvideo',
            highWaterMark: 1 << 25,
            requestOptions: {
              maxRetries: 3,
              maxReconnects: 2,
              headers: {
                'user-agent': YTDLP_USER_AGENT,
                'referer': 'https://www.youtube.com',
                'origin': 'https://www.youtube.com',
                ...(COOKIES_HEADER ? { 'cookie': COOKIES_HEADER } : {}),
              },
            },
          });
        } catch (_) {
          return url;
        }
      }
      return inputStreamOrUrl;
    };

    let attemptedTlsFallback = false;
    let attemptedInputRefresh = false;

    return new Promise((resolve, reject) => {
      let currentOutputUrl = outputUrl;
      let command = null;

      const startWithOutput = (outUrl) => {
        currentOutputUrl = outUrl;
        try {
          const inputVal = makeInput();
          const extraInputOpts = [];
          if (typeof inputVal === 'string' && /^https?:\/\//i.test(inputVal)) {
            extraInputOpts.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '2');
            try {
              const headers = [];
              if (/youtube\.com|youtu\.be/i.test(url)) {
                headers.push('Referer: https://www.youtube.com');
                headers.push('Origin: https://www.youtube.com');
                if (COOKIES_HEADER) headers.push(`Cookie: ${COOKIES_HEADER}`);
              }
              if (headers.length) extraInputOpts.push('-headers', headers.join('\r\n'));
            } catch (_) {}
          }

      command = ffmpeg(inputVal)
        .inputOptions([...inputOpts, ...extraInputOpts])
        .outputOptions(outputOpts)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .format('flv')
        .output(outUrl);

          command
            .on('start', async (cmdLine) => {
              try {
                console.log(`[Streamer] FFmpeg started for external ${streamId}: ${cmdLine}`);
                this.lastStreamErrors.delete(streamId);
                this.activeStreams.set(streamId, {
                  command,
                  startedAt: new Date(),
                  progress: 0,
                  lastUpdateMs: Date.now(),
                  stopped: false,
                  outputUrl: outUrl,
                  external: true,
                  sourceUrl: url,
                });
                resolve({ streamId, command });
              } catch (err) { reject(err); }
            })
            .on('progress', async (progress) => {
              try {
                const entry = this.activeStreams.get(streamId);
                if (!entry) return;
                const now = Date.now();
                const seconds = parseTimemark(progress.timemark);
                if (seconds !== entry.progress || now - (entry.lastUpdateMs || 0) > 1000) {
                  entry.progress = seconds;
                  entry.lastUpdateMs = now;
                }
              } catch (err) {
                console.warn(`[Streamer] External progress update failed for ${streamId}: ${err.message}`);
              }
            })
            .on('stderr', (line) => {
              if (line && /Error|Invalid|failed/i.test(line)) {
                console.warn(`[Streamer][${streamId}] ffmpeg: ${line.trim()}`);
              }
            })
            .on('end', async () => {
              try {
                this.activeStreams.delete(streamId);
                console.log(`[Streamer] External stream finished (${streamId}).`);
              } catch (err) {
                console.error(`[Streamer] External end handler error for ${streamId}: ${err.message}`);
              }
            })
            .on('error', async (err) => {
              try {
                console.error(`[Streamer] FFmpeg error for external ${streamId}: ${err.message}`);
                const msg = err && err.message ? err.message : 'Unknown streaming error';
                const isRtmp = /^rtmp:\/\//i.test(currentOutputUrl);
                const isRtmps = /^rtmps:\/\//i.test(currentOutputUrl);
                const looksHandshake = /Error opening output file|I\/O error|Connection refused|Protocol not found|TLS|handshake|403|Invalid argument/i.test(msg);
                if (isRtmp && !attemptedTlsFallback && looksHandshake) {
                  attemptedTlsFallback = true;
                  const tlsUrl = currentOutputUrl.replace(/^rtmp:\/\//i, 'rtmps://');
                  console.warn(`[Streamer] Attempting RTMPS fallback for ${streamId}: ${tlsUrl}`);
                  try {
                    try { if (command) command.kill('SIGINT'); } catch (_) {}
                    return startWithOutput(tlsUrl);
                  } catch (fallbackErr) {
                    console.error(`[Streamer] RTMPS fallback failed for ${streamId}: ${fallbackErr.message}`);
                  }
                }
                if (isRtmps && looksHandshake) {
                  const plainUrl = currentOutputUrl.replace(/^rtmps:\/\//i, 'rtmp://');
                  console.warn(`[Streamer] Attempting RTMP fallback for ${streamId}: ${plainUrl}`);
                  try {
                    try { if (command) command.kill('SIGINT'); } catch (_) {}
                    return startWithOutput(plainUrl);
                  } catch (fallbackErr2) {
                    console.error(`[Streamer] RTMP fallback failed for ${streamId}: ${fallbackErr2.message}`);
                  }
                }
                const looksExpired = /(410|Gone|HTTP 410|403|Forbidden|signature).*?/i.test(msg);
                if (isYouTube && !attemptedInputRefresh && looksExpired) {
                  attemptedInputRefresh = true;
                  console.warn(`[Streamer] Attempting YouTube input refresh for ${streamId} due to ${msg}`);
                  try {
                    let newDirect = null;
                    if (ytdlp) {
                      try {
                        const ytdlpOpts2 = {
                          getUrl: true,
                          format: 'best[height<=1080]/best',
                          noWarnings: true,
                          noCheckCertificates: true,
                          quiet: true,
                          userAgent: YTDLP_USER_AGENT,
                        };
                        if (YTDLP_COOKIES) ytdlpOpts2.cookies = YTDLP_COOKIES;
                        if (YTDLP_EXTRACTOR_ARGS) ytdlpOpts2.extractorArgs = YTDLP_EXTRACTOR_ARGS;
                        if (YTDLP_SOURCE_ADDRESS) ytdlpOpts2.sourceAddress = YTDLP_SOURCE_ADDRESS;
                        const out = await ytdlp(url, ytdlpOpts2);
                        newDirect = Array.isArray(out) ? (out[0] || '').trim() : String(out || '').trim();
                      } catch (_) {}
                    }
                    if (!newDirect) { try { newDirect = await resolveViaYtdlpBin(url); } catch (_) {} }
                    if (!newDirect) { try { newDirect = null; } catch (_) {} }
                    directResolvedUrl = newDirect;
                    try { if (command) command.kill('SIGINT'); } catch (_) {}
                    console.warn(`[Streamer] Restarting external ${streamId} with refreshed input`);
                    return startWithOutput(currentOutputUrl);
                  } catch (refreshErr) {
                    console.error(`[Streamer] Input refresh failed for ${streamId}: ${refreshErr.message}`);
                  }
                }
                this.lastStreamErrors.set(streamId, msg);
                this.activeStreams.delete(streamId);
              } catch (_) {}
            });

          command.run();
        } catch (startErr) { reject(startErr); }
      };

      startWithOutput(outputUrl);
    });
  }

  async stopExternalStream(streamId) {
    const id = String(streamId);
    const entry = this.activeStreams.get(id);
    if (!entry) return false;
    try {
      entry.stopped = true;
      const cmd = entry.command;
      if (cmd && cmd.ffmpegProc && cmd.ffmpegProc.stdin) {
        try { cmd.ffmpegProc.stdin.write('q'); } catch (_) {}
      }
      try { cmd.kill('SIGINT'); } catch (_) {}
      this.activeStreams.delete(id);
      console.log(`[Streamer] Stopped external stream ${id}.`);
      return true;
    } catch (err) {
      console.error(`[Streamer] Failed to stop external ${id}: ${err.message}`);
      return false;
    }
  }

  getStreamStatus(videoId) {
    const entry = this.activeStreams.get(String(videoId));
    if (!entry) {
      const err = this.lastStreamErrors.get(String(videoId));
      return { active: false, error: err };
    }
    return {
      active: true,
      videoId: String(videoId),
      outputUrl: entry.outputUrl,
      startedAt: entry.startedAt,
      progress: entry.progress || 0,
      stopped: !!entry.stopped,
    };
  }

  async startStream(videoId, opts = {}) {
    const id = String(videoId);
    if (this.activeStreams.has(id)) {
      throw new Error(`Stream already active for video ${id}`);
    }

    const video = await Video.findById(id);
    if (!video) throw new Error('Video not found');

    if (!video.filepath || !fs.existsSync(path.resolve(video.filepath))) {
      throw new Error('Video file not found on disk');
    }

    const useRtmpUrl = opts.rtmpUrl || video.rtmpUrl;
    const useStreamKey = opts.streamKey || video.streamKey;
    const outputUrl = buildOutputUrl(useRtmpUrl, useStreamKey);

    const shouldLoop = !!(video.loop && !opts.playlistId && !opts.disableLoop);
    const inputOpts = ['-re'];
    if (shouldLoop) {
      // Loop input indefinitely; stream will only stop via stopTime or manual stop
      inputOpts.push('-stream_loop', '-1');
    }
    // Ensure scheduleTime exists when transitioning to streaming from library (Instant Live)
    if (!video.scheduleTime) {
      try { await Video.findByIdAndUpdate(id, { scheduleTime: new Date() }).exec(); } catch (_) {}
      video.scheduleTime = new Date();
    }

    const ovFiles = this.getOrCreateOverlayFiles(id, video.overlayConfig || {})
    let currentOutputUrl = outputUrl;
    let command = null;
    let attemptedTlsDowngrade = false;

    return new Promise((resolve, reject) => {
      const startWithOutput = (outUrl) => {
        currentOutputUrl = outUrl;
        try {
          command = ffmpeg(path.resolve(video.filepath))
            .inputOptions(inputOpts)
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate('128k')
            .outputOptions([
              '-preset veryfast',
              `-r ${OUT_FPS}`,
              `-b:v ${OUT_BV}`,
              `-maxrate ${OUT_MAXRATE}`,
              `-bufsize ${OUT_BUFSIZE}`,
              `-g ${OUT_FPS * 2}`,
              '-pix_fmt yuv420p',
              `-tune ${OUT_TUNE}`,
              '-profile:v high',
              '-level 4.1',
              '-flvflags no_duration_filesize',
              '-max_muxing_queue_size 1024',
              '-rtmp_live live',
              `-vf ${Streamer.buildVfChain(`scale=${OUT_WIDTH}:-2:force_original_aspect_ratio=decrease`, video.overlayConfig || {}, ovFiles)}`,
            ])
            .format('flv')
            .output(outUrl);

          command
            .on('start', async (cmdLine) => {
              try {
                console.log(`[Streamer] FFmpeg started for video ${id}: ${cmdLine}`);
                video.status = 'streaming';
                video.streamStartedAt = new Date();
                try { video.streamEndedAt = null; } catch (_) {}
                video.progress = 0;
                video.usedRtmpUrl = useRtmpUrl;
                video.usedStreamKey = useStreamKey;
                video.lastOutputUrl = outUrl;
                await video.save();
                try { await insertStreamEvent(id, 'start', { outputUrl: outUrl }); } catch (_) {}
                try { await syncVideo(video); } catch (_) {}

                const entry = {
                  command,
                  startedAt: new Date(),
                  progress: 0,
                  lastUpdateMs: Date.now(),
                  stopped: false,
                  outputUrl: outUrl,
                };
                this.activeStreams.set(id, entry);
                resolve(command);
              } catch (err) {
                reject(err);
              }
            })
            .on('progress', async (progress) => {
              try {
                const entry = this.activeStreams.get(id);
                if (!entry) return;
                const now = Date.now();
                const seconds = parseTimemark(progress.timemark);
                let pct = undefined;
                if (typeof video.duration === 'number' && video.duration > 0) {
                  pct = Math.min(100, Math.floor((seconds / video.duration) * 100));
                }
                if (typeof pct === 'number') {
                  if (pct !== entry.progress || now - (entry.lastUpdateMs || 0) > 1000) {
                    entry.progress = pct;
                    entry.lastUpdateMs = now;
                    await Video.findByIdAndUpdate(id, { progress: pct }).exec();
                    try { await updateVideoProgress(id, pct); } catch (_) {}
                  }
                }
              } catch (err) {
                console.warn(`[Streamer] Progress update failed for ${id}: ${err.message}`);
              }
            })
            .on('stderr', (line) => {
              if (line && /Error|Invalid|failed/i.test(line)) {
                console.warn(`[Streamer][${id}] ffmpeg: ${line.trim()}`);
              }
            })
            .on('end', async () => {
              try {
                const entry = this.activeStreams.get(id);
                this.activeStreams.delete(id);
                const exists = await Video.exists({ _id: id });
                if (!exists) {
                  console.log(`[Streamer] Video ${id} no longer exists; skipping end-state save.`);
                  return;
                }
                if (entry && entry.stopped) {
                  video.status = 'cancelled';
                } else {
                  video.status = 'completed';
                  video.progress = 100;
                }
                video.streamEndedAt = new Date();
                if (video.status === 'completed' && video.repeatDaily) {
                  const prevStart = video.scheduleTime ? new Date(video.scheduleTime) : new Date();
                  const prevStop = video.stopTime ? new Date(video.stopTime) : null;
                  const nextStart = new Date(prevStart);
                  nextStart.setDate(nextStart.getDate() + 1);
                  let nextStop = null;
                  if (prevStop && prevStart) {
                    const deltaMs = prevStop.getTime() - prevStart.getTime();
                    nextStop = new Date(nextStart.getTime() + Math.max(0, deltaMs));
                  }
                  video.status = 'scheduled';
                  video.scheduleTime = nextStart;
                  if (nextStop) video.stopTime = nextStop;
                  video.progress = 0;
                }
                await video.save();
                try { await insertStreamEvent(id, 'end', { progress: video.progress, outputUrl: video.lastOutputUrl }); } catch (_) {}
                try { await syncVideo(video); } catch (_) {}
                console.log(`[Streamer] Stream finished for video ${id} (${video.status}).`);
              } catch (err) {
                console.error(`[Streamer] End handler error for ${id}: ${err.message}`);
              }
            })
            .on('error', async (err, _stdout, _stderr) => {
              try {
                const msg = err && err.message ? err.message : 'Unknown streaming error';
                const isRtmps = /^rtmps:\/\//i.test(currentOutputUrl);
                const looksHandshake = /TLS|handshake|Protocol not found|I\/O error|Connection refused|Invalid argument/i.test(msg);
                if (isRtmps && !attemptedTlsDowngrade && looksHandshake) {
                  attemptedTlsDowngrade = true;
                  const plainUrl = currentOutputUrl.replace(/^rtmps:\/\//i, 'rtmp://');
                  console.warn(`[Streamer] Attempting RTMP fallback for ${id}: ${plainUrl}`);
                  try { if (command) command.kill('SIGINT'); } catch (_) {}
                  return startWithOutput(plainUrl);
                }
                console.error(`[Streamer] FFmpeg error for video ${id}: ${err.message}`);
                this.activeStreams.delete(id);
                const exists = await Video.exists({ _id: id });
                if (exists) {
                  video.status = 'failed';
                  video.errorMessage = err.message || 'Streaming failed';
                  video.streamEndedAt = new Date();
                  await video.save();
                  try { await insertStreamEvent(id, 'error', { message: video.errorMessage }); } catch (_) {}
                  try { await syncVideo(video); } catch (_) {}
                } else {
                  console.log(`[Streamer] Video ${id} no longer exists; skipping error-state save.`);
                }
              } catch (saveErr) {
                console.error(`[Streamer] Failed to persist error for ${id}: ${saveErr.message}`);
              }
            });

          try {
            command.run();
          } catch (runErr) {
            reject(runErr);
          }
        } catch (startErr) {
          reject(startErr);
        }
      };

      startWithOutput(outputUrl);
    });
  }

  async stopStream(videoId) {
    const id = String(videoId);
    const entry = this.activeStreams.get(id);
    if (!entry) return false;

    try {
      entry.stopped = true;
      const cmd = entry.command;
      // Try graceful quit: send 'q' to ffmpeg stdin; fallback to SIGINT
      if (cmd && cmd.ffmpegProc && cmd.ffmpegProc.stdin) {
        try {
          cmd.ffmpegProc.stdin.write('q');
        } catch (_) {}
      }
      try {
        cmd.kill('SIGINT');
      } catch (_) {}

      // Persist cancelled state immediately
      await Video.findByIdAndUpdate(id, { status: 'cancelled', streamEndedAt: new Date() }).exec();
      try { await insertStreamEvent(id, 'stop'); } catch (_) {}
      this.activeStreams.delete(id);
      console.log(`[Streamer] Stopped stream for video ${id}.`);
      return true;
    } catch (err) {
      console.error(`[Streamer] Failed to stop stream for ${id}: ${err.message}`);
      return false;
    }
  }
}

module.exports = new Streamer();
