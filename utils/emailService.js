const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const getOTPEmailTemplate = require('../Email Templates/otpEmailTemplate');
const getWelcomeEmailTemplate = require('../Email Templates/welcomeEmailTemplate');
const getAppointmentBookingConfirmationTemplate = require('../Email Templates/appointmentBookingConfirmation');
const getAppointmentConfirmedTemplate = require('../Email Templates/appointmentConfirmed');
const getAppointmentReminderTemplate = require('../Email Templates/appointmentReminder');
const getAppointmentRescheduledTemplate = require('../Email Templates/appointmentRescheduled');
const getAppointmentCancelledTemplate = require('../Email Templates/appointmentCancelled');
const getAppointmentCompletedTemplate = require('../Email Templates/appointmentCompleted');
const getRatingRequestTemplate = require('../Email Templates/ratingRequest');
const getNoShowNotificationTemplate = require('../Email Templates/noShowNotification');
const getCheckInSuccessfulTemplate = require('../Email Templates/checkInSuccessful');
const { getAdminOTPEmailTemplate } = require('../Email Templates/adminOtpEmailTemplate');
const getSupportMessageConfirmationTemplate = require('../Email Templates/supportMessageConfirmation');
const getSupportMessageNotificationTemplate = require('../Email Templates/supportMessageNotification');
const getServiceCompletionOTPTemplate = require('../Email Templates/serviceCompletionOtpTemplate');
const getPackageCancellationOtpTemplate = require('../Email Templates/packageCancellationOtpTemplate');
const getBookingExpiredNotificationTemplate = require('../Email Templates/bookingExpiredNotification');
const getBirthdayWishTemplate = require('../Email Templates/birthdayWishTemplate');

// Product Order Templates
const getOrderConfirmationTemplate = require('../Email Templates/orderConfirmation');
const getOrderConfirmedEmail = require('../Email Templates/orderConfirmedByAdmin');
const getOrderProcessingTemplate = require('../Email Templates/orderProcessing');
const getOrderPackedTemplate = require('../Email Templates/orderPacked');
const getOrderShippedTemplate = require('../Email Templates/orderShipped');
const getOrderOutForDeliveryTemplate = require('../Email Templates/orderOutForDelivery');
const getOrderDeliveredTemplate = require('../Email Templates/orderDelivered');
const getOrderCancelledTemplate = require('../Email Templates/orderCancelled');
const getReturnRequestReceivedTemplate = require('../Email Templates/returnRequestReceived');
const getReturnApprovedTemplate = require('../Email Templates/returnApproved');
const getReturnRejectedTemplate = require('../Email Templates/returnRejected');
const getRefundProcessedTemplate = require('../Email Templates/refundProcessed');

// Validate AWS credentials on module load
const validateAWSCredentials = () => {
  const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FROM_EMAIL'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing AWS SES credentials:', missing);
    console.log('⚠️ AWS SES not configured properly - emails will fail');
    return false;
  }
  
  console.log('✅ AWS SES credentials validated successfully');
  return true;
};

// Create AWS SES client with validation
let sesClient;
const isAWSConfigured = validateAWSCredentials();

