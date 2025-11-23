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
const { protect, protectAdmin } = require('../middleware/auth');

// User routes
router.post('/initiate', protect, initiateChat);
router.get('/user', protect, getUserChats);
router.get('/:chatId/messages', protect, getChatMessages);
router.post('/:chatId/messages', protect, sendMessage);
router.put('/:chatId/read', protect, markChatAsRead);

// Admin routes
router.get('/admin/branch/:branchId', protectAdmin, getChatsByBranch);
router.get('/admin/stats', protectAdmin, getChatStats);
router.post('/admin/:chatId/messages', protectAdmin, sendMessage);
router.put('/admin/:chatId/read', protectAdmin, markChatAsRead);
router.put('/admin/:chatId/close', protectAdmin, closeChat);
router.put('/admin/:chatId/assign', protectAdmin, assignChat);

module.exports = router;
