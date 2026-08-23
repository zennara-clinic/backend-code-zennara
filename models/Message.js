const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    required: true,
    index: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'senderModel'
  },
  senderModel: {
    type: String,
    required: true,
    enum: ['User', 'Admin']
  },
  senderName: {
    type: String,
    required: true
  },
  messageType: {
    type: String,
    enum: ['text', 'image', 'file', 'system'],
    default: 'text'
  },
  content: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  attachment: {
    url: { type: String, trim: true },
    key: { type: String, trim: true },
    fileName: { type: String, trim: true, maxlength: 180 },
    mimeType: { type: String, trim: true, maxlength: 120 },
    size: { type: Number, min: 0 },
    kind: { type: String, enum: ['image', 'file'] }
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  },
  isDelivered: {
    type: Boolean,
    default: false
  },
  deliveredAt: {
    type: Date
  },
  metadata: {
    editedAt: Date,
    deletedAt: Date,
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message'
    }
  }
}, {
  timestamps: true
});

// Indexes for better query performance
messageSchema.index({ chatId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, senderModel: 1 });

messageSchema.pre('validate', function validateMessagePayload(next) {
  const hasText = Boolean(this.content && this.content.trim());
  const hasAttachment = Boolean(this.attachment && this.attachment.url);
  if (this.messageType !== 'system' && !hasText && !hasAttachment) {
    return next(new Error('A message must contain text or an attachment'));
  }
  if ((this.messageType === 'image' || this.messageType === 'file') && !hasAttachment) {
    return next(new Error('Attachment metadata is required for file messages'));
  }
  next();
});

// Method to mark message as read
messageSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

// Method to mark message as delivered
messageSchema.methods.markAsDelivered = function() {
  this.isDelivered = true;
  this.deliveredAt = new Date();
  return this.save();
};

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
