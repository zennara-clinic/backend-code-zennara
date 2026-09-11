const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { deleteFromS3 } = require('./s3Service');

const connectedUsers = new Map();
const connectedAdmins = new Map();

/**
 * The live server, kept so services outside the socket layer (the booking
 * lifecycle, for one) can push an update to every open panel the instant a
 * status moves — the day book must not wait for its next poll to show that a
 * guest has been checked in.
 */
let ioRef = null;

const setupSocketIO = (io) => {
  ioRef = io;
  // Authentication middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      const userType = socket.handshake.auth.userType || 'user'; // 'user' or 'admin'

      console.log(`Socket auth attempt - UserType: ${userType}, Token present: ${!!token}`);

      if (!token) {
        console.error('Socket auth failed: No token provided');
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('Socket JWT decoded:', { 
        userId: decoded.userId, 
        adminId: decoded.adminId, 
        role: decoded.role,
        userType 
      });

      if (userType === 'admin') {
        // Admin tokens use 'adminId' field
        const adminId = decoded.adminId || decoded.id;
        if (!adminId) {
          return next(new Error('Invalid admin token'));
        }
        const admin = await Admin.findById(adminId);
        if (!admin) {
          return next(new Error('Admin not found'));
        }
        socket.admin = admin;
        socket.userType = 'admin';
      } else {
        // User tokens use 'userId' field
        const userId = decoded.userId || decoded.id;
        if (!userId) {
          return next(new Error('Invalid user token'));
        }
        const user = await User.findById(userId);
        if (!user) {
          return next(new Error('User not found'));
        }
        socket.user = user;
        socket.userType = 'user';
      }

      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`✅ Socket connected: ${socket.id}`);

    // Handle user/admin connection
    if (socket.userType === 'user' && socket.user) {
      connectedUsers.set(socket.user._id.toString(), socket.id);
      // One room per guest, so a booking update reaches every device they have
      // open rather than only the most recently connected socket.
      socket.join(`user_${socket.user._id}`);
      console.log(`👤 User connected: ${socket.user.fullName} (${socket.user._id})`);
    } else if (socket.userType === 'admin' && socket.admin) {
      connectedAdmins.set(socket.admin._id.toString(), socket.id);
      // Every signed-in staff member watches the same appointment stream.
      socket.join('staff');
      if (socket.admin.branchId) socket.join(`staff_branch_${socket.admin.branchId}`);
      console.log(`👨‍💼 Admin connected: ${socket.admin.name} (${socket.admin._id})`);
    }

    // Send connection confirmation
    socket.emit('connected', {
      socketId: socket.id,
      userType: socket.userType,
      timestamp: new Date()
    });

    // Join chat room
    socket.on('joinChat', async (chatId) => {
      try {
        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit('error', { message: 'Chat not found' });
          return;
        }

        // Verify access
        if (socket.userType === 'user' && chat.userId.toString() !== socket.user._id.toString()) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        socket.join(chatId);
        console.log(`💬 ${socket.userType} ${socket.id} joined chat ${chatId}`);

        // If admin, also join branch room
        if (socket.userType === 'admin') {
          socket.join(`branch_${chat.branchId}`);
          console.log(`🏪 Admin also joined branch room: branch_${chat.branchId}`);
          
          // Request presence status from user if they're in this chat
          console.log(`📱 Admin requesting presence for chat ${chatId}`);
          io.to(chatId).emit('requestPresence', { chatId });
        }

        // Send confirmation
        socket.emit('joinedChat', { chatId });
        console.log(`✅ Sent joinedChat confirmation for ${chatId}`);

        // Mark messages as delivered
        await Message.updateMany(
          {
            chatId,
            isDelivered: false,
            senderModel: socket.userType === 'admin' ? 'User' : 'Admin'
          },
          {
            $set: {
              isDelivered: true,
              deliveredAt: new Date()
            }
          }
        );

      } catch (error) {
        console.error('Error joining chat:', error);
        socket.emit('error', { message: 'Error joining chat' });
      }
    });

    // Leave chat room
    socket.on('leaveChat', (chatId) => {
      socket.leave(chatId);
      console.log(`${socket.userType} ${socket.id} left chat ${chatId}`);
    });

    // Send message via socket
    socket.on('sendMessage', async (data) => {
      try {
        const { chatId } = data;
        const content = String(data.content || '').trim();

        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit('error', { message: 'Chat not found' });
          return;
        }

        if (socket.userType === 'user' && String(chat.userId) !== String(socket.user._id)) {
          socket.emit('error', { message: 'Unauthorized', tempId: data.tempId });
          return;
        }
        if (chat.status !== 'active') {
          socket.emit('error', { message: 'This conversation is closed.', tempId: data.tempId });
          return;
        }
        if (!content) {
          socket.emit('error', { message: 'Message cannot be empty.', tempId: data.tempId });
          return;
        }
        if (content.length > 2000) {
          socket.emit('error', { message: 'Message is too long. Maximum length is 2,000 characters.', tempId: data.tempId });
          return;
        }

        // Determine sender details
        let senderId, senderModel, senderName;
        
        if (socket.userType === 'user') {
          senderId = socket.user._id;
          senderModel = 'User';
          senderName = socket.user.fullName;
        } else {
          senderId = socket.admin._id;
          senderModel = 'Admin';
          senderName = socket.admin.name || 'Admin';
        }

        // Create message
        const message = await Message.create({
          chatId,
          senderId,
          senderModel,
          senderName,
          content,
          messageType: 'text',
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

        // Emit to chat room
        io.to(chatId).emit('newMessage', message);

        // Notify admin about new message from user
        if (senderModel === 'User') {
          io.to(`branch_${chat.branchId}`).emit('chatUpdate', {
            chatId: chat._id,
            userId: chat.userId,
            lastMessage: content,
            unreadCount: chat.unreadCount,
            lastMessageTime: chat.lastMessageTime
          });
        }

        // Send confirmation to sender
        socket.emit('messageSent', { messageId: message._id, tempId: data.tempId });

      } catch (error) {
        console.error('Error sending message via socket:', error);
        socket.emit('error', { message: 'Error sending message', tempId: data.tempId });
      }
    });

    // Typing indicator
    socket.on('typing', (data) => {
      const { chatId } = data;
      const typingData = {
        userId: socket.userType === 'user' ? socket.user._id : socket.admin._id,
        userName: socket.userType === 'user' ? socket.user.fullName : socket.admin.name,
        userType: socket.userType,
        chatId
      };
      console.log(`${socket.userType} typing in chat ${chatId}:`, typingData);
      socket.to(chatId).emit('userTyping', typingData);
    });

    socket.on('stopTyping', (data) => {
      const { chatId } = data;
      const stopData = {
        userId: socket.userType === 'user' ? socket.user._id : socket.admin._id,
        userType: socket.userType,
        chatId
      };
      console.log(`${socket.userType} stopped typing in chat ${chatId}`);
      socket.to(chatId).emit('userStoppedTyping', stopData);
    });

    // User presence tracking
    socket.on('userJoinedChat', async (data) => {
      const { chatId } = data;
      
      if (socket.userType === 'user') {
        console.log(`👤 User ${socket.user.fullName} joined chat ${chatId}`);
        
        // Broadcast to chat room (admins will receive this)
        const presenceData = {
          chatId,
          userId: socket.user._id,
          userName: socket.user.fullName,
          online: true,
          lastSeen: new Date()
        };
        
        console.log(`📡 Broadcasting presence to chat ${chatId}:`, presenceData);
        io.to(chatId).emit('userPresenceChanged', presenceData);
        
        // Also broadcast to branch room for admin panel updates
        const chat = await Chat.findById(chatId);
        if (chat) {
          io.to(`branch_${chat.branchId}`).emit('userPresenceChanged', presenceData);
        }
      }
    });

    socket.on('userLeftChat', async (data) => {
      const { chatId } = data;
      
      if (socket.userType === 'user') {
        console.log(`👤 User ${socket.user.fullName} left chat ${chatId}`);
        
        // Broadcast to chat room (admins will receive this)
        const presenceData = {
          chatId,
          userId: socket.user._id,
          userName: socket.user.fullName,
          online: false,
          lastSeen: new Date()
        };
        
        console.log(`📡 Broadcasting offline presence to chat ${chatId}`);
        io.to(chatId).emit('userPresenceChanged', presenceData);
        
        // Also broadcast to branch room
        const chat = await Chat.findById(chatId);
        if (chat) {
          io.to(`branch_${chat.branchId}`).emit('userPresenceChanged', presenceData);
        }
      }
    });

    // Admin requested presence - user responds with current status
    socket.on('requestPresence', async (data) => {
      const { chatId } = data;
      
      if (socket.userType === 'user') {
        console.log(`📡 User responding to presence request for chat ${chatId}`);
        
        const presenceData = {
          chatId,
          userId: socket.user._id,
          userName: socket.user.fullName,
          online: true,
          lastSeen: new Date()
        };
        
        // Broadcast current online status
        io.to(chatId).emit('userPresenceChanged', presenceData);
        
        // Also send to branch room
        const chat = await Chat.findById(chatId);
        if (chat) {
          console.log(`📡 Also sending presence to branch_${chat.branchId}`);
          io.to(`branch_${chat.branchId}`).emit('userPresenceChanged', presenceData);
        }
      }
    });

    // Mark messages as read
    socket.on('markAsRead', async (data) => {
      try {
        const { chatId } = data;

        const chat = await Chat.findById(chatId);
        if (!chat) {
          return;
        }

        // Mark all unread messages as read
        await Message.updateMany(
          {
            chatId,
            isRead: false,
            senderModel: socket.userType === 'admin' ? 'User' : 'Admin'
          },
          {
            $set: {
              isRead: true,
              readAt: new Date()
            }
          }
        );

        // Reset unread count if admin is reading
        if (socket.userType === 'admin') {
          await chat.markAsRead();
        }

        // Notify other party
        socket.to(chatId).emit('messagesRead', { chatId });

        // Update admin panel
        if (socket.userType === 'admin') {
          io.to(`branch_${chat.branchId}`).emit('chatUpdate', {
            chatId: chat._id,
            unreadCount: 0
          });
        }

      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    });

    // Join branch room for admin
    socket.on('joinBranch', async (branchId) => {
      if (socket.userType === 'admin') {
        socket.join(`branch_${branchId}`);
        console.log(`Admin ${socket.id} joined branch ${branchId}`);
        socket.emit('joinedBranch', { branchId });
      }
    });

    // Leave branch room
    socket.on('leaveBranch', (branchId) => {
      if (socket.userType === 'admin') {
        socket.leave(`branch_${branchId}`);
        console.log(`Admin ${socket.id} left branch ${branchId}`);
      }
    });

    // Delete message
    socket.on('deleteMessage', async (data) => {
      try {
        const { messageId, chatId } = data;
        const userType = socket.userType === 'admin' ? 'Admin' : 'User';
        const userId = socket.userType === 'user' ? socket.user._id : socket.admin._id;

        // Find and verify message ownership
        const message = await Message.findById(messageId);
        
        if (!message) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }

        if (message.senderId.toString() !== userId.toString() || message.senderModel !== userType) {
          socket.emit('error', { message: 'You can only delete your own messages' });
          return;
        }

        // Delete the message
        await Message.findByIdAndDelete(messageId);
        if (message.attachment?.url) await deleteFromS3(message.attachment.url);

        // Notify all users in the chat room
        io.to(chatId).emit('messageDeleted', {
          messageId,
          chatId
        });

        console.log(`Message ${messageId} deleted by ${userType} ${userId}`);
      } catch (error) {
        console.error('Error deleting message via socket:', error);
        socket.emit('error', { message: 'Failed to delete message' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`❌ Socket disconnected: ${socket.id}`);
      
      if (socket.userType === 'user' && socket.user) {
        connectedUsers.delete(socket.user._id.toString());
        console.log(`👤 User disconnected: ${socket.user.fullName}`);
        
        // Notify all chats this user was in that they're offline
        const userChats = await Chat.find({ userId: socket.user._id });
        for (const chat of userChats) {
          const presenceData = {
            chatId: chat._id,
            userId: socket.user._id,
            userName: socket.user.fullName,
            online: false,
            lastSeen: new Date()
          };
          io.to(chat._id.toString()).emit('userPresenceChanged', presenceData);
          io.to(`branch_${chat.branchId}`).emit('userPresenceChanged', presenceData);
        }
      } else if (socket.userType === 'admin' && socket.admin) {
        connectedAdmins.delete(socket.admin._id.toString());
        console.log(`👨‍💼 Admin disconnected: ${socket.admin.name}`);
      }
    });
  });

  return io;
};

