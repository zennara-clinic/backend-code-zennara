const ProductOrder = require('../models/ProductOrder');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { initiateOnlineRefund } = require('../services/orderLifecycleService');
const whatsappService = require('../services/whatsappService');
const emailService = require('../utils/emailService');

// Validation helpers
const validateBankDetails = (details, method) => {
  if (!details) return false;
  
  if (method === 'Bank Transfer') {
    return !!(
      details.accountHolderName &&
      details.bankName &&
      details.accountNumber &&
      details.ifscCode &&
      details.accountNumber.length >= 9 &&
      details.accountNumber.length <= 18 &&
      details.ifscCode.length === 11
    );
  }
  
  if (method === 'UPI') {
    return !!(details.upiId && details.upiId.includes('@'));
  }
  
  return true;
};

const validateRefundAmount = (amount, total) => {
  return amount > 0 && amount <= total && Number.isFinite(amount);
};

/**
 * @desc    Initiate refund process (admin only)
 * @route   POST /api/admin/product-orders/:id/initiate-refund
 * @access  Private (Admin)
 */
exports.initiateRefund = async (req, res) => {
  try {
    const { refundMethod, bankDetails, transactionId, notes, refundAmount } = req.body;
    const orderId = req.params.id;
    
    console.log('Initiating refund for order:', orderId);
    
    // Validate order exists
    const order = await ProductOrder.findById(orderId)
      .populate('userId', 'fullName email phone refundBankDetails');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order is eligible for refund
    if (!['Cancelled', 'Returned'].includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Order must be cancelled or returned to process refund'
      });
    }
    
    // Check if already refunded
    if (order.paymentStatus === 'Refunded') {
      return res.status(400).json({
        success: false,
        message: 'Order has already been refunded'
      });
    }

    if (order.paymentStatus !== 'Paid') {
      return res.status(400).json({
        success: false,
        message: 'This order has no captured payment to refund'
      });
    }
    
    // Check if refund is already in progress
    if (order.refundDetails?.status === 'Processing') {
      return res.status(400).json({
        success: false,
        message: 'Refund is already in progress for this order'
      });
    }

    // A settled refund no longer blocks the balance: a part refund leaves money
    // still owed, and that must remain refundable.
    const alreadyRefunded = Number(order.refundDetails?.amountRefunded || 0);
    const refundable = Math.round((Number(order.pricing.total) - alreadyRefunded) * 100) / 100;
    if (refundable <= 0) {
      return res.status(400).json({
        success: false,
        message: `This order has been refunded in full (Rs.${alreadyRefunded.toFixed(2)}).`,
      });
    }
    
    // Determine refund amount
    const amountToRefund = refundAmount === undefined || refundAmount === null
      ? refundable
      : Number(refundAmount);

    // Against the BALANCE, not the order total — otherwise two part refunds
    // could together exceed what the guest paid.
    if (!validateRefundAmount(amountToRefund, refundable)) {
      return res.status(400).json({
        success: false,
        message: alreadyRefunded > 0
          ? `Only Rs.${refundable.toFixed(2)} is still refundable on this order (Rs.${alreadyRefunded.toFixed(2)} already returned).`
          : 'Invalid refund amount. Must be between 0 and the order total.',
      });
    }
    
    // Check payment method and process accordingly
    let refundOrder = order;
    
    /*
     * The clinic takes only online payments, so this branch is not COD: it is
     * the handful of orders paid at the clinic counter (mirrored from Zenoti),
     * which Razorpay cannot refund. Staff return the money and record it here.
     */
    const isManualRefund = !['Razorpay', 'Online'].includes(order.paymentMethod);
    if (isManualRefund) {
      if (!refundMethod || !['Bank Transfer', 'UPI', 'Cash', 'Store Credit'].includes(refundMethod)) {
        return res.status(400).json({
          success: false,
          message: 'Please specify refund method: Bank Transfer, UPI, Cash, or Store Credit'
        });
      }
      
      // For Bank Transfer or UPI, validate bank details
      if (refundMethod === 'Bank Transfer' || refundMethod === 'UPI') {
        const finalBankDetails = bankDetails || order.userId?.refundBankDetails;
        
        if (!validateBankDetails(finalBankDetails, refundMethod)) {
          return res.status(400).json({
            success: false,
            message: `Invalid or incomplete bank details for ${refundMethod}. Please provide valid details.`,
            requiresBankDetails: true,
            details: {
              method: refundMethod,
              required: refundMethod === 'Bank Transfer' 
                ? ['accountHolderName', 'bankName', 'accountNumber', 'ifscCode']
                : ['accountHolderName', 'upiId']
            }
          });
        }
        
        // Update order with refund details
        order.refundDetails = {
          method: refundMethod,
          amount: amountToRefund,
          status: 'Processing',
          bankDetails: {
            accountHolderName: finalBankDetails.accountHolderName,
            bankName: finalBankDetails.bankName,
            accountNumber: finalBankDetails.accountNumber,
            ifscCode: finalBankDetails.ifscCode,
            upiId: finalBankDetails.upiId
          },
          transactionId: transactionId || null,
          refundInitiatedAt: new Date(),
          refundedBy: (req.admin?._id || req.user?._id),
          notes: notes || 'COD order refund initiated',
          retryCount: 0,
          lastRetryAt: null
        };
      } else {
        // Cash or Store Credit
        order.refundDetails = {
          method: refundMethod,
          amount: amountToRefund,
          status: 'Processing',
          transactionId: transactionId || null,
          refundInitiatedAt: new Date(),
          refundedBy: (req.admin?._id || req.user?._id),
          notes: notes || `${refundMethod} refund initiated`,
          retryCount: 0,
          lastRetryAt: null
        };
      }
      
      // Add to status history
      order.statusHistory.push({
        status: 'Refund Initiated',
        timestamp: new Date(),
        note: `${refundMethod} refund of Rs.${amountToRefund} initiated by admin`,
        initiatedBy: (req.admin?._id || req.user?._id)
      });
      
    } else {
      try {
        const result = await initiateOnlineRefund(order._id, {
          amount: amountToRefund,
          actorId: req.admin?._id || req.user?._id,
          trigger: 'manual',
          notes: notes || 'Refund initiated by admin to the original payment method',
        });
        refundOrder = await ProductOrder.findById(result.order._id)
          .populate('userId', 'fullName email phone refundBankDetails');
      } catch (error) {
        return res.status(502).json({
          success: false,
          message: 'Razorpay refund could not be confirmed. It is safe to retry from this order.',
          error: error.message,
          errorCode: 'RAZORPAY_REFUND_FAILED'
        });
      }
    }

    if (isManualRefund) {
      order.refundDetails.amountRefunded = alreadyRefunded + amountToRefund;
      order.paymentStatus = order.refundDetails.amountRefunded >= Number(order.pricing.total)
        ? 'Refunded'
        : 'Partially Refunded';
      await order.save();
      refundOrder = order;
    }
    
    // Send notifications asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        if (refundOrder.refundDetails?.status !== 'Completed') return;
        const user = refundOrder.userId;
        const notificationData = {
          customerName: refundOrder.shippingAddress.fullName,
          orderNumber: refundOrder.orderNumber,
          refundAmount: amountToRefund,
          refundMethod: refundOrder.refundDetails.method,
          refundDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }),
          transactionId: refundOrder.refundDetails.transactionId || 'Will be updated soon',
          estimatedDays: refundOrder.refundDetails.method === 'Razorpay' ? '5-7' : '2-3'
        };
        
        if (user) {
          if (user.phone) {
            await whatsappService.sendRefundProcessed(user.phone, notificationData);
            console.log('WhatsApp refund notification sent');
          }
          if (user.email) {
            await emailService.sendRefundProcessedEmail(user.email, notificationData.customerName, notificationData);
            console.log('Email refund notification sent');
          }
        }
      } catch (error) {
        console.error('Notification sending failed:', error.message);
        // Don't fail the refund if notification fails
      }
    });
    
    res.json({
      success: true,
      message: `Refund initiated successfully via ${refundOrder.refundDetails.method}`,
      data: {
        orderId: refundOrder._id,
        orderNumber: refundOrder.orderNumber,
        refundAmount: amountToRefund,
        refundMethod: refundOrder.refundDetails.method,
        refundStatus: refundOrder.refundDetails.status,
        transactionId: refundOrder.refundDetails.transactionId,
        estimatedDays: refundOrder.refundDetails.method === 'Razorpay' ? '5-7' : '2-3'
      }
    });
    
  } catch (error) {
    console.error('Refund initiation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate refund',
      error: error.message,
      errorCode: 'REFUND_INITIATION_FAILED'
    });
  }
};

