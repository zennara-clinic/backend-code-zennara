const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  // User Reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Booking Reference Number (e.g., ZEN202510078473) - Auto-generated
  referenceNumber: {
    type: String,
    unique: true,
    index: true
  },

  // Consultation/Treatment Reference
  consultationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Consultation',
    required: true,
    index: true
  },

  // Personal Details
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  mobileNumber: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },

  // Location & Schedule
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true
  },
  preferredLocation: {
    type: String,
    required: true,
    index: true
  },
  preferredDate: {
    type: Date,
    required: true,
    index: true
  },
  preferredTimeSlots: [{
    type: String,
    required: true
  }],

  // Booking Status
  status: {
    type: String,
    required: true,
    enum: [
      'Awaiting Confirmation',
      'Confirmed',
      'Rescheduled',
      'In Progress',
      'Cancelled',
      'No Show',
      'Completed'
    ],
    default: 'Awaiting Confirmation',
    index: true
  },

  // Session Details (for Confirmed and later statuses)
  confirmedDate: Date,
  confirmedTime: String,
  checkInTime: Date,
  checkOutTime: Date,
  sessionDuration: Number, // in minutes

  // Cancellation & Reschedule Info
  cancellationReason: String,
  cancelledAt: Date,
  rescheduledFrom: {
    date: Date,
    time: String
  },
  rescheduledAt: Date,

  // Rating & Feedback
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  feedback: String,
  ratedAt: Date,

  // Metadata
  notes: String,
  adminNotes: String,

}, {
  timestamps: true
});

// Generate unique reference number
bookingSchema.pre('save', async function(next) {
  if (!this.referenceNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.referenceNumber = `ZEN${year}${month}${day}${random}`;
  }
  next();
});

// Index for efficient queries
bookingSchema.index({ userId: 1, status: 1 });
bookingSchema.index({ preferredDate: 1, preferredLocation: 1 });
bookingSchema.index({ createdAt: -1 });

// Virtual for formatted date
bookingSchema.virtual('formattedDate').get(function() {
  if (!this.confirmedDate && !this.preferredDate) return '';
  const date = this.confirmedDate || this.preferredDate;
  return date.toLocaleDateString('en-US', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  });
});

// Method to check if booking can be cancelled
bookingSchema.methods.canBeCancelled = function() {
  return ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'].includes(this.status);
};

// Method to check if booking can be rescheduled
bookingSchema.methods.canBeRescheduled = function() {
  return ['Confirmed', 'No Show'].includes(this.status);
};

module.exports = mongoose.model('Booking', bookingSchema);
