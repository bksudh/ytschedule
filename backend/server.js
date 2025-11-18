const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cron = require('node-cron');
let MongoMemoryServer = null;
try {
  // Loaded lazily to avoid requiring the package in environments where it's not installed
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
} catch (_) {}

dotenv.config();

const app = express();

// Middleware: security, CORS, body parsers, request logger
app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',');
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // In dev, allow others but log
      console.warn(`[CORS] Allowing origin: ${origin}`);
      cb(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} - ${res.statusCode} (${dur}ms)`);
  });
  next();
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';

let dbStatus = 'disconnected';
let cronTask = null;
let mongoMemory = null;

// DB connection with retry
async function connectWithRetry(attempt = 1, maxAttempts = 3) {
  try {
    let uri = MONGODB_URI;
    if (!uri) {
      // If no external MongoDB URI, spin up an in-memory instance for development
      if (!MongoMemoryServer) {
        console.warn('[DB] MONGODB_URI not set and mongodb-memory-server not available; running without database');
        return;
      }
      if (!mongoMemory) {
        mongoMemory = await MongoMemoryServer.create();
        console.log(`[DB] Started in-memory MongoDB at ${mongoMemory.getUri()}`);
      }
      uri = mongoMemory.getUri();
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    dbStatus = 'connected';
    console.log(`[DB] Connected on attempt ${attempt}`);
  } catch (err) {
    dbStatus = 'disconnected';
    console.error(`[DB] Connection attempt ${attempt} failed: ${err.message}`);
    if (attempt < maxAttempts) {
      const delay = 2000 * attempt;
      console.log(`[DB] Retrying in ${delay}ms...`);
      setTimeout(() => connectWithRetry(attempt + 1, maxAttempts), delay);
    } else {
      console.error('[DB] Max retry attempts reached. Continuing without DB.');
    }
  }
}

mongoose.connection.on('connected', () => {
  dbStatus = 'connected';
});
mongoose.connection.on('disconnected', () => {
  dbStatus = 'disconnected';
});
mongoose.connection.on('error', (err) => {
  dbStatus = 'disconnected';
  console.error(`[DB] Error: ${err.message}`);
});

connectWithRetry(1, 3);

const videosRouter = require('./routes/videos');
app.use('/api/videos', videosRouter);
const playlistsRouter = require('./routes/playlists');
app.use('/api/playlists', playlistsRouter);

const streamer = require('./utils/streamer');
const Video = require('./models/Video');
const Playlist = require('./models/Playlist');
const ExternalJob = require('./models/ExternalJob');
const supabase = require('./utils/supabase');

const healthHandler = (req, res) => {
  const streams = streamer.getAllActiveStreams().length;
  res.status(200).json({ status: 'ok', db: dbStatus, streams, uptime: process.uptime() });
};

app.get('/api/health', healthHandler);
app.get('/health', healthHandler);

// Active streams listing (videos + external URL jobs)
app.get('/api/streams/active', async (req, res) => {
  try {
    const ids = streamer.getAllActiveStreams();
    const out = [];
    for (const id of ids) {
      const sid = String(id);
      const st = (typeof streamer.getStreamStatus === 'function') ? streamer.getStreamStatus(sid) : null;
      const base = { id: sid, status: 'streaming', startedAt: st && st.startedAt ? st.startedAt : undefined };
      if (sid.startsWith('url:')) {
        // External stream (YouTube URL)
        const job = await ExternalJob.findOne({ streamId: sid }).lean().exec();
        out.push({
          ...base,
          type: 'external',
          title: (job && job.title) || 'External URL',
          sourceUrl: (st && st.sourceUrl) || (job && job.sourceUrl) || undefined,
          outputUrl: (st && st.outputUrl) || (job && job.lastOutputUrl) || undefined,
          progress: (st && typeof st.progress === 'number') ? st.progress : undefined,
          stopTime: (job && job.stopTime) || undefined,
        });
      } else {
        // Video stream
        const v = await Video.findById(sid).lean().exec();
        let pl = null;
        if (v && v.playlistId) {
          try { pl = await Playlist.findById(v.playlistId).lean().exec(); } catch (_) {}
        }
        const output = (st && st.outputUrl) || (v && v.lastOutputUrl) || ((v && v.usedRtmpUrl && v.usedStreamKey) ? `${v.usedRtmpUrl.replace(/\/$/, '')}/${v.usedStreamKey}` : undefined);
        out.push({
          ...base,
          type: 'video',
          title: (v && v.title) || sid,
          outputUrl: output,
          progress: (st && typeof st.progress === 'number') ? st.progress : (v && typeof v.progress === 'number' ? v.progress : undefined),
          stopTime: (v && v.stopTime) || undefined,
          playlistId: (v && v.playlistId) || undefined,
          playlistName: (pl && pl.name) || undefined,
        });
      }
    }
    res.status(200).json({ active: out, count: out.length });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : 'Failed to list active streams' });
  }
});

// Supabase health
app.get('/api/supabase/health', async (req, res) => {
  try {
    const status = await supabase.getStatus();
    res.status(200).json(status);
  } catch (err) {
    res.status(200).json({ url: false, anon: false, admin: false, connected: false });
  }
});

// Cron: every minute, auto-stop streams at stopTime and start next due video (sequential)
function startCron() {
  if (cronTask) return cronTask;
  cronTask = cron.schedule('* * * * *', async () => {
    if (dbStatus !== 'connected') return;
    const now = new Date();
    try {
      // 1) Stop any streaming videos whose stopTime has arrived
      const toStop = await Video.find({ status: 'streaming', stopTime: { $exists: true, $lte: now } });
      for (const v of toStop) {
        try {
          const ok = await streamer.stopStream(v._id.toString());
          console.log(`[Cron] Auto-stopped ${v.title} at planned stopTime (${ok ? 'ok' : 'no active process'})`);
        } catch (err) {
          console.error(`[Cron] Failed to auto-stop ${v._id}: ${err.message}`);
        }
      }

      // 1b) Stop any running external URL jobs whose stopTime has arrived
      const extToStop = await ExternalJob.find({ status: 'streaming', stopTime: { $exists: true, $lte: now } }).lean().exec();
      for (const job of extToStop) {
        try {
          if (job.streamId) {
            const ok = await streamer.stopExternalStream(job.streamId);
            console.log(`[Cron] Auto-stopped external job ${job._id} (${ok ? 'ok' : 'no active process'})`);
          }
        } catch (err) {
          console.error(`[Cron] Failed to auto-stop external ${job._id}: ${err.message}`);
        }
      }

      // 1a) If no active streams and a running playlist has finished all items,
      //     either mark completed or reset to start again when loop is enabled
      const activeCountPre = streamer.getAllActiveStreams().length;
      if (activeCountPre === 0) {
        const donePlaylists = await Playlist.find({ status: 'running' }).lean().exec();
        for (const pl of donePlaylists) {
          if (Array.isArray(pl.videos) && typeof pl.currentIndex === 'number' && pl.currentIndex >= pl.videos.length) {
            try {
              if (pl.loop) {
                await Playlist.findByIdAndUpdate(pl._id, { currentIndex: 0 }).exec();
                console.log(`[Cron] Playlist ${pl._id} loop enabled; resetting to first item.`);
                // Keep status as 'running'; next cycle will start first item
              } else {
                const endedAt = new Date();
                await Playlist.findByIdAndUpdate(pl._id, { status: 'completed', streamEndedAt: endedAt }).exec();
                try { await supabase.syncPlaylist({ _id: pl._id, status: 'completed', streamEndedAt: endedAt }); } catch (_) {}
              }
            } catch (_) {}
          }
        }
      }

      // 2) If no active streams, start the next due scheduled video
      const activeCount = streamer.getAllActiveStreams().length;
      if (activeCount > 0) return;

      // 2a) If there is a running playlist, start its next item
      let running = await Playlist.findOne({ status: 'running' }).sort({ updatedAt: 1 }).exec();
      if (running && Array.isArray(running.videos) && running.currentIndex < running.videos.length) {
        const nextVideoId = String(running.videos[running.currentIndex]);
        try {
          await streamer.startStream(nextVideoId, { rtmpUrl: running.rtmpUrl, streamKey: running.streamKey });
          running.currentIndex += 1;
          await running.save();
          try { await supabase.syncPlaylist(running); } catch (_) {}
          const v = await Video.findById(nextVideoId).lean().exec();
          console.log(`[Cron] Started playlist item ${running.currentIndex}/${running.videos.length}: ${v && v.title ? v.title : nextVideoId}`);
          return;
        } catch (err) {
          console.error(`[Cron] Failed to start playlist item for ${running._id}: ${err.message}`);
        }
      }

      // 2b) If a scheduled playlist is due, mark running and start first item
      const duePlaylist = await Playlist.findOne({ status: 'scheduled', scheduleTime: { $lte: now } }).sort({ scheduleTime: 1 }).exec();
      if (duePlaylist) {
        duePlaylist.status = 'running';
        duePlaylist.streamStartedAt = new Date();
        await duePlaylist.save();
        try { await supabase.syncPlaylist(duePlaylist); } catch (_) {}
        if (Array.isArray(duePlaylist.videos) && duePlaylist.videos.length > 0) {
          const firstId = String(duePlaylist.videos[duePlaylist.currentIndex] || duePlaylist.videos[0]);
          try {
            await streamer.startStream(firstId, { rtmpUrl: duePlaylist.rtmpUrl, streamKey: duePlaylist.streamKey, playlistId: duePlaylist._id });
            duePlaylist.currentIndex = 1;
            await duePlaylist.save();
            try { await supabase.syncPlaylist(duePlaylist); } catch (_) {}
            const v = await Video.findById(firstId).lean().exec();
            console.log(`[Cron] Started first playlist item: ${v && v.title ? v.title : firstId}`);
            return;
          } catch (err) {
            console.error(`[Cron] Failed to start first playlist item for ${duePlaylist._id}: ${err.message}`);
          }
        }
      }

      // 2c) Fallback: start next due scheduled video not part of a playlist
      const next = await Video.findOne({ status: 'scheduled', scheduleTime: { $lte: now }, $or: [ { playlistId: { $exists: false } }, { playlistId: null } ] }).sort({ scheduleTime: 1 });
      if (next) {
        try {
          await streamer.startStream(next._id.toString());
          console.log(`[Cron] Started stream for: ${next.title}`);
        } catch (err) {
          console.error(`[Cron] Failed to start stream for ${next._id}: ${err.message}`);
          try {
            next.status = 'failed';
            next.errorMessage = err.message;
            next.streamEndedAt = new Date();
            await next.save();
          } catch (_) {}
        }
      } else {
        // 2d) If no video is due, start next scheduled external URL job
        const nextJob = await ExternalJob.findOne({ status: 'scheduled', scheduleTime: { $lte: now } }).sort({ scheduleTime: 1 }).exec();
        if (!nextJob) return;
        try {
          const { streamId, command } = await streamer.startUrlStream(nextJob.sourceUrl, { rtmpUrl: nextJob.rtmpUrl, streamKey: nextJob.streamKey });
          nextJob.status = 'streaming';
          nextJob.streamId = streamId;
          nextJob.startedAt = new Date();
          nextJob.lastOutputUrl = `${nextJob.rtmpUrl.endsWith('/') ? nextJob.rtmpUrl : nextJob.rtmpUrl + '/'}${nextJob.streamKey}`;
          await nextJob.save();

          command.on('end', async () => {
            try {
              const j = await ExternalJob.findById(nextJob._id);
              if (!j) return;
              j.status = 'completed';
              j.progress = 100;
              j.endedAt = new Date();
              await j.save();
            } catch (e) {
              console.error(`[Cron] Failed to mark external job complete: ${e.message}`);
            }
          });
          command.on('error', async (err) => {
            try {
              const j = await ExternalJob.findById(nextJob._id);
              if (!j) return;
              j.status = 'failed';
              j.errorMessage = err.message || 'Streaming failed';
              j.endedAt = new Date();
              await j.save();
            } catch (e) {
              console.error(`[Cron] Failed to mark external job error: ${e.message}`);
            }
          });
          console.log(`[Cron] Started external URL job ${nextJob._id}`);
        } catch (err) {
          console.error(`[Cron] Failed to start external job ${nextJob._id}: ${err.message}`);
          try {
            nextJob.status = 'failed';
            nextJob.errorMessage = err.message;
            nextJob.endedAt = new Date();
            await nextJob.save();
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error(`[Cron] Job error: ${err.message}`);
    }
  }, { scheduled: true });
  console.log('[Cron] Job scheduled to run every minute (auto-stop + sequential start).');
  return cronTask;
}

mongoose.connection.on('connected', () => {
  try {
    startCron();
  } catch (err) {
    console.error(`[Cron] Failed to start: ${err.message}`);
  }
});

// 404 handler
app.use((req, res, _next) => {
  res.status(404).json({ error: 'Not Found' });
});

// Global error handler
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });

  async function shutdown(signal) {
    console.log(`[Shutdown] Received ${signal}`);
    try {
      if (cronTask) {
        cronTask.stop();
        console.log('[Shutdown] Cron task stopped');
      }
    } catch (_) {}
    try {
      const ids = streamer.getAllActiveStreams();
      console.log(`[Shutdown] Stopping ${ids.length} active stream(s)`);
      for (const id of ids) {
        try {
          await streamer.stopStream(id);
        } catch (err) {
          console.warn(`[Shutdown] Failed to stop stream ${id}: ${err.message}`);
        }
      }
    } catch (_) {}
    try {
      await mongoose.connection.close(false);
      console.log('[Shutdown] MongoDB connection closed');
    } catch (err) {
      console.warn(`[Shutdown] MongoDB close error: ${err.message}`);
    }
    try {
      if (mongoMemory) {
        await mongoMemory.stop();
        console.log('[Shutdown] In-memory MongoDB stopped');
      }
    } catch (_) {}
    process.exit(0);
  }
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));
}

module.exports = app;