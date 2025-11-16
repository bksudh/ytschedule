const ffmpeg = require('../utils/ffmpeg');
const fs = require('fs');
const path = require('path');
const Video = require('../models/Video');

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
  }

  getAllActiveStreams() {
    return Array.from(this.activeStreams.keys());
  }

  getStreamStatus(videoId) {
    const entry = this.activeStreams.get(String(videoId));
    if (!entry) return { active: false };
    return {
      active: true,
      videoId: String(videoId),
      outputUrl: entry.outputUrl,
      startedAt: entry.startedAt,
      progress: entry.progress || 0,
      stopped: !!entry.stopped,
    };
  }

  async startStream(videoId) {
    const id = String(videoId);
    if (this.activeStreams.has(id)) {
      throw new Error(`Stream already active for video ${id}`);
    }

    const video = await Video.findById(id);
    if (!video) throw new Error('Video not found');

    if (!video.filepath || !fs.existsSync(path.resolve(video.filepath))) {
      throw new Error('Video file not found on disk');
    }

    const outputUrl = buildOutputUrl(video.rtmpUrl, video.streamKey);

    const command = ffmpeg(path.resolve(video.filepath))
      .inputOptions(['-re'])
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
            await video.save();

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
            await video.save();
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