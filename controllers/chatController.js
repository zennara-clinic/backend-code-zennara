const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Admin = require('../models/Admin');
const path = require('path');
const { uploadChatAttachmentToS3, deleteFromS3 } = require('../services/s3Service');

const CHAT_EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const canAccessChat = (req, chat) => Boolean(
  req.admin || (req.user && String(chat.userId) === String(req.user._id))
);

const senderForRequest = (req) => {
  if (req.user) return { senderId: req.user._id, senderModel: 'User', senderName: req.user.fullName };
  if (req.admin) return { senderId: req.admin._id, senderModel: 'Admin', senderName: req.admin.name || 'Admin' };
  return null;
};

const updateChatAfterMessage = async (chat, senderModel, preview) => {
  chat.lastMessage = preview;
  chat.lastMessageTime = new Date();
  if (senderModel === 'User') chat.unreadCount += 1;
  await chat.save();
};

const emitNewMessage = (io, chat, message) => {
  if (!io) return;
  io.to(String(chat._id)).emit('newMessage', message);
  if (message.senderModel === 'User') {
    io.to(`branch_${chat.branchId}`).emit('chatUpdate', {
      chatId: chat._id,
      userId: chat.userId,
      lastMessage: chat.lastMessage,
      unreadCount: chat.unreadCount,
      lastMessageTime: chat.lastMessageTime,
    });
  }
};

const cleanFileName = (name, extension) => {
  const stem = path.basename(String(name || 'attachment'), path.extname(String(name || '')))
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'attachment';
  return `${stem}.${extension}`;
};

// @desc    Get or create chat for a user
// @route   POST /api/chat/initiate
// @access  Private (User)
exports.initiateChat = async (req, res) => {
  try {
    const { branchId } = req.body;
    const userId = req.user._id;

    // Validate branch
    const branch = await Branch.findById(branchId);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Check if chat already exists
    let chat = await Chat.findOne({
      userId,
      branchId,
      status: 'active'
    });

    if (!chat) {
      // Create new chat
      chat = await Chat.create({
        userId,
        branchId,
        branchName: branch.name,
        metadata: {
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
          platform: 'mobile'
        }
      });
    }

    // Populate user details
    await chat.populate('userId', 'fullName email phone');

    res.status(200).json({
      success: true,
      data: chat
    });
  } catch (error) {
    console.error('Error initiating chat:', error);
    res.status(500).json({
      success: false,
      message: 'Error initiating chat',
      error: error.message
    });
  }
};

// @desc    Get all chats for admin by branch
// @route   GET /api/chat/admin/branch/:branchId
// @access  Private (Admin)
exports.getChatsByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { status = 'active', page = 1, limit = 50 } = req.query;

    const query = {
      branchId,
      status
    };

    const chats = await Chat.find(query)
      .populate('userId', 'fullName email phone location')
      .populate('assignedAdmin', 'name email role')
      .populate('branchId', 'name address')
      .sort({ lastMessageTime: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Chat.countDocuments(query);

    res.status(200).json({
      success: true,
      data: chats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting chats by branch:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching chats',
      error: error.message
    });
  }
};

// @desc    Get all chats for a user
// @route   GET /api/chat/user
// @access  Private (User)
exports.getUserChats = async (req, res) => {
  try {
    const userId = req.user._id;

    const chats = await Chat.find({
      userId,
      status: 'active'
    })
      .populate('branchId', 'name address')
      .sort({ lastMessageTime: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: chats
    });
  } catch (error) {
    console.error('Error getting user chats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching chats',
      error: error.message
    });
  }
};

// @desc    Get messages for a chat
// @route   GET /api/chat/:chatId/messages
// @access  Private
exports.getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Verify chat exists and user has access
    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Check authorization - users can only see their own chats, admins can see all
    if (req.user && !req.admin) {
      // User must be the owner of the chat
      if (chat.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized access'
        });
      }
    }
    // Admins have access to all chats, no additional check needed

    const visible = req.user && !req.admin ? { chatId, messageType: { $ne: 'note' } } : { chatId };
    const messages = await Message.find(visible)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Message.countDocuments({ chatId });

    res.status(200).json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting chat messages:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching messages',
      error: error.message
    });
  }
};

