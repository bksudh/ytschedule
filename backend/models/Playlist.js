const mongoose = require('mongoose');

const PlaylistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    videos: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true }],
    scheduleTime: { type: Date, required: true, index: true },
    // Optional RTMP settings that apply to the whole playlist.
    // If provided, these will be used for streaming each item when the
    // individual video does not have its own RTMP configuration (e.g., library videos).
    rtmpUrl: { type: String, trim: true },
    streamKey: { type: String, trim: true },
    status: {
      type: String,
      enum: ['scheduled', 'running', 'completed', 'cancelled', 'failed'],
      default: 'scheduled',
      index: true,
    },
    currentIndex: { type: Number, default: 0, min: 0 },
    streamStartedAt: { type: Date },
    streamEndedAt: { type: Date },
    createdBy: { type: String },
    // Repeat playlist from the beginning after the last item finishes
    loop: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

PlaylistSchema.index({ status: 1, scheduleTime: 1 });
PlaylistSchema.index({ status: 1, updatedAt: 1 });

PlaylistSchema.pre('save', function (next) {
  if (!Array.isArray(this.videos) || this.videos.length === 0) {
    return next(new Error('Playlist must include at least one video'));
  }
  if (!this.scheduleTime) {
    return next(new Error('scheduleTime is required for playlist'));
  }
  if (typeof this.currentIndex !== 'number' || this.currentIndex < 0) {
    return next(new Error('currentIndex must be >= 0'));
  }
  next();
});

module.exports = mongoose.model('Playlist', PlaylistSchema);