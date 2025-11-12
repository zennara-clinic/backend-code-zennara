const mongoose = require('mongoose');

const treatmentRatingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  treatmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Treatment',
    required: [true, 'Treatment ID is required']
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
  // No review text for treatments - only rating
  isVerified: {
    type: Boolean,
    default: true // Since ratings can only be submitted after completed treatment
  }
}, {
  timestamps: true
});

// Indexes for better query performance
treatmentRatingSchema.index({ treatmentId: 1 });
treatmentRatingSchema.index({ userId: 1 });
treatmentRatingSchema.index({ bookingId: 1 });
treatmentRatingSchema.index({ rating: 1 });

// Prevent duplicate ratings for same treatment booking
treatmentRatingSchema.index({ userId: 1, treatmentId: 1, bookingId: 1 }, { unique: true });

module.exports = mongoose.model('TreatmentRating', treatmentRatingSchema);
