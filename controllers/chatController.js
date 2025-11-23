const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Admin = require('../models/Admin');

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

    const messages = await Message.find({ chatId })
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Message.countDocuments({ chatId });

    // Reverse messages to show oldest first
    messages.reverse();

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
    const { content, messageType = 'text', attachments = [] } = req.body;

    // Verify chat exists
    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Determine sender details
    let senderId, senderModel, senderName;
    
    if (req.user) {
      senderId = req.user._id;
      senderModel = 'User';
      senderName = req.user.fullName;
    } else if (req.admin) {
      senderId = req.admin._id;
      senderModel = 'Admin';
      senderName = req.admin.name || 'Admin';
    } else {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Create message
    const message = await Message.create({
      chatId,
      senderId,
      senderModel,
      senderName,
      content,
      messageType,
      attachments,
      isDelivered: true,
      deliveredAt: new Date()
    });

    // Update chat's last message
    await chat.updateLastMessage(content);

    // If message is from user, increment unread count
    if (senderModel === 'User') {
      chat.unreadCount += 1;
      await chat.save();
    }

    // Emit socket event (handled by socket.io)
    if (req.io) {
      req.io.to(chatId).emit('newMessage', message);
      
      // Notify admin about new message from user
      if (senderModel === 'User') {
        req.io.to(`branch_${chat.branchId}`).emit('chatUpdate', {
          chatId: chat._id,
          lastMessage: content,
          unreadCount: chat.unreadCount,
          lastMessageTime: chat.lastMessageTime
        });
      }
    }

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

    const matchStage = branchId ? { branchId: mongoose.Types.ObjectId(branchId) } : {};

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
      { assignedAdmin: adminId },
      { new: true }
    ).populate('assignedAdmin', 'name email');

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
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
