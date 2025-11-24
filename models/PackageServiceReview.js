const mongoose = require('mongoose');

const packageServiceReviewSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  packageAssignmentId: {
    type: String,
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
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  reviewText: {
    type: String,
    required: true,
    minlength: 10,
    maxlength: 1000
  },
  isApproved: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for faster lookups
packageServiceReviewSchema.index({ userId: 1, packageAssignmentId: 1, serviceId: 1 });
packageServiceReviewSchema.index({ serviceId: 1, isApproved: 1 });

const PackageServiceReview = mongoose.model('PackageServiceReview', packageServiceReviewSchema);

module.exports = PackageServiceReview;
