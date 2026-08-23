const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const emailService = require('../utils/emailService');
const {
  restoreStockOnce,
  initiateOnlineRefund,
} = require('../services/orderLifecycleService');

// @desc    Get all orders (Admin)
// @route   GET /api/admin/product-orders
// @access  Private/Admin
exports.getAllOrders = async (req, res) => {
  try {
    const { status, paymentStatus, userId, search, startDate, endDate, limit, page = 1 } = req.query;
    
    const query = {};
    
    if (status) {
      query.orderStatus = status;
    }
    
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

    if (userId) query.userId = userId;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) { const d = new Date(endDate); d.setHours(23, 59, 59, 999); query.createdAt.$lte = d; }
    }

    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const User = require('../models/User');
      const users = await User.find({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }] }).select('_id').lean();
      query.$or = [
        { orderNumber: rx },
        { 'shippingAddress.fullName': rx },
        { 'shippingAddress.phone': rx },
        { userId: { $in: users.map((u) => u._id) } },
      ];
    }
    
    const pageSize = limit ? parseInt(limit) : 50;
    const skip = (parseInt(page) - 1) * pageSize;
    
    const orders = await ProductOrder.find(query)
      .populate('userId', 'fullName email phone')
      .populate('items.productId', 'name image')
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .skip(skip);
    
    const total = await ProductOrder.countDocuments(query);
    
    res.json({
      success: true,
      data: orders,
      count: orders.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / pageSize)
    });
  } catch (error) {
    console.error('Get all orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message
    });
  }
};

// @desc    Get single order (Admin)
// @route   GET /api/admin/product-orders/:id
// @access  Private/Admin
exports.getOrderById = async (req, res) => {
  try {
    const order = await ProductOrder.findById(req.params.id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId', 'name image price');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Get order by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
      error: error.message
    });
  }
};