// @desc    Send a message
// @route   POST /api/chat/:chatId/messages
// @access  Private
exports.sendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const content = String(req.body.content || '').trim();

    // Verify chat exists
    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    if (!canAccessChat(req, chat)) {
      return res.status(403).json({ success: false, message: 'Unauthorized access' });
    }
    if (chat.status !== 'active') {
      return res.status(409).json({ success: false, message: 'This conversation is closed.' });
    }
    if (!content) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ success: false, message: 'Message is too long. Maximum length is 2,000 characters.' });
    }

    // Determine sender details
    const sender = senderForRequest(req);
    if (!sender) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Private note: staff-only, never leaves the panel (ezConnect "Private Note").
    if (req.admin && req.body.kind === 'note') {
      const note = await Message.create({ chatId, ...sender, content, messageType: 'note', isDelivered: true, deliveredAt: new Date(), metadata: { private: true } });
      emitNewMessage(req.io, chat, note);
      return res.status(201).json({ success: true, data: note });
    }

    // WhatsApp thread: free text only inside 24h of the guest's last message;
    // outside it, a pre-approved template (Twilio Content SID) is required.
    if (chat.channel === 'whatsapp' && req.admin) {
      const wa = require('../services/whatsappService');
      const MessageTemplate = require('../models/MessageTemplate');
      const withinWindow = chat.lastInboundAt && Date.now() - new Date(chat.lastInboundAt).getTime() < 24 * 3600 * 1000;
      let sendResult;
      let outText = content;
      if (req.body.templateId) {
        const tpl = await MessageTemplate.findById(req.body.templateId);
        if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
        const { varsFrom } = require('./messageTemplateController');
        const vars = await varsFrom({ userId: chat.userId, bookingId: req.body.bookingId }, req.admin?.name);
        outText = MessageTemplate.render(tpl.body, vars);
        if (tpl.twilioContentSid) {
          const cv = {}; (tpl.contentVariables || []).forEach((k, i) => { cv[String(i + 1)] = vars[k] ?? ''; });
          sendResult = await wa.sendTemplateMessage(chat.waPhone || '', tpl.twilioContentSid, cv);
        } else if (withinWindow) sendResult = await wa.sendMessage(chat.waPhone || '', outText);
        else return res.status(409).json({ success: false, code: 'WA_WINDOW_CLOSED', message: 'WhatsApp messages can be sent only in response to an incoming message (last 24h). Choose a template that has an approved WhatsApp Content SID.' });
        await MessageTemplate.updateOne({ _id: tpl._id }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } });
      } else {
        if (!withinWindow) return res.status(409).json({ success: false, code: 'WA_WINDOW_CLOSED', message: 'WhatsApp messages can be sent only in response to an incoming message (last 24h). Choose a template.' });
        sendResult = await wa.sendMessage(chat.waPhone || '', outText);
      }
      if (!sendResult?.success) return res.status(502).json({ success: false, message: `WhatsApp did not accept the message: ${sendResult?.error || 'unknown error'}` });
      const waMessage = await Message.create({ chatId, ...sender, content: outText, messageType: req.body.templateId ? 'template' : 'text', isDelivered: false, metadata: { channel: 'whatsapp', sid: sendResult.messageSid, status: sendResult.status || 'queued', template: req.body.templateId || null } });
      await updateChatAfterMessage(chat, sender.senderModel, outText);
      emitNewMessage(req.io, chat, waMessage);
      return res.status(201).json({ success: true, data: waMessage });
    }

    // Create message
    const message = await Message.create({
      chatId,
      ...sender,
      content,
      messageType: 'text',
      isDelivered: true,
      deliveredAt: new Date()
    });

    // Update chat's last message
    await updateChatAfterMessage(chat, sender.senderModel, content);
    emitNewMessage(req.io, chat, message);

    res.status(201).json({
      success: true,
      data: message
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending message',
      error: error.message
    });
  }
};

