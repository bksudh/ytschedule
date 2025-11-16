const mongoose = require('mongoose');

const VideoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    filename: { type: String, required: true, trim: true },
    filepath: { type: String, required: true, trim: true },
    filesize: { type: Number, min: 0 },
    duration: { type: Number, min: 0 }, // seconds
    scheduleTime: { type: Date, required: true, index: true },
    // Optional planned stop time for auto-stopping the stream
    stopTime: { type: Date, required: false, index: true },
    rtmpUrl: { type: String, required: true, trim: true },
    streamKey: { type: String, required: true, trim: true }, // store encrypted value
    status: {
      type: String,
      enum: ['scheduled', 'streaming', 'completed', 'failed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    errorMessage: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    streamStartedAt: { type: Date },
    streamEndedAt: { type: Date },
    createdBy: { type: String },
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
  // Ensure scheduleTime exists (schema requires it, but double-check for clarity)
  if (!this.scheduleTime) {
    return next(new Error('scheduleTime is required'));
  }

  // Progress bounds
  if (typeof this.progress === 'number') {
    if (this.progress < 0 || this.progress > 100) {
      return next(new Error('progress must be between 0 and 100'));
    }
  }

  // Stream key should not be obviously plain text (basic sanity checks)
  if (typeof this.streamKey !== 'string' || this.streamKey.trim().length < 16) {
    return next(new Error('streamKey must be provided and appear encrypted (min length 16)'));
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