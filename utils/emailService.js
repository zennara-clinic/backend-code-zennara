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

/**
 * Confirm a completed email/phone change to the customer. Two modes:
 *   - default → "your <thing> was updated successfully" (to the new/current contact)
 *   - alert   → "your <thing> was changed" security notice (sent to the OLD email)
 *
 * Best-effort: it never throws, so a failed notification can't undo the change
 * the scheduler already applied.
 */
exports.sendContactUpdatedEmail = async (email, fullName, { type, alert = false, detail = '' } = {}) => {
  try {
    if (!email) return;
    const GREEN = '#032F22';
    const label = type === 'email' ? 'email address' : 'mobile number';
    const title = alert ? `Your ${label} was changed` : `Your ${label} was updated`;
    const lead = alert
      ? `The ${label} on your Zennara account was just changed${detail ? ` (to ${detail})` : ''}. ` +
        `If this was you, no action is needed. If you didn't request this, please contact the clinic straight away.`
      : `Your Zennara account ${label} has been updated successfully${detail ? ` to <strong>${detail}</strong>` : ''}. ` +
        `You'll use it to sign in and receive updates from now on.`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#111714;">
        <h2 style="color:${GREEN};font-size:20px;margin:0 0 14px;">${title}</h2>
        <p style="font-size:14px;line-height:22px;color:#4F5853;margin:0 0 14px;">Hi ${fullName || 'there'},</p>
        <p style="font-size:14px;line-height:22px;color:#4F5853;margin:0 0 18px;">${lead}</p>
        <p style="font-size:12.5px;line-height:20px;color:#7A827E;margin:22px 0 0;">— Team Zennara</p>
      </div>`;
    const subject = alert ? `Zennara: your ${label} was changed` : `Zennara: your ${label} was updated`;
    await sendEmail(email, subject, html);
    console.log(`✅ Contact-updated email sent (${alert ? 'alert' : 'confirm'})`);
  } catch (error) {
    console.error('❌ Contact-updated email failed:', error.message);
  }
};

/**
 * Email the user a readable summary of everything Zennara holds about them
 * (a DPDPA data-access request). Plain, human-readable HTML — not a raw JSON
 * dump — so the person can actually understand what we have.
 */
exports.sendDataExportEmail = async (email, fullName, exportData) => {
  const GREEN = '#032F22';
  const p = exportData.personalInformation || {};
  const stats = exportData.statistics || {};
  const appointments = exportData.appointments || [];
  const orders = exportData.orders || [];
  const addresses = exportData.addresses || [];
  const packages = exportData.treatmentPackages || [];
  const health = exportData.healthInformation || [];
  const reviews = exportData.reviews || [];

  const esc = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
  const asDate = (v) =>
    v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  const row = (label, value) =>
    `<tr><td style="padding:7px 0;color:#7A827E;font-size:13px;">${label}</td>` +
    `<td style="padding:7px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(value)}</td></tr>`;

  const section = (title, inner) =>
    `<h3 style="margin:26px 0 10px;color:${GREEN};font-size:15px;">${title}</h3>${inner}`;

  const hasActivity =
    appointments.length || orders.length || packages.length || health.length || reviews.length || addresses.length;

  const apptTable = appointments.length
    ? `<table style="width:100%;border-collapse:collapse;">${appointments.slice(0, 12).map((a) =>
        `<tr><td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;">${esc(a.status)}</td>` +
        `<td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;">${asDate(a.confirmedDate || a.date)}</td>` +
        `<td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;">${esc(a.location)}</td></tr>`).join('')}</table>`
    : '<p style="color:#7A827E;font-size:13px;margin:0;">No appointments on record.</p>';

  const orderTable = orders.length
    ? `<table style="width:100%;border-collapse:collapse;">${orders.slice(0, 12).map((o) =>
        `<tr><td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;">#${esc(o.orderNumber)}</td>` +
        `<td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;">${esc(o.status)}</td>` +
        `<td style="padding:7px 8px;border-top:1px solid #eee;font-size:12.5px;text-align:right;">₹${esc(o.total)}</td></tr>`).join('')}</table>`
    : '<p style="color:#7A827E;font-size:13px;margin:0;">No orders on record.</p>';

  const body = `
    ${section('Your profile', `<table style="width:100%;border-collapse:collapse;">
      ${row('Name', p.fullName)}
      ${row('Email', p.email)}
      ${row('Phone', p.phone)}
      ${row('Membership', p.memberType)}
      ${row('Member since', asDate(p.accountCreated))}
    </table>`)}

    ${hasActivity ? `
      ${section('At a glance', `<table style="width:100%;border-collapse:collapse;">
        ${row('Appointments', appointments.length)}
        ${row('Orders', orders.length)}
        ${row('Treatment packages', packages.length)}
        ${row('Saved addresses', addresses.length)}
        ${row('Health forms', health.length)}
        ${row('Reviews written', reviews.length)}
      </table>`)}
      ${section('Appointments', apptTable)}
      ${section('Orders', orderTable)}
    ` : `
      <div style="margin:26px 0;padding:16px;border-radius:12px;background:#EFF3EE;">
        <p style="margin:0;color:#111714;font-size:13.5px;line-height:20px;">
          We don't hold much data on your account yet — just the basic profile above.
          You haven't booked an appointment, placed an order or saved anything with us so far.
        </p>
      </div>
    `}

    <p style="margin:24px 0 0;color:#7A827E;font-size:11.5px;line-height:17px;">
      Provided under the Digital Personal Data Protection Act, 2023. Clinical records are
      retained as required by the Clinical Establishments Act. To correct or delete your data,
      reply to this email or use Account Settings in the app.
    </p>`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:${GREEN};padding:22px 24px;border-radius:14px 14px 0 0;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">ZENNARA</div>
      <div style="color:#E0C391;font-size:12px;margin-top:2px;">Your data export</div>
    </div>
    <div style="padding:24px;border:1px solid #eee;border-top:0;border-radius:0 0 14px 14px;">
      <p style="color:#111714;font-size:14px;">Hi ${esc(fullName || p.fullName || 'there')},</p>
      <p style="color:#4F5853;font-size:13.5px;line-height:20px;">
        Here's a summary of everything we hold about you at Zennara, as of ${asDate(new Date())}.
      </p>
      ${body}
    </div>
  </div>`;

  const response = await sendEmail(email, 'Your Zennara data export', html);
  console.log('✅ Data export email sent');
  return response;
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

