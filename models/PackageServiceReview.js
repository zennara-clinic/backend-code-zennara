const mongoose = require('mongoose');

const packageServiceReviewSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  assignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PackageAssignment',
    required: [true, 'Package Assignment ID is required']
  },
  serviceId: {
    type: String,
    required: [true, 'Service ID is required']
  },
  serviceName: {
    type: String,
    required: [true, 'Service name is required']
  },
  rating: {
    type: Number,
    required: [true, 'Rating is required'],
    min: [1, 'Rating must be at least 1'],
    max: [5, 'Rating cannot exceed 5']
  },
  reviewText: {
    type: String,
    required: [true, 'Review text is required'],
    trim: true,
    minlength: [10, 'Review must be at least 10 characters'],
    maxlength: [1000, 'Review cannot exceed 1000 characters']
  },
  staffRatings: {
    doctor: {
      rating: {
        type: Number,
        min: 1,
        max: 5
      },
      name: String
    },
    therapist: {
      rating: {
        type: Number,
        min: 1,
        max: 5
      },
      name: String
    },
    manager: {
      rating: {
        type: Number,
        min: 1,
        max: 5
      },
      name: String
    }
  },
  treatmentExperience: {
    reliefGrading: {
      type: Number,
      min: 0,
      max: 10
    },
    satisfaction: {
      type: Number,
      min: 1,
      max: 5
    },
    wouldRecommend: {
      type: Boolean,
      default: null
    }
  },
  images: [{
    type: String,
    trim: true
  }],
  isVerifiedTreatment: {
    type: Boolean,
    default: true // Since reviews can only be submitted after completed service
  },
  isApproved: {
    type: Boolean,
    default: true // Auto-approve, can add moderation later
  },
  helpfulCount: {
    type: Number,
    default: 0,
    min: 0
  },
  reportCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isReported: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for better query performance
packageServiceReviewSchema.index({ assignmentId: 1, serviceId: 1 });
packageServiceReviewSchema.index({ userId: 1 });
packageServiceReviewSchema.index({ serviceId: 1 });
packageServiceReviewSchema.index({ rating: 1 });
packageServiceReviewSchema.index({ isApproved: 1 });
packageServiceReviewSchema.index({ createdAt: -1 });

// Prevent duplicate reviews for same service in same assignment
packageServiceReviewSchema.index({ userId: 1, assignmentId: 1, serviceId: 1 }, { unique: true });

module.exports = mongoose.model('PackageServiceReview', packageServiceReviewSchema);
