const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const emailService = require('../utils/emailService');

// @desc    Get all orders (Admin)
// @route   GET /api/admin/product-orders
// @access  Private/Admin
exports.getAllOrders = async (req, res) => {
  try {
    const { status, paymentStatus, limit, page = 1 } = req.query;
    
    const query = {};
    
    if (status) {
      query.orderStatus = status;
    }
    
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
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
      'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned'
    ];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order status'
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
      order.paymentStatus = 'Paid'; // Mark as paid when delivered (COD)
    }
    
    if (status === 'Cancelled' && !order.cancelledAt) {
      order.cancelledAt = new Date();
      order.cancelReason = note || 'Cancelled by admin';
      
      // Restore stock
      for (const item of order.items) {
        const product = await Product.findById(item.productId);
        if (product) {
          product.stock += item.quantity;
          await product.save();
        }
      }
    }
    
    await order.save();
    
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
            data.refundInfo = order.paymentStatus === 'Paid';
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
      message: 'Order status updated successfully',
      data: order,
      notificationSent: sendNotification
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
    
    // Calculate total revenue
    const revenueResult = await ProductOrder.aggregate([
      { $match: { orderStatus: { $ne: 'Cancelled' } } },
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
