const mongoose = require('mongoose');

const consultationReviewSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  consultationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Consultation',
    required: [true, 'Consultation ID is required']
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: [true, 'Booking ID is required']
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
  isVerified: {
    type: Boolean,
    default: true // Since reviews can only be submitted after completed consultation
  },
  helpfulCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isApproved: {
    type: Boolean,
    default: true // Auto-approve, can add moderation later
  }
}, {
  timestamps: true
});

// Indexes for better query performance
consultationReviewSchema.index({ consultationId: 1, createdAt: -1 });
consultationReviewSchema.index({ userId: 1 });
consultationReviewSchema.index({ bookingId: 1 });
consultationReviewSchema.index({ rating: 1 });
consultationReviewSchema.index({ isApproved: 1 });

// Prevent duplicate reviews for same consultation booking
consultationReviewSchema.index({ userId: 1, consultationId: 1, bookingId: 1 }, { unique: true });

module.exports = mongoose.model('ConsultationReview', consultationReviewSchema);
