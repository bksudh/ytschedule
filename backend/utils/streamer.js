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
const { spawn } = require('child_process');

async function resolveViaYtdlpBin(url) {
  return new Promise((resolve) => {
    try {
      const args = ['-g', '-f', 'best[height<=1080]/best', url];
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

    // Basic YouTube URL detection; fall back to letting ffmpeg fetch http(s) URLs directly
    const isYouTube = /youtube\.com\/watch\?v=|youtu\.be\//i.test(url);

    let inputStreamOrUrl = url;
    let useInputFormat = undefined;
    if (isYouTube) {
      // Try to resolve a direct media URL via yt-dlp first (most robust)
      let directUrl = null;
      if (ytdlp) {
        try {
          const out = await ytdlp(url, { getUrl: true, format: 'best[height<=1080]/best', noWarnings: true, noCheckCertificates: true, quiet: true });
          directUrl = Array.isArray(out) ? (out[0] || '').trim() : String(out || '').trim();
        } catch (err) {
          console.warn(`[Streamer] yt-dlp resolve failed: ${err.message}`);
        }
      }
      if (!directUrl) {
        try {
          directUrl = await resolveViaYtdlpBin(url);
        } catch (_) {}
      }

      if (directUrl) {
        inputStreamOrUrl = directUrl;
        useInputFormat = undefined; // ffmpeg will auto-detect container
      } else {
        // Fallback to ytdl-core stream
        try {
          inputStreamOrUrl = ytdl(url, { quality: 'highest', filter: 'audioandvideo', highWaterMark: 1 << 25 });
          useInputFormat = undefined; // do not force container
        } catch (err) {
          throw new Error(`Failed to initialize YouTube download: ${err.message}`);
        }
      }
    }

    const inputOpts = ['-re', '-thread_queue_size', '4096', '-user_agent', 'Mozilla/5.0'];
    const outputOpts = [
      '-preset veryfast',
      '-maxrate 3000k',
      '-bufsize 6000k',
      '-g 60',
      '-pix_fmt yuv420p',
      '-vf scale=1920:-2:force_original_aspect_ratio=decrease',
    ];

    // Generate an external stream id
    const streamId = `url:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const command = (typeof inputStreamOrUrl === 'string' ? ffmpeg(inputStreamOrUrl) : ffmpeg(inputStreamOrUrl))
      .inputOptions(inputOpts)
      .outputOptions(outputOpts)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .format('flv')
      .output(outputUrl);

    // Avoid forcing inputFormat; ffmpeg will detect stream container

    return new Promise((resolve, reject) => {
      command
        .on('start', async (cmdLine) => {
          try {
            console.log(`[Streamer] FFmpeg started for external ${streamId}: ${cmdLine}`);
            this.lastStreamErrors.delete(streamId);
            const entry = {
              command,
              startedAt: new Date(),
              progress: 0,
              lastUpdateMs: Date.now(),
              stopped: false,
              outputUrl,
              external: true,
              sourceUrl: url,
            };
            this.activeStreams.set(streamId, entry);
            resolve({ streamId, command });
          } catch (err) {
            reject(err);
          }
        })
        .on('progress', async (progress) => {
          try {
            const entry = this.activeStreams.get(streamId);
            if (!entry) return;
            const now = Date.now();
            const seconds = parseTimemark(progress.timemark);
            // Just store seconds observed as numeric progress for external streams
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
        .on('error', async (err, _stdout, _stderr) => {
          try {
            console.error(`[Streamer] FFmpeg error for external ${streamId}: ${err.message}`);
            this.lastStreamErrors.set(streamId, err && err.message ? err.message : 'Unknown streaming error');
            this.activeStreams.delete(streamId);
          } catch (_) {}
        });

      // Start
      try {
        command.run();
      } catch (err) {
        reject(err);
      }
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
        // Scale down to 1080p if larger; otherwise keep aspect ratio
        '-vf scale=1920:-2:force_original_aspect_ratio=decrease',
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