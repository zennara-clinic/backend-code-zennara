const Notification = require('../models/Notification');

// Create a new notification (typically called internally, not exposed via API)
const createNotification = async (notificationData) => {
  try {
    const notification = new Notification(notificationData);
    await notification.save();
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

// Get all notifications with filters
const getAllNotifications = async (req, res) => {
  try {
    const {
      type,
      isRead,
      priority,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build filter object
    const filter = {};
    if (type) filter.type = type;
    if (isRead !== undefined) filter.isRead = isRead === 'true';
    if (priority) filter.priority = priority;

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    // Execute query
    const notifications = await Notification.find(filter)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count for pagination
    const total = await Notification.countDocuments(filter);

    // Get unread count
    const unreadCount = await Notification.countDocuments({ isRead: false });

    res.status(200).json({
      success: true,
      data: {
        notifications,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        },
        unreadCount
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching notifications',
      error: error.message
    });
  }
};

// Get recent notifications (for popup)
const getRecentNotifications = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 3;

    const notifications = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const unreadCount = await Notification.countDocuments({ isRead: false });

    res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount
      }
    });
  } catch (error) {
    console.error('Error fetching recent notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching recent notifications',
      error: error.message
    });
  }
};

// Get unread count
const getUnreadCount = async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({ isRead: false });

    res.status(200).json({
      success: true,
      data: { unreadCount }
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching unread count',
      error: error.message
    });
  }
};

// Get notification by ID
const getNotificationById = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findById(id).lean();

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      data: notification
    });
  } catch (error) {
    console.error('Error fetching notification:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching notification',
      error: error.message
    });
  }
};

// Mark notification as read
const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findByIdAndUpdate(
      id,
      {
        isRead: true,
        readAt: new Date()
      },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Error marking notification as read',
      error: error.message
    });
  }
};

// Mark all notifications as read
const markAllAsRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { isRead: false },
      {
        isRead: true,
        readAt: new Date()
      }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
      data: {
        modifiedCount: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      message: 'Error marking all notifications as read',
      error: error.message
    });
  }
};

// Delete notification
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findByIdAndDelete(id);

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting notification',
      error: error.message
    });
  }
};

// Delete all read notifications
const deleteAllRead = async (req, res) => {
  try {
    const result = await Notification.deleteMany({ isRead: true });

    res.status(200).json({
      success: true,
      message: 'All read notifications deleted',
      data: {
        deletedCount: result.deletedCount
      }
    });
  } catch (error) {
    console.error('Error deleting read notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting read notifications',
      error: error.message
    });
  }
};

// Get notification statistics
const getNotificationStats = async (req, res) => {
  try {
    const stats = await Notification.aggregate([
      {
        $facet: {
          byType: [
            {
              $group: {
                _id: '$type',
                count: { $sum: 1 },
                unread: {
                  $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
                }
              }
            }
          ],
          byPriority: [
            {
              $group: {
                _id: '$priority',
                count: { $sum: 1 },
                unread: {
                  $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
                }
              }
            }
          ],
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                unread: {
                  $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
                },
                read: {
                  $sum: { $cond: [{ $eq: ['$isRead', true] }, 1, 0] }
                }
              }
            }
          ]
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        byType: stats[0].byType,
        byPriority: stats[0].byPriority,
        overall: stats[0].overall[0] || { total: 0, unread: 0, read: 0 }
      }
    });
  } catch (error) {
    console.error('Error fetching notification stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching notification stats',
      error: error.message
    });
  }
};

module.exports = {
  createNotification,
  getAllNotifications,
  getRecentNotifications,
  getUnreadCount,
  getNotificationById,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  getNotificationStats
};
