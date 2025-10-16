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

// Create AWS SES client
const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function to send email via AWS SES
const sendEmail = async (to, subject, htmlContent) => {
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
