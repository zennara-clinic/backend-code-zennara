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
      
      console.log(`Sending WhatsApp to: ${formattedTo}`);
      
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: formattedTo,
        body: messageBody
      });

      console.log(`WhatsApp sent successfully. SID: ${message.sid}`);
      
      return {
        success: true,
        messageSid: message.sid,
        status: message.status
      };
    } catch (error) {
      console.error('WhatsApp sending failed:', error.message);
      
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
      
      console.log(`Sending WhatsApp template to: ${formattedTo}`);
      
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: formattedTo,
        contentSid: contentSid,
        contentVariables: JSON.stringify(contentVariables)
      });

      console.log(`WhatsApp template sent successfully. SID: ${message.sid}`);
      
      return {
        success: true,
        messageSid: message.sid,
        status: message.status
      };
    } catch (error) {
      console.error('WhatsApp template sending failed:', error.message);
      
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
    // Try template message first (production mode)
    if (process.env.WHATSAPP_BOOKING_RECEIVED_SID && 
        !process.env.WHATSAPP_BOOKING_RECEIVED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_BOOKING_RECEIVED_SID,
        {
          '1': data.patientName,
          '2': data.referenceNumber,
          '3': data.treatment,
          '4': data.date,
          '5': data.timeSlots,
          '6': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.patientName}!

Your appointment request has been received.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.timeSlots}
Location: ${data.location}

Status: Awaiting Confirmation

You will receive a confirmation message once your appointment is scheduled.

Thank you for choosing Zennara Clinic.`;

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
    const message = `Hello ${data.patientName}!

Your appointment has been confirmed.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.confirmedDate}
Time: ${data.confirmedTime}
Location: ${data.location}

Please arrive 10 minutes early with any relevant medical documents.

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
          '4': data.newDate,
          '5': data.newTime,
          '6': data.location
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.patientName}!

Your appointment has been rescheduled.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
New Date: ${data.newDate}
New Time: ${data.newTime}
Location: ${data.location}

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
    const message = `Hello ${data.patientName},

Your appointment has been cancelled.

Reference: ${data.referenceNumber}
Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}

You can book a new appointment through the Zennara App.

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
    const message = `Hello ${data.patientName}!

You have been checked in successfully.

Treatment: ${data.treatment}
Time: ${data.time}
Location: ${data.location}

Estimated wait time: ${data.waitTime || '5-10'} minutes

Please have a seat in the waiting area.

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
    const message = `Hello ${data.patientName}!

Thank you for visiting Zennara Clinic today.

Treatment: ${data.treatment}
Date: ${data.date}
Location: ${data.location}

We hope you had a great experience. You can rate your visit in the Zennara App.

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
    const message = `Hello ${data.patientName},

We missed you today.

Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}
Location: ${data.location}

