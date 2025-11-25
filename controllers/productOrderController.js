const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const Address = require('../models/Address');
const User = require('../models/User');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const emailService = require('../utils/emailService');
const logger = require('../utils/logger');
const { validateOwnership } = require('../middleware/securityMiddleware');

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
    
    // Get address details and verify it belongs to the user
    const address = await Address.findOne({ _id: addressId, userId: req.user._id });
    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found or has been deleted. Please select a valid address.'
      });
    }

    // Validate address has all required fields
    if (!address.fullName || !address.phone || !address.addressLine1 || 
        !address.city || !address.state || !address.postalCode) {
      return res.status(400).json({
        success: false,
        message: 'Selected address is incomplete. Please update or select another address.'
      });
    }
    
    // Validate and process items
    const processedItems = [];
    let calculatedSubtotal = 0;
    
    // First pass: validate all items before modifying stock
    const itemsToProcess = [];
    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid item data in cart'
        });
      }
      
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
      
      itemsToProcess.push({ product, quantity: item.quantity });
    }
    
    // Second pass: atomically reduce stock using findByIdAndUpdate to prevent race conditions
    for (const { product, quantity } of itemsToProcess) {
      // Use atomic update with $inc to prevent race conditions
      const updated = await Product.findOneAndUpdate(
        { 
          _id: product._id, 
          stock: { $gte: quantity }, // Ensure stock is still sufficient
          isActive: true 
        },
        { 
          $inc: { stock: -quantity } 
        },
        { 
          new: true, // Return updated document
          runValidators: true 
        }
      );
      
      if (!updated) {
        // Stock changed between validation and update - rollback previous items
        for (let i = 0; i < processedItems.length; i++) {
          await Product.findByIdAndUpdate(
            itemsToProcess[i].product._id,
            { $inc: { stock: itemsToProcess[i].quantity } }
          );
        }
        
        return res.status(400).json({
          success: false,
          message: `Stock changed for ${product.name}. Please try again.`,
          requiresRefresh: true
        });
      }
      
      // Use product price
      const price = product.price;
      const subtotal = price * quantity;
      calculatedSubtotal += subtotal;
      
      processedItems.push({
        productId: product._id,
        productName: product.name,
        productImage: product.image,
        quantity: quantity,
        price: price,
        subtotal: subtotal
      });
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
      
      console.log('Attempting to create notification for order:', {
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
      console.log('Order notification created successfully');
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
      console.error('Error stack:', notifError.stack);
    }

    // Send WhatsApp and Email order confirmation
    try {
      const user = await User.findById(req.user._id);
      const formattedAddress = `${populatedOrder.shippingAddress.addressLine1}, ${populatedOrder.shippingAddress.city}, ${populatedOrder.shippingAddress.state} - ${populatedOrder.shippingAddress.postalCode}`;
      
      const orderData = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber,
        orderDate: populatedOrder.createdAt.toLocaleDateString('en-IN'),
        items: populatedOrder.items.map(item => ({
          name: item.productName,
          quantity: item.quantity,
          price: item.price,
          subtotal: item.subtotal
        })),
        subtotal: populatedOrder.pricing.subtotal,
        gst: populatedOrder.pricing.gst,
        deliveryFee: populatedOrder.pricing.deliveryFee,
        discount: populatedOrder.pricing.discount,
        total: populatedOrder.pricing.total,
        shippingAddress: formattedAddress,
        paymentMethod: populatedOrder.paymentMethod
      };

      // Send WhatsApp
      if (user && user.phone) {
        await whatsappService.sendOrderConfirmation(user.phone, orderData);
        console.log('WhatsApp order confirmation sent');
      }

      // Send Email
      if (user && user.email) {
        await emailService.sendOrderConfirmationEmail(user.email, orderData.customerName, orderData);
        console.log('Email order confirmation sent');
      }
    } catch (error) {
      console.error('Notification sending failed:', error.message);
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
    
    const validStatuses = ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order status'
      });
    }
    
    const oldStatus = order.orderStatus;
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

    // Send WhatsApp and Email notifications based on status
    console.log('=== NOTIFICATION PROCESS STARTED ===');
    console.log('Order ID:', order._id);
    console.log('New Status:', status);
    
    try {
      console.log('Step 1: Fetching user data...');
      const populatedOrder = await ProductOrder.findById(order._id).populate('userId', 'fullName email phone');
      
      if (!populatedOrder) {
        console.error('ERROR: Order not found after save!');
        return;
      }
      
      const user = populatedOrder.userId;
      console.log('Step 2: User populated successfully');
      console.log('User details:', {
        userId: user?._id,
        phone: user?.phone,
        email: user?.email,
        name: user?.fullName
      });
      
      if (!user) {
        console.error('ERROR: User not found for order:', order._id);
        return;
      }
      
      if (!user.phone && !user.email) {
        console.error('ERROR: User has no phone or email!');
        return;
      }
      
      console.log('Step 3: Building notification data...');
      const formattedAddress = `${populatedOrder.shippingAddress.addressLine1}, ${populatedOrder.shippingAddress.city}, ${populatedOrder.shippingAddress.state} - ${populatedOrder.shippingAddress.postalCode}`;
      
      const data = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber,
        shippingAddress: formattedAddress
      };

      console.log('Step 4: Preparing to send notifications for status:', status);
      console.log('User phone available?', !!user.phone);
      console.log('User email available?', !!user.email);

      let notificationSent = false;

      switch (status) {
        case 'Confirmed':
        case 'Processing':
          console.log('>>> Matched status: Processing');
          try {
            if (user.phone) {
              console.log('Attempting WhatsApp to:', user.phone);
              const whatsappResult = await whatsappService.sendOrderProcessing(user.phone, data);
              console.log('WhatsApp result:', whatsappResult);
              notificationSent = true;
            }
            if (user.email) {
              console.log('Attempting Email to:', user.email);
              await emailService.sendOrderProcessingEmail(user.email, data.customerName, data);
              console.log('Email sent successfully');
              notificationSent = true;
            }
          } catch (err) {
            console.error('ERROR in Processing notification:', err);
          }
          break;
        case 'Packed':
          console.log('>>> Matched status: Packed');
          try {
            if (user.phone) {
              console.log('Attempting WhatsApp Packed to:', user.phone);
              await whatsappService.sendOrderPacked(user.phone, data);
              notificationSent = true;
            }
            if (user.email) {
              console.log('Attempting Email Packed to:', user.email);
              await emailService.sendOrderPackedEmail(user.email, data.customerName, data);
              notificationSent = true;
            }
          } catch (err) {
            console.error('ERROR in Packed notification:', err);
          }
          break;
        case 'Shipped':
          console.log('>>> Matched status: Shipped');
          data.trackingId = order.trackingId;
          data.estimatedDelivery = order.estimatedDelivery;
          data.courier = order.courier;
          try {
            if (user.phone) {
              console.log('Attempting WhatsApp Shipped to:', user.phone);
              await whatsappService.sendOrderShipped(user.phone, data);
              notificationSent = true;
            }
            if (user.email) {
              console.log('Attempting Email Shipped to:', user.email);
              await emailService.sendOrderShippedEmail(user.email, data.customerName, data);
              notificationSent = true;
            }
          } catch (err) {
            console.error('ERROR in Shipped notification:', err);
          }
          break;
        case 'Out for Delivery':
          console.log('>>> Matched status: Out for Delivery');
          data.deliveryPartner = order.deliveryPartner;
          data.expectedTime = order.expectedDeliveryTime;
          try {
            if (user.phone) {
              console.log('Attempting WhatsApp Out for Delivery to:', user.phone);
              await whatsappService.sendOrderOutForDelivery(user.phone, data);
              notificationSent = true;
            }
            if (user.email) {
              console.log('Attempting Email Out for Delivery to:', user.email);
              await emailService.sendOrderOutForDeliveryEmail(user.email, data.customerName, data);
              notificationSent = true;
            }
          } catch (err) {
            console.error('ERROR in Out for Delivery notification:', err);
          }
          break;
        case 'Delivered':
          console.log('>>> Matched status: Delivered');
          data.deliveredAt = order.deliveredAt.toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short'
          });
          try {
            if (user.phone) {
              console.log('Attempting WhatsApp Delivered to:', user.phone);
              await whatsappService.sendOrderDelivered(user.phone, data);
              notificationSent = true;
            }
            if (user.email) {
              console.log('Attempting Email Delivered to:', user.email);
              await emailService.sendOrderDeliveredEmail(user.email, data.customerName, data);
              notificationSent = true;
            }
          } catch (err) {
            console.error('ERROR in Delivered notification:', err);
          }
          break;
        default:
          console.log('>>> WARNING: No notification configured for status:', status);
      }
      
      if (notificationSent) {
        console.log('=== NOTIFICATION SENT SUCCESSFULLY ===');
      } else {
        console.log('=== NO NOTIFICATION WAS SENT ===');
      }
    } catch (error) {
      console.error('=== CRITICAL ERROR IN NOTIFICATION PROCESS ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    console.log('=== NOTIFICATION PROCESS ENDED ===\n')
    
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

    // Send WhatsApp and Email cancellation notification
    try {
      const user = populatedOrder.userId;
      const data = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber,
        reason: reason || 'As per your request',
        cancelledAt: order.cancelledAt.toLocaleDateString('en-IN'),
        totalAmount: populatedOrder.pricing.total,
        refundInfo: populatedOrder.paymentStatus === 'Paid'
      };
      
      if (user) {
        if (user.phone) {
          await whatsappService.sendOrderCancelled(user.phone, data);
          console.log('WhatsApp order cancellation notification sent');
        }
        if (user.email) {
          await emailService.sendOrderCancelledEmail(user.email, data.customerName, data);
          console.log('Email order cancellation notification sent');
        }
      }
    } catch (error) {
      console.error('Notification sending failed:', error.message);
    }
    
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
    if (!order.deliveredAt) {
      return res.status(400).json({
        success: false,
        message: 'Order delivery date not found. Cannot process return.'
      });
    }
    
    const deliveryDate = new Date(order.deliveredAt);
    const currentDate = new Date();
    
    // Validate delivery date is valid
    if (isNaN(deliveryDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery date. Cannot process return.'
      });
    }
    
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

    // Send WhatsApp and Email return request notification
    try {
      const user = populatedOrder.userId;
      const data = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber,
        reason: reason || 'No reason provided',
        returnDate: order.returnedAt.toLocaleDateString('en-IN')
      };
      
      if (user) {
        if (user.phone) {
          await whatsappService.sendReturnRequestReceived(user.phone, data);
          console.log('WhatsApp return request notification sent');
        }
        if (user.email) {
          await emailService.sendReturnRequestReceivedEmail(user.email, data.customerName, data);
          console.log('Email return request notification sent');
        }
      }
    } catch (error) {
      console.error('Notification sending failed:', error.message);
    }
    
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
    
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');

    // Send WhatsApp and Email return approved notification
    try {
      const user = populatedOrder.userId;
      const data = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber
      };
      
      if (user) {
        if (user.phone) {
          await whatsappService.sendReturnApproved(user.phone, data);
          console.log('WhatsApp return approved notification sent');
        }
        if (user.email) {
          await emailService.sendReturnApprovedEmail(user.email, data.customerName, data);
          console.log('Email return approved notification sent');
        }
      }
    } catch (error) {
      console.error('Notification sending failed:', error.message);
    }
    
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
    
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');

    // Send WhatsApp and Email return rejected notification
    try {
      const user = populatedOrder.userId;
      const data = {
        customerName: populatedOrder.shippingAddress.fullName,
        orderNumber: populatedOrder.orderNumber,
        rejectionReason: reason
      };
      
      if (user) {
        if (user.phone) {
          await whatsappService.sendReturnRejected(user.phone, data);
          console.log('WhatsApp return rejected notification sent');
        }
        if (user.email) {
          await emailService.sendReturnRejectedEmail(user.email, data.customerName, data);
          console.log('Email return rejected notification sent');
        }
      }
    } catch (error) {
      console.error('Notification sending failed:', error.message);
    }
    
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