// @desc    Upload and send an image/document in an existing chat
// @route   POST /api/chat/:chatId/attachments
// @access  Private (owning user or authenticated admin)
exports.sendAttachment = async (req, res) => {
  let uploadedUrl = null;
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!canAccessChat(req, chat)) return res.status(403).json({ success: false, message: 'Unauthorized access' });
    if (chat.status !== 'active') return res.status(409).json({ success: false, message: 'This conversation is closed.' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose a file to send.' });

    const sender = senderForRequest(req);
    if (!sender) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const mimeType = String(req.file.mimetype || '').toLowerCase();
    const extension = CHAT_EXTENSION_BY_MIME[mimeType];
    if (!extension) return res.status(400).json({ success: false, message: 'Unsupported file type.' });

    const fileName = cleanFileName(req.file.originalname, extension);
    const stored = await uploadChatAttachmentToS3(req.file, fileName, extension);
    uploadedUrl = stored.url;
    const kind = mimeType.startsWith('image/') ? 'image' : 'file';
    const caption = String(req.body.caption || '').trim().slice(0, 2000);
    const message = await Message.create({
      chatId: chat._id,
      ...sender,
      messageType: kind,
      content: caption,
      attachment: {
        url: stored.url,
        key: stored.key,
        fileName,
        mimeType,
        size: req.file.size,
        kind,
      },
      isDelivered: true,
      deliveredAt: new Date(),
    });

    const preview = caption || (kind === 'image' ? 'Photo' : `File: ${fileName}`);
    await updateChatAfterMessage(chat, sender.senderModel, preview);
    emitNewMessage(req.io, chat, message);

    return res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (uploadedUrl) await deleteFromS3(uploadedUrl).catch(() => {});
    console.error('Error sending chat attachment:', error);
    return res.status(500).json({ success: false, message: 'Could not send this file. Please try again.' });
  }
};

// @desc    Mark messages as read
// @route   PUT /api/chat/:chatId/read
// @access  Private
exports.markChatAsRead = async (req, res) => {
  try {
    const { chatId } = req.params;

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    if (!canAccessChat(req, chat)) {
      return res.status(403).json({ success: false, message: 'Unauthorized access' });
    }

    // Mark all unread messages as read
    await Message.updateMany(
      {
        chatId,
        isRead: false,
        senderModel: req.admin ? 'User' : 'Admin'
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    );

    // Reset unread count if admin is reading
    if (req.admin) {
      await chat.markAsRead();
    }

    // Emit socket event
    if (req.io) {
      req.io.to(chatId).emit('messagesRead', { chatId });
    }

    res.status(200).json({
      success: true,
      message: 'Chat marked as read'
    });
  } catch (error) {
    console.error('Error marking chat as read:', error);
    res.status(500).json({
      success: false,
      message: 'Error marking chat as read',
      error: error.message
    });
  }
};

// @desc    Close/Archive chat
// @route   PUT /api/chat/:chatId/close
// @access  Private (Admin)
exports.closeChat = async (req, res) => {
  try {
    const { chatId } = req.params;

    const chat = await Chat.findByIdAndUpdate(
      chatId,
      { status: 'closed' },
      { new: true }
    );

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Emit socket event
    if (req.io) {
      req.io.to(chatId).emit('chatClosed', { chatId });
    }

    res.status(200).json({
      success: true,
      data: chat
    });
  } catch (error) {
    console.error('Error closing chat:', error);
    res.status(500).json({
      success: false,
      message: 'Error closing chat',
      error: error.message
    });
  }
};

// @desc    Get chat statistics for admin
// @route   GET /api/chat/admin/stats
// @access  Private (Admin)
exports.getChatStats = async (req, res) => {
  try {
    const { branchId } = req.query;

    // ObjectId is a class from Mongoose 7 on — calling it without `new` throws
    // "Class constructor ObjectId cannot be invoked without 'new'", which made
    // this endpoint 500 for any caller that passed a branchId.
    const matchStage = branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {};

    const stats = await Chat.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalUnread: { $sum: '$unreadCount' }
        }
      }
    ]);

    const branchStats = await Chat.aggregate([
      {
        $group: {
          _id: '$branchId',
          activeChats: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          totalUnread: { $sum: '$unreadCount' }
        }
      },
      {
        $lookup: {
          from: 'branches',
          localField: '_id',
          foreignField: '_id',
          as: 'branch'
        }
      },
      { $unwind: '$branch' },
      {
        $project: {
          branchId: '$_id',
          branchName: '$branch.name',
          activeChats: 1,
          totalUnread: 1
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        overall: stats,
        byBranch: branchStats
      }
    });
  } catch (error) {
    console.error('Error getting chat stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching chat statistics',
      error: error.message
    });
  }
};

