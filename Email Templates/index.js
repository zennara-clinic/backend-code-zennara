/**
 * Email Templates Index
 * Central export for all email templates
 */

const getOTPEmailTemplate = require('./otpEmailTemplate');
const getWelcomeEmailTemplate = require('./welcomeEmailTemplate');
const getAppointmentBookingConfirmationTemplate = require('./appointmentBookingConfirmation');
const getAppointmentConfirmedTemplate = require('./appointmentConfirmed');
const getAppointmentReminderTemplate = require('./appointmentReminder');
const getAppointmentRescheduledTemplate = require('./appointmentRescheduled');
const getAppointmentCancelledTemplate = require('./appointmentCancelled');
const getAppointmentCompletedTemplate = require('./appointmentCompleted');
const getRatingRequestTemplate = require('./ratingRequest');
const getNoShowNotificationTemplate = require('./noShowNotification');
const getCheckInSuccessfulTemplate = require('./checkInSuccessful');
const getSupportMessageConfirmationTemplate = require('./supportMessageConfirmation');
const getSupportMessageNotificationTemplate = require('./supportMessageNotification');
const getPackageCancellationOtpTemplate = require('./packageCancellationOtpTemplate');

// Product Order Templates
const getOrderConfirmationTemplate = require('./orderConfirmation');
const getOrderProcessingTemplate = require('./orderProcessing');
const getOrderPackedTemplate = require('./orderPacked');
const getOrderShippedTemplate = require('./orderShipped');
const getOrderOutForDeliveryTemplate = require('./orderOutForDelivery');
const getOrderDeliveredTemplate = require('./orderDelivered');
const getOrderCancelledTemplate = require('./orderCancelled');
const getReturnRequestReceivedTemplate = require('./returnRequestReceived');
const getReturnApprovedTemplate = require('./returnApproved');
const getReturnRejectedTemplate = require('./returnRejected');
const getRefundProcessedTemplate = require('./refundProcessed');

module.exports = {
  // Authentication Templates
  getOTPEmailTemplate,
  getWelcomeEmailTemplate,
  
  // Appointment Templates
  getAppointmentBookingConfirmationTemplate,
  getAppointmentConfirmedTemplate,
  getAppointmentReminderTemplate,
  getAppointmentRescheduledTemplate,
  getAppointmentCancelledTemplate,
  getAppointmentCompletedTemplate,
  
  // Feedback & Follow-up Templates
  getRatingRequestTemplate,
  getNoShowNotificationTemplate,
  getCheckInSuccessfulTemplate,
  
  // Support Templates
  getSupportMessageConfirmationTemplate,
  getSupportMessageNotificationTemplate,
  
  // Package Templates
  getPackageCancellationOtpTemplate,
  
  // Product Order Templates
  getOrderConfirmationTemplate,
  getOrderProcessingTemplate,
  getOrderPackedTemplate,
  getOrderShippedTemplate,
  getOrderOutForDeliveryTemplate,
  getOrderDeliveredTemplate,
  getOrderCancelledTemplate,
  getReturnRequestReceivedTemplate,
  getReturnApprovedTemplate,
  getReturnRejectedTemplate,
  getRefundProcessedTemplate,
};
