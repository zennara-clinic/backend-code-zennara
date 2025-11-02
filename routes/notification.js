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
  getNotificationStats,
  getUserNotifications,
  getUserUnreadCount,
  markUserNotificationAsRead,
  markAllUserNotificationsAsRead,
  deleteUserNotification
} = require('../controllers/notificationController');

// Auth middleware
const { protectAdmin, protect } = require('../middleware/auth');

// ==================== ADMIN ROUTES ====================
// Get all notifications with filters (admin)
router.get('/admin', protectAdmin, getAllNotifications);

// Get recent notifications (for popup - admin)
router.get('/admin/recent', protectAdmin, getRecentNotifications);

// Get unread count (admin)
router.get('/admin/unread-count', protectAdmin, getUnreadCount);

// Get notification statistics (admin)
router.get('/admin/stats', protectAdmin, getNotificationStats);

// Get specific notification (admin)
router.get('/admin/:id', protectAdmin, getNotificationById);

// Mark notification as read (admin)
router.patch('/admin/:id/read', protectAdmin, markAsRead);

// Mark all notifications as read (admin)
router.patch('/admin/mark-all-read', protectAdmin, markAllAsRead);

// Delete notification (admin)
router.delete('/admin/:id', protectAdmin, deleteNotification);

// Delete all read notifications (admin)
router.delete('/admin/read/all', protectAdmin, deleteAllRead);

// ==================== USER ROUTES ====================
// Get user's notifications
router.get('/', protect, getUserNotifications);

// Get user's unread count
router.get('/unread-count', protect, getUserUnreadCount);

// Mark user's notification as read
router.patch('/:id/read', protect, markUserNotificationAsRead);

// Mark all user's notifications as read
router.patch('/mark-all-read', protect, markAllUserNotificationsAsRead);

// Delete user's notification
router.delete('/:id', protect, deleteUserNotification);

module.exports = router;
