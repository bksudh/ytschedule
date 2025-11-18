const mongoose = require('mongoose');

const ExternalJobSchema = new mongoose.Schema(
  {
    sourceUrl: { type: String, required: true, trim: true },
    rtmpUrl: { type: String, required: true, trim: true },
    streamKey: { type: String, required: true, trim: true },
    scheduleTime: { type: Date, required: true },
    stopTime: { type: Date },
    status: { type: String, enum: ['scheduled', 'streaming', 'completed', 'failed', 'cancelled'], default: 'scheduled' },
    progress: { type: Number, default: 0 },
    streamId: { type: String },
    startedAt: { type: Date },
    endedAt: { type: Date },
    lastOutputUrl: { type: String },
    errorMessage: { type: String },
    createdBy: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ExternalJobSchema.index({ status: 1, scheduleTime: 1 });
ExternalJobSchema.index({ status: 1, stopTime: 1 });
ExternalJobSchema.index({ createdBy: 1 });

module.exports = mongoose.model('ExternalJob', ExternalJobSchema);