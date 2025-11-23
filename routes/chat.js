const express = require('express');
const router = express.Router();
const {
  initiateChat,
  getChatsByBranch,
  getUserChats,
  getChatMessages,
  sendMessage,
  markChatAsRead,
  closeChat,
  getChatStats,
  assignChat
} = require('../controllers/chatController');
const { protect, protectAdmin, protectBoth } = require('../middleware/auth');

// User routes
router.post('/initiate', protect, initiateChat);
router.get('/user', protect, getUserChats);

// Shared routes (both user and admin can access)
router.get('/:chatId/messages', protectBoth, getChatMessages);
router.post('/:chatId/messages', protectBoth, sendMessage);
router.put('/:chatId/read', protectBoth, markChatAsRead);

// Admin routes
router.get('/admin/branch/:branchId', protectAdmin, getChatsByBranch);
router.get('/admin/stats', protectAdmin, getChatStats);
router.put('/admin/:chatId/close', protectAdmin, closeChat);
router.put('/admin/:chatId/assign', protectAdmin, assignChat);

module.exports = router;
