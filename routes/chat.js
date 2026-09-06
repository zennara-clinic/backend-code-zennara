const express = require('express');
const router = express.Router();
const {
  initiateChat,
  getChatsByBranch,
  getUserChats,
  getChatMessages,
  sendMessage,
  sendAttachment,
  markChatAsRead,
  closeChat,
  getChatStats,
  assignChat,
  deleteMessage
} = require('../controllers/chatController');
const { protect, protectAdmin, protectBoth, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('chat.manage');
// Opening the inbox and its counters is a read; replying/closing is a change.
const VIEW = requirePermission('chat.view', 'chat.manage');
const { receiveChatAttachment } = require('../middleware/chatAttachmentUpload');

// User routes
// Twilio webhooks (form-encoded, unauthenticated; signature checked when TWILIO_AUTH_TOKEN is set).
const chatCtrl = require('../controllers/chatController');
router.post('/whatsapp/inbound', express.urlencoded({ extended: false }), chatCtrl.whatsappInbound);
router.post('/whatsapp/status', express.urlencoded({ extended: false }), chatCtrl.whatsappStatus);

router.post('/initiate', protect, initiateChat);
router.get('/user', protect, getUserChats);
router.get('/user/unread', protect, require('../controllers/chatController').getUserUnread);

// Shared routes (both user and admin can access)
router.get('/:chatId/messages', protectBoth, getChatMessages);
router.post('/:chatId/messages', protectBoth, sendMessage);
router.post('/:chatId/attachments', protectBoth, receiveChatAttachment, sendAttachment);
router.put('/:chatId/read', protectBoth, markChatAsRead);
router.delete('/messages/:messageId', protectBoth, deleteMessage);

// Admin routes
router.get('/admin/branch/:branchId', protectAdmin, VIEW, getChatsByBranch);
router.get('/admin/stats', protectAdmin, VIEW, getChatStats);
router.put('/admin/:chatId/close', protectAdmin, MANAGE, closeChat);
router.put('/admin/:chatId/assign', protectAdmin, MANAGE, assignChat);
router.put('/admin/:chatId/tags', protectAdmin, MANAGE, chatCtrl.setChatTags);
router.post('/admin/start-whatsapp', protectAdmin, MANAGE, chatCtrl.startWhatsApp);

module.exports = router;
