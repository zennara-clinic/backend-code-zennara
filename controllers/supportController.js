const SupportMessage = require('../models/SupportMessage');
const emailService = require('../utils/emailService');

// @desc    Create new support message
// @route   POST /api/support
// @access  Public/Private (works for both logged in and guest users)
exports.createSupportMessage = async (req, res) => {
  try {
    const { name, email, phone, location, subject, message } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields: name, email, phone, subject, and message',
      });
    }

    // Create support message
    const supportMessage = await SupportMessage.create({
      userId: req.user?._id || null, // Will be null for guest users
      name,
      email,
      phone,
      location: location || null,
      subject,
      message,
      status: 'pending',
      priority: 'medium',
    });

    console.log('✅ Support message created:', supportMessage._id);

    // Send confirmation email to user
    try {
      await emailService.sendSupportMessageConfirmation(
        email,
        name,
        {
          subject,
          message,
          ticketId: supportMessage._id.toString(),
        }
      );
      console.log('📧 Support confirmation email sent to user');
    } catch (emailError) {
      console.error('⚠️ Failed to send confirmation email:', emailError.message);
    }

    // Send notification to admin/support team
    try {
      await emailService.sendSupportMessageNotification(
        'info@zennara.com', // Admin email
        {
          ticketId: supportMessage._id.toString(),
          name,
          email,
          phone,
          location: location || 'Not specified',
          subject,
          message,
          timestamp: supportMessage.createdAt,
        }
      );
      console.log('📧 Support notification email sent to admin');
    } catch (emailError) {
      console.error('⚠️ Failed to send admin notification:', emailError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Your message has been sent successfully. We will get back to you soon.',
      data: {
        id: supportMessage._id,
        status: supportMessage.status,
        createdAt: supportMessage.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Create support message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send your message. Please try again.',
    });
  }
};

// @desc    Get user's support messages
// @route   GET /api/support/my-messages
// @access  Private
exports.getUserSupportMessages = async (req, res) => {
  try {
    const { status } = req.query;

    const query = { userId: req.user._id };
    if (status) {
      query.status = status;
    }

    const messages = await SupportMessage.find(query)
      .sort({ createdAt: -1 })
      .select('-adminNotes -assignedTo -resolvedBy');

    res.status(200).json({
      success: true,
      count: messages.length,
      data: messages,
    });
  } catch (error) {
    console.error('❌ Get user support messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch your messages',
    });
  }
};

// @desc    Get single support message
// @route   GET /api/support/:id
// @access  Private
exports.getSupportMessage = async (req, res) => {
  try {
    const message = await SupportMessage.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).select('-adminNotes -assignedTo -resolvedBy');

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Support message not found',
      });
    }

    res.status(200).json({
      success: true,
      data: message,
    });
  } catch (error) {
    console.error('❌ Get support message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch message',
    });
  }
};

// @desc    Get all support messages (Admin only)
// @route   GET /api/support/admin/all
// @access  Private/Admin
exports.getAllSupportMessages = async (req, res) => {
  try {
    const { status, priority, limit = 50, page = 1 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;

    const skip = (page - 1) * limit;

    const messages = await SupportMessage.find(query)
      .populate('userId', 'fullName email phone')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await SupportMessage.countDocuments(query);

    res.status(200).json({
      success: true,
      count: messages.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      data: messages,
    });
  } catch (error) {
    console.error('❌ Get all support messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch support messages',
    });
  }
};

// @desc    Update support message status (Admin only)
// @route   PUT /api/support/admin/:id/status
// @access  Private/Admin
exports.updateSupportMessageStatus = async (req, res) => {
  try {
    const { status, adminNote } = req.body;

    const message = await SupportMessage.findById(req.params.id);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Support message not found',
      });
    }

    message.status = status;

    if (status === 'resolved' || status === 'closed') {
      message.resolvedAt = new Date();
      message.resolvedBy = req.user._id;
    }

    if (adminNote) {
      message.adminNotes.push({
        note: adminNote,
        addedBy: req.user._id,
      });
    }

    await message.save();

    res.status(200).json({
      success: true,
      message: 'Support message status updated',
      data: message,
    });
  } catch (error) {
    console.error('❌ Update support message status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update status',
    });
  }
};
