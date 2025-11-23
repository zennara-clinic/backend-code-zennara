const ProductOrder = require('../models/ProductOrder');
const User = require('../models/User');
const razorpayService = require('../services/razorpayService');
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
    
    // Check if refund is already in progress
    if (order.refundDetails?.status === 'Processing') {
      return res.status(400).json({
        success: false,
        message: 'Refund is already in progress for this order'
      });
    }
    
    // Determine refund amount
    const amountToRefund = refundAmount || order.pricing.total;
    
    // Validate refund amount
    if (!validateRefundAmount(amountToRefund, order.pricing.total)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid refund amount. Must be between 0 and order total.'
      });
    }
    
    // Check payment method and process accordingly
    let refundResult;
    
    if (order.paymentMethod === 'COD') {
      console.log('Processing COD refund manually');
      
      // COD Order - Manual refund process
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
          refundedBy: req.user._id,
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
          refundedBy: req.user._id,
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
        initiatedBy: req.user._id
      });
      
    } else {
      console.log('Processing online payment refund via Razorpay');
      
      // Online Payment - Use Razorpay refund API
      if (!order.razorpayPaymentId) {
        return res.status(400).json({
          success: false,
          message: 'No payment ID found. Cannot process online refund.'
        });
      }
      
      try {
        // Call Razorpay refund API
        refundResult = await razorpayService.refundPayment(
          order.razorpayPaymentId,
          amountToRefund
        );
        
        console.log('Razorpay refund successful:', refundResult.id);
        
        // Update order with refund details
        order.refundDetails = {
          method: 'Razorpay',
          amount: amountToRefund,
          status: 'Processing',
          razorpayRefundId: refundResult.id,
          transactionId: refundResult.id,
          refundInitiatedAt: new Date(),
          refundedBy: req.user._id,
          notes: notes || 'Online payment refund processed via Razorpay',
          retryCount: 0,
          lastRetryAt: null
        };
        
        // Add to status history
        order.statusHistory.push({
          status: 'Refund Initiated',
          timestamp: new Date(),
          note: `Razorpay refund of Rs.${amountToRefund} initiated. Refund ID: ${refundResult.id}`,
          initiatedBy: req.user._id
        });
        
      } catch (error) {
        console.error('Razorpay refund failed:', error.message);
        
        return res.status(500).json({
          success: false,
          message: 'Failed to process Razorpay refund',
          error: error.message,
          errorCode: 'RAZORPAY_REFUND_FAILED'
        });
      }
    }
    
    await order.save();
    
    // Send notifications asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        const user = order.userId;
        const notificationData = {
          customerName: order.shippingAddress.fullName,
          orderNumber: order.orderNumber,
          refundAmount: amountToRefund,
          refundMethod: order.refundDetails.method,
          refundDate: new Date().toLocaleDateString('en-IN', { 
            day: '2-digit', month: 'short', year: 'numeric' 
          }),
          transactionId: order.refundDetails.transactionId || 'Will be updated soon',
          estimatedDays: order.refundDetails.method === 'Razorpay' ? '5-7' : '2-3'
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
      message: `Refund initiated successfully via ${order.refundDetails.method}`,
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        refundAmount: amountToRefund,
        refundMethod: order.refundDetails.method,
        refundStatus: order.refundDetails.status,
        transactionId: order.refundDetails.transactionId,
        estimatedDays: order.refundDetails.method === 'Razorpay' ? '5-7' : '2-3'
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
    order.refundDetails.completedBy = req.user._id;
    
    if (notes) {
      order.refundDetails.notes = (order.refundDetails.notes || '') + '\n' + notes;
    }
    
    // Update payment status
    order.paymentStatus = 'Refunded';
    
    // Add to status history with admin info
    order.statusHistory.push({
      status: 'Refund Completed',
      timestamp: new Date(),
      note: `Refund of Rs.${order.refundDetails.amount} completed. Transaction ID: ${transactionId}`,
      completedBy: req.user._id
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
          refundDate: new Date().toLocaleDateString('en-IN', { 
            day: '2-digit', month: 'short', year: 'numeric' 
          }),
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
    
    const user = await User.findById(req.user._id);
    
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
    const user = await User.findById(req.user._id).select('refundBankDetails');
    
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
