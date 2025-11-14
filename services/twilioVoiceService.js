const twilio = require('twilio');

class TwilioVoiceService {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    this.voiceCallerNumber = process.env.TWILIO_VOICE_CALLER_NUMBER || this.phoneNumber;
    
    if (!this.accountSid || !this.authToken || !this.phoneNumber) {
      console.error('Twilio credentials missing');
      return;
    }
    
    this.client = twilio(this.accountSid, this.authToken);
  }

  /**
   * Make an automated voice call for appointment booking confirmation
   * @param {string} toPhoneNumber - Recipient phone number
   * @param {object} bookingDetails - Booking information
   */
  async makeBookingConfirmationCall(toPhoneNumber, bookingDetails) {
    try {
      if (!this.client) {
        throw new Error('Twilio client not initialized');
      }

      const {
        patientName,
        treatment,
        date,
        timeSlots,
        branchName,
        branchAddress,
        referenceNumber
      } = bookingDetails;

      // Format the phone number
      const formattedPhone = this.formatPhoneNumber(toPhoneNumber);

      // Create TwiML for the voice message
      const twiml = this.generateBookingConfirmationTwiML(bookingDetails);

      // Make the call
      const call = await this.client.calls.create({
        twiml: twiml,
        to: formattedPhone,
        from: this.voiceCallerNumber,
        statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL, // Optional: for tracking call status
        statusCallbackMethod: 'POST'
      });

      console.log(`Voice call initiated successfully. Call SID: ${call.sid}`);
      return {
        success: true,
        callSid: call.sid,
        status: call.status
      };

    } catch (error) {
      console.error('Failed to make voice call:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate TwiML for booking confirmation voice message
   * @param {object} bookingDetails - Booking information
   * @returns {string} TwiML XML string
   */
  generateBookingConfirmationTwiML(bookingDetails) {
    const {
      patientName,
      treatment,
      date,
      timeSlots,
      branchName,
      branchAddress,
      referenceNumber
    } = bookingDetails;

    // Create the voice message script - short, energetic, and crisp
    const message = `
      <Response>
        <Say voice="Polly.Matthew" language="en-IN">
          Hello ${this.escapeXml(patientName)}! Thanks for booking with Zennara Clinic. We'll review and confirm your appointment shortly. You have booked at ${this.escapeXml(branchName)} branch. Have a great day!
        </Say>
      </Response>
    `;

    return message;
  }

  /**
   * Format phone number to E.164 format
   * @param {string} phoneNumber - Phone number
   * @returns {string} Formatted phone number
   */
  formatPhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    let cleaned = phoneNumber.replace(/\D/g, '');
    
    // If it starts with 91, add +
    if (cleaned.startsWith('91')) {
      return `+${cleaned}`;
    }
    
    // If it doesn't have country code, add +91
    if (cleaned.length === 10) {
      return `+91${cleaned}`;
    }
    
    return `+${cleaned}`;
  }

  /**
   * Escape XML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeXml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Convert reference number to spoken format (spell out each character)
   * @param {string} refNumber - Reference number
   * @returns {string} Spoken reference number
   */
  speakReferenceNumber(refNumber) {
    if (!refNumber) return '';
    // Add spaces between characters for better pronunciation
    return refNumber.split('').join(' ');
  }

  /**
   * Get call status by Call SID
   * @param {string} callSid - Twilio Call SID
   */
  async getCallStatus(callSid) {
    try {
      if (!this.client) {
        throw new Error('Twilio client not initialized');
      }

      const call = await this.client.calls(callSid).fetch();
      return {
        success: true,
        status: call.status,
        duration: call.duration,
        startTime: call.startTime,
        endTime: call.endTime
      };
    } catch (error) {
      console.error('Failed to fetch call status:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new TwilioVoiceService();
