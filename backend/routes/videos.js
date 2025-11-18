const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('../utils/ffmpeg');
const Video = require('../models/Video');
const streamer = require('../utils/streamer');
const { syncVideo } = require('../utils/supabase');
const net = require('net');
const tls = require('tls');

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'videos');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedExts = ['.mp4', '.avi', '.mov', '.mkv', '.flv'];
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext);
    const ts = Date.now();
    cb(null, `${ts}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExts.includes(ext)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  },
});

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
}

// Simple in-memory rate limiter (per IP + path)
const rateBuckets = new Map();
function rateLimit(maxPerWindow, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > maxPerWindow) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

// Auth placeholders
function optionalAuth(req, _res, next) {
  // TODO: parse Authorization header and populate req.user
  req.user = null;
  next();
}
function requireAuth(req, res, next) {
  // TODO: enforce authentication
  // For now, allow all requests
  // Example: if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// 1. POST /upload
router.post(
  '/upload',
  upload.single('video'),
  [
    body('title').isString().trim().isLength({ min: 1 }),
    body('scheduleTime').isISO8601(),
    body('stopTime').optional().isISO8601(),
    body('rtmpUrl').isString().trim().isLength({ min: 1 }),
    body('streamKey').isString().trim().isLength({ min: 16 }),
    body('loop').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;

      if (!req.file) return res.status(400).json({ error: 'video file is required' });

      const filepath = path.join(uploadDir, req.file.filename);
      const filesize = req.file.size;
      const scheduleTime = new Date(req.body.scheduleTime);
      const stopTime = req.body.stopTime ? new Date(req.body.stopTime) : undefined;

      let duration = undefined;
      try {
        await new Promise((resolve) => {
          ffmpeg.ffprobe(filepath, (err, data) => {
            if (err) return resolve();
            const streams = (data && data.streams) || [];
            const vStream = streams.find((s) => s.codec_type === 'video');
            const dur = (data.format && data.format.duration) || (vStream && vStream.duration);
            duration = dur ? Math.round(Number(dur)) : undefined;
            resolve();
          });
        });
      } catch (_) {}

      const video = await Video.create({
        title: req.body.title,
        filename: req.file.filename,
        filepath,
        filesize,
        duration,
        scheduleTime,
        stopTime,
        rtmpUrl: req.body.rtmpUrl,
        streamKey: req.body.streamKey,
        loop: !!req.body.loop,
        status: 'scheduled',
      });
      try { await syncVideo(video); } catch (_) {}
      res.status(201).json(video);
    } catch (err) {
      next(err);
    }
  }
);

// Legacy: keep existing simple POST / for compatibility (frontend may rely on it)
router.post(
  '/',
  upload.single('file'),
  [
    body('title').isString().trim().isLength({ min: 1 }),
    body('scheduledAt').optional().isISO8601(),
    body('scheduleTime').optional().isISO8601(),
    body('stopTime').optional().isISO8601(),
    body('rtmpUrl').isString().trim().isLength({ min: 1 }),
    body('streamKey').isString().trim().isLength({ min: 16 }),
    body('loop').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      if (!req.file) return res.status(400).json({ error: 'File is required' });

      const scheduledAt = req.body.scheduleTime || req.body.scheduledAt; // virtual handles scheduledAt
      const stopTime = req.body.stopTime ? new Date(req.body.stopTime) : undefined;
      const filepath = path.join(uploadDir, req.file.filename);
      const filesize = req.file.size;

      let duration = undefined;
      try {
        await new Promise((resolve) => {
          ffmpeg.ffprobe(filepath, (err, data) => {
            if (err) return resolve();
            const streams = (data && data.streams) || [];
            const vStream = streams.find((s) => s.codec_type === 'video');
            const dur = (data.format && data.format.duration) || (vStream && vStream.duration);
            duration = dur ? Math.round(Number(dur)) : undefined;
            resolve();
          });
        });
      } catch (_) {}

      const video = await Video.create({
        title: req.body.title,
        filename: req.file.filename,
        filepath,
        filesize,
        duration,
        scheduledAt, // virtual maps to scheduleTime
        stopTime,
        rtmpUrl: req.body.rtmpUrl,
        streamKey: req.body.streamKey,
        loop: !!req.body.loop,
        status: 'scheduled',
      });
      try { await syncVideo(video); } catch (_) {}
      res.status(201).json(video);
    } catch (err) {
      next(err);
    }
  }
);

// 2. GET /
router.get(
  '/',
  [
    query('status').optional().isIn(['library', 'scheduled', 'streaming', 'completed', 'failed', 'cancelled']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;

      // Degrade gracefully when MongoDB is disconnected to avoid long timeouts
      if (mongoose.connection.readyState !== 1) {
        return res.status(200).json([]);
      }

      const filter = {};
      if (req.query.status) filter.status = req.query.status;

      const limit = req.query.limit || 50;
      const skip = req.query.skip || 0;

      const videos = await Video.find(filter)
        .sort({ scheduleTime: 1 })
        .skip(skip)
        .limit(limit);
      res.json(videos);
    } catch (err) {
      next(err);
    }
  }
);

// Upload to library (unscheduled, store for later)
router.post(
  '/library',
  upload.single('file'),
  [
    body('title').isString().trim().isLength({ min: 1 }),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      if (!req.file) return res.status(400).json({ error: 'File is required' });

      const filepath = path.join(uploadDir, req.file.filename);
      const filesize = req.file.size;

      let duration = undefined;
      try {
        await new Promise((resolve) => {
          ffmpeg.ffprobe(filepath, (err, data) => {
            if (err) return resolve();
            const streams = (data && data.streams) || [];
            const vStream = streams.find((s) => s.codec_type === 'video');
            const dur = (data.format && data.format.duration) || (vStream && vStream.duration);
            duration = dur ? Math.round(Number(dur)) : undefined;
            resolve();
          });
        });
      } catch (_) {}

      const video = await Video.create({
        title: req.body.title,
        filename: req.file.filename,
        filepath,
        filesize,
        duration,
        status: 'library',
      });
      try { await syncVideo(video); } catch (_) {}
      res.status(201).json(video);
    } catch (err) {
      next(err);
    }
  }
);

// 3. GET /:id
router.get(
  '/:id',
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      res.json(video);
    } catch (err) {
      next(err);
    }
  }
);

// 4. PUT /:id
router.put(
  '/:id',
  [
    param('id').isMongoId(),
    body('title').optional().isString().trim().isLength({ min: 1 }),
    body('scheduleTime').optional().isISO8601(),
    body('stopTime').optional().isISO8601(),
    body('rtmpUrl').optional().isString().trim().isLength({ min: 1 }),
    body('streamKey').optional().isString().trim().isLength({ min: 16 }),
    body('status').optional().isIn(['library', 'scheduled', 'streaming', 'completed', 'failed', 'cancelled']),
    body('loop').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      if (video.status === 'streaming') return res.status(400).json({ error: 'Cannot update a streaming video' });

      if (req.body.title) video.title = req.body.title;
      if (req.body.scheduleTime) video.scheduleTime = new Date(req.body.scheduleTime);
      if (req.body.rtmpUrl) video.rtmpUrl = req.body.rtmpUrl;
      if (req.body.stopTime) video.stopTime = new Date(req.body.stopTime);
      if (req.body.streamKey) video.streamKey = req.body.streamKey;
      if (req.body.status) video.status = req.body.status;
      if (typeof req.body.loop === 'boolean') video.loop = req.body.loop;
      await video.save();
      try { await syncVideo(video); } catch (_) {}
      res.json(video);
    } catch (err) {
      next(err);
    }
  }
);

// Helper: build output RTMP URL and parse host/port
function buildRtmpOutputUrl(rtmpUrl, streamKey) {
  if (typeof rtmpUrl !== 'string' || !/^rtmps?:\/\//i.test(rtmpUrl)) {
    throw new Error('Invalid RTMP URL');
  }
  if (typeof streamKey !== 'string' || streamKey.trim().length < 8) {
    throw new Error('Invalid stream key');
  }
  return rtmpUrl.endsWith('/') ? `${rtmpUrl}${streamKey}` : `${rtmpUrl}/${streamKey}`;
}
function parseHostPortFromRtmp(rtmpUrl) {
  const u = new URL(rtmpUrl);
  const protocol = u.protocol.replace(':', '');
  const host = u.hostname;
  const port = u.port ? Number(u.port) : protocol === 'rtmps' ? 443 : 1935;
  return { protocol, host, port };
}

// 1. POST /:id/stream/start
router.post(
  '/:id/stream/start',
  rateLimit(5, 60_000),
  optionalAuth,
  [
    param('id').isMongoId(),
    body('force').optional().isBoolean(),
    // Optional RTMP details for Instant Live (required when starting library items)
    body('rtmpUrl').optional().isString().trim().isLength({ min: 1 }),
    body('streamKey').optional().isString().trim().isLength({ min: 8 }),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;

      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      const force = Boolean(req.body.force);
      const now = new Date();

      // Case A: Scheduled item (existing behavior)
      if (video.status === 'scheduled') {
        if (!force && video.scheduleTime && video.scheduleTime > now) {
          return res.status(400).json({ error: 'Not scheduled yet. Use force to start early.' });
        }
        try {
          await streamer.startStream(video._id.toString());
          return res.json({ message: 'Stream started' });
        } catch (err) {
          const msg = err && err.message ? err.message : 'Failed to start stream';
          if (/already active/i.test(msg)) return res.status(409).json({ error: msg });
          if (/Video file not found/i.test(msg)) return res.status(404).json({ error: msg });
          if (/Invalid RTMP URL|stream key/i.test(msg)) return res.status(400).json({ error: msg });
          return res.status(500).json({ error: msg });
        }
      }

      // Case B: Instant Live for Library items
      if (video.status === 'library') {
        const rtmpUrl = String(req.body.rtmpUrl || video.rtmpUrl || '').trim();
        const streamKey = String(req.body.streamKey || video.streamKey || '').trim();
        if (!rtmpUrl || !streamKey || streamKey.length < 8) {
          return res.status(400).json({ error: 'RTMP URL and Stream Key are required for Instant Live' });
        }
        // Ensure a scheduleTime exists to satisfy model validation when status changes to streaming
        if (!video.scheduleTime) {
          try {
            await Video.findByIdAndUpdate(video._id, { scheduleTime: now }).exec();
          } catch (_) {}
        }
        try {
          await streamer.startStream(video._id.toString(), { rtmpUrl, streamKey });
          return res.json({ message: 'Instant Live started' });
        } catch (err) {
          const msg = err && err.message ? err.message : 'Failed to start Instant Live';
          if (/already active/i.test(msg)) return res.status(409).json({ error: msg });
          if (/Video file not found/i.test(msg)) return res.status(404).json({ error: msg });
          if (/Invalid RTMP URL|stream key/i.test(msg)) return res.status(400).json({ error: msg });
          return res.status(500).json({ error: msg });
        }
      }

      return res.status(400).json({ error: 'Video is not in a startable state' });
    } catch (err) {
      next(err);
    }
  }
);

// 2. POST /:id/stream/stop
router.post(
  '/:id/stream/stop',
  rateLimit(5, 60_000),
  requireAuth,
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      if (video.status !== 'streaming') return res.status(400).json({ error: 'Video is not streaming' });

      const ok = await streamer.stopStream(req.params.id);
      if (!ok) return res.status(400).json({ error: 'No active stream process to stop' });
      return res.json({ success: true, message: 'Stream stop requested' });
    } catch (err) {
      next(err);
    }
  }
);

// 3. GET /:id/stream/status
router.get(
  '/:id/stream/status',
  rateLimit(15, 60_000),
  optionalAuth,
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      const status = streamer.getStreamStatus(req.params.id);
      const payload = {
        active: !!(status && status.active),
        progress: typeof video.progress === 'number' ? video.progress : (status && status.progress) || 0,
        state: video.status,
      };
      if (status && status.active) {
        payload.outputUrl = status.outputUrl;
        payload.startedAt = status.startedAt;
      }
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

// 4. POST /test-rtmp
router.post(
  '/test-rtmp',
  rateLimit(10, 60_000),
  requireAuth,
  [body('rtmpUrl').isString().trim().isLength({ min: 1 }), body('streamKey').isString().trim().isLength({ min: 8 })],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const { rtmpUrl, streamKey } = req.body;
      try {
        const full = buildRtmpOutputUrl(rtmpUrl, streamKey);
        const { protocol, host, port } = parseHostPortFromRtmp(rtmpUrl);

        const reachable = await new Promise((resolve) => {
          const timerMs = 3000;
          let done = false;
          const onDone = (ok) => {
            if (done) return;
            done = true;
            resolve(ok);
          };
          const timer = setTimeout(() => onDone(false), timerMs);
          const onConnect = () => {
            clearTimeout(timer);
            socket.end();
            onDone(true);
          };
          const onError = () => {
            clearTimeout(timer);
            onDone(false);
          };
          let socket;
          if (protocol === 'rtmps') {
            socket = tls.connect({ host, port, servername: host }, onConnect);
          } else {
            socket = net.connect({ host, port }, onConnect);
          }
          socket.on('error', onError);
        });

        return res.json({ reachable, protocol, host, port, outputUrl: full });
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid RTMP configuration' });
      }
    } catch (err) {
      next(err);
    }
  }
);

// 5. DELETE /:id
router.delete(
  '/:id',
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      const status = streamer.getStreamStatus(req.params.id);
      if (status && status.active) {
        await streamer.stopStream(req.params.id);
      }

      // Delete file from disk
      try {
        if (video.filepath && fs.existsSync(video.filepath)) {
          fs.unlinkSync(video.filepath);
        }
      } catch (fsErr) {
        console.warn(`[Videos] Failed to delete file: ${fsErr.message}`);
      }

      await Video.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;