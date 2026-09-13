const mongoose = require('mongoose');

/**
 * The shipping address is only required when the order is being delivered.
 * A store-pickup order carries the centre in `fulfilment` instead. Nested
 * paths validate with `this` = the order, so the rule can read the type.
 */
const deliveryOnly = function deliveryOnly() { return !(this.fulfilment && this.fulfilment.type === 'pickup'); };

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
  /**
   * Delivery or store pickup (utils/orderFulfilment.js).
   *
   * `branchId` is the centre the order belongs to in either flow: the centre
   * the guest was shopping at (which sets centre-wise prices) and, for pickup,
   * the centre they collect from. Pickup orders carry a six-character code the
   * guest shows at the desk, the centre's address as it stood when the order
   * was placed, and the timestamps of the two pickup steps.
   */
  fulfilment: {
    type: { type: String, enum: ['delivery', 'pickup'], default: 'delivery', index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    branchName: { type: String, default: null, trim: true },
    pickupAddress: {
      addressLine1: { type: String, default: null },
      city: { type: String, default: null },
      state: { type: String, default: null },
      pincode: { type: String, default: null },
      phone: { type: String, default: null },
    },
    readyAt: { type: Date, default: null },
    collectedAt: { type: Date, default: null },
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    collectedNote: { type: String, default: null },
  },
  /**
   * The handover code — the one thing that says the right person received the
   * order (utils/orderFulfilment.js).
   *
   * Both flows end with it. A store-pickup order gets its code the moment the
   * order exists, because the guest can walk in as soon as it is ready; a
   * delivery order gets one when a rider is assigned, because until then there
   * is nobody to show it to. It is messaged to WhatsApp and email as soon as
   * it is issued, and shown in the app from that moment.
   *
   * Nothing is marked Collected or Delivered without it. `method` records how
   * the handover was confirmed: 'code' when it was typed and matched,
   * 'override' when staff could not get it and said why instead.
   */
  handover: {
    code: { type: String, default: null, trim: true, uppercase: true },
    /** Which flow the code was cut for, so a changed order cannot reuse the wrong one. */
    issuedFor: { type: String, enum: ['delivery', 'pickup', null], default: null },
    issuedAt: { type: Date, default: null },
    /** Last time it went out, and by which routes. */
    sentAt: { type: Date, default: null },
    sentChannels: { type: [String], default: [] },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    method: { type: String, enum: ['code', 'override', null], default: null },
    note: { type: String, default: null },
  },
  shippingAddress: {
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Address'
    },
    fullName: {
      type: String,
      required: deliveryOnly
    },
    phone: {
      type: String,
      required: deliveryOnly
    },
    addressLine1: {
      type: String,
      required: deliveryOnly
    },
    addressLine2: String,
    city: {
      type: String,
      required: deliveryOnly
    },
    state: {
      type: String,
      required: deliveryOnly
    },
    postalCode: {
      type: String,
      required: deliveryOnly
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
    // 'Razorpay'/'Online' are the only methods new orders may use — cash on
    // delivery was withdrawn in the 2026-09 store policy. 'COD' is KEPT in the
    // enum on purpose: thousands of historical orders carry it, and dropping
    // the value would make every one of them fail validation on the next save
    // (cancel, return, status change). Nothing may write it going forward.
    enum: ['Razorpay', 'Online', 'COD', 'Clinic'],
    default: 'Razorpay'
  },
  /** 'zenoti' = a sale rung up at the clinic counter, mirrored from Zenoti. */
  source: { type: String, enum: ['app', 'zenoti'], default: 'app', index: true },
  paymentStatus: {
    type: String,
    /**
     * 'Partially Refunded' exists because the panel offers an editable refund
     * amount. Without it a part refund left the order 'Paid' and its
     * refundDetails 'Completed', which read as fully settled and blocked the
     * balance from ever being returned.
     */
    enum: ['Pending', 'Paid', 'Failed', 'Refunded', 'Partially Refunded'],
    default: 'Pending'
  },
  orderStatus: {
    type: String,
    // 'Ready for Pickup' and 'Collected' are the store-pickup flow's last two
    // steps; 'Shipped' → 'Delivered' belong to delivery only. Which ladder an
    // order follows is decided by fulfilment.type (utils/orderFulfilment.js).
    enum: [
      'Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped',
      'Out for Delivery', 'Delivery Failed', 'Delivered',
      'Ready for Pickup', 'Collected',
      'Cancelled', 'Return Requested', 'Returned'
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
    /** The most recent refund's amount. `amountRefunded` is the running total. */
    amount: {
      type: Number,
      default: 0
    },
    /**
     * Everything returned to the guest so far, across every part refund. This
     * is what decides whether more can be returned, never `amount`.
     */
    amountRefunded: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['Pending', 'Processing', 'Completed', 'Failed'],
      default: 'Pending'
    },
    /** One row per refund attempt, so a part-refunded order can be audited. */
    history: [{
      amount: Number,
      razorpayRefundId: String,
      status: { type: String, enum: ['Processing', 'Completed', 'Failed'] },
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
      note: String,
      _id: false,
    }],
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
    refundNotifiedAt: Date,
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
  /** Zenoti's line-item id for a counter sale — the idempotency key for the mirror. */
  zenotiSaleId: { type: String, default: null },
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
// Analytics windows: orders placed in a period ({ createdAt: in window }) and
// the paid ones ({ paymentStatus: 'Paid', createdAt: in window }) — the
// dashboard, financial and monthly-revenue reports. `{ userId, createdAt }`
// above only serves one guest's history, not a clinic-wide window.
productOrderSchema.index({ createdAt: -1 });
productOrderSchema.index({ paymentStatus: 1, createdAt: -1 });
productOrderSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, sparse: true, name: 'one_product_order_per_razorpay_order' }
);
productOrderSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, sparse: true, name: 'one_product_order_per_razorpay_payment' }
);

productOrderSchema.index({ zenotiSaleId: 1 }, { unique: true, partialFilterExpression: { zenotiSaleId: { $type: 'string' } } });
// The desk's pickup queue: open pickup orders at one centre, newest first.
productOrderSchema.index({ 'fulfilment.type': 1, 'fulfilment.branchId': 1, orderStatus: 1, createdAt: -1 });
// A code is looked up when the guest reads it out, and checked for collisions
// while it is live; only an open order carries one.
productOrderSchema.index({ 'handover.code': 1 }, { partialFilterExpression: { 'handover.code': { $type: 'string' } } });

module.exports = mongoose.model('ProductOrder', productOrderSchema);
