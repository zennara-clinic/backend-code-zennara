const express = require('express');
const router = express.Router();
const {
  getAllNotifications,
  getRecentNotifications,
  getUnreadCount,
  getNotificationById,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  getNotificationStats
} = require('../controllers/notificationController');

// Admin auth middleware - import the specific function directly
const { protectAdmin } = require('../middleware/auth');

// Get all notifications with filters
router.get('/', protectAdmin, getAllNotifications);

// Get recent notifications (for popup)
router.get('/recent', protectAdmin, getRecentNotifications);

// Get unread count
router.get('/unread-count', protectAdmin, getUnreadCount);

// Get notification statistics
router.get('/stats', protectAdmin, getNotificationStats);

// Get specific notification
router.get('/:id', protectAdmin, getNotificationById);

// Mark notification as read
router.patch('/:id/read', protectAdmin, markAsRead);

// Mark all notifications as read
router.patch('/mark-all-read', protectAdmin, markAllAsRead);

// Delete notification
router.delete('/:id', protectAdmin, deleteNotification);

// Delete all read notifications
router.delete('/read/all', protectAdmin, deleteAllRead);

module.exports = router;
