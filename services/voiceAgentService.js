const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const murfAIService = require('./murfAIService');

/**
 * Voice AI Agent Service
 * Handles intelligent conversations about user's account, orders, bookings, etc.
 */
class VoiceAgentService {
  
  /**
   * Process user query and generate intelligent response
   * @param {string} userId - User ID
   * @param {string} query - User's question
   * @returns {Promise<object>} Response with text and audio
   */
  async processQuery(userId, query) {
    try {
      // Get user data
      const userData = await this.getUserData(userId);
      
      // Analyze query intent
      const intent = this.detectIntent(query);
      
      // Generate response based on intent
      const responseText = await this.generateResponse(intent, userData, query);
      
      // Convert to speech using Murf AI
      const audioResponse = await murfAIService.textToSpeech(responseText, {
        voiceId: 'en-IN-male-1', // Indian English male voice
        speed: 1.0
      });
      
      return {
        success: true,
        intent: intent,
        response: responseText,
        audio: audioResponse.success ? audioResponse.audioUrl : null,
        duration: audioResponse.duration
      };
      
    } catch (error) {
      console.error('Voice Agent Error:', error);
      return {
        success: false,
        error: error.message,
        response: "I'm sorry, I encountered an error processing your request. Please try again."
      };
    }
  }

  /**
   * Detect user's intent from query
   */
  detectIntent(query) {
    const lowerQuery = query.toLowerCase();
    
    // Order-related queries
    if (lowerQuery.match(/order|delivery|track|shipping|package|product/i)) {
      if (lowerQuery.match(/track|status|where/i)) return 'ORDER_STATUS';
      if (lowerQuery.match(/upcoming|pending/i)) return 'UPCOMING_ORDERS';
      return 'ORDER_INFO';
    }
    
    // Booking-related queries
    if (lowerQuery.match(/booking|appointment|schedule|consultation/i)) {
      if (lowerQuery.match(/upcoming|next|future/i)) return 'UPCOMING_BOOKINGS';
      if (lowerQuery.match(/cancel|reschedule/i)) return 'MODIFY_BOOKING';
      if (lowerQuery.match(/history|past|previous/i)) return 'BOOKING_HISTORY';
      return 'BOOKING_INFO';
    }
    
    // Service/Consultation queries
    if (lowerQuery.match(/service|treatment|facial|hair|skin|what do you offer/i)) {
      return 'SERVICES_INFO';
    }
    
    // Account queries
    if (lowerQuery.match(/account|profile|my details|personal/i)) {
      return 'ACCOUNT_INFO';
    }
    
    // General help
    if (lowerQuery.match(/help|how|what can you/i)) {
      return 'HELP';
    }
    
    return 'GENERAL';
  }

  /**
   * Get comprehensive user data
   */
  async getUserData(userId) {
    try {
      const [user, bookings, orders, consultations] = await Promise.all([
        User.findById(userId).select('-password'),
        Booking.find({ userId })
          .populate('consultationId', 'name category price')
          .populate('branchId', 'name address')
          .sort({ createdAt: -1 })
          .limit(10),
        ProductOrder.find({ userId })
          .populate('items.productId', 'name')
          .sort({ createdAt: -1 })
          .limit(10),
        Consultation.find({ isActive: true }).select('name category price description')
      ]);

      return {
        user,
        bookings,
        orders,
        consultations,
        upcomingBookings: bookings.filter(b => 
          new Date(b.preferredDate) > new Date() && 
          ['Awaiting Confirmation', 'Confirmed'].includes(b.status)
        ),
        activeOrders: orders.filter(o => 
          !['Delivered', 'Cancelled', 'Returned'].includes(o.status)
        )
      };
    } catch (error) {
      console.error('Error fetching user data:', error);
      return null;
    }
  }

  /**
   * Generate intelligent response based on intent and user data
   */
  async generateResponse(intent, userData, originalQuery) {
    if (!userData) {
      return "I'm having trouble accessing your account information right now. Please try again in a moment.";
    }

    const { user, bookings, orders, upcomingBookings, activeOrders, consultations } = userData;

    switch (intent) {
      case 'ORDER_STATUS':
        return this.getOrderStatusResponse(activeOrders, orders);
      
      case 'UPCOMING_ORDERS':
        return this.getUpcomingOrdersResponse(activeOrders);
      
      case 'ORDER_INFO':
        return this.getOrderInfoResponse(orders);
      
      case 'UPCOMING_BOOKINGS':
        return this.getUpcomingBookingsResponse(upcomingBookings);
      
      case 'BOOKING_HISTORY':
        return this.getBookingHistoryResponse(bookings);
      
      case 'BOOKING_INFO':
        return this.getBookingInfoResponse(bookings, upcomingBookings);
      
      case 'SERVICES_INFO':
        return this.getServicesInfoResponse(consultations);
      
      case 'ACCOUNT_INFO':
        return this.getAccountInfoResponse(user, bookings, orders);
      
      case 'HELP':
        return this.getHelpResponse();
      
      default:
        return this.getGeneralResponse(user);
    }
  }