You can reschedule through the Zennara App.

Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send appointment reminder (24 hours before)
   */
  async sendAppointmentReminder(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_REMINDER_TEMPLATE_SID && 
        !process.env.WHATSAPP_REMINDER_TEMPLATE_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_REMINDER_TEMPLATE_SID,
        {
          '1': data.patientName,
          '2': data.treatment,
          '3': data.date,
          '4': data.time,
          '5': data.location,
          '6': data.address || 'Check Zennara App for location details'
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.patientName}!

Reminder: Your appointment is tomorrow.

Treatment: ${data.treatment}
Date: ${data.date}
Time: ${data.time}
Location: ${data.location}
Address: ${data.address || 'Check Zennara App for location details'}

Please arrive 10 minutes early with relevant documents.

Zennara Clinic`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send OTP for verification
   */
  async sendOTP(phoneNumber, otp, expiryMinutes = 5) {
    // Debug: Log environment variable status
    console.log('[DEBUG] WHATSAPP_OTP_TEMPLATE_SID exists:', !!process.env.WHATSAPP_OTP_TEMPLATE_SID);
    console.log('[DEBUG] WHATSAPP_OTP_TEMPLATE_SID value:', process.env.WHATSAPP_OTP_TEMPLATE_SID);
    
    // Try template message first (production mode)
    if (process.env.WHATSAPP_OTP_TEMPLATE_SID && 
        !process.env.WHATSAPP_OTP_TEMPLATE_SID.includes('xxx')) {
      
      console.log('Using approved WhatsApp template for OTP');
      console.log('Template SID:', process.env.WHATSAPP_OTP_TEMPLATE_SID);
      console.log('Template Name: zennara_otp_v2');
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_OTP_TEMPLATE_SID,
        {
          '1': otp.toString()
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    console.log('WhatsApp template not configured, using fallback message');
    console.log('[DEBUG] Reason: Template SID is', process.env.WHATSAPP_OTP_TEMPLATE_SID || 'undefined');
    const message = `Your Zennara verification code is ${otp}

Valid for ${expiryMinutes} minutes. Do not share this code with anyone.`;

    return await this.sendMessage(phoneNumber, message);
  }

  // ==================== PRODUCT ORDER NOTIFICATIONS ====================

  /**
   * Send order placed notification (when user places order)
   */
  async sendOrderConfirmation(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_PLACED_SID && 
        !process.env.WHATSAPP_ORDER_PLACED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_PLACED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.total,
          '4': data.paymentMethod,
          '5': data.shippingAddress
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order has been placed successfully.

Order Number: ${data.orderNumber}
Total: Rs.${data.total}
Payment: ${data.paymentMethod}

Delivery Address:
${data.shippingAddress}

Your order is awaiting confirmation. Check the Zennara App for updates.

Thank you for shopping with us!`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order confirmed notification (when admin confirms)
   */
  async sendOrderConfirmed(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_CONFIRMED_SID && 
        !process.env.WHATSAPP_ORDER_CONFIRMED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_CONFIRMED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.total
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order has been confirmed.

Order Number: ${data.orderNumber}
Total: Rs.${data.total}

We are processing your order. Check the Zennara App for updates.

Thank you!`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order processing notification
   */
  async sendOrderProcessing(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_PROCESSING_SID && 
        !process.env.WHATSAPP_ORDER_PROCESSING_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_PROCESSING_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order is now being processed.

Order Number: ${data.orderNumber}

We are preparing your items for shipment. Check the Zennara App for updates.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order packed notification
   */
  async sendOrderPacked(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_PACKED_SID && 
        !process.env.WHATSAPP_ORDER_PACKED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_PACKED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order has been packed and is ready for shipment.

Order Number: ${data.orderNumber}

Your order will be handed over to our delivery partner soon. Check the Zennara App for updates.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order shipped notification
   */
  async sendOrderShipped(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_SHIPPED_SID && 
        !process.env.WHATSAPP_ORDER_SHIPPED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_SHIPPED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.trackingId || 'Will be updated soon',
          '4': data.estimatedDelivery || '2-3 business days'
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order has been shipped.

Order Number: ${data.orderNumber}
Tracking ID: ${data.trackingId || 'Will be updated soon'}
Estimated Delivery: ${data.estimatedDelivery || '2-3 business days'}

Check the Zennara App for tracking updates.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order out for delivery notification
   */
  async sendOrderOutForDelivery(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_OUT_FOR_DELIVERY_SID && 
        !process.env.WHATSAPP_OUT_FOR_DELIVERY_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_OUT_FOR_DELIVERY_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.deliveryPartner || 'Local Courier',
          '4': data.expectedTime || 'End of day'
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order is out for delivery today.

Order Number: ${data.orderNumber}
Delivery Partner: ${data.deliveryPartner || 'Local Courier'}
Expected By: ${data.expectedTime || 'End of day'}

Please keep your phone handy.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order delivered notification
   */
  async sendOrderDelivered(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_DELIVERED_SID && 
        !process.env.WHATSAPP_ORDER_DELIVERED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_DELIVERED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.deliveredAt
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your order has been delivered successfully.

Order Number: ${data.orderNumber}
Delivered At: ${data.deliveredAt}

Thank you for shopping with Zennara Clinic. Please rate your experience in the app.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send order cancelled notification
   */
  async sendOrderCancelled(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_ORDER_CANCELLED_SID && 
        !process.env.WHATSAPP_ORDER_CANCELLED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_ORDER_CANCELLED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.reason || 'As per your request'
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName},

Your order has been cancelled.

Order Number: ${data.orderNumber}
Reason: ${data.reason || 'As per your request'}

If payment was made, refund will be processed within 5-7 business days.

Thank you.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send return request received notification
   */
  async sendReturnRequestReceived(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_RETURN_REQUEST_SID && 
        !process.env.WHATSAPP_RETURN_REQUEST_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_RETURN_REQUEST_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.reason
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName},

We have received your return request.

Order Number: ${data.orderNumber}
Return Reason: ${data.reason}

Our team will review and contact you within 24 hours. Check the Zennara App for updates.

Thank you.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send return approved notification
   */
  async sendReturnApproved(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_RETURN_APPROVED_SID && 
        !process.env.WHATSAPP_RETURN_APPROVED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_RETURN_APPROVED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your return request has been approved.

Order Number: ${data.orderNumber}

Our logistics partner will contact you within 24-48 hours to schedule pickup. Please keep items ready in original packaging.

Check the Zennara App for updates.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send return rejected notification
   */
  async sendReturnRejected(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_RETURN_REJECTED_SID && 
        !process.env.WHATSAPP_RETURN_REJECTED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_RETURN_REJECTED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.rejectionReason
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName},

We are unable to process your return request.

Order Number: ${data.orderNumber}
Reason: ${data.rejectionReason}

Contact our support team through the Zennara App for assistance.

Thank you.`;

    return await this.sendMessage(phoneNumber, message);
  }

  /**
   * Send refund processed notification
   */
  async sendRefundProcessed(phoneNumber, data) {
    // Try template message first (production mode)
    if (process.env.WHATSAPP_REFUND_PROCESSED_SID && 
        !process.env.WHATSAPP_REFUND_PROCESSED_SID.includes('xxx')) {
      
      return await this.sendTemplateMessage(
        phoneNumber,
        process.env.WHATSAPP_REFUND_PROCESSED_SID,
        {
          '1': data.customerName,
          '2': data.orderNumber,
          '3': data.refundAmount,
          '4': data.refundMethod
        }
      );
    }
    
    // Fallback to direct message (sandbox mode)
    const message = `Hello ${data.customerName}!

Your refund has been processed.

Order Number: ${data.orderNumber}
Refund Amount: Rs.${data.refundAmount}
Refund Method: ${data.refundMethod}

Amount will be credited within 5-7 business days.

Thank you!`;

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
