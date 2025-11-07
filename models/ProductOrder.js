const mongoose = require('mongoose');

const productOrderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  orderNumber: {
    type: String,
    required: true
  },
  items: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    productName: String,
    productImage: String,
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1']
    },
    price: {
      type: Number,
      required: true,
      min: [0, 'Price cannot be negative']
    },
    subtotal: {
      type: Number,
      required: true
    }
  }],
  shippingAddress: {
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Address'
    },
    fullName: {
      type: String,
      required: true
    },
    phone: {
      type: String,
      required: true
    },
    addressLine1: {
      type: String,
      required: true
    },
    addressLine2: String,
    city: {
      type: String,
      required: true
    },
    state: {
      type: String,
      required: true
    },
    postalCode: {
      type: String,
      required: true
    },
    country: {
      type: String,
      default: 'India'
    }
  },
  pricing: {
    subtotal: {
      type: Number,
      required: true
    },
    gst: {
      type: Number,
      default: 0
    },
    discount: {
      type: Number,
      default: 0
    },
    deliveryFee: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      required: true
    }
  },
  coupon: {
    code: String,
    discount: Number
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['COD', 'Razorpay', 'Online'],
    default: 'COD'
  },
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Failed', 'Refunded'],
    default: 'Pending'
  },
  orderStatus: {
    type: String,
    enum: ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned'],
    default: 'Order Placed'
  },
  statusHistory: [{
    status: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    note: String
  }],
  deliveryDate: Date,
  cancelReason: String,
  cancelledAt: Date,
  returnReason: String,
  returnedAt: Date,
  returnApproved: {
    type: Boolean,
    default: false
  },
  returnApprovedAt: Date,
  returnApprovedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  returnRejected: {
    type: Boolean,
    default: false
  },
  returnRejectedAt: Date,
  returnRejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  returnRejectionReason: String,
  deliveredAt: Date,
  notes: String
}, {
  timestamps: true
});

// Generate order number before saving (fallback if not provided)
productOrderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await this.constructor.countDocuments();
    this.orderNumber = `ORD${Date.now()}${String(count + 1).padStart(4, '0')}`;
  }
  
  // Add initial status to history only if new and history is empty
  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.orderStatus,
      timestamp: new Date(),
      note: 'Order placed'
    });
  }
  
  next();
});

// Indexes
productOrderSchema.index({ userId: 1, createdAt: -1 });
productOrderSchema.index({ orderNumber: 1 }, { unique: true });
productOrderSchema.index({ orderStatus: 1 });
productOrderSchema.index({ paymentStatus: 1 });

module.exports = mongoose.model('ProductOrder', productOrderSchema);