/**
 * The clinic's full postal address for a branch name — so every appointment
 * email carries the address the app's centre picker no longer shows.
 * Returns '' when the branch can't be resolved; the email still sends.
 */
async function resolveClinicAddress(name) {
  if (!name) return '';
  try {
    const Branch = require('../models/Branch');
    const b = await Branch.findOne({ name }).lean();
    const a = b && b.address;
    if (!a) return '';
    const cityLine = [a.city, a.state].filter(Boolean).join(', ');
    const withPin = [cityLine, a.pincode].filter(Boolean).join(' ');
    return [a.line1, a.line2, withPin].map((p) => (p || '').trim()).filter(Boolean).join(', ');
  } catch (e) {
    return '';
  }
}

/** Fill `data.address` from the branch in `data.location`, if not already set. */
async function withClinicAddress(data) {
  if (data && !data.address) {
    data.address = await resolveClinicAddress(data.location);
  }
  return data;
}

/**
 * Email the guest their check-in / check-out code, shown as large digits they
 * read to reception. `kind` is 'check-in' or 'check-out'.
 */
exports.sendVisitCodeEmail = async (email, fullName, { code, kind, referenceNumber, treatment, location }) => {
  const GREEN = '#032F22';
  const isOut = kind === 'check-out';
  const title = isOut ? 'Your check-out code' : 'Your check-in code';
  const intro = isOut
    ? 'Read this code to reception to complete your visit.'
    : 'Show this code at reception to check in for your appointment.';
  const esc = (v) => (v === undefined || v === null || v === '' ? '' : String(v));

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:${GREEN};padding:22px 24px;border-radius:14px 14px 0 0;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">ZENNARA</div>
      <div style="color:#E0C391;font-size:12px;margin-top:2px;">${title}</div>
    </div>
    <div style="padding:24px;border:1px solid #eee;border-top:0;border-radius:0 0 14px 14px;text-align:center;">
      <p style="color:#111714;font-size:14px;text-align:left;">Hi ${esc(fullName) || 'there'},</p>
      <p style="color:#4F5853;font-size:13.5px;line-height:20px;text-align:left;">${intro}</p>
      <div style="margin:22px auto;display:inline-block;background:#EFF3EE;border-radius:14px;padding:18px 30px;">
        <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:${GREEN};">${esc(code)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        ${treatment ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;text-align:left;">Appointment</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(treatment)}</td></tr>` : ''}
        ${location ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;text-align:left;">Center</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(location)}</td></tr>` : ''}
        ${referenceNumber ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;text-align:left;">Reference</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(referenceNumber)}</td></tr>` : ''}
      </table>
      <p style="color:#7A827E;font-size:11.5px;line-height:17px;margin-top:18px;text-align:left;">
        Don't share this code with anyone except Zennara reception staff. It also appears on your appointment screen in the app.
      </p>
    </div>
  </div>`;

  const response = await sendEmail(email, `${title} — Zennara${referenceNumber ? ` [${referenceNumber}]` : ''}`, html);
  console.log('✅ Visit code email sent');
  return response;
};

// Send Appointment Booking Confirmation Email
exports.sendAppointmentBookingConfirmation = async (email, fullName, bookingData, branch = 'Zennara Clinic') => {
  try {
    await withClinicAddress(bookingData);
    const htmlContent = getAppointmentBookingConfirmationTemplate(fullName, bookingData, branch);
    
    const response = await sendEmail(email, `Appointment Booking Received [${bookingData.referenceNumber}]`, htmlContent);
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
    await withClinicAddress(appointmentData);
    const htmlContent = getAppointmentConfirmedTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, `Appointment Confirmed [${appointmentData.referenceNumber}]`, htmlContent);
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
    await withClinicAddress(appointmentData);
    const htmlContent = getAppointmentReminderTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, `Appointment Reminder [${appointmentData.referenceNumber}]`, htmlContent);
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
    await withClinicAddress(appointmentData);
    const htmlContent = getAppointmentRescheduledTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, `Appointment Rescheduled [${appointmentData.referenceNumber}]`, htmlContent);
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
    await withClinicAddress(appointmentData);
    const htmlContent = getAppointmentCancelledTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, `Appointment Cancelled [${appointmentData.referenceNumber}]`, htmlContent);
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
    await withClinicAddress(appointmentData);
    const htmlContent = getAppointmentCompletedTemplate(fullName, appointmentData, branch);
    
    const response = await sendEmail(email, `Thank You for Visiting Zennara [${appointmentData.referenceNumber}]`, htmlContent);
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
    
    const response = await sendEmail(email, `How Was Your Experience? [${appointmentData.referenceNumber}]`, htmlContent);
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
    
    const response = await sendEmail(email, `Missed Appointment [${appointmentData.referenceNumber}]`, htmlContent);
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
    
    const response = await sendEmail(email, `Check-in Confirmed [${appointmentData.referenceNumber}]`, htmlContent);
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
/**
 * Dermatologist panel credentials — sent when the admin creates the login or
 * resets the password. Set DOCTOR_PANEL_URL in the environment to include a
 * sign-in button.
 */
exports.sendDoctorCredentials = async (email, name, { password, mode = 'created', panel = 'Dermatologist' } = {}) => {
  const { getDoctorCredentialsTemplate } = require('../Email Templates/doctorCredentialsTemplate');
  const panelUrl = panel === 'Therapist'
    ? (process.env.THERAPIST_PANEL_URL || '')
    : (process.env.DOCTOR_PANEL_URL || '');
  const htmlContent = getDoctorCredentialsTemplate(name, { email, password, mode, panel, panelUrl });
  const subject = mode === 'reset'
    ? `Zennara ${panel} Panel — your password was reset`
    : `Zennara ${panel} Panel — your login details`;
  const response = await sendEmail(email, subject, htmlContent);
  console.log(`✅ ${panel} credentials email sent (${mode})`);
  return response;
};

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
    const response = await sendEmail(email, `Order Placed [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Order Confirmed by Admin [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Your Order is Being Processed [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Order Packed & Ready [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Order Shipped - Track Your Delivery [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Out for Delivery Today [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Order Successfully Delivered [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Order Cancellation Confirmed [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Return Request Received & Under Review [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Return Request Approved [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Return Request Decision [${orderData.orderNumber}]`, htmlContent);
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
    const response = await sendEmail(email, `Refund Successfully Processed [${orderData.orderNumber}]`, htmlContent);
    console.log('Refund processed email sent successfully');
    return response;
  } catch (error) {
    console.error('Refund processed email sending failed');
    throw error;
  }
};

/**
 * Sent when reception checks a guest in or out WITHOUT a code (manual override),
 * so the guest always knows their session was started/closed on their behalf.
 */
exports.sendManualCheckNotice = async (email, fullName, { kind, treatment, location, referenceNumber, at }) => {
  const GREEN = '#032F22';
  const isOut = kind === 'checkout';
  const line = isOut
    ? 'You are checked out without code for this session.'
    : 'You are checked in without code for this session.';
  const title = isOut ? 'Session completed' : 'Session started';
  const when = at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:${GREEN};padding:22px 24px;border-radius:14px 14px 0 0;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">ZENNARA</div>
      <div style="color:#E0C391;font-size:12px;margin-top:2px;">${title}</div>
    </div>
    <div style="padding:24px;border:1px solid #eee;border-top:0;border-radius:0 0 14px 14px;">
      <p style="color:#111714;font-size:14px;">Hi ${esc(fullName) || 'there'},</p>
      <p style="color:#111714;font-size:15px;font-weight:600;line-height:22px;">${line}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        ${treatment ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;">Session</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(treatment)}</td></tr>` : ''}
        ${location ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;">Center</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(location)}</td></tr>` : ''}
        ${when ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;">Time</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(when)}</td></tr>` : ''}
        ${referenceNumber ? `<tr><td style="padding:6px 0;color:#7A827E;font-size:13px;">Reference</td><td style="padding:6px 0;color:#111714;font-size:13px;font-weight:600;text-align:right;">${esc(referenceNumber)}</td></tr>` : ''}
      </table>
      <p style="color:#7A827E;font-size:11.5px;line-height:17px;margin-top:18px;">If this wasn't you, please tell the reception team right away.</p>
    </div>
  </div>`;
  return sendEmail(email, `${title} — Zennara${referenceNumber ? ` [${referenceNumber}]` : ''}`, html);
};
