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

const streamer = require('./utils/streamer');
const Video = require('./models/Video');

const healthHandler = (req, res) => {
  const streams = streamer.getAllActiveStreams().length;
  res.status(200).json({ status: 'ok', db: dbStatus, streams, uptime: process.uptime() });
};

app.get('/api/health', healthHandler);
app.get('/health', healthHandler);

// Cron: every minute, start all due scheduled videos
function startCron() {
  if (cronTask) return cronTask;
  cronTask = cron.schedule('* * * * *', async () => {
    if (dbStatus !== 'connected') return;
    const now = new Date();
    try {
      const due = await Video.find({ status: 'scheduled', scheduleTime: { $lte: now } }).sort({ scheduleTime: 1 });
      if (!due.length) return;
      console.log(`[Cron] Found ${due.length} due video(s).`);
      for (const v of due) {
        try {
          await streamer.startStream(v._id.toString());
          console.log(`[Cron] Started stream for: ${v.title}`);
        } catch (err) {
          console.error(`[Cron] Failed to start stream for ${v._id}: ${err.message}`);
          try {
            v.status = 'failed';
            v.errorMessage = err.message;
            v.streamEndedAt = new Date();
            await v.save();
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error(`[Cron] Job error: ${err.message}`);
    }
  }, { scheduled: true });
  console.log('[Cron] Job scheduled to run every minute.');
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