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
    // 'COD' = cash on delivery (createOrder defaults to it); 'Razorpay'/'Online'
    // for prepaid. COD was missing here, so every cash order failed validation.
    enum: ['Razorpay', 'Online', 'COD'],
    default: 'Razorpay'
  },
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Failed', 'Refunded'],
    default: 'Pending'
  },
  orderStatus: {
    type: String,
    enum: [
      'Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped',
      'Out for Delivery', 'Delivery Failed', 'Delivered', 'Cancelled',
      'Return Requested', 'Returned'
    ],
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
  trackingId: String,
  courier: String,
  estimatedDelivery: Date,
  deliveryPartner: String,
  deliveryPartnerPhone: String,
  expectedDeliveryTime: Date,
  deliveryAttempt: { type: Number, default: 0 },
  deliveryAssignedAt: Date,
  deliveryAssignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  deliveryFailedAt: Date,
  deliveryFailureReason: String,
  deliveryFailures: [{
    attempt: Number,
    failedAt: { type: Date, default: Date.now },
    reason: String,
    note: String,
    deliveryPartner: String,
    deliveryPartnerPhone: String,
    courier: String,
    trackingId: String,
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
  }],
  cancelReason: String,
  cancelledAt: Date,
  returnReason: String,
  returnRequestedAt: Date,
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
  stockRestoredAt: Date,
  stockRestorationReason: String,
  notes: String,
  // Refund Management
  refundDetails: {
    method: {
      type: String,
      enum: ['Razorpay', 'Bank Transfer', 'UPI', 'Store Credit', 'Cash'],
      default: null
    },
    amount: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ['Pending', 'Processing', 'Completed', 'Failed'],
      default: 'Pending'
    },
    bankDetails: {
      accountHolderName: String,
      bankName: String,
      accountNumber: String,
      ifscCode: String,
      upiId: String
    },
    razorpayRefundId: String,
    transactionId: String,
    transactionProof: String, // URL to uploaded proof
    refundInitiatedAt: Date,
    refundCompletedAt: Date,
    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    notes: String,
    failureReason: String,
    idempotencyKey: String,
    trigger: {
      type: String,
      enum: ['customer_cancellation', 'admin_cancellation', 'return_completed', 'manual'],
      default: 'manual'
    },
    retryCount: { type: Number, default: 0 },
    lastRetryAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
  },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  razorpaySignature: String,

  // Zenoti write-back (Phase 2): the product invoice this order created in the
  // CRM, and its sync status, for idempotency + observability.
  zenotiInvoiceId: { type: String, default: null },
  zenotiSyncStatus: {
    type: String,
    enum: ['pending', 'synced', 'failed', 'skipped', 'dryrun', null],
    default: null
  },
  zenotiSyncError: { type: String, default: null },
  zenotiSyncedAt: { type: Date, default: null },

  /** Set when the owner deleted their account; kept, anonymised, for accounting. */
  accountDeleted: { type: Boolean, default: false },
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

  // Remember first-save for the post-save Zenoti push.
  this._wasNew = this.isNew;

  next();
});

// Push a newly-created order to Zenoti as a product invoice. Fire-and-forget and
// gated by ZENOTI_WRITE_MODE — a CRM failure never affects the order itself.
productOrderSchema.post('save', function (doc) {
  if (!doc._wasNew) return;
  if (doc.zenotiInvoiceId) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncOrder(doc._id).catch(() => {});
    } catch (_) { /* never let CRM wiring affect order creation */ }
  });
});

// Indexes
productOrderSchema.index({ userId: 1, createdAt: -1 });
productOrderSchema.index({ orderNumber: 1 }, { unique: true });
productOrderSchema.index({ orderStatus: 1 });
productOrderSchema.index({ paymentStatus: 1 });
productOrderSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, sparse: true, name: 'one_product_order_per_razorpay_order' }
);
productOrderSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, sparse: true, name: 'one_product_order_per_razorpay_payment' }
);

module.exports = mongoose.model('ProductOrder', productOrderSchema);
