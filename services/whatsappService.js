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
    const message = `✅ *Zennara Clinic - Appointment Confirmed*

Hello ${data.patientName}! 👋

Great news! Your appointment has been confirmed.

📋 *Confirmed Details:*
Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.confirmedDate}
Time: ${data.confirmedTime}
Location: ${data.location}

📍 *Address:*
${data.address || 'Check our website for location details'}

⚠️ *Important:*
• Arrive 10 minutes early
• Bring any relevant medical documents
• Wear comfortable clothing

Need to reschedule? Visit: https://zennara.in/appointments

See you soon! 💚

_Reply CANCEL to cancel appointment_`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment rescheduled notification
   */
  async sendAppointmentRescheduled(phoneNumber, data) {
    const message = `📅 *Zennara Clinic - Appointment Rescheduled*

Hello ${data.patientName}! 👋

Your appointment has been rescheduled.

🔄 *Previous Schedule:*
Date: ${data.oldDate}
Time: ${data.oldTime}

✅ *New Schedule:*
Date: ${data.newDate}
Time: ${data.newTime}

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Location: ${data.location}

We look forward to seeing you! 💚

_Reply CANCEL to cancel appointment_`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment cancellation notification
   */
  async sendAppointmentCancelled(phoneNumber, data) {
    const message = `❌ *Zennara Clinic - Appointment Cancelled*

Hello ${data.patientName},

Your appointment has been cancelled.

📋 *Cancelled Appointment:*
Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}

${data.reason ? `Reason: ${data.reason}\n\n` : ''}Want to book again? Visit: https://zennara.in/appointments

We hope to see you soon! 💚`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send check-in successful notification
   */
  async sendCheckInSuccessful(phoneNumber, data) {
    const message = `✅ *Zennara Clinic - Checked In*

Hello ${data.patientName}! 👋

You've been checked in successfully!

📋 *Session Details:*
Treatment: ${data.treatment}
Time: ${data.time}
Location: ${data.location}

⏱️ Estimated wait time: ${data.waitTime || '5-10'} minutes

Please have a seat in the waiting area. Our staff will call you shortly.

Thank you for your patience! 💚`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment completed notification
   */
  async sendAppointmentCompleted(phoneNumber, data) {
    const message = `🎉 *Zennara Clinic - Session Completed*

Hello ${data.patientName}! 👋

Thank you for visiting Zennara Clinic today!

📋 *Session Summary:*
Treatment: ${data.treatment}
Date: ${data.date}
Location: ${data.location}
${data.sessionDuration ? `Duration: ${data.sessionDuration} minutes\n` : ''}
💚 We hope you had a great experience!

📝 *Rate Your Experience:*
Help us improve by rating your visit:
https://zennara.in/rate/${data.bookingId}

🔄 *Book Your Next Visit:*
https://zennara.in/appointments

See you next time! 💚`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send no-show notification
   */
  async sendNoShowNotification(phoneNumber, data) {
    const message = `⚠️ *Zennara Clinic - Missed Appointment*

Hello ${data.patientName},

We missed you today! You didn't show up for your scheduled appointment.

📋 *Missed Appointment:*
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}
Location: ${data.location}

🔄 *Want to Reschedule?*
Book a new appointment: https://zennara.in/appointments

We understand things happen. We hope to see you soon! 💚

_For any concerns, please contact us_`;

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