// @desc    Update order status (Admin)
// @route   PUT /api/admin/product-orders/:id/status
// @access  Private/Admin
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, note, sendNotification = false } = req.body;
    
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    const validStatuses = [
      'Order Placed', 'Confirmed', 'Processing', 'Packed', 
      'Shipped', 'Out for Delivery', 'Delivery Failed', 'Delivered',
      'Cancelled', 'Return Requested', 'Returned'
    ];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order status'
      });
    }

    if (status === order.orderStatus) {
      return res.json({ success: true, message: 'Order already has this status', data: order });
    }
    if (status === 'Delivery Failed') {
      return res.status(400).json({
        success: false,
        message: 'Use the failed-delivery action so the attempt and reason are recorded',
      });
    }
    if (status === 'Out for Delivery') {
      return res.status(400).json({
        success: false,
        message: 'Assign a delivery partner so the delivery attempt is recorded',
      });
    }
    if (['Return Requested', 'Returned'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Use the return workflow to update this status',
      });
    }
    if (['Delivered', 'Return Requested', 'Returned', 'Cancelled'].includes(order.orderStatus)) {
      return res.status(409).json({
        success: false,
        message: `A ${order.orderStatus.toLowerCase()} order cannot move to ${status}`,
      });
    }
    if (order.orderStatus === 'Delivery Failed' && status !== 'Cancelled') {
      return res.status(409).json({
        success: false,
        message: 'Reassign this failed delivery before continuing fulfilment',
      });
    }
    
    // Define status sequence
    const statusSequence = [
      'Order Placed', 'Confirmed', 'Processing', 'Packed', 
      'Shipped', 'Out for Delivery', 'Delivered'
    ];
    
    // Get current and new status indices
    const currentStatusIndex = statusSequence.indexOf(order.orderStatus);
    const newStatusIndex = statusSequence.indexOf(status);

    if (status !== 'Cancelled' && currentStatusIndex !== -1 && newStatusIndex <= currentStatusIndex) {
      return res.status(409).json({
        success: false,
        message: 'Fulfilment statuses can only move forward',
      });
    }
    
    // Store old status for notification (BEFORE changing it)
    const oldStatus = order.orderStatus;
    
    // Add intermediate statuses if skipping ahead
    if (newStatusIndex > currentStatusIndex && currentStatusIndex !== -1 && newStatusIndex !== -1) {
      // Add all intermediate statuses
      for (let i = currentStatusIndex + 1; i <= newStatusIndex; i++) {
        const intermediateStatus = statusSequence[i];
        
        // Check if this status is already in history
        const alreadyExists = order.statusHistory.some(h => h.status === intermediateStatus);
        
        if (!alreadyExists) {
          order.statusHistory.push({
            status: intermediateStatus,
            timestamp: new Date(),
            note: i === newStatusIndex 
              ? (note || `Status updated to ${intermediateStatus} by admin`)
              : `Auto-added intermediate status: ${intermediateStatus}`
          });
        }
      }
    } else {
      // For backward status changes or cancelled/returned, just add the single status
      order.statusHistory.push({
        status: status,
        timestamp: new Date(),
        note: note || `Status updated to ${status} by admin`
      });
    }
    
    // Update order status
    order.orderStatus = status;
    
    // Handle specific status updates
    if (status === 'Delivered') {
      order.deliveredAt = new Date();
      if (order.paymentMethod === 'COD') order.paymentStatus = 'Paid';
    }
    
    if (status === 'Cancelled' && !order.cancelledAt) {
      order.cancelledAt = new Date();
      order.cancelReason = note || 'Cancelled by admin';
      
    }
    
    await order.save();

    let refundError = null;
    if (status === 'Cancelled') {
      await restoreStockOnce(order._id, 'Admin cancellation');
      if (order.paymentStatus === 'Paid' && order.paymentMethod !== 'COD') {
        try {
          await initiateOnlineRefund(order._id, {
            trigger: 'admin_cancellation',
            actorId: req.admin?._id || req.user?._id,
            notes: note || 'Automatic refund after admin cancellation',
          });
        } catch (error) {
          refundError = error.message;
          console.error('Automatic admin cancellation refund failed:', error.message);
        }
      }
    }

    const lifecycleState = await ProductOrder.findById(order._id)
      .select('paymentStatus refundDetails stockRestoredAt stockRestorationReason statusHistory');
    if (lifecycleState) {
      order.paymentStatus = lifecycleState.paymentStatus;
      order.refundDetails = lifecycleState.refundDetails;
      order.stockRestoredAt = lifecycleState.stockRestoredAt;
      order.stockRestorationReason = lifecycleState.stockRestorationReason;
      order.statusHistory = lifecycleState.statusHistory;
    }
    
    // Populate before sending response
    await order.populate('userId', 'fullName email phone');
    await order.populate('items.productId', 'name image');
    
    // Create admin notification for status change
    try {
      // Extract userId - it's populated so we need the _id
      const userId = order.userId?._id || order.userId;
      
      await NotificationHelper.orderStatusChanged(
        {
          _id: order._id,
          userId: userId,
          orderNumber: order.orderNumber
        },
        oldStatus,
        status
      );
      console.log('🔔 Order status change notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }
    
    // Send WhatsApp and Email notifications
    console.log('=== ADMIN ORDER STATUS UPDATE: SENDING NOTIFICATIONS ===');
    console.log('Order:', order.orderNumber, '| Status:', status);
    
    try {
      const user = order.userId;
      
      if (!user) {
        console.error('User not populated for order:', order._id);
      } else {
        console.log('User:', user.fullName, '| Phone:', user.phone, '| Email:', user.email);
        
        const formattedAddress = `${order.shippingAddress.addressLine1}, ${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.postalCode}`;
        
        const data = {
          customerName: order.shippingAddress.fullName,
          orderNumber: order.orderNumber,
          shippingAddress: formattedAddress
        };

        let notificationsSent = false;

        switch (status) {
          case 'Confirmed':
            console.log('Sending Order Confirmed notifications...');
            // Send "Order Confirmed" notification
            data.items = order.items.map(item => ({
              name: item.productName,
              quantity: item.quantity
            }));
            data.total = order.pricing.total;
            if (user.phone) await whatsappService.sendOrderConfirmed(user.phone, data);
            if (user.email) await emailService.sendOrderConfirmedEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Processing':
            console.log('Sending Processing notifications...');
            if (user.phone) await whatsappService.sendOrderProcessing(user.phone, data);
            if (user.email) await emailService.sendOrderProcessingEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Packed':
            console.log('Sending Packed notifications...');
            if (user.phone) await whatsappService.sendOrderPacked(user.phone, data);
            if (user.email) await emailService.sendOrderPackedEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Shipped':
            console.log('Sending Shipped notifications...');
            data.trackingId = order.trackingId;
            data.estimatedDelivery = order.estimatedDelivery;
            data.courier = order.courier;
            if (user.phone) await whatsappService.sendOrderShipped(user.phone, data);
            if (user.email) await emailService.sendOrderShippedEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Out for Delivery':
            console.log('Sending Out for Delivery notifications...');
            data.deliveryPartner = order.deliveryPartner;
            data.expectedTime = order.expectedDeliveryTime;
            if (user.phone) await whatsappService.sendOrderOutForDelivery(user.phone, data);
            if (user.email) await emailService.sendOrderOutForDeliveryEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Delivered':
            console.log('Sending Delivered notifications...');
            data.deliveredAt = order.deliveredAt.toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short'
            });
            if (user.phone) await whatsappService.sendOrderDelivered(user.phone, data);
            if (user.email) await emailService.sendOrderDeliveredEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          case 'Cancelled':
            console.log('Sending Cancelled notifications...');
            data.reason = order.cancelReason || 'Cancelled by admin';
            data.cancelledAt = order.cancelledAt.toLocaleDateString('en-IN');
            data.totalAmount = order.pricing.total;
            data.refundInfo = ['Paid', 'Refunded'].includes(order.paymentStatus);
            if (user.phone) await whatsappService.sendOrderCancelled(user.phone, data);
            if (user.email) await emailService.sendOrderCancelledEmail(user.email, data.customerName, data);
            notificationsSent = true;
            break;
          default:
            console.log('No notification configured for status:', status);
        }
        
        if (notificationsSent) {
          console.log('✅ Notifications sent successfully');
        } else {
          console.log('⚠️ No notifications were sent');
        }
      }
    } catch (notificationError) {
      console.error('❌ Failed to send notifications:', notificationError);
      console.error('Error stack:', notificationError.stack);
    }
    console.log('=== NOTIFICATION PROCESS COMPLETE ===\n');
    
    res.json({
      success: true,
      message: refundError
        ? 'Order cancelled and stock restored. The automatic refund needs attention.'
        : status === 'Cancelled' && order.refundDetails?.status === 'Processing'
          ? 'Order cancelled, stock restored, and refund initiated.'
          : 'Order status updated successfully',
      data: order,
      notificationSent: sendNotification,
      refundRequiresAttention: Boolean(refundError)
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update order status',
      error: error.message
    });
  }
};