const getConnectedUsers = () => connectedUsers;
const getConnectedAdmins = () => connectedAdmins;

/**
 * Tell every open panel — and the guest's own app — that an appointment moved.
 *
 * Fire-and-forget: if nobody is listening, or sockets are not up yet (a cron
 * boot run), this is a no-op. The payload is deliberately small; clients
 * re-read the booking rather than trusting a broadcast.
 */
const emitBookingUpdate = async (bookingId, action = null) => {
  if (!ioRef) return;
  try {
    const Booking = require('../models/Booking');
    const booking = await Booking.findById(bookingId)
      .select('userId status branchId preferredLocation referenceNumber zenotiAppointmentId')
      .lean();
    if (!booking) return;
    const payload = {
      bookingId: String(booking._id),
      status: booking.status,
      action,
      referenceNumber: booking.referenceNumber,
      at: new Date().toISOString(),
    };
    ioRef.to('staff').emit('booking:updated', payload);
    if (booking.branchId) ioRef.to(`staff_branch_${booking.branchId}`).emit('booking:updated', payload);
    if (booking.userId) ioRef.to(`user_${booking.userId}`).emit('booking:updated', payload);
  } catch (error) {
    console.error('⚠️ booking:updated broadcast failed:', error.message);
  }
};

/**
 * Several bookings changed in one Zenoti mirror pass.
 *
 * One event per room rather than one per booking: panels coalesce reloads
 * anyway, and a first far-horizon pass can touch hundreds of rows. Same event
 * name and shape as emitBookingUpdate, so every panel and the app already
 * listen for it. Fire-and-forget.
 */
