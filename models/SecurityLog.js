const mongoose = require('mongoose');

const SecurityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  eventType: {
    type: String,
    enum: [
      'login_success',
      'login_failed',
      'otp_requested',
      'otp_verified',
      'otp_failed',
      'account_locked',
      'account_unlocked',
      'profile_updated',
      'password_changed',
      'email_changed',
      'phone_changed',
      'logout',
      'session_created',
      'session_revoked'
    ],
    required: true,
    index: true
  },
  ipAddress: String,
  userAgent: String,
  deviceInfo: {
    platform: String,
    deviceId: String,
    appVersion: String
  },
  location: {
    country: String,
    city: String,
    coordinates: {
      latitude: Number,
      longitude: Number
    }
  },
  metadata: mongoose.Schema.Types.Mixed, // Additional event-specific data
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low'
  },
  success: {
    type: Boolean,
    default: true
  },
  errorMessage: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
SecurityLogSchema.index({ userId: 1, eventType: 1, createdAt: -1 });
SecurityLogSchema.index({ eventType: 1, createdAt: -1 });
SecurityLogSchema.index({ createdAt: -1 });

// TTL index - auto-delete logs older than 90 days
SecurityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

// Static method to log event
SecurityLogSchema.statics.logEvent = async function(userId, eventType, data = {}) {
  try {
    const log = await this.create({
      userId,
      eventType,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      deviceInfo: data.deviceInfo,
      location: data.location,
      metadata: data.metadata,
      severity: data.severity || 'low',
      success: data.success !== undefined ? data.success : true,
      errorMessage: data.errorMessage
    });
    return log;
  } catch (error) {
    console.error('❌ Failed to log security event:', error);
    // Don't throw - logging should never break the main flow
    return null;
  }
};

// Static method to get user activity
SecurityLogSchema.statics.getUserActivity = async function(userId, limit = 20) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// Static method to detect suspicious activity
SecurityLogSchema.statics.detectSuspiciousActivity = async function(userId) {
  const oneHour = 60 * 60 * 1000;
  const oneDayAgo = new Date(Date.now() - 24 * oneHour);
  
  // Count failed login attempts in last 24 hours
  const failedLogins = await this.countDocuments({
    userId,
    eventType: { $in: ['login_failed', 'otp_failed'] },
    createdAt: { $gte: oneDayAgo }
  });
  
  // Count OTP requests in last hour
  const recentOtpRequests = await this.countDocuments({
    userId,
    eventType: 'otp_requested',
    createdAt: { $gte: new Date(Date.now() - oneHour) }
  });
  
  return {
    isSuspicious: failedLogins > 5 || recentOtpRequests > 3,
    failedLogins,
    recentOtpRequests
  };
};

module.exports = mongoose.model('SecurityLog', SecurityLogSchema);