/**
 * @desc    Complete refund (mark as completed after bank transfer)
 * @route   PUT /api/admin/product-orders/:id/complete-refund
 * @access  Private (Admin)
 */
exports.completeRefund = async (req, res) => {
  try {
    const { transactionId, transactionProof, notes } = req.body;
    const orderId = req.params.id;
    
    console.log('Completing refund for order:', orderId);
    
    // Validate required fields
    if (!transactionId || !transactionId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID is required to complete refund'
      });
    }
    
    const order = await ProductOrder.findById(orderId)
      .populate('userId', 'fullName email phone');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (!order.refundDetails || order.refundDetails.status !== 'Processing') {
      return res.status(400).json({
        success: false,
        message: 'No pending refund found for this order',
        currentStatus: order.refundDetails?.status || 'None'
      });
    }

    if (order.refundDetails.method === 'Razorpay') {
      return res.status(400).json({
        success: false,
        message: 'Razorpay refunds are completed only from the verified gateway status',
      });
    }
    
    // Validate transaction ID format (basic check)
    if (transactionId.length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Invalid transaction ID format'
      });
    }
    
    // Update refund status
    order.refundDetails.status = 'Completed';
    order.refundDetails.refundCompletedAt = new Date();
    order.refundDetails.transactionId = transactionId;
    order.refundDetails.transactionProof = transactionProof || null;
    order.refundDetails.completedBy = (req.admin?._id || req.user?._id);
    
    if (notes) {
      order.refundDetails.notes = (order.refundDetails.notes || '') + '\n' + notes;
    }
    
    /*
     * Cumulative, and mirrored onto the Payment record. These used to disagree:
     * the order read 'Refunded' while its payment still read 'captured', and a
     * part refund was marked as though the whole order had been returned.
     */
    const settledNow = Number(order.refundDetails.amountRefunded || 0) + Number(order.refundDetails.amount || 0);
    order.refundDetails.amountRefunded = settledNow;
    order.paymentStatus = settledNow >= Number(order.pricing.total) ? 'Refunded' : 'Partially Refunded';
    if (order.razorpayPaymentId) {
      await Payment.findOneAndUpdate(
        { razorpayPaymentId: order.razorpayPaymentId },
        { status: order.paymentStatus === 'Refunded' ? 'refunded' : 'partially_refunded' },
      ).catch(() => {});
    }

    // Add to status history with admin info
    order.statusHistory.push({
      status: 'Refund Completed',
      timestamp: new Date(),
      note: `Refund of Rs.${order.refundDetails.amount} completed. Transaction ID: ${transactionId}`,
      completedBy: (req.admin?._id || req.user?._id)
    });
    
    await order.save();
    
    // Send completion notification asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        const user = order.userId;
        const notificationData = {
          customerName: order.shippingAddress.fullName,
          orderNumber: order.orderNumber,
          refundAmount: order.refundDetails.amount,
          refundMethod: order.refundDetails.method,
          refundDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }),
          transactionId: order.refundDetails.transactionId,
          completedAt: new Date().toLocaleString('en-IN')
        };
        
        if (user) {
          if (user.phone) {
            await whatsappService.sendRefundProcessed(user.phone, notificationData);
            console.log('WhatsApp refund completion notification sent');
          }
          if (user.email) {
            await emailService.sendRefundProcessedEmail(user.email, notificationData.customerName, notificationData);
            console.log('Email refund completion notification sent');
          }
        }
      } catch (error) {
        console.error('Notification sending failed:', error.message);
        // Don't fail the refund completion if notification fails
      }
    });
    
    res.json({
      success: true,
      message: 'Refund marked as completed successfully',
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        refundAmount: order.refundDetails.amount,
        refundMethod: order.refundDetails.method,
        refundStatus: order.refundDetails.status,
        transactionId: order.refundDetails.transactionId,
        completedAt: order.refundDetails.refundCompletedAt
      }
    });
    
  } catch (error) {
    console.error('Complete refund error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete refund',
      error: error.message,
      errorCode: 'REFUND_COMPLETION_FAILED'
    });
  }
};

