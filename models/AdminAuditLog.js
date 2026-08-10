const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true,
    index: true
  },
  adminEmail: {
    type: String,
    required: true
  },
  action: {
    type: String,
    required: true,
    enum: [
      // Authentication
      'LOGIN',
      'LOGOUT',
      'OTP_REQUESTED',
      'OTP_VERIFIED',
      'FAILED_LOGIN',
      
      // Product Management
      'PRODUCT_CREATED',
      'PRODUCT_UPDATED',
      'PRODUCT_DELETED',
      'PRODUCT_STATUS_CHANGED',
      'STOCK_UPDATED',
      'BULK_UPDATE',
      
      // Order Management
      'ORDER_STATUS_UPDATED',
      'ORDER_DELETED',
      'RETURN_APPROVED',
      'RETURN_REJECTED',
      
      // User Management
      'USER_ACTIVATED',
      'USER_DEACTIVATED',
      'USER_DELETED',
      
      // Admin Management
      'ADMIN_CREATED',
      'ADMIN_ROLE_CHANGED',
      'ADMIN_DEACTIVATED',
      
      // Booking / front desk
      'BOOKING_CONFIRMED',
      'BOOKING_CHECKED_IN',
      'BOOKING_CHECKED_OUT',
      'BOOKING_CANCELLED',
      'BOOKING_NO_SHOW',
      'BOOKING_CREATED',
      'BOOKING_RESCHEDULED',

      // Catalogue (services, categories, packages, coupons)
      'CATALOGUE_CREATED',
      'CATALOGUE_UPDATED',
      'CATALOGUE_DELETED',
      'CATALOGUE_STATUS_CHANGED',

      // Doctors
      'DOCTOR_CREATED',
      'DOCTOR_UPDATED',
      'DOCTOR_DELETED',
      'DOCTOR_STATUS_CHANGED',
      'DOCTOR_FEE_REQUESTED',
      'DOCTOR_FEE_APPROVED',
      'DOCTOR_FEE_REJECTED',

      // Branches
      'BRANCH_CREATED',
      'BRANCH_UPDATED',
      'BRANCH_DELETED',
      'BRANCH_STATUS_CHANGED',

      // Inventory & vendors
      'INVENTORY_CREATED',
      'INVENTORY_UPDATED',
      'INVENTORY_DELETED',
      'VENDOR_CREATED',
      'VENDOR_UPDATED',
      'VENDOR_DELETED',

      // Reviews & support
      'REVIEW_APPROVED',
      'REVIEW_REJECTED',
      'REVIEW_DELETED',
      'SUPPORT_UPDATED',

      // Clinical
      'PRESCRIPTION_SAVED',
      'CONSENT_SIGNED',
      'FORM_STATUS_CHANGED',

      // Settings
      'SETTINGS_UPDATED',
      'CONFIG_CHANGED',
      'APP_CUSTOMIZATION_UPDATED',

      // Security
      'UNAUTHORIZED_ACCESS_ATTEMPT',
      'PERMISSION_DENIED',
      'SUSPICIOUS_ACTIVITY'
    ]
  },
  resource: {
    type: String,
    required: true,
    enum: [
      'AUTH', 'PRODUCT', 'ORDER', 'USER', 'ADMIN', 'SETTINGS', 'SECURITY',
      'BOOKING', 'CATALOGUE', 'DOCTOR', 'BRANCH', 'INVENTORY', 'VENDOR',
      'REVIEW', 'SUPPORT', 'CLINICAL',
    ]
  },
  resourceId: {
    type: String, // ID of affected resource (order ID, product ID, etc.)
    default: null
  },
  details: {
    type: Object, // Additional context about the action
    default: {}
  },
  ipAddress: {
    type: String,
    required: true
  },
  userAgent: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILED', 'WARNING'],
    default: 'SUCCESS'
  },
  errorMessage: {
    type: String,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
AdminAuditLogSchema.index({ adminId: 1, timestamp: -1 });
AdminAuditLogSchema.index({ action: 1, timestamp: -1 });
AdminAuditLogSchema.index({ resource: 1, timestamp: -1 });
AdminAuditLogSchema.index({ status: 1, timestamp: -1 });

// Static method to log action
AdminAuditLogSchema.statics.logAction = async function(data) {
  try {
    const log = await this.create({
      adminId: data.adminId,
      adminEmail: data.adminEmail,
      action: data.action,
      resource: data.resource,
      resourceId: data.resourceId || null,
      details: data.details || {},
      ipAddress: data.ipAddress,
      userAgent: data.userAgent || null,
      status: data.status || 'SUCCESS',
      errorMessage: data.errorMessage || null
    });
    console.log(`📝 Audit log created: ${data.action} by ${data.adminEmail}`);
    return log;
  } catch (error) {
    console.error('❌ Failed to create audit log:', error);
    // Don't throw error to prevent disrupting main operation
    return null;
  }
};

// Static method to get admin activity
AdminAuditLogSchema.statics.getAdminActivity = async function(adminId, options = {}) {
  const {
    limit = 50,
    skip = 0,
    startDate = null,
    endDate = null,
    action = null,
    resource = null
  } = options;

  const query = { adminId };

  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  if (action) query.action = action;
  if (resource) query.resource = resource;

  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .skip(skip)
    .lean();
};

// Static method to get suspicious activities
AdminAuditLogSchema.statics.getSuspiciousActivities = async function(timeWindow = 24) {
  const cutoffTime = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
  
  return this.find({
    timestamp: { $gte: cutoffTime },
    $or: [
      { status: 'FAILED' },
      { action: 'UNAUTHORIZED_ACCESS_ATTEMPT' },
      { action: 'PERMISSION_DENIED' },
      { action: 'SUSPICIOUS_ACTIVITY' }
    ]
  })
  .sort({ timestamp: -1 })
  .limit(100)
  .lean();
};

// Auto-delete logs older than 90 days (data retention policy)
AdminAuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
