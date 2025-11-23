const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Chat = require('../models/Chat');
const Message = require('../models/Message');

const connectedUsers = new Map();
const connectedAdmins = new Map();

const setupSocketIO = (io) => {
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
    console.log(`Socket connected: ${socket.id}`);

    // Handle user/admin connection
    if (socket.userType === 'user' && socket.user) {
      connectedUsers.set(socket.user._id.toString(), socket.id);
      console.log(`User connected: ${socket.user.fullName} (${socket.user._id})`);
    } else if (socket.userType === 'admin' && socket.admin) {
      connectedAdmins.set(socket.admin._id.toString(), socket.id);
      console.log(`Admin connected: ${socket.admin.name} (${socket.admin._id})`);
    }

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
        console.log(`${socket.userType} ${socket.id} joined chat ${chatId}`);

        // If admin, also join branch room
        if (socket.userType === 'admin') {
          socket.join(`branch_${chat.branchId}`);
        }

        // Send confirmation
        socket.emit('joinedChat', { chatId });

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
        const { chatId, content, messageType = 'text', attachments = [] } = data;

        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit('error', { message: 'Chat not found' });
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
      socket.to(chatId).emit('userTyping', {
        userId: socket.userType === 'user' ? socket.user._id : socket.admin._id,
        userName: socket.userType === 'user' ? socket.user.fullName : socket.admin.name,
        chatId
      });
    });

    socket.on('stopTyping', (data) => {
      const { chatId } = data;
      socket.to(chatId).emit('userStoppedTyping', {
        userId: socket.userType === 'user' ? socket.user._id : socket.admin._id,
        chatId
      });
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

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      
      if (socket.userType === 'user' && socket.user) {
        connectedUsers.delete(socket.user._id.toString());
        console.log(`User disconnected: ${socket.user.fullName}`);
      } else if (socket.userType === 'admin' && socket.admin) {
        connectedAdmins.delete(socket.admin._id.toString());
        console.log(`Admin disconnected: ${socket.admin.name}`);
      }
    });
  });

  return io;
};

const getConnectedUsers = () => connectedUsers;
const getConnectedAdmins = () => connectedAdmins;

module.exports = {
  setupSocketIO,
  getConnectedUsers,
  getConnectedAdmins
};
