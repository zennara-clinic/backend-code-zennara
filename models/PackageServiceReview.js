const mongoose = require('mongoose');

const packageServiceReviewSchema = new mongoose.Schema({
  assignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PackageAssignment',
    required: true
  },
  serviceId: {
    type: String,
    required: true
  },
  serviceName: {
    type: String,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  review: {
    type: String,
    required: false,
    maxlength: 1000
  },
  staffRating: {
    doctor: {
      type: Number,
      min: 1,
      max: 5
    },
    therapist: {
      type: Number,
      min: 1,
      max: 5
    },
    manager: {
      type: Number,
      min: 1,
      max: 5
    }
  },
  wouldRecommend: {
    type: Boolean,
    required: true
  },
  serviceQuality: {
    type: Number,
    min: 1,
    max: 5
  },
  facilityCleanliness: {
    type: Number,
    min: 1,
    max: 5
  },
  waitTime: {
    type: Number,
    min: 1,
    max: 5
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  adminResponse: {
    text: String,
    respondedAt: Date,
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    }
  }
}, {
  timestamps: true
});

// Index for efficient queries
packageServiceReviewSchema.index({ assignmentId: 1, serviceId: 1 });
packageServiceReviewSchema.index({ userId: 1 });
packageServiceReviewSchema.index({ serviceId: 1 });

const PackageServiceReview = mongoose.model('PackageServiceReview', packageServiceReviewSchema);

module.exports = PackageServiceReview;