const emitBookingsSynced = (changes = []) => {
  if (!ioRef || !Array.isArray(changes) || !changes.length) return;
  try {
    const at = new Date().toISOString();
    const first = changes[0];
    ioRef.to('staff').emit('booking:updated', {
      bookingId: first.id, status: first.status, action: 'zenoti_sync', count: changes.length, at,
    });
    const byBranch = new Map();
    const byUser = new Map();
    for (const change of changes) {
      if (change.branchId && !byBranch.has(change.branchId)) byBranch.set(change.branchId, change);
      if (change.userId) {
        if (!byUser.has(change.userId)) byUser.set(change.userId, []);
        byUser.get(change.userId).push(change);
      }
    }
    for (const [branchId, change] of byBranch) {
      ioRef.to(`staff_branch_${branchId}`).emit('booking:updated', {
        bookingId: change.id, status: change.status, action: 'zenoti_sync', count: changes.length, at,
      });
    }
    for (const [userId, list] of byUser) {
      ioRef.to(`user_${userId}`).emit('booking:updated', {
        bookingId: list[0].id, status: list[0].status, action: 'zenoti_sync', count: list.length, at,
      });
    }
  } catch (error) {
    console.error('⚠️ booking:updated (zenoti sync) broadcast failed:', error.message);
  }
};

module.exports = {
  setupSocketIO,
  emitBookingsSynced,
  getConnectedUsers,
  getConnectedAdmins,
  emitBookingUpdate
};
