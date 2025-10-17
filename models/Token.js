const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'userType',
    required: true,
    index: true
  },
  userType: {
    type: String,
    enum: ['User', 'Admin'],
    default: 'User'
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: ['access', 'refresh', 'admin_access'],
    default: 'access'
  },
  deviceInfo: {
    platform: String,
    deviceId: String,
    deviceName: String,
    appVersion: String
  },
  ipAddress: String,
  location: {
    country: String,
    city: String
  },
  trustedDevice: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  lastUsedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for auto-deletion of expired tokens
TokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Method to check if token is valid
TokenSchema.methods.isValid = function() {
  return this.isActive && this.expiresAt > new Date();
};

// Method to revoke token
TokenSchema.methods.revoke = function() {
  this.isActive = false;
  return this.save();
};

// Static method to clean up expired tokens
TokenSchema.statics.cleanupExpired = async function() {
  return this.deleteMany({
    expiresAt: { $lt: new Date() }
  });
};

// Static method to revoke all user tokens
TokenSchema.statics.revokeAllUserTokens = async function(userId) {
  return this.updateMany(
    { userId, isActive: true },
    { isActive: false }
  );
};

// Static method to get active sessions for user
TokenSchema.statics.getActiveSessions = async function(userId) {
  return this.find({
    userId,
    isActive: true,
    expiresAt: { $gt: new Date() }
  })
    .sort({ lastUsedAt: -1 })
    .lean();
};

// Static method to create token pair (access + refresh)
TokenSchema.statics.createTokenPair = async function(userId, deviceInfo, ipAddress) {
  const jwt = require('jsonwebtoken');
  
  // Create access token (15 minutes)
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  // Create refresh token (7 days)
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  const now = new Date();
  const accessExpiry = new Date(now.getTime() + 15 * 60 * 1000); // 15 min
  const refreshExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  // Save both tokens
  await this.create([
    {
      userId,
      token: accessToken,
      type: 'access',
      deviceInfo,
      ipAddress,
      expiresAt: accessExpiry,
      isActive: true
    },
    {
      userId,
      token: refreshToken,
      type: 'refresh',
      deviceInfo,
      ipAddress,
      expiresAt: refreshExpiry,
      isActive: true
    }
  ]);
  
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiry,
    refreshExpiresAt: refreshExpiry
  };
};

module.exports = mongoose.model('Token', TokenSchema);
