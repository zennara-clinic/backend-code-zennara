const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: ['access', 'refresh'],
    default: 'access'
  },
  deviceInfo: {
    platform: String,
    deviceId: String,
    appVersion: String
  },
  ipAddress: String,
  isActive: {
    type: Boolean,
    default: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
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

module.exports = mongoose.model('Token', TokenSchema);
