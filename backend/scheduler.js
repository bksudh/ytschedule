const cron = require('node-cron');
const streamer = require('./utils/streamer');
const Video = require('./models/Video');

let task = null;
let isStreaming = false;

async function processDueVideos() {
  if (isStreaming) return; // prevent concurrent streams
  const now = new Date();
  try {
    const next = await Video.find({ status: 'scheduled', scheduleTime: { $lte: now } })
      .sort({ scheduleTime: 1 })
      .limit(1);

    if (!next.length) return;
    const video = next[0];

    isStreaming = true;
    console.log(`[Scheduler] Starting stream: ${video.title}`);

    try {
      const cmd = await streamer.startStream(video._id.toString());

      // Set concurrency guard back when ffmpeg finishes/errors.
      cmd.on('end', () => {
        isStreaming = false;
        console.log(`[Scheduler] Completed stream: ${video.title}`);
      });
      cmd.on('error', (err) => {
        isStreaming = false;
        console.error(`[Scheduler] Stream error: ${err.message}`);
      });
    } catch (err) {
      console.error(`[Scheduler] Failed to start stream: ${err.message}`);
      // Persist failed status if startup failed before streamer could mark anything.
      try {
        video.status = 'failed';
        video.errorMessage = err.message;
        video.streamEndedAt = new Date();
        await video.save();
      } catch (_) {}
      isStreaming = false;
    }
  } catch (err) {
    console.error(`[Scheduler] Error: ${err.message}`);
  }
}

function startScheduler() {
  if (task) return task; // already started
  // Every minute check for due videos
  task = cron.schedule('*/1 * * * *', processDueVideos, { scheduled: true });
  console.log('[Scheduler] Scheduled job started (every minute).');
  return task;
}

module.exports = { startScheduler };