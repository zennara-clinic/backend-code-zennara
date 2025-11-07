const twilio = require('twilio');

class WhatsAppService {
  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    this.fromNumber = `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;
  }

  /**
   * Format phone number to WhatsApp format
   * Assumes Indian numbers (10 digits) - adds +91
   * For other countries, you may need to adjust
   */
  formatPhoneNumber(phoneNumber) {
    // Remove any spaces, dashes, or special characters
    let cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // If it's a 10-digit number, add +91 (India)
    if (cleaned.length === 10 && !cleaned.startsWith('+')) {
      cleaned = `+91${cleaned}`;
    }
    
    // If it doesn't have +, add it
    if (!cleaned.startsWith('+')) {
      cleaned = `+${cleaned}`;
    }
    
    return `whatsapp:${cleaned}`;
  }

  /**
   * Generic method to send WhatsApp message
   */
  async sendMessage(to, messageBody) {
    try {
      const formattedTo = this.formatPhoneNumber(to);
      
      console.log(`📱 Sending WhatsApp to: ${formattedTo}`);
      
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: formattedTo,
        body: messageBody
      });

      console.log(`✅ WhatsApp sent successfully. SID: ${message.sid}`);
      
      return {
        success: true,
        messageSid: message.sid,
        status: message.status
      };
    } catch (error) {
      console.error('❌ WhatsApp sending failed:', error.message);
      
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  /**
   * Send message using approved Twilio Content Template
   * Use this method when you have approved WhatsApp templates
   */
  async sendTemplateMessage(to, contentSid, contentVariables) {
    try {
      const formattedTo = this.formatPhoneNumber(to);
      
      console.log(`📱 Sending WhatsApp template to: ${formattedTo}`);
      
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: formattedTo,
        contentSid: contentSid,
        contentVariables: JSON.stringify(contentVariables)
      });

      console.log(`✅ WhatsApp template sent successfully. SID: ${message.sid}`);
      
      return {
        success: true,
        messageSid: message.sid,
        status: message.status
      };
    } catch (error) {
      console.error('❌ WhatsApp template sending failed:', error.message);
      
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  // ==================== APPOINTMENT NOTIFICATIONS ====================

  /**
   * Send booking confirmation (when user creates appointment)
   */
  async sendBookingConfirmation(phoneNumber, data) {
    const message = `🎉 *Zennara Clinic - Booking Confirmed*

Hello ${data.patientName}! 👋

Your appointment has been received successfully.

📋 *Booking Details:*
Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.timeSlots}
Location: ${data.location}

⏳ Status: *Awaiting Confirmation*

We'll confirm your exact appointment time shortly. You'll receive a confirmation message once your appointment is scheduled.

📱 Track your appointment: https://zennara.in/appointments

Thank you for choosing Zennara! 💚

_Reply HELP for assistance_`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment confirmation (when admin confirms)
   */
  async sendAppointmentConfirmed(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_CONFIRMED_TEMPLATE_SID && 
        !process.env.WHATSAPP_CONFIRMED_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_CONFIRMED_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.referenceNumber,
          '3': data.treatment,
          '4': data.confirmedDate,
          '5': data.confirmedTime,
          '6': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `✅ *Zennara Clinic - Appointment Confirmed*

Hello ${data.patientName}! 👋

Great news! Your appointment has been confirmed.

📋 *Confirmed Details:*
Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.confirmedDate}
Time: ${data.confirmedTime}
Location: ${data.location}

Please arrive 10 minutes early. Bring any relevant medical documents.

View details in your Zennara App.

See you soon!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment rescheduled notification
   */
  async sendAppointmentRescheduled(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_RESCHEDULED_TEMPLATE_SID && 
        !process.env.WHATSAPP_RESCHEDULED_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_RESCHEDULED_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.referenceNumber,
          '3': data.treatment,
          '4': data.oldDate,
          '5': data.oldTime,
          '6': data.newDate,
          '7': data.newTime,
          '8': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `📅 *Zennara Clinic - Appointment Rescheduled*

Hello ${data.patientName}! 👋

Your appointment has been rescheduled.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}

Previous: ${data.oldDate} at ${data.oldTime}
New Schedule: ${data.newDate} at ${data.newTime}

Location: ${data.location}

Check your Zennara App for updated details.

We look forward to seeing you!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment cancellation notification
   */
  async sendAppointmentCancelled(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_CANCELLED_TEMPLATE_SID && 
        !process.env.WHATSAPP_CANCELLED_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_CANCELLED_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.referenceNumber,
          '3': data.treatment,
          '4': data.date,
          '5': data.time
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `❌ *Zennara Clinic - Appointment Cancelled*

Hello ${data.patientName},

Your appointment has been cancelled.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}

