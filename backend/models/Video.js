const mongoose = require('mongoose');

const VideoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    filename: { type: String, required: true, trim: true },
    filepath: { type: String, required: true, trim: true },
    filesize: { type: Number, min: 0 },
    duration: { type: Number, min: 0 }, // seconds
    // For library items, scheduleTime can be omitted
    scheduleTime: { type: Date, required: function () { return this.status !== 'library'; }, index: true },
    // Optional planned stop time for auto-stopping the stream
    stopTime: { type: Date, required: false, index: true },
    // Optional reference to a playlist this video belongs to
    playlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist' },
    // RTMP details: required when streaming unless playlist overrides are provided
    rtmpUrl: { type: String, required: function () { return this.status !== 'library' && !this.usedRtmpUrl; }, trim: true },
    streamKey: { type: String, required: function () { return this.status !== 'library' && !this.usedStreamKey; }, trim: true },
    status: {
      type: String,
      enum: ['library', 'scheduled', 'streaming', 'completed', 'failed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    errorMessage: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    streamStartedAt: { type: Date },
    streamEndedAt: { type: Date },
    // Persist actual RTMP details used during the last stream (could come from playlist overrides)
    usedRtmpUrl: { type: String, trim: true },
    usedStreamKey: { type: String, trim: true },
    lastOutputUrl: { type: String, trim: true },
    createdBy: { type: String },
    // Loop this video continuously when streaming (until manual stop or stopTime)
    loop: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for backward-compatibility with older API/clients using `scheduledAt`
VideoSchema.virtual('scheduledAt')
  .get(function () {
    return this.scheduleTime;
  })
  .set(function (val) {
    this.scheduleTime = val instanceof Date ? val : new Date(val);
  });

// Indexes for common queries
VideoSchema.index({ status: 1, scheduleTime: 1 });
VideoSchema.index({ status: 1, stopTime: 1 });
VideoSchema.index({ playlistId: 1, status: 1 });
VideoSchema.index({ createdBy: 1 });
VideoSchema.index({ uploadedAt: 1 });

// Instance methods
VideoSchema.methods.isReadyToStream = function () {
  if (!this.scheduleTime) return false;
  return this.status === 'scheduled' && this.scheduleTime <= new Date();
};

VideoSchema.methods.canBeDeleted = function () {
  return ['completed', 'failed', 'cancelled'].includes(this.status);
};

// Validation and status-driven timestamps
VideoSchema.pre('save', function (next) {
  // Ensure scheduleTime exists for non-library items
  if (this.status !== 'library' && !this.scheduleTime) {
    return next(new Error('scheduleTime is required'));
  }

  // Progress bounds
  if (typeof this.progress === 'number') {
    if (this.progress < 0 || this.progress > 100) {
      return next(new Error('progress must be between 0 and 100'));
    }
  }

  // Stream key checks: either streamKey (>=16) or usedStreamKey (>=8) must be present when not library
  if (this.status !== 'library') {
    const hasPrimary = typeof this.streamKey === 'string' && this.streamKey.trim().length >= 16;
    const hasOverride = typeof this.usedStreamKey === 'string' && this.usedStreamKey.trim().length >= 8;
    if (!hasPrimary && !hasOverride) {
      return next(new Error('Valid stream key required (video or playlist override)'));
    }
  }

  // Status-driven timestamps
  if (this.isModified('status')) {
    if (this.status === 'streaming') {
      if (!this.streamStartedAt) this.streamStartedAt = new Date();
    }
    if (['completed', 'failed', 'cancelled'].includes(this.status)) {
      if (!this.streamEndedAt) this.streamEndedAt = new Date();
    }
  }

  // Temporal consistency
  if (this.streamStartedAt && this.streamEndedAt && this.streamEndedAt < this.streamStartedAt) {
    return next(new Error('streamEndedAt cannot be earlier than streamStartedAt'));
  }

  // Ensure stopTime (if provided) is not earlier than scheduleTime
  if (this.stopTime && this.scheduleTime && this.stopTime < this.scheduleTime) {
    return next(new Error('stopTime must be later than scheduleTime'));
  }

  next();
});

module.exports = mongoose.model('Video', VideoSchema);