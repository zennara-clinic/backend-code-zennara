const mongoose = require('mongoose');

/** One row per roster import / crawl window, so the panel can show sync health. */
const ZenotiSyncRunSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['roster', 'details'], required: true },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    trigger: { type: String, enum: ['schedule', 'manual', 'boot'], default: 'schedule' },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

ZenotiSyncRunSchema.index({ type: 1, startedAt: -1 });

module.exports = mongoose.model('ZenotiSyncRun', ZenotiSyncRunSchema);
