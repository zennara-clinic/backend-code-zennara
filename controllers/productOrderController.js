const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const Address = require('../models/Address');
const NotificationHelper = require('../utils/notificationHelper');

// @desc    Create new product order
// @route   POST /api/product-orders
// @access  Private
exports.createOrder = async (req, res) => {
  try {
    const { items, addressId, pricing, coupon, paymentMethod = 'COD', notes } = req.body;
    
    console.log('📦 Creating product order for user:', req.user._id);
    console.log('👤 Member Type:', req.user.memberType);
    console.log('📋 Order items:', items?.length || 0);
    
    // Validate items
    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order must contain at least one item'
      });
    }
    
    // Validate address
    if (!addressId) {
      return res.status(400).json({
        success: false,
        message: 'Shipping address is required'
      });
    }
    
    // Get address details
    const address = await Address.findOne({ _id: addressId, userId: req.user._id });
    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }
    
    // Validate and process items
    const processedItems = [];
    let calculatedSubtotal = 0;
    
    for (const item of items) {
      const product = await Product.findById(item.productId);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item.productId}`
        });
      }
      
      if (!product.isActive) {
        return res.status(400).json({
          success: false,
          message: `Product is not available: ${product.name}`
        });
      }
      
      if (product.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.stock}`,
          availableStock: product.stock
        });
      }
      
      // Use product price
      const price = product.price;
      
      const subtotal = price * item.quantity;
      calculatedSubtotal += subtotal;
      
      processedItems.push({
        productId: product._id,
        productName: product.name,
        productImage: product.image,
        quantity: item.quantity,
        price: price,
        subtotal: subtotal
      });
      
      // Reduce stock
      product.stock -= item.quantity;
      await product.save();
    }
    
    // Generate unique order number
    const orderCount = await ProductOrder.countDocuments();
    const orderNumber = `ORD${Date.now()}${String(orderCount + 1).padStart(4, '0')}`;
    
    // Create order
    const order = await ProductOrder.create({
      userId: req.user._id,
      orderNumber,
      items: processedItems,
      shippingAddress: {
        addressId: address._id,
        fullName: address.fullName,
        phone: address.phone,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country
      },
      pricing: {
        subtotal: calculatedSubtotal,
        gst: pricing.gst || 0,
        discount: pricing.discount || 0,
        deliveryFee: pricing.deliveryFee || 0,
        total: calculatedSubtotal + (pricing.gst || 0) + (pricing.deliveryFee || 0) - (pricing.discount || 0)
      },
      coupon: coupon ? {
        code: coupon.code,
        discount: coupon.discount
      } : undefined,
      paymentMethod,
      notes
    });
    
    // Populate order details
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    console.log('✅ Order created successfully:', populatedOrder.orderNumber);

    // Create notification for admin and user
    try {
      // Extract userId - it's populated so we need the _id
      const userId = populatedOrder.userId?._id || populatedOrder.userId;
      
      console.log('📢 Attempting to create notification for order:', {
        orderId: populatedOrder._id,
        userId: userId,
        orderNumber: populatedOrder.orderNumber,
        totalAmount: populatedOrder.pricing.total,
        customerName: populatedOrder.shippingAddress.fullName
      });
      
      await NotificationHelper.orderCreated({
        _id: populatedOrder._id,
        userId: userId,
        orderNumber: populatedOrder.orderNumber,
        totalAmount: populatedOrder.pricing.total,
        shippingAddress: { name: populatedOrder.shippingAddress.fullName }
      });
      console.log('✅ Order notification created successfully');
    } catch (notifError) {
      console.error('❌ Failed to create notification:', notifError);
      console.error('Error stack:', notifError.stack);
    }
    
    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: populatedOrder
    });
  } catch (error) {
    console.error('❌ Create order error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: error.message
    });
  }
};

// @desc    Get user orders
// @route   GET /api/product-orders
// @access  Private
exports.getUserOrders = async (req, res) => {
  try {
    const { status, limit } = req.query;
    
    const query = { userId: req.user._id };
    
    if (status) {
      query.orderStatus = status;
    }
    
    let ordersQuery = ProductOrder.find(query)
      .populate('items.productId')
      .sort({ createdAt: -1 });
    
    if (limit) {
      ordersQuery = ordersQuery.limit(parseInt(limit));
    }
    
    const orders = await ordersQuery;
    
    res.json({
      success: true,
      data: orders,
      count: orders.length
    });
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message
    });
  }
};

// @desc    Get single order
// @route   GET /api/product-orders/:id
// @access  Private
exports.getOrder = async (req, res) => {
  try {
    const order = await ProductOrder.findOne({
      _id: req.params.id,
      userId: req.user._id
    })
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
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
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
      error: error.message
    });
  }
};

// @desc    Get order by order number
// @route   GET /api/product-orders/number/:orderNumber
// @access  Private
exports.getOrderByNumber = async (req, res) => {
  try {
    const order = await ProductOrder.findOne({
      orderNumber: req.params.orderNumber,
      userId: req.user._id
    })
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
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
    console.error('Get order by number error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
      error: error.message
    });
  }
};

