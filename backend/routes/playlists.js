const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');
const { syncPlaylist } = require('../utils/supabase');

const router = express.Router();

function handleValidationErrors(req, res) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
}

// Create playlist
router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1 }),
    body('description').optional().isString().trim(),
    body('videoIds').isArray({ min: 1 }),
    body('videoIds.*').isMongoId(),
    body('scheduleTime').isISO8601(),
    body('rtmpUrl').optional().isString().trim().isLength({ min: 1 }),
    body('streamKey').optional().isString().trim().isLength({ min: 8 }),
    body('loop').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const { name, description, videoIds, scheduleTime, rtmpUrl, streamKey, loop } = req.body;

      // Verify videos exist and are not currently streaming
      const vids = await Video.find({ _id: { $in: videoIds } }).exec();
      if (vids.length !== videoIds.length) {
        return res.status(404).json({ error: 'One or more videos not found' });
      }
      const streamingIds = vids.filter(v => v.status === 'streaming').map(v => v._id.toString());
      if (streamingIds.length > 0) {
        return res.status(400).json({ error: 'Some videos are currently streaming and cannot be added' });
      }

      // If any selected videos are library items, RTMP details must be provided at playlist-level.
      const requiresRtmp = vids.some(v => v.status === 'library');
      if (requiresRtmp && (!rtmpUrl || !streamKey)) {
        return res.status(400).json({ error: 'RTMP URL and Stream Key are required to stream library videos in a playlist' });
      }

      const playlist = new Playlist({
        name,
        description,
        videos: videoIds,
        scheduleTime: new Date(scheduleTime),
        status: 'scheduled',
        currentIndex: 0,
        rtmpUrl: rtmpUrl || undefined,
        streamKey: streamKey || undefined,
        loop: !!loop,
      });
      await playlist.save();
      try { await syncPlaylist(playlist); } catch (_) {}

      // Link videos to this playlist
      await Video.updateMany({ _id: { $in: videoIds } }, { $set: { playlistId: playlist._id } }).exec();

      return res.status(201).json(playlist);
    } catch (err) {
      next(err);
    }
  }
);

// List playlists
router.get(
  '/',
  [
    query('status').optional().isIn(['scheduled', 'running', 'completed', 'cancelled', 'failed']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      const limit = req.query.limit || 50;
      const skip = req.query.skip || 0;
      const items = await Playlist.find(filter).sort({ scheduleTime: 1, createdAt: 1 }).skip(skip).limit(limit).lean().exec();
      return res.json(items);
    } catch (err) {
      next(err);
    }
  }
);

// Get one playlist (populated)
router.get(
  '/:id',
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const pl = await Playlist.findById(req.params.id).populate('videos').exec();
      if (!pl) return res.status(404).json({ error: 'Playlist not found' });
      return res.json(pl);
    } catch (err) {
      next(err);
    }
  }
);

// Update playlist (name, description, scheduleTime, videos)
router.put(
  '/:id',
  [
    param('id').isMongoId(),
    body('name').optional().isString().trim().isLength({ min: 1 }),
    body('description').optional().isString().trim(),
    body('scheduleTime').optional().isISO8601(),
    body('videoIds').optional().isArray({ min: 1 }),
    body('videoIds.*').optional().isMongoId(),
    body('rtmpUrl').optional().isString().trim().isLength({ min: 1 }),
    body('streamKey').optional().isString().trim().isLength({ min: 8 }),
    body('loop').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const pl = await Playlist.findById(req.params.id).exec();
      if (!pl) return res.status(404).json({ error: 'Playlist not found' });
      if (pl.status === 'running') return res.status(400).json({ error: 'Cannot modify a running playlist' });

      const { name, description, scheduleTime, videoIds, rtmpUrl, streamKey, loop } = req.body;
      if (name) pl.name = name;
      if (description) pl.description = description;
      if (scheduleTime) pl.scheduleTime = new Date(scheduleTime);
      if (rtmpUrl) pl.rtmpUrl = rtmpUrl;
      if (streamKey) pl.streamKey = streamKey;
      if (typeof loop === 'boolean') pl.loop = loop;
      if (Array.isArray(videoIds) && videoIds.length > 0) {
        const vids = await Video.find({ _id: { $in: videoIds } }).exec();
        if (vids.length !== videoIds.length) {
          return res.status(404).json({ error: 'One or more videos not found' });
        }
        pl.videos = videoIds;
        pl.currentIndex = 0;
        // Update video playlist links: add for new ones, remove for those no longer included
        const allIds = [...new Set([...videoIds, ...pl.videos.map(v => v.toString())])];
        await Video.updateMany({ _id: { $in: allIds } }, { $set: { playlistId: pl._id } }).exec();
        await Video.updateMany({ playlistId: pl._id, _id: { $nin: videoIds } }, { $unset: { playlistId: '' } }).exec();
      }
      await pl.save();
      try { await syncPlaylist(pl); } catch (_) {}
      return res.json(pl);
    } catch (err) {
      next(err);
    }
  }
);

// Cancel playlist and unlink videos
router.post(
  '/:id/cancel',
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const pl = await Playlist.findById(req.params.id).exec();
      if (!pl) return res.status(404).json({ error: 'Playlist not found' });
      pl.status = 'cancelled';
      await pl.save();
      try { await syncPlaylist(pl); } catch (_) {}
      await Video.updateMany({ playlistId: pl._id }, { $unset: { playlistId: '' } }).exec();
      return res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;