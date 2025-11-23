const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true
  },
  branchName: {
    type: String,
    required: true
  },
  lastMessage: {
    type: String,
    default: ''
  },
  lastMessageTime: {
    type: Date,
    default: Date.now
  },
  unreadCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'archived'],
    default: 'active',
    index: true
  },
  assignedAdmin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  tags: [{
    type: String
  }],
  metadata: {
    userAgent: String,
    ipAddress: String,
    platform: String
  }
}, {
  timestamps: true
});

// Indexes for better query performance
chatSchema.index({ userId: 1, branchId: 1 });
chatSchema.index({ status: 1, lastMessageTime: -1 });
chatSchema.index({ branchId: 1, status: 1, lastMessageTime: -1 });

// Virtual for populating messages
chatSchema.virtual('messages', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'chatId'
});

// Method to mark messages as read
chatSchema.methods.markAsRead = function() {
  this.unreadCount = 0;
  return this.save();
};

// Method to update last message
chatSchema.methods.updateLastMessage = function(messageText) {
  this.lastMessage = messageText;
  this.lastMessageTime = new Date();
  return this.save();
};

const Chat = mongoose.model('Chat', chatSchema);

module.exports = Chat;
