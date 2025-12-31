const mongoose = require('mongoose');

const KeyProfileSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100, unique: true },
  rtmpUrl: { type: String, required: true, trim: true },
  streamKey: { type: String, required: true, trim: true },
}, { timestamps: true });

KeyProfileSchema.path('rtmpUrl').validate(function (v) {
  return typeof v === 'string' && /^rtmps?:\/\//i.test(v);
}, 'Invalid RTMP URL');

KeyProfileSchema.path('streamKey').validate(function (v) {
  return typeof v === 'string' && v.trim().length >= 8;
}, 'Invalid stream key');

module.exports = mongoose.model('KeyProfile', KeyProfileSchema);
