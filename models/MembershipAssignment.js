const mongoose = require('mongoose');

/**
 * A guest's membership — one row per sale, with its own member number,
 * validity, the discount rules frozen at sale and the credit balances.
 *
 * User.memberType / zenMembership* stay as the guest's CURRENT-membership
 * summary (the app and the panel read them everywhere); syncUserMembership()
 * in utils/membershipRules.js keeps that summary in step with these rows.
 */
const membershipAssignmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  membershipId: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true, index: true },
  memberNumber: { type: String, default: null, index: true },
  snapshot: {
    name: String, code: String,
    discounts: { servicesPercent: { type: Number, default: 0 }, productsPercent: { type: Number, default: 0 }, packagesPercent: { type: Number, default: 0 } },
    validityMonths: Number,
    branchIds: { type: [String], default: [] },
  },
  credits: [{
    _id: false,
    serviceId: String, serviceName: String, qty: { type: Number, default: 0 }, used: { type: Number, default: 0 },
  }],
  price: { type: Number, default: 0 },
  payment: {
    isReceived: { type: Boolean, default: false },
    receivedDate: { type: Date, default: null },
    paymentMethod: { type: String, default: null },
    transactionId: { type: String, default: null },
    amountPaid: { type: Number, default: null },
    balanceDue: { type: Number, default: null },
  },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  status: { type: String, enum: ['Active', 'Expired', 'Cancelled'], default: 'Active', index: true },
  validFrom: { type: Date, default: Date.now },
  validUntil: { type: Date, default: null, index: true },
  autoRenew: { type: Boolean, default: false },
  redemptions: [{
    _id: false,
    at: Date, kind: { type: String, enum: ['credit', 'discount'] }, serviceId: String, serviceName: String, amount: Number,
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }, invoiceNumber: String, byName: String, reversed: { type: Boolean, default: false },
  }],
  cancellation: { cancelledAt: Date, byName: String, reason: String, refundAmount: Number, refundMethod: String },
  notes: { type: String, default: '' },
  source: { type: String, enum: ['panel', 'app', 'zenoti'], default: 'panel', index: true },
  zenotiUserMembershipId: { type: String, default: null, index: true },
  zenotiInvoiceNumber: { type: String, default: null },
  soldByName: { type: String, default: null },
}, { timestamps: true });

membershipAssignmentSchema.index({ userId: 1, status: 1, validUntil: -1 });

membershipAssignmentSchema.methods.isCurrent = function(at = new Date()) {
  return this.status === 'Active' && (!this.validUntil || new Date(this.validUntil) > at);
};

membershipAssignmentSchema.methods.creditBalances = function() {
  return (this.credits || []).map((c) => ({ serviceId: c.serviceId, serviceName: c.serviceName, entitled: c.qty, used: c.used, balance: Math.max(0, (c.qty || 0) - (c.used || 0)) }));
};

module.exports = mongoose.model('MembershipAssignment', membershipAssignmentSchema);
