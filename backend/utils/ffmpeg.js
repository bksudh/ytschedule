const ffmpeg = require('fluent-ffmpeg');

// Resolve static binaries for cross-platform reliability
let ffmpegPath = null;
let ffprobePath = null;

try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {}

try {
  // Prefer @ffprobe-installer/ffprobe; fallback to ffprobe-static if needed
  const fp = require('@ffprobe-installer/ffprobe');
  ffprobePath = fp.path;
} catch (_) {
  try {
    const fps = require('ffprobe-static');
    ffprobePath = fps.path;
  } catch (_) {}
}

if (ffmpegPath) {
  try { ffmpeg.setFfmpegPath(ffmpegPath); } catch (_) {}
}
if (ffprobePath) {
  try { ffmpeg.setFfprobePath(ffprobePath); } catch (_) {}
}

module.exports = ffmpeg;