Want to rebook? Open the Zennara App and book a new appointment.

We hope to see you soon!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send check-in successful notification
   */
  async sendCheckInSuccessful(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_CHECKIN_TEMPLATE_SID && 
        !process.env.WHATSAPP_CHECKIN_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_CHECKIN_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.treatment,
          '3': data.time,
          '4': data.location,
          '5': data.waitTime || '5-10'
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `✅ *Zennara Clinic - Checked In*

Hello ${data.patientName}! 👋

You have been checked in successfully!

Treatment: ${data.treatment}
Time: ${data.time}
Location: ${data.location}

Estimated wait time: ${data.waitTime || '5-10'} minutes

Please have a seat in the waiting area. Our staff will call you shortly.

Thank you!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment completed notification
   */
  async sendAppointmentCompleted(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_COMPLETED_TEMPLATE_SID && 
        !process.env.WHATSAPP_COMPLETED_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_COMPLETED_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.treatment,
          '3': data.date,
          '4': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `🎉 *Zennara Clinic - Session Completed*

Hello ${data.patientName}! 👋

Thank you for visiting Zennara Clinic today!

Treatment: ${data.treatment}
Date: ${data.date}
Location: ${data.location}

We hope you had a great experience!

Rate your visit in the Zennara App.

Book your next appointment anytime in the app.

See you next time!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send no-show notification
   */
  async sendNoShowNotification(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_NOSHOW_TEMPLATE_SID && 
        !process.env.WHATSAPP_NOSHOW_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_NOSHOW_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.treatment,
          '3': data.date,
          '4': data.time,
          '5': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `⚠️ *Zennara Clinic - Missed Appointment*

Hello ${data.patientName},

We missed you today.

You did not show up for your scheduled appointment:

Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}
Location: ${data.location}

We understand things happen. Want to reschedule? Open the Zennara App to book a new appointment.

Hope to see you soon!
Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment reminder (24 hours before)
   */
  async sendAppointmentReminder(phoneNumber, data) {
    const message = `⏰ *Zennara Clinic - Appointment Reminder*

Hello ${data.patientName}! 👋

This is a reminder about your upcoming appointment.

📋 *Appointment Details:*
Treatment: ${data.treatment}
Date: ${data.date} (Tomorrow)
Time: ${data.time}
Location: ${data.location}

📍 *Address:*
${data.address || 'Check our website for location details'}

⚠️ *Remember to:*
• Arrive 10 minutes early
• Bring any relevant documents
• Reply CONFIRM to confirm your attendance

Need to reschedule? Visit: https://zennara.in/appointments

See you tomorrow! 💚

_Reply CANCEL to cancel appointment_`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send OTP for verification
   */
  async sendOTP(phoneNumber, otp, expiryMinutes = 5) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_OTP_TEMPLATE_SID && 
        !process.env.WHATSAPP_OTP_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_OTP_TEMPLATE_SID,
        {
          '1': otp.toString(),
          '2': expiryMinutes.toString()
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `🔐 *Zennara Clinic - Verification Code*

Your verification code is: *${otp}*

⏱️ Valid for ${expiryMinutes} minutes

🔒 Do not share this code with anyone.

If you didn't request this code, please ignore this message.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Check service health
   */
  async checkHealth() {
    try {
      // Try to fetch account info to verify credentials
      await this.client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      return {
        success: true,
        message: 'WhatsApp service is healthy',
        fromNumber: process.env.TWILIO_PHONE_NUMBER
      };
    } catch (error) {
      return {
        success: false,
        message: 'WhatsApp service is not healthy',
        error: error.message
      };
    }
  }
}

// Export singleton instance
module.exports = new WhatsAppService();