// @desc    Assign chat to admin
// @route   PUT /api/chat/:chatId/assign
// @access  Private (Admin)
exports.assignChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { adminId } = req.body;

    const chat = await Chat.findByIdAndUpdate(
      chatId,
      { assignedAdmin: adminId || null },
      { new: true }
    ).populate('assignedAdmin', 'name email role');

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // A system line in the thread so the guest knows who they are talking to.
    if (chat.assignedAdmin) {
      const sys = await Message.create({
        chatId: chat._id,
        senderId: req.admin._id,
        senderModel: 'Admin',
        senderName: 'Zennara',
        content: `${chat.assignedAdmin.name} has joined the conversation`,
        messageType: 'system',
        isDelivered: true,
        deliveredAt: new Date()
      });
      if (req.io) req.io.to(String(chat._id)).emit('newMessage', sys);
    }
    if (req.io) {
      req.io.to(`branch_${chat.branchId}`).emit('chatUpdate', {
        chatId: chat._id,
        assignedAdmin: chat.assignedAdmin
      });
    }

    res.status(200).json({
      success: true,
      data: chat
    });
  } catch (error) {
    console.error('Error assigning chat:', error);
    res.status(500).json({
      success: false,
      message: 'Error assigning chat',
      error: error.message
    });
  }
};

// @desc    Delete a message
// @route   DELETE /api/chat/messages/:messageId
// @access  Private (User or Admin - can only delete own messages)
exports.deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userType = req.admin ? 'Admin' : 'User';
    const userId = req.admin?._id || req.user?._id;

    // Find the message
    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is authorized to delete (only can delete own messages)
    if (message.senderId.toString() !== userId.toString() || message.senderModel !== userType) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own messages'
      });
    }

    // Delete the message
    await Message.findByIdAndDelete(messageId);
    if (message.attachment?.url) await deleteFromS3(message.attachment.url);

    // Emit socket event to notify other party
    if (req.io) {
      req.io.to(message.chatId.toString()).emit('messageDeleted', {
        messageId: message._id,
        chatId: message.chatId
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully',
      data: { messageId: message._id }
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting message',
      error: error.message
    });
  }
};


// @desc    Messages from the clinic the guest has not read yet (for the app badge)
// @route   GET /api/chat/user/unread
// @access  Private (User)
exports.getUserUnread = async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user._id }).select('_id').lean();
    const ids = chats.map((c) => c._id);
    const count = ids.length
      ? await Message.countDocuments({ chatId: { $in: ids }, senderModel: 'Admin', messageType: 'text', isRead: false })
      : 0;
    res.status(200).json({ success: true, data: { unreadCount: count } });
  } catch (error) {
    console.error('Error counting unread:', error);
    res.status(500).json({ success: false, message: 'Error counting unread messages' });
  }
};


/* ------------------------------------------------------------------------ */
/* WhatsApp channel (Twilio) — the guest's WhatsApp thread in the desk inbox  */
/* ------------------------------------------------------------------------ */