  /**
   * Response generators for different intents
   */
  
  getOrderStatusResponse(activeOrders, allOrders) {
    if (activeOrders.length === 0) {
      if (allOrders.length > 0) {
        return "You don't have any active orders right now. Your recent orders have been delivered or completed.";
      }
      return "You haven't placed any orders yet. Browse our product catalog to get started!";
    }

    const order = activeOrders[0];
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    
    return `You have ${activeOrders.length} active order${activeOrders.length > 1 ? 's' : ''}. Your most recent order of ${itemCount} item${itemCount > 1 ? 's' : ''} is currently ${order.status}. Order number is ${order.orderNumber}.`;
  }

  getUpcomingOrdersResponse(activeOrders) {
    if (activeOrders.length === 0) {
      return "You don't have any upcoming orders at the moment.";
    }

    const ordersList = activeOrders.slice(0, 3).map((order, index) => 
      `${index + 1}. Order ${order.orderNumber}, status: ${order.status}`
    ).join('. ');

    return `You have ${activeOrders.length} upcoming order${activeOrders.length > 1 ? 's' : ''}. ${ordersList}.`;
  }

  getOrderInfoResponse(orders) {
    if (orders.length === 0) {
      return "You haven't placed any orders yet. Check out our products and place your first order!";
    }

    return `You have placed ${orders.length} order${orders.length > 1 ? 's' : ''} in total. Your most recent order was placed on ${new Date(orders[0].createdAt).toLocaleDateString('en-IN')}.`;
  }

  getUpcomingBookingsResponse(upcomingBookings) {
    if (upcomingBookings.length === 0) {
      return "You don't have any upcoming appointments scheduled. Would you like to book a consultation?";
    }

    const booking = upcomingBookings[0];
    const dateStr = new Date(booking.preferredDate).toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });

    if (upcomingBookings.length === 1) {
      return `You have one upcoming appointment. ${booking.consultationId?.name || 'Consultation'} at ${booking.branchId?.name || booking.preferredLocation} branch on ${dateStr}. Reference number is ${booking.referenceNumber}.`;
    }

    return `You have ${upcomingBookings.length} upcoming appointments. Your next one is ${booking.consultationId?.name || 'Consultation'} on ${dateStr} at ${booking.branchId?.name || booking.preferredLocation} branch.`;
  }

  getBookingHistoryResponse(bookings) {
    if (bookings.length === 0) {
      return "You haven't made any bookings yet. Book your first consultation with us today!";
    }

    const completed = bookings.filter(b => b.status === 'Completed').length;
    const cancelled = bookings.filter(b => b.status === 'Cancelled').length;

    return `You have ${bookings.length} booking${bookings.length > 1 ? 's' : ''} in total. ${completed} completed and ${cancelled} cancelled. Your last appointment was on ${new Date(bookings[0].createdAt).toLocaleDateString('en-IN')}.`;
  }

  getBookingInfoResponse(bookings, upcomingBookings) {
    if (bookings.length === 0) {
      return "You don't have any bookings yet. Let me know if you'd like to schedule a consultation!";
    }

    const upcoming = upcomingBookings.length;
    const total = bookings.length;

    return `You have ${total} total booking${total > 1 ? 's' : ''}. ${upcoming > 0 ? `${upcoming} upcoming appointment${upcoming > 1 ? 's' : ''} scheduled.` : 'No upcoming appointments at the moment.'}`;
  }

  getServicesInfoResponse(consultations) {
    if (consultations.length === 0) {
      return "We're currently updating our services. Please check back soon!";
    }

    const categories = [...new Set(consultations.map(c => c.category))];
    const topServices = consultations.slice(0, 5).map(c => c.name).join(', ');

    return `We offer ${consultations.length} different consultation services across ${categories.length} categories including ${categories.slice(0, 3).join(', ')}. Popular services include ${topServices}. Would you like to know more about any specific service?`;
  }

  getAccountInfoResponse(user, bookings, orders) {
    const name = user.name || 'User';
    const bookingCount = bookings.length;
    const orderCount = orders.length;

    return `Hello ${name}! Your account is active. You have ${bookingCount} total booking${bookingCount !== 1 ? 's' : ''} and ${orderCount} order${orderCount !== 1 ? 's' : ''}. Your registered email is ${user.email}. How can I help you today?`;
  }

  getHelpResponse() {
    return "I'm Zennara's AI assistant! I can help you with information about your orders, track deliveries, check your appointments, tell you about our consultation services, and manage your account. What would you like to know?";
  }

  getGeneralResponse(user) {
    const name = user.name || 'there';
    return `Hello ${name}! I'm here to help you with your Zennara account. You can ask me about your orders, bookings, our services, or your account details. What would you like to know?`;
  }
}

module.exports = new VoiceAgentService();
