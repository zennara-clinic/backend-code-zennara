const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');

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
      'Pending', 'Confirmed', 'Processing', 'Packed', 
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
      'Pending', 'Confirmed', 'Processing', 'Packed', 
      'Shipped', 'Out for Delivery', 'Delivered'
    ];
    
    // Get current and new status indices
    const currentStatusIndex = statusSequence.indexOf(order.orderStatus);
    const newStatusIndex = statusSequence.indexOf(status);
    
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
    
    // Send notification if requested (placeholder for future email/SMS integration)
    if (sendNotification && order.userId?.email) {
      // TODO: Implement email notification
      console.log(`📧 Notification would be sent to ${order.userId.email} about order ${order.orderNumber} status: ${status}`);
    }
    
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
    const pendingOrders = await ProductOrder.countDocuments({ orderStatus: 'Pending' });
    const processingOrders = await ProductOrder.countDocuments({ 
      orderStatus: { $in: ['Confirmed', 'Processing', 'Packed'] } 
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
        pendingOrders,
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