// @desc    Cancel order
// @route   PUT /api/product-orders/:id/cancel
// @access  Private
exports.cancelOrder = async (req, res) => {
  try {
    const { reason } = req.body;
    
    const order = await ProductOrder.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order can be cancelled
    if (['Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'].includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel order with status: ${order.orderStatus}`
      });
    }
    
    // Restore stock
    for (const item of order.items) {
      const product = await Product.findById(item.productId);
      if (product) {
        product.stock += item.quantity;
        await product.save();
      }
    }
    
    order.orderStatus = 'Cancelled';
    order.cancelReason = reason || 'Cancelled by user';
    order.cancelledAt = new Date();
    order.statusHistory.push({
      status: 'Cancelled',
      timestamp: new Date(),
      note: reason || 'Cancelled by user'
    });
    
    await order.save();
    
    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: order
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message
    });
  }
};

// @desc    Update order status (Admin only - for testing, can be called by user)
// @route   PUT /api/product-orders/:id/status
// @access  Private
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, note } = req.body;
    
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    const validStatuses = ['Pending', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order status'
      });
    }
    
    order.orderStatus = status;
    
    if (status === 'Delivered') {
      order.deliveredAt = new Date();
      order.paymentStatus = 'Paid'; // Mark as paid when delivered (COD)
    }
    
    order.statusHistory.push({
      status: status,
      timestamp: new Date(),
      note: note || `Status updated to ${status}`
    });
    
    await order.save();
    
    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: order
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

// @desc    Cancel order
// @route   POST /api/orders/:id/cancel
// @access  Private
exports.cancelOrder = async (req, res) => {
  try {
    const { reason } = req.body;
    
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order belongs to user
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this order'
      });
    }
    
    // Check if order can be cancelled (not delivered)
    if (order.orderStatus === 'Delivered') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel delivered orders. Please request a return instead.'
      });
    }
    
    if (order.orderStatus === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Order is already cancelled'
      });
    }
    
    // Update order status
    order.orderStatus = 'Cancelled';
    order.cancelReason = reason || 'Cancelled by customer';
    order.cancelledAt = new Date();
    
    // Add to status history
    order.statusHistory.push({
      status: 'Cancelled',
      timestamp: new Date(),
      note: `Cancelled by customer: ${reason || 'No reason provided'}`
    });
    
    // Restore stock for all items
    const Product = require('../models/Product');
    for (const item of order.items) {
      const product = await Product.findById(item.productId);
      if (product) {
        product.stock += item.quantity;
        await product.save();
      }
    }
    
    await order.save();
    
    // Populate order details
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: populatedOrder
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message
    });
  }
};

// @desc    Return order
// @route   POST /api/orders/:id/return
// @access  Private
exports.returnOrder = async (req, res) => {
  try {
    const { reason } = req.body;
    
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order belongs to user
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to return this order'
      });
    }
    
    // Check if order is delivered
    if (order.orderStatus !== 'Delivered') {
      return res.status(400).json({
        success: false,
        message: 'Only delivered orders can be returned'
      });
    }
    
    if (order.orderStatus === 'Returned') {
      return res.status(400).json({
        success: false,
        message: 'Order is already marked as returned'
      });
    }
    
    // Check if return window is valid (e.g., within 7 days of delivery)
    const deliveryDate = new Date(order.deliveredAt);
    const currentDate = new Date();
    const daysSinceDelivery = Math.floor((currentDate - deliveryDate) / (1000 * 60 * 60 * 24));
    
    if (daysSinceDelivery > 7) {
      return res.status(400).json({
        success: false,
        message: 'Return window has expired. Returns are only accepted within 7 days of delivery.'
      });
    }
    
    // Update order status
    order.orderStatus = 'Returned';
    order.returnReason = reason || 'Returned by customer';
    order.returnedAt = new Date();
    
    // Add to status history
    order.statusHistory.push({
      status: 'Returned',
      timestamp: new Date(),
      note: `Return requested by customer: ${reason || 'No reason provided'}`
    });
    
    await order.save();
    
    // Populate order details
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    res.json({
      success: true,
      message: 'Return request submitted successfully. Our team will contact you soon.',
      data: populatedOrder
    });
  } catch (error) {
    console.error('Return order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process return request',
      error: error.message
    });
  }
};

// @desc    Approve return request (Admin)
// @route   PUT /api/admin/product-orders/:id/approve-return
// @access  Private (Admin)
exports.approveReturn = async (req, res) => {
  try {
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.orderStatus !== 'Returned') {
      return res.status(400).json({
        success: false,
        message: 'Only returned orders can be approved'
      });
    }
    
    // Update order with approval
    order.returnApproved = true;
    order.returnApprovedAt = new Date();
    order.returnApprovedBy = req.user?._id || null;
    
    // Add to status history
    order.statusHistory.push({
      status: 'Return Approved',
      timestamp: new Date(),
      note: 'Return request approved by admin. Pickup will be scheduled.'
    });
    
    await order.save();
    
    // TODO: Schedule pickup with logistics partner
    // TODO: Send email notification to customer
    
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    res.json({
      success: true,
      message: 'Return request approved successfully. Pickup will be scheduled.',
      data: populatedOrder
    });
  } catch (error) {
    console.error('Approve return error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve return request',
      error: error.message
    });
  }
};

// @desc    Reject return request (Admin)
// @route   PUT /api/admin/product-orders/:id/reject-return
// @access  Private (Admin)
exports.rejectReturn = async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }
    
    const order = await ProductOrder.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.orderStatus !== 'Returned') {
      return res.status(400).json({
        success: false,
        message: 'Only returned orders can be rejected'
      });
    }
    
    // Update order status back to Delivered
    order.orderStatus = 'Delivered';
    order.returnRejected = true;
    order.returnRejectedAt = new Date();
    order.returnRejectedBy = req.user?._id || null;
    order.returnRejectionReason = reason;
    
    // Add to status history
    order.statusHistory.push({
      status: 'Return Rejected',
      timestamp: new Date(),
      note: `Return request rejected: ${reason}`
    });
    
    await order.save();
    
    // TODO: Send email notification to customer with rejection reason
    
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    res.json({
      success: true,
      message: 'Return request rejected. Customer will be notified.',
      data: populatedOrder
    });
  } catch (error) {
    console.error('Reject return error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject return request',
      error: error.message
    });
  }
};
