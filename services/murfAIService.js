const axios = require('axios');

class MurfAIService {
  constructor() {
    this.apiKey = process.env.MURF_AI;
    this.baseURL = 'https://global.api.murf.ai/v1';
    this.falconURL = 'https://us-east.api.murf.ai/v1'; // Using US-East for higher concurrency
    
    if (!this.apiKey) {
      console.warn('MURF_AI API key not found in environment variables');
    }
  }

  /**
   * Convert text to speech using Murf AI Falcon model (for real-time conversational AI)
   * @param {string} text - The text to convert to speech
   * @param {object} options - Additional options for the API
   * @returns {Promise<Buffer>} - Audio buffer
   */
  async textToSpeech(text, options = {}) {
    try {
      const {
        voiceId = 'en-US-Lily', // Default female voice
        model = 'Falcon',
        sampleRate = 44100,
        format = 'mp3',
        style = 'Conversational'
      } = options;

      const endpoint = model === 'Falcon' 
        ? `${this.falconURL}/speech/stream`
        : `${this.baseURL}/speech/generate`;

      const response = await axios.post(
        endpoint,
        {
          text,
          voiceId,
          model,
          sampleRate,
          format,
          style
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
        }
      );

      return Buffer.from(response.data);
    } catch (error) {
      console.error('Murf AI TTS Error:', error.response?.data || error.message);
      throw new Error('Failed to generate speech from text');
    }
  }

  /**
   * Stream text to speech for real-time conversational AI
   * @param {string} text - The text to convert to speech
   * @param {object} options - Additional options
   * @returns {Promise<Stream>} - Audio stream
   */
  async streamTextToSpeech(text, options = {}) {
    try {
      const {
        voiceId = 'en-US-Lily',
        model = 'Falcon',
        sampleRate = 44100,
        format = 'mp3'
      } = options;

      const response = await axios.post(
        `${this.falconURL}/speech/stream`,
        {
          text,
          voiceId,
          model,
          sampleRate,
          format
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream'
        }
      );

      return response.data;
    } catch (error) {
      console.error('Murf AI Stream Error:', error.response?.data || error.message);
      throw new Error('Failed to stream speech');
    }
  }