if (isAWSConfigured) {
  sesClient = new SESClient({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

// Helper function to send email via AWS SES
const sendEmail = async (to, subject, htmlContent) => {
  if (!isAWSConfigured || !sesClient) {
    const error = new Error('AWS SES client not initialized. Check your credentials in .env file');
    console.error('❌ Email Service Error:', error.message);
    console.log('📋 Required env variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, FROM_EMAIL');
    throw error;
  }

  const params = {
    Source: `${process.env.FROM_NAME} <${process.env.FROM_EMAIL}>`,
    Destination: {
      ToAddresses: [to],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: htmlContent,
          Charset: 'UTF-8',
        },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    const response = await sesClient.send(command);
    return response;
  } catch (error) {
    console.error('AWS SES Error:', error);
    throw error;
  }
};

// Send OTP Email
exports.sendOTPEmail = async (email, fullName, otp, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getOTPEmailTemplate(fullName, otp, branch);
    
    const response = await sendEmail(email, 'Your Zennara Verification Code', htmlContent);
    console.log('✅ OTP email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Welcome Email
exports.sendWelcomeEmail = async (email, fullName, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getWelcomeEmailTemplate(fullName, branch);
    
    const response = await sendEmail(email, 'Welcome to Zennara!', htmlContent);
    console.log('✅ Welcome email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Booking Confirmation Email
exports.sendAppointmentBookingConfirmation = async (email, fullName, bookingData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentBookingConfirmationTemplate(fullName, bookingData, branch);
    
    const response = await sendEmail(email, 'Appointment Booking Received - Zennara Clinic', htmlContent);
    console.log('✅ Appointment booking confirmation email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Confirmed Email
exports.sendAppointmentConfirmed = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentConfirmedTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Appointment Confirmed - Zennara Clinic', htmlContent);
    console.log('✅ Appointment confirmed email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Reminder Email
exports.sendAppointmentReminder = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentReminderTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Appointment Reminder - Zennara Clinic', htmlContent);
    console.log('✅ Appointment reminder email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Rescheduled Email
exports.sendAppointmentRescheduled = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentRescheduledTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Appointment Rescheduled - Zennara Clinic', htmlContent);
    console.log('✅ Appointment rescheduled email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Cancelled Email
exports.sendAppointmentCancelled = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentCancelledTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Appointment Cancelled - Zennara Clinic', htmlContent);
    console.log('✅ Appointment cancelled email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Appointment Completed Email
exports.sendAppointmentCompleted = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getAppointmentCompletedTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Thank You - Zennara Clinic', htmlContent);
    console.log('✅ Appointment completed email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Rating Request Email
exports.sendRatingRequest = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getRatingRequestTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'How Was Your Experience? - Zennara Clinic', htmlContent);
    console.log('✅ Rating request email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send No-Show Notification Email
exports.sendNoShowNotification = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getNoShowNotificationTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Missed Appointment - Zennara Clinic', htmlContent);
    console.log('✅ No-show notification email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// Send Check-in Successful Email
exports.sendCheckInSuccessful = async (email, fullName, appointmentData, branch = 'Zennara Clinic') => {
  try {
    const htmlContent = getCheckInSuccessfulTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, 'Check-in Confirmed - Zennara Clinic', htmlContent);
    console.log('✅ Check-in successful email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

// ========================================
// ADMIN AUTHENTICATION EMAILS
// ========================================

// Send Admin OTP Email
exports.sendAdminOTP = async (email, adminName, otp) => {
  try {
    const htmlContent = getAdminOTPEmailTemplate(adminName, otp);
    
    const response = await sendEmail(email, 'Zennara Admin Panel - Verification Code', htmlContent);
    console.log('✅ Admin OTP email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Admin email sending failed');
    throw error;
  }
};

// ========================================
// SUPPORT MESSAGE EMAILS
// ========================================

// Send Support Message Confirmation Email (to user)
exports.sendSupportMessageConfirmation = async (email, name, messageData) => {
  try {
    const htmlContent = getSupportMessageConfirmationTemplate(name, messageData);
    
    const response = await sendEmail(email, 'We\'ve Received Your Message - Zennara Support', htmlContent);
    console.log('✅ Support confirmation email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Support confirmation email sending failed');
    throw error;
  }
};

// Send Support Message Notification Email (to admin)
exports.sendSupportMessageNotification = async (adminEmail, messageData) => {
  try {
    const htmlContent = getSupportMessageNotificationTemplate(messageData);
    
    const response = await sendEmail(adminEmail, `🔔 New Support Message - ${messageData.subject}`, htmlContent);
    console.log('✅ Support notification email sent to admin');
    return response;
  } catch (error) {
    console.error('❌ Support notification email sending failed');
    throw error;
  }
};

// ========================================
// PACKAGE SERVICE COMPLETION EMAILS
// ========================================

// Send Service Completion OTP Email
exports.sendOtpEmail = async (email, otp, fullName, serviceName, packageName) => {
  try {
    const htmlContent = getServiceCompletionOTPTemplate(fullName, otp, serviceName, packageName);
    
    const response = await sendEmail(email, '🔐 Service Completion Verification - Zennara Clinic', htmlContent);
    console.log('✅ Service completion OTP email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Service completion OTP email sending failed');
    throw error;
  }
};

// ========================================
// PACKAGE CANCELLATION EMAILS
// ========================================

// Send Package Cancellation OTP Email
exports.sendPackageCancellationOtp = async (email, otp, fullName, packageName, assignmentId) => {
  try {
    const htmlContent = getPackageCancellationOtpTemplate(fullName, otp, packageName, assignmentId);
    
    const response = await sendEmail(email, '⚠️ Package Cancellation Verification - Zennara', htmlContent);
    console.log('✅ Package cancellation OTP email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Package cancellation OTP email sending failed');
    throw error;
  }
};

// Send Booking Expired Notification
exports.sendBookingExpiredNotification = async (email, fullName, bookingDetails) => {
  try {
    const htmlContent = getBookingExpiredNotificationTemplate(fullName, bookingDetails);
    
    const response = await sendEmail(email, '⏰ Appointment Request Expired - Zennara', htmlContent);
    console.log('✅ Booking expired notification email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Booking expired notification email sending failed');
    throw error;
  }
};

// ========================================
// BIRTHDAY WISH EMAILS
// ========================================

// Send Birthday Wish Email
exports.sendBirthdayWish = async (email, fullName) => {
  try {
    const htmlContent = getBirthdayWishTemplate(fullName);
    
    const response = await sendEmail(email, '🎂 Happy Birthday from Zennara! 🎉', htmlContent);
    console.log(`✅ Birthday wish email sent successfully to ${fullName}`);
    return response;
  } catch (error) {
    console.error('❌ Birthday wish email sending failed');
    throw error;
  }
};

// ========================================
// PRODUCT ORDER EMAILS
// ========================================

// Send Order Placed Email (when user places order)
exports.sendOrderConfirmationEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderConfirmationTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Placed - ${orderData.orderNumber}`, htmlContent);
    console.log('Order placed email sent successfully');
    return response;
  } catch (error) {
    console.error('Order placed email sending failed');
    throw error;
  }
};

// Send Order Confirmed Email (when admin confirms order)
exports.sendOrderConfirmedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderConfirmedEmail(customerName, orderData);
    const response = await sendEmail(email, `Order Confirmed - ${orderData.orderNumber}`, htmlContent);
    console.log('Order confirmed email sent successfully');
    return response;
  } catch (error) {
    console.error('Order confirmed email sending failed');
    throw error;
  }
};

// Send Order Processing Email
exports.sendOrderProcessingEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderProcessingTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Processing - ${orderData.orderNumber}`, htmlContent);
    console.log('Order processing email sent successfully');
    return response;
  } catch (error) {
    console.error('Order processing email sending failed');
    throw error;
  }
};

// Send Order Packed Email
exports.sendOrderPackedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderPackedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Packed - ${orderData.orderNumber}`, htmlContent);
    console.log('Order packed email sent successfully');
    return response;
  } catch (error) {
    console.error('Order packed email sending failed');
    throw error;
  }
};

// Send Order Shipped Email
exports.sendOrderShippedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderShippedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Shipped - ${orderData.orderNumber}`, htmlContent);
    console.log('Order shipped email sent successfully');
    return response;
  } catch (error) {
    console.error('Order shipped email sending failed');
    throw error;
  }
};

// Send Order Out for Delivery Email
exports.sendOrderOutForDeliveryEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderOutForDeliveryTemplate(customerName, orderData);
    const response = await sendEmail(email, `Out for Delivery - ${orderData.orderNumber}`, htmlContent);
    console.log('Order out for delivery email sent successfully');
    return response;
  } catch (error) {
    console.error('Order out for delivery email sending failed');
    throw error;
  }
};

// Send Order Delivered Email
exports.sendOrderDeliveredEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderDeliveredTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Delivered - ${orderData.orderNumber}`, htmlContent);
    console.log('Order delivered email sent successfully');
    return response;
  } catch (error) {
    console.error('Order delivered email sending failed');
    throw error;
  }
};

// Send Order Cancelled Email
exports.sendOrderCancelledEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getOrderCancelledTemplate(customerName, orderData);
    const response = await sendEmail(email, `Order Cancelled - ${orderData.orderNumber}`, htmlContent);
    console.log('Order cancelled email sent successfully');
    return response;
  } catch (error) {
    console.error('Order cancelled email sending failed');
    throw error;
  }
};

// Send Return Request Received Email
exports.sendReturnRequestReceivedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getReturnRequestReceivedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Return Request Received - ${orderData.orderNumber}`, htmlContent);
    console.log('Return request email sent successfully');
    return response;
  } catch (error) {
    console.error('Return request email sending failed');
    throw error;
  }
};

// Send Return Approved Email
exports.sendReturnApprovedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getReturnApprovedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Return Approved - ${orderData.orderNumber}`, htmlContent);
    console.log('Return approved email sent successfully');
    return response;
  } catch (error) {
    console.error('Return approved email sending failed');
    throw error;
  }
};

// Send Return Rejected Email
exports.sendReturnRejectedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getReturnRejectedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Return Request Update - ${orderData.orderNumber}`, htmlContent);
    console.log('Return rejected email sent successfully');
    return response;
  } catch (error) {
    console.error('Return rejected email sending failed');
    throw error;
  }
};

// Send Refund Processed Email
exports.sendRefundProcessedEmail = async (email, customerName, orderData) => {
  try {
    const htmlContent = getRefundProcessedTemplate(customerName, orderData);
    const response = await sendEmail(email, `Refund Processed - ${orderData.orderNumber}`, htmlContent);
    console.log('Refund processed email sent successfully');
    return response;
  } catch (error) {
    console.error('Refund processed email sending failed');
    throw error;
  }
};