// @desc    Mark an out-for-delivery attempt as failed
// @route   PUT /api/admin/product-orders/:id/delivery-failed
// @access  Private/Admin
exports.markDeliveryFailed = async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const note = String(req.body?.note || '').trim();
    if (reason.length < 4) {
      return res.status(400).json({ success: false, message: 'A delivery failure reason is required' });
    }

    const order = await ProductOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.orderStatus !== 'Out for Delivery') {
      return res.status(409).json({
        success: false,
        message: 'Only an order that is out for delivery can be marked failed',
      });
    }

    const attempt = Math.max(1, Number(order.deliveryAttempt) || 1);
    const now = new Date();
    order.orderStatus = 'Delivery Failed';
    order.deliveryAttempt = attempt;
    order.deliveryFailedAt = now;
    order.deliveryFailureReason = reason;
    order.deliveryFailures.push({
      attempt,
      failedAt: now,
      reason,
      note,
      deliveryPartner: order.deliveryPartner,
      deliveryPartnerPhone: order.deliveryPartnerPhone,
      courier: order.courier,
      trackingId: order.trackingId,
      markedBy: req.admin?._id || req.user?._id,
    });
    order.statusHistory.push({
      status: 'Delivery Failed',
      timestamp: now,
      note: `Delivery attempt ${attempt} failed: ${reason}${note ? ` · ${note}` : ''}`,
    });
    await order.save();

    NotificationHelper.orderStatusChanged(
      { _id: order._id, userId: order.userId, orderNumber: order.orderNumber },
      'Out for Delivery',
      'Delivery Failed'
    ).catch((error) => console.error('Delivery failure notification failed:', error.message));

    return res.json({
      success: true,
      message: `Delivery attempt ${attempt} marked failed. Reassign it or cancel the order.`,
      data: order,
    });
  } catch (error) {
    console.error('Mark delivery failed error:', error);
    return res.status(500).json({ success: false, message: 'Failed to mark delivery attempt', error: error.message });
  }
};