function twilioSignatureOk(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // not configured → accept (dev)
  try {
    const twilio = require('twilio');
    const url = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}${req.originalUrl}`;
    return twilio.validateRequest(token, req.headers['x-twilio-signature'] || '', url, req.body || {});
  } catch { return true; }
}

const e164 = (v) => { const d = String(v || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, ''); if (!d) return null; if (d.startsWith('+')) return d; return d.length === 10 ? `+91${d}` : `+${d}`; };

/**
 * POST /api/chat/whatsapp/inbound — Twilio webhook for an incoming WhatsApp
 * message. Finds the guest by phone (creates a contact when unknown, as
 * ezConnect does), opens or reuses their WhatsApp thread at the centre the
 * number belongs to, stores the message (+ media links) and pushes it live.
 */
exports.whatsappInbound = async (req, res) => {
  try {
    if (!twilioSignatureOk(req)) return res.status(403).send('bad signature');
    const from = e164(req.body.From); const to = e164(req.body.To);
    const body = String(req.body.Body || '').trim();
    const numMedia = Number(req.body.NumMedia) || 0;
    if (!from) return res.status(400).send('no sender');
    const digits = from.replace(/^\+91/, '').replace(/\D/g, '');
    let user = await User.findOne({ $or: [{ phone: digits }, { phone: from }, { phone: new RegExp(`${digits}$`) }] });
    if (!user) {
      user = await User.create({ fullName: String(req.body.ProfileName || '').trim() || `WhatsApp ${digits.slice(-4)}`, phone: digits, email: `wa.${digits}@zennara.local`, isVerified: false, referralSource: 'WhatsApp' });
    }
    let branch = to ? await Branch.findOne({ 'messaging.whatsappNumber': { $in: [to, to.replace('+', ''), `whatsapp:${to}`] } }).lean() : null;
    if (!branch && user.location) branch = await Branch.findOne({ name: user.location }).lean();
    if (!branch) branch = await Branch.findOne({ isActive: true }).sort({ displayOrder: 1 }).lean();
    let chat = await Chat.findOne({ userId: user._id, channel: 'whatsapp', status: { $ne: 'archived' } }).sort({ lastMessageTime: -1 });
    if (!chat) chat = await Chat.create({ userId: user._id, branchId: branch?._id, branchName: branch?.name || '', channel: 'whatsapp', waPhone: from, status: 'active', lastMessage: '', unreadCount: 0 });
    else if (chat.status === 'closed') chat.status = 'active';
    chat.waPhone = from; chat.lastInboundAt = new Date();
    const media = []; for (let i = 0; i < numMedia; i += 1) media.push({ url: req.body[`MediaUrl${i}`], contentType: req.body[`MediaContentType${i}`] });
    const content = body || (media.length ? `[${media.length} attachment${media.length === 1 ? '' : 's'}]` : '(empty message)');
    const message = await Message.create({ chatId: chat._id, senderId: user._id, senderModel: 'User', senderName: user.fullName, content, messageType: 'text', isDelivered: true, deliveredAt: new Date(), metadata: { channel: 'whatsapp', sid: req.body.MessageSid || null, media, profileName: req.body.ProfileName || null } });
    await updateChatAfterMessage(chat, 'User', content);
    emitNewMessage(req.io, chat, message);
    res.type('text/xml').send('<Response></Response>');
  } catch (error) {
    console.error('WhatsApp inbound error:', error);
    res.status(500).send('error');
  }
};

/** POST /api/chat/whatsapp/status — Twilio delivery receipts (sent / delivered / read / failed). */
exports.whatsappStatus = async (req, res) => {
  try {
    if (!twilioSignatureOk(req)) return res.status(403).send('bad signature');
    const sid = req.body.MessageSid || req.body.SmsSid; const status = req.body.MessageStatus || req.body.SmsStatus;
    if (sid && status) {
      const set = { 'metadata.status': status };
      if (['delivered', 'read'].includes(status)) { set.isDelivered = true; set.deliveredAt = new Date(); }
      if (status === 'read') { set.isRead = true; set.readAt = new Date(); }
      if (status === 'failed' || status === 'undelivered') set['metadata.error'] = req.body.ErrorMessage || req.body.ErrorCode || 'failed';
      const m = await Message.findOneAndUpdate({ 'metadata.sid': sid }, { $set: set }, { new: true });
      if (m && req.io) req.io.to(String(m.chatId)).emit('messageStatus', { messageId: m._id, status });
    }
    res.type('text/xml').send('<Response></Response>');
  } catch (error) { res.status(500).send('error'); }
};

/** PUT /api/chat/admin/:chatId/tags { tags: [], pinned? } — ezConnect "Assign Tag" / Pinned. */
exports.setChatTags = async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (Array.isArray(req.body.tags)) chat.tags = req.body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
    if (req.body.pinned !== undefined) chat.pinned = !!req.body.pinned;
    await chat.save();
    return res.json({ success: true, data: chat });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

/**
 * POST /api/chat/admin/start-whatsapp { userId, templateId, bookingId? } —
 * open (or reuse) a guest's WhatsApp thread from the desk and send a template
 * (the only way to start a conversation outside the 24h window).
 */
exports.startWhatsApp = async (req, res) => {
  try {
    const { userId, templateId, bookingId } = req.body || {};
    const user = await User.findById(userId);
    if (!user || !user.phone) return res.status(404).json({ success: false, message: 'Guest with a phone number not found' });
    const MessageTemplate = require('../models/MessageTemplate');
    const tpl = templateId ? await MessageTemplate.findById(templateId) : null;
    if (!tpl) return res.status(400).json({ success: false, message: 'Choose a template to start a WhatsApp conversation.' });
    let branch = req.body.branchId ? await Branch.findById(req.body.branchId).lean() : null;
    if (!branch && user.location) branch = await Branch.findOne({ name: user.location }).lean();
    if (!branch) branch = await Branch.findOne({ isActive: true }).sort({ displayOrder: 1 }).lean();
    let chat = await Chat.findOne({ userId: user._id, channel: 'whatsapp', status: { $ne: 'archived' } }).sort({ lastMessageTime: -1 });
    if (!chat) chat = await Chat.create({ userId: user._id, branchId: branch?._id, branchName: branch?.name || '', channel: 'whatsapp', waPhone: e164(user.phone), status: 'active', lastMessage: '', unreadCount: 0 });
    if (chat.status === 'closed') { chat.status = 'active'; await chat.save(); }
    req.params.chatId = String(chat._id);
    req.body = { templateId: tpl._id, bookingId, content: tpl.name };
    return exports.sendMessage(req, res);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};
