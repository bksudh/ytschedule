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

class Streamer {
  constructor() {
    this.activeStreams = new Map(); // videoId -> { command, startedAt, progress, lastUpdateMs, stopped, outputUrl }
    this.lastStreamErrors = new Map(); // id -> last error message
    this.globalOverlay = {};
  }

  static hexToFFColor(hex, alpha = 1) {
    const h = String(hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    const a = Math.max(0, Math.min(1, Number(alpha || 1)));
    return `0x${h}@${a}`;
  }

  static buildNowLiveFilters(nl) {
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
    const tryFonts = [
      'C:/Windows/Fonts/segoeui.ttf',
      'C:/Windows/Fonts/arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/Library/Fonts/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
    ];
    let fontFile = null;
    try {
      for (const p of tryFonts) {
        if (fs.existsSync(p)) { fontFile = p.replace(/\\/g, '/'); break; }
      }
    } catch (_) {}
    const fontOpt = fontFile ? `:fontfile='${fontFile}'` : '';

    const filters = [];
    // Label with auto box
    filters.push(`drawtext=text='${(nl.text || 'NOW LIVE').replace(/[:\\]/g, '\\$&')}':fontsize=${labelSize}:fontcolor=${Streamer.hexToFFColor(labelColor, 1)}:x=${xExpr}:y=${yExpr}:box=1:boxcolor=${labelBg}:boxborderw=0${fontOpt}`);
    // Items stacked below/above
    let gap = 2;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/[:\\]/g, '\\$&');
      const yItemExpr = isTop ? `((${yExpr})+text_h+4+${i}*(${itemSize}+6))` : `((${yExpr})-${i}*(${itemSize}+6)-(${itemSize}+6))`;
      filters.push(`drawtext=text='${line}':fontsize=${itemSize}:fontcolor=${Streamer.hexToFFColor(itemColor, 1)}:x=${xExpr}:y=${yItemExpr}:box=1:boxcolor=${itemBg}:boxborderw=0${fontOpt}`);
    }
    return filters;
  }

  static buildVfChain(baseScale, overlayConfig) {
    const chain = [baseScale];
    const nlFilters = Streamer.buildNowLiveFilters(overlayConfig && overlayConfig.nowLive);
    chain.push(...nlFilters);
    return chain.join(',');
  }
  setGlobalOverlay(overlay) {
    this.globalOverlay = overlay || {};
  }
  getGlobalOverlay() {
    return this.globalOverlay || {};
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
    const outputOpts = [
      '-preset veryfast',
      '-maxrate 3000k',
      '-bufsize 6000k',
      '-g 60',
      '-pix_fmt yuv420p',
      `-vf ${Streamer.buildVfChain('scale=1920:-2:force_original_aspect_ratio=decrease', opts.overlay || this.getGlobalOverlay())}`,
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
                const looksHandshake = /Error opening output file|I\/O error|Connection refused|Protocol not found|TLS|handshake|403/i.test(msg);
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

    const command = ffmpeg(path.resolve(video.filepath))
      .inputOptions(inputOpts)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-preset veryfast',
        '-maxrate 3000k',
        '-bufsize 6000k',
        '-g 60',
        '-pix_fmt yuv420p',
        // Scale + overlay chain
        `-vf ${Streamer.buildVfChain('scale=1920:-2:force_original_aspect_ratio=decrease', video.overlayConfig || {})}`,
      ])
      .format('flv')
      .output(outputUrl);

    return new Promise((resolve, reject) => {
      command
        .on('start', async (cmdLine) => {
          try {
            console.log(`[Streamer] FFmpeg started for video ${id}: ${cmdLine}`);
            video.status = 'streaming';
            video.streamStartedAt = new Date();
            try { video.streamEndedAt = null; } catch (_) {}
            video.progress = 0;
            // Persist actual RTMP details used for this run
            video.usedRtmpUrl = useRtmpUrl;
            video.usedStreamKey = useStreamKey;
            video.lastOutputUrl = outputUrl;
            await video.save();
            try { await insertStreamEvent(id, 'start', { outputUrl }); } catch (_) {}
            try { await syncVideo(video); } catch (_) {}

            const entry = {
              command,
              startedAt: new Date(),
              progress: 0,
              lastUpdateMs: Date.now(),
              stopped: false,
              outputUrl,
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
              // Rate-limit DB writes to ~1s or when percentage increases.
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
          // Optional: log ffmpeg internal lines for diagnostics
          if (line && /Error|Invalid|failed/i.test(line)) {
            console.warn(`[Streamer][${id}] ffmpeg: ${line.trim()}`);
          }
        })
        .on('end', async () => {
          try {
            const entry = this.activeStreams.get(id);
            this.activeStreams.delete(id);
            // Verify document still exists before saving
            const exists = await Video.exists({ _id: id });
            if (!exists) {
              console.log(`[Streamer] Video ${id} no longer exists; skipping end-state save.`);
              return;
            }
            // If stopStream was called, prefer cancelled status.
            if (entry && entry.stopped) {
              video.status = 'cancelled';
            } else {
              video.status = 'completed';
              video.progress = 100;
            }
            video.streamEndedAt = new Date();
            // lastOutputUrl etc already set on start; keep as-is for audit
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
            console.error(`[Streamer] FFmpeg error for video ${id}: ${err.message}`);
            this.activeStreams.delete(id);
            // Verify document still exists before saving
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
          // Reject only if startup failed; if error after start, the promise has resolved already.
          // For completeness, we do not re-reject here.
        });

      // Run the command
      try {
        command.run();
      } catch (runErr) {
        reject(runErr);
      }
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
