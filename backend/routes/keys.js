const express = require('express');
const { body, param, validationResult } = require('express-validator');
const KeyProfile = require('../models/KeyProfile');

const router = express.Router();

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
}

router.get('/', async (_req, res, next) => {
  try {
    const items = await KeyProfile.find({}).sort({ createdAt: -1 }).lean().exec();
    res.set('Cache-Control', 'no-store');
    return res.json(items.map(k => ({ _id: k._id, name: k.name, rtmpUrl: k.rtmpUrl, streamKey: k.streamKey })));
  } catch (err) { next(err); }
});

router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }),
    body('rtmpUrl').isString().trim().isLength({ min: 1 }),
    body('streamKey').isString().trim().isLength({ min: 8 }),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const { name, rtmpUrl, streamKey } = req.body;
      const created = await KeyProfile.create({ name, rtmpUrl, streamKey });
      return res.status(201).json({ _id: created._id, name: created.name, rtmpUrl: created.rtmpUrl, streamKey: created.streamKey });
    } catch (err) { next(err); }
  }
);

router.put(
  '/:id',
  [
    param('id').isMongoId(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('rtmpUrl').optional().isString().trim().isLength({ min: 1 }),
    body('streamKey').optional().isString().trim().isLength({ min: 8 }),
  ],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const k = await KeyProfile.findById(req.params.id);
      if (!k) return res.status(404).json({ error: 'Key not found' });
      if (req.body.name) k.name = req.body.name;
      if (req.body.rtmpUrl) k.rtmpUrl = req.body.rtmpUrl;
      if (req.body.streamKey) k.streamKey = req.body.streamKey;
      await k.save();
      return res.json({ _id: k._id, name: k.name, rtmpUrl: k.rtmpUrl, streamKey: k.streamKey });
    } catch (err) { next(err); }
  }
);

router.delete(
  '/:id',
  [param('id').isMongoId()],
  async (req, res, next) => {
    try {
      const errResp = handleValidationErrors(req, res);
      if (errResp) return;
      const k = await KeyProfile.findById(req.params.id);
      if (!k) return res.status(404).json({ error: 'Key not found' });
      await k.deleteOne();
      return res.json({ success: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
