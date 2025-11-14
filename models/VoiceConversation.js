const mongoose = require('mongoose');

const voiceConversationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  conversations: [{
    timestamp: {
      type: Date,
      default: Date.now
    },
    userQuery: {
      type: String,
      required: true
    },
    userQueryType: {
      type: String,
      enum: ['text', 'voice'],
      default: 'text'
    },
    aiResponse: {
      type: String,
      required: true
    },
    responseType: {
      type: String,
      enum: ['text', 'audio'],
      default: 'text'
    },
    audioUrl: {
      type: String,
      default: null
    },
    context: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    sentiment: {
      type: String,
      enum: ['positive', 'neutral', 'negative', 'unknown'],
      default: 'unknown'
    },
    duration: {
      type: Number, // in seconds
      default: 0
    }
  }],
  metadata: {
    device: {
      type: String,
      default: 'unknown'
    },
    platform: {
      type: String,
      default: 'unknown'
    },
    appVersion: {
      type: String,
      default: 'unknown'
    },
    location: {
      type: String,
      default: null
    }
  },
  voiceSettings: {
    voiceId: {
      type: String,
      default: 'en-US-wayne'
    },
    model: {
      type: String,
      default: 'Falcon'
    },
    language: {
      type: String,
      default: 'en-US'
    }
  },
  totalInteractions: {
    type: Number,
    default: 0
  },
  averageResponseTime: {
    type: Number, // in milliseconds
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  endedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
voiceConversationSchema.index({ userId: 1, createdAt: -1 });
voiceConversationSchema.index({ sessionId: 1 });
voiceConversationSchema.index({ isActive: 1 });

// Pre-save middleware to update totalInteractions
voiceConversationSchema.pre('save', function(next) {
  if (this.isModified('conversations')) {
    this.totalInteractions = this.conversations.length;
  }
  next();
});

// Method to add a conversation
voiceConversationSchema.methods.addConversation = function(userQuery, aiResponse, options = {}) {
  this.conversations.push({
    userQuery,
    aiResponse,
    userQueryType: options.userQueryType || 'text',
    responseType: options.responseType || 'text',
    audioUrl: options.audioUrl || null,
    context: options.context || {},
    sentiment: options.sentiment || 'unknown',
    duration: options.duration || 0
  });
  
  this.totalInteractions = this.conversations.length;
  return this.save();
};

// Method to end conversation session
voiceConversationSchema.methods.endSession = function() {
  this.isActive = false;
  this.endedAt = new Date();
  return this.save();
};

// Static method to create new session
voiceConversationSchema.statics.createSession = async function(userId, metadata = {}, voiceSettings = {}) {
  const sessionId = `VS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  return this.create({
    userId,
    sessionId,
    metadata: {
      device: metadata.device || 'unknown',
      platform: metadata.platform || 'unknown',
      appVersion: metadata.appVersion || 'unknown',
      location: metadata.location || null
    },
    voiceSettings: {
      voiceId: voiceSettings.voiceId || 'en-US-wayne',
      model: voiceSettings.model || 'Falcon',
      language: voiceSettings.language || 'en-US'
    }
  });
};

// Static method to get active session for user
voiceConversationSchema.statics.getActiveSession = async function(userId) {
  return this.findOne({
    userId,
    isActive: true
  }).sort({ createdAt: -1 });
};

// Static method to get user's conversation history
voiceConversationSchema.statics.getUserHistory = async function(userId, limit = 10) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-conversations.context'); // Exclude context for privacy
};

// Virtual for session duration
voiceConversationSchema.virtual('sessionDuration').get(function() {
  if (!this.endedAt) {
    return Date.now() - this.createdAt.getTime();
  }
  return this.endedAt.getTime() - this.createdAt.getTime();
});

module.exports = mongoose.model('VoiceConversation', voiceConversationSchema);