/**
 * @desc    Get customer bank details
 * @route   GET /api/users/:userId/bank-details
 * @access  Private (Admin)
 */
exports.getCustomerBankDetails = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('refundBankDetails fullName email phone');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: {
        userId: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        bankDetails: user.refundBankDetails || null,
        hasBankDetails: !!(user.refundBankDetails?.accountNumber || user.refundBankDetails?.upiId)
      }
    });
    
  } catch (error) {
    console.error('❌ Get bank details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bank details',
      error: error.message
    });
  }
};

/**
 * @desc    Update/Add user bank details (by user)
 * @route   PUT /api/users/me/bank-details
 * @access  Private (User)
 */
exports.updateBankDetails = async (req, res) => {
  try {
    const { accountHolderName, bankName, accountNumber, ifscCode, upiId, preferredMethod } = req.body;
    
    const user = await User.findById((req.admin?._id || req.user?._id));
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Validate at least one payment method is provided
    if (!accountNumber && !upiId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide either bank account details or UPI ID'
      });
    }
    
    // Validate bank details if provided
    if (accountNumber) {
      if (!ifscCode || !accountHolderName || !bankName) {
        return res.status(400).json({
          success: false,
          message: 'Account holder name, bank name, and IFSC code are required for bank transfer'
        });
      }
    }
    
    // Update bank details
    user.refundBankDetails = {
      accountHolderName: accountHolderName || user.refundBankDetails?.accountHolderName,
      bankName: bankName || user.refundBankDetails?.bankName,
      accountNumber: accountNumber || user.refundBankDetails?.accountNumber,
      ifscCode: ifscCode?.toUpperCase() || user.refundBankDetails?.ifscCode,
      upiId: upiId || user.refundBankDetails?.upiId,
      preferredMethod: preferredMethod || user.refundBankDetails?.preferredMethod || 'Bank Transfer',
      isVerified: false, // Admin will verify
      addedAt: user.refundBankDetails?.addedAt || new Date(),
      lastUpdatedAt: new Date()
    };
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Bank details updated successfully',
      data: {
        bankDetails: user.refundBankDetails
      }
    });
    
  } catch (error) {
    console.error('❌ Update bank details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update bank details',
      error: error.message
    });
  }
};

/**
 * @desc    Get user's own bank details
 * @route   GET /api/users/me/bank-details
 * @access  Private (User)
 */
exports.getMyBankDetails = async (req, res) => {
  try {
    const user = await User.findById((req.admin?._id || req.user?._id)).select('refundBankDetails');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: {
        bankDetails: user.refundBankDetails || null,
        hasBankDetails: !!(user.refundBankDetails?.accountNumber || user.refundBankDetails?.upiId)
      }
    });
    
  } catch (error) {
    console.error('❌ Get my bank details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bank details',
      error: error.message
    });
  }
};

module.exports = exports;