  /**
   * Get available voices from Murf AI
   * @returns {Promise<Array>} - List of available voices
   */
  async getAvailableVoices() {
    try {
      const response = await axios.get(
        `${this.baseURL}/voices`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.voices || [];
    } catch (error) {
      console.error('Failed to fetch voices:', error.message);
      return this.getDefaultVoices();
    }
  }

  /**
   * Get default voices as fallback
   * @returns {Array} - Default voice configurations
   */
  getDefaultVoices() {
    return [
      {
        id: 'en-US-Lily',
        name: 'Lily',
        language: 'English (US)',
        gender: 'Female',
        description: 'Professional and friendly female voice'
      },
      {
        id: 'en-US-Marcus',
        name: 'Marcus',
        language: 'English (US)',
        gender: 'Male',
        description: 'Warm and professional male voice'
      },
      {
        id: 'en-IN-Priya',
        name: 'Priya',
        language: 'English (India)',
        gender: 'Female',
        description: 'Indian English female voice'
      },
      {
        id: 'en-IN-Ravi',
        name: 'Ravi',
        language: 'English (India)',
        gender: 'Male',
        description: 'Indian English male voice'
      }
    ];
  }

  /**
   * Generate conversational response with context awareness
   * @param {string} userQuery - The user's question
   * @param {object} context - Context data (orders, bookings, etc.)
   * @returns {string} - Generated response text
   */
  generateResponse(userQuery, context = {}) {
    const lowerQuery = userQuery.toLowerCase();
    
    // Orders related queries
    if (lowerQuery.includes('order') || lowerQuery.includes('orders')) {
      return this.handleOrderQuery(lowerQuery, context.orders || []);
    }
    
    // Bookings related queries
    if (lowerQuery.includes('booking') || lowerQuery.includes('appointment') || lowerQuery.includes('consultation')) {
      return this.handleBookingQuery(lowerQuery, context.bookings || []);
    }
    
    // Services related queries
    if (lowerQuery.includes('service') || lowerQuery.includes('treatment') || lowerQuery.includes('consultation')) {
      return this.handleServiceQuery(lowerQuery, context.consultations || []);
    }
    
    // Account related queries
    if (lowerQuery.includes('account') || lowerQuery.includes('profile') || lowerQuery.includes('membership')) {
      return this.handleAccountQuery(lowerQuery, context.user || {});
    }
    
    // Default greeting or general query
    return this.handleGeneralQuery(lowerQuery, context);
  }

  /**
   * Handle order-related queries
   */
  handleOrderQuery(query, orders) {
    if (!orders || orders.length === 0) {
      return "You currently don't have any orders. Would you like to browse our products and place an order?";
    }

    if (query.includes('recent') || query.includes('latest') || query.includes('last')) {
      const latestOrder = orders[0];
      return `Your most recent order ${latestOrder.orderNumber} was placed on ${new Date(latestOrder.createdAt).toLocaleDateString()}. The order status is ${latestOrder.orderStatus}. Total amount is ${latestOrder.pricing.total} rupees.`;
    }

    if (query.includes('pending') || query.includes('processing')) {
      const pendingOrders = orders.filter(o => 
        !['Delivered', 'Cancelled', 'Returned'].includes(o.orderStatus)
      );
      
      if (pendingOrders.length === 0) {
        return "You don't have any pending orders at the moment.";
      }
      
      return `You have ${pendingOrders.length} order${pendingOrders.length > 1 ? 's' : ''} in progress. ${pendingOrders.map(o => 
        `Order ${o.orderNumber} is currently ${o.orderStatus}`
      ).join('. ')}.`;
    }

    if (query.includes('delivered')) {
      const deliveredOrders = orders.filter(o => o.orderStatus === 'Delivered');
      return `You have ${deliveredOrders.length} delivered order${deliveredOrders.length !== 1 ? 's' : ''}.`;
    }

    return `You have ${orders.length} total order${orders.length !== 1 ? 's' : ''}. Your latest order ${orders[0].orderNumber} is currently ${orders[0].orderStatus}.`;
  }

  /**
   * Handle booking-related queries
   */
  handleBookingQuery(query, bookings) {
    if (!bookings || bookings.length === 0) {
      return "You don't have any bookings at the moment. Would you like to schedule a consultation with our doctors?";
    }

    if (query.includes('upcoming') || query.includes('next') || query.includes('future')) {
      const upcomingBookings = bookings.filter(b => 
        ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'].includes(b.status) &&
        new Date(b.preferredDate || b.confirmedDate) >= new Date()
      );

      if (upcomingBookings.length === 0) {
        return "You don't have any upcoming appointments. Would you like to book a consultation?";
      }

      const nextBooking = upcomingBookings[0];
      const date = new Date(nextBooking.confirmedDate || nextBooking.preferredDate);
      return `Your next appointment is ${nextBooking.consultationId?.name || 'a consultation'} on ${date.toLocaleDateString()} at ${nextBooking.confirmedTime || 'a time to be confirmed'}. The booking reference is ${nextBooking.referenceNumber}.`;
    }

    if (query.includes('past') || query.includes('previous') || query.includes('completed')) {
      const pastBookings = bookings.filter(b => b.status === 'Completed');
      return `You have completed ${pastBookings.length} consultation${pastBookings.length !== 1 ? 's' : ''} with us.`;
    }

    if (query.includes('cancelled')) {
      const cancelledBookings = bookings.filter(b => 
        ['Cancelled', 'No Show'].includes(b.status)
      );
      return `You have ${cancelledBookings.length} cancelled or missed appointment${cancelledBookings.length !== 1 ? 's' : ''}.`;
    }

    return `You have ${bookings.length} total booking${bookings.length !== 1 ? 's' : ''}. Let me know if you'd like details about any specific appointment.`;
  }

  /**
   * Handle service-related queries
   */
  handleServiceQuery(query, consultations) {
    if (!consultations || consultations.length === 0) {
      return "We offer a wide range of aesthetic and wellness consultations. Let me fetch the complete list for you.";
    }

    if (query.includes('how many') || query.includes('total') || query.includes('all')) {
      const categories = [...new Set(consultations.map(c => c.category))];
      return `We offer ${consultations.length} different consultation services across ${categories.length} categories including ${categories.slice(0, 3).join(', ')}${categories.length > 3 ? ' and more' : ''}.`;
    }

    if (query.includes('popular') || query.includes('best')) {
      const popular = consultations.filter(c => c.isPopular);
      if (popular.length > 0) {
        return `Our most popular services include ${popular.slice(0, 3).map(c => c.name).join(', ')}. Would you like to know more about any of these?`;
      }
    }

    if (query.includes('price') || query.includes('cost')) {
      const avgPrice = consultations.reduce((sum, c) => sum + c.price, 0) / consultations.length;
      return `Our consultation services range from ${Math.min(...consultations.map(c => c.price))} to ${Math.max(...consultations.map(c => c.price))} rupees, with an average price of ${Math.round(avgPrice)} rupees.`;
    }

    return `We offer ${consultations.length} professional consultation services. Would you like to know about specific categories or treatments?`;
  }

  /**
   * Handle account-related queries
   */
  handleAccountQuery(query, user) {
    if (!user || !user.fullName) {
      return "I couldn't find your account details. Please make sure you're logged in.";
    }

    if (query.includes('membership') || query.includes('member')) {
      if (user.memberType === 'Zen Member') {
        const expiryDate = new Date(user.zenMembershipExpiryDate);
        return `You are a Zen Member! Your membership is active until ${expiryDate.toLocaleDateString()}. Zen members enjoy exclusive benefits and priority booking.`;
      } else {
        return "You are currently a Regular Member. Would you like to upgrade to Zen Membership for exclusive benefits?";
      }
    }

    if (query.includes('profile') || query.includes('info') || query.includes('details')) {
      return `Hello ${user.fullName}! Your account is active. You joined us on ${new Date(user.createdAt).toLocaleDateString()}. Your preferred location is ${user.location}.`;
    }

    if (query.includes('spent') || query.includes('spending')) {
      return `You have spent a total of ${user.totalSpent || 0} rupees with us. Thank you for being a valued customer!`;
    }

    return `Hello ${user.fullName}! How can I assist you today with your account?`;
  }

  /**
   * Handle general queries and greetings
   */
  handleGeneralQuery(query, context) {
    const userName = context.user?.fullName || 'there';

    if (query.includes('hello') || query.includes('hi') || query.includes('hey')) {
      return `Hello ${userName}! I'm your Zennara voice assistant. I can help you with information about your orders, bookings, consultations, and account. What would you like to know?`;
    }

    if (query.includes('help') || query.includes('what can you')) {
      return `I can help you with the following: Check your order status and history, view your upcoming appointments, get information about our consultation services, check your membership details, and answer general questions about Zennara. What would you like to know?`;
    }

    if (query.includes('thank')) {
      return `You're welcome! Is there anything else I can help you with today?`;
    }

    if (query.includes('bye') || query.includes('goodbye')) {
      return `Goodbye ${userName}! Feel free to reach out anytime you need assistance. Have a wonderful day!`;
    }

    return `I'm your Zennara voice assistant. I can help you with orders, bookings, consultations, and account information. What would you like to know?`;
  }
}

module.exports = new MurfAIService();