// @desc    Assign or reassign delivery and start a new attempt
// @route   PUT /api/admin/product-orders/:id/assign-delivery
// @access  Private/Admin
exports.assignDelivery = async (req, res) => {
  try {
    const deliveryPartner = String(req.body?.deliveryPartner || '').trim();
    const courier = String(req.body?.courier || '').trim();
    if (!deliveryPartner && !courier) {
      return res.status(400).json({ success: false, message: 'Enter a delivery partner or courier' });
    }
    const expectedDeliveryTime = req.body?.expectedDeliveryTime
      ? new Date(req.body.expectedDeliveryTime)
      : undefined;
    if (expectedDeliveryTime && Number.isNaN(expectedDeliveryTime.getTime())) {
      return res.status(400).json({ success: false, message: 'Expected delivery time is invalid' });
    }

    const order = await ProductOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['Shipped', 'Delivery Failed'].includes(order.orderStatus)) {
      return res.status(409).json({
        success: false,
        message: 'Delivery can be assigned after shipping or reassigned after a failed attempt',
      });
    }

    const wasFailed = order.orderStatus === 'Delivery Failed';
    const attempt = wasFailed
      ? Math.max(1, Number(order.deliveryAttempt) || 1) + 1
      : Math.max(1, Number(order.deliveryAttempt) || 1);
    const now = new Date();
    order.deliveryPartner = deliveryPartner || order.deliveryPartner;
    order.deliveryPartnerPhone = String(req.body?.deliveryPartnerPhone || '').trim() || undefined;
    order.courier = courier || order.courier;
    order.trackingId = String(req.body?.trackingId || '').trim() || undefined;
    order.expectedDeliveryTime = expectedDeliveryTime;
    order.deliveryAttempt = attempt;
    order.deliveryAssignedAt = now;
    order.deliveryAssignedBy = req.admin?._id || req.user?._id;
    order.deliveryFailedAt = undefined;
    order.deliveryFailureReason = undefined;
    order.orderStatus = 'Out for Delivery';
    order.statusHistory.push({
      status: 'Out for Delivery',
      timestamp: now,
      note: `${wasFailed ? 'Reassigned' : 'Assigned'} for delivery attempt ${attempt} to ${deliveryPartner || courier}`,
    });
    await order.save();

    NotificationHelper.orderStatusChanged(
      { _id: order._id, userId: order.userId, orderNumber: order.orderNumber },
      wasFailed ? 'Delivery Failed' : 'Shipped',
      'Out for Delivery'
    ).catch((error) => console.error('Delivery assignment notification failed:', error.message));

    return res.json({
      success: true,
      message: `Delivery attempt ${attempt} assigned successfully`,
      data: order,
    });
  } catch (error) {
    console.error('Assign delivery error:', error);
    return res.status(500).json({ success: false, message: 'Failed to assign delivery', error: error.message });
  }
};

// @desc    Get order statistics (Admin)
// @route   GET /api/admin/product-orders/stats
// @access  Private/Admin
exports.getOrderStats = async (req, res) => {
  try {
    const totalOrders = await ProductOrder.countDocuments();
    const newOrders = await ProductOrder.countDocuments({ orderStatus: 'Order Placed' });
    const confirmedOrders = await ProductOrder.countDocuments({ orderStatus: 'Confirmed' });
    const processingOrders = await ProductOrder.countDocuments({ 
      orderStatus: { $in: ['Processing', 'Packed'] } 
    });
    const shippedOrders = await ProductOrder.countDocuments({ 
      orderStatus: { $in: ['Shipped', 'Out for Delivery'] } 
    });
    const deliveredOrders = await ProductOrder.countDocuments({ orderStatus: 'Delivered' });
    const cancelledOrders = await ProductOrder.countDocuments({ orderStatus: 'Cancelled' });
    const failedDeliveryOrders = await ProductOrder.countDocuments({ orderStatus: 'Delivery Failed' });
    const returnRequestedOrders = await ProductOrder.countDocuments({ orderStatus: 'Return Requested' });
    
    // Calculate total revenue
    const revenueResult = await ProductOrder.aggregate([
      { $match: { orderStatus: { $nin: ['Cancelled', 'Returned'] } } },
      { $group: { _id: null, total: { $sum: '$pricing.total' } } }
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;
    
    res.json({
      success: true,
      data: {
        totalOrders,
        newOrders,
        confirmedOrders,
        processingOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,
        failedDeliveryOrders,
        returnRequestedOrders,
        totalRevenue
      }
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order statistics',
      error: error.message
    });
  }
};

// @desc    Delete order (Admin)
// @route   DELETE /api/admin/product-orders/:id
// @access  Private/Admin
exports.deleteOrder = async (req, res) => {
  try {
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Restore stock if order is not delivered
    if (!['Delivered', 'Cancelled'].includes(order.orderStatus)) {
      for (const item of order.items) {
        const product = await Product.findById(item.productId);
        if (product) {
          product.stock += item.quantity;
          await product.save();
        }
      }
    }
    
    await order.deleteOne();
    
    res.json({
      success: true,
      message: 'Order deleted successfully'
    });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete order',
      error: error.message
    });
  }
};
