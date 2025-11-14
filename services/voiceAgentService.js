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
      console.log(`🎯 User query: "${query}" → Detected intent: ${intent}`);
      
      // Generate response based on intent
      const responseText = await this.generateResponse(intent, userData, query);
      
      // Convert to speech using Murf AI
      console.log('🎙️ Generating voice response with Murf AI...');
      const audioResponse = await murfAIService.textToSpeech(responseText, {
        voiceId: 'en-IN-male-1', // Indian English male voice
        speed: 1.0
      });
      
      if (audioResponse.success) {
        console.log('✅ Murf AI voice generated successfully');
      } else {
        console.log('❌ Murf AI failed:', audioResponse.error);
      }
      
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
   * Advanced intent detection with natural language understanding
   */
  detectIntent(query) {
    const lowerQuery = query.toLowerCase().trim();
    
    // Remove question words for better matching
    const cleanQuery = lowerQuery.replace(/^(can you|could you|please|would you|will you|do you|does|what|when|where|how|why|tell me|show me|get|find|check|give me)\s*/gi, '');
    
    // ORDER STATUS - Tracking, delivery status, where is my order
    const orderStatusPatterns = [
      /where('s| is| are)? (is |my )?(order|package|delivery|shipment|parcel)/i,
      /track(ing)? (my )?(order|package|delivery|shipment)/i,
      /(order|package|delivery) (status|update|tracking|location)/i,
      /(what('s| is) the |check )?(status|progress) (of |on )?(my )?order/i,
      /(when (will|do|can|could)|has) (my )?(order|package|delivery|shipment) (arrive|come|reach|deliver|get|receive)/i,
      /when (can|will|do) (i|we) (get|receive) (the |my )?(order|delivery|package|shipment)/i,
      /delivery (status|update|tracking|time|date|eta)/i,
      /(is|are) my (order|package) (shipped|delivered|on the way)/i,
      /(order|delivery|package|shipment) (eta|estimated time|expected|when)/i,
      /how long (will|does|until) (my )?(order|delivery|package)/i
    ];
    if (orderStatusPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'ORDER_STATUS';
    }

    // UPCOMING BOOKINGS - Next appointments, future consultations
    const upcomingBookingPatterns = [
      /(next|upcoming|future|scheduled) (appointment|booking|consultation|visit|session)/i,
      /(do i have|show me|any|what('s| is)) (any )?(upcoming|next|future) (appointment|booking|consultation)/i,
      /when('s| is) (my )?(next|upcoming) (appointment|booking|consultation|visit)/i,
      /(my )?(upcoming|future|next|scheduled) (appointment|booking|visit|session)s?/i,
      /(appointment|booking|consultation)s? (coming|scheduled|planned)/i,
      /what (appointment|booking|consultation)s? (do i have|are scheduled|coming up)/i
    ];
    if (upcomingBookingPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'UPCOMING_BOOKINGS';
    }

    // BOOKING HISTORY - Past appointments
    const bookingHistoryPatterns = [
      /(past|previous|old|completed|history of) (appointment|booking|consultation|visit)s?/i,
      /(booking|appointment|consultation) (history|record|log)/i,
      /(how many|all|show) (appointment|booking|consultation)s? (have i|i('ve| have))/i,
      /my (appointment|booking|consultation) (history|record)/i
    ];
    if (bookingHistoryPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'BOOKING_HISTORY';
    }

    // BOOKING INFO - General booking information
    const bookingInfoPatterns = [
      /(any|do i have) (appointment|booking|consultation)s?/i,
      /(appointment|booking|consultation)s?$/i,
      /about (my )?(appointment|booking|consultation)s?/i
    ];
    if (bookingInfoPatterns.some(pattern => pattern.test(lowerQuery)) || 
        lowerQuery.match(/\b(appointment|booking|consultation)s?\b/) && !lowerQuery.match(/order|product|service|treatment/)) {
      return 'BOOKING_INFO';
    }

    // UPCOMING ORDERS - Pending deliveries
    const upcomingOrderPatterns = [
      /(upcoming|pending|active|current|ongoing) (order|purchase|delivery)s?/i,
      /(order|purchase|delivery)s? (on the way|coming|pending|active)/i,
      /(do i have|any|show) (pending|active|upcoming) (order|purchase)/i
    ];
    if (upcomingOrderPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'UPCOMING_ORDERS';
    }

    // ORDER INFO - General order information
    const orderInfoPatterns = [
      /(my|all) (order|purchase)s?/i,
      /(how many|total) (order|purchase)s? (have i|i('ve| have))/i,
      /(order|purchase) (history|record|list)/i,
      /(placed|made) (any )?order/i
    ];
    if (orderInfoPatterns.some(pattern => pattern.test(lowerQuery)) ||
        (lowerQuery.match(/\b(order|purchase|delivery)s?\b/) && !lowerQuery.match(/appointment|booking|service/))) {
      return 'ORDER_INFO';
    }

    // SERVICES INFO - Treatment/consultation services
    const servicesPatterns = [
      /(what |which )?(service|treatment|consultation|therapy|procedure)s? (do you|are|does zennara) (offer|have|provide)/i,
      /(tell|show) (me )?(about )?(your |the )?(service|treatment|consultation|offering)s?/i,
      /(available|offer) (service|treatment|consultation)s?/i,
      /(facial|hair|skin|laser|botox|derma) (treatment|service|therapy)/i,
      /types? of (service|treatment|consultation)/i,
      /(what can|can) (i|you) (get|do|book)/i,
      /menu|offerings?|catalogue|catalog/i
    ];
    if (servicesPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'SERVICES_INFO';
    }

    // ACCOUNT INFO - Profile, account details
    const accountPatterns = [
      /(my )?(account|profile) (detail|info|information)/i,
      /(show|tell|get) (me )?(my )?(account|profile|detail|information)/i,
      /(email|name|phone|personal) (detail|info|address)/i,
      /(registered|my) (email|phone|mobile|number|name)/i,
      /(about|check) (my )?account/i,
      /member(ship)?( type| level| status)?/i
    ];
    if (accountPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'ACCOUNT_INFO';
    }

    // HELP - General help queries
    const helpPatterns = [
      /^(hi|hey|hello|help|assist|support)$/i,
      /(what can you|can you help|help me|assist me|support)/i,
      /(what (can|do) you do|your capabilities|features)/i,
      /how (do|can) (i|you)/i
    ];
    if (helpPatterns.some(pattern => pattern.test(lowerQuery))) {
      return 'HELP';
    }

    // Default to GENERAL for anything else
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
        const lastOrder = allOrders[0];
        return `Great news! You don't have any pending orders at the moment. Your most recent order ${lastOrder.orderNumber} was ${lastOrder.status.toLowerCase()}. All your orders have been successfully completed. Feel free to browse our products anytime!`;
      }
      return "It looks like you haven't placed any orders with us yet. I'd love to help you explore our premium product range. Would you like to know about our bestsellers or current offers?";
    }

    const order = activeOrders[0];
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const itemText = itemCount === 1 ? 'item' : 'items';
    
    let statusDetail = '';
    switch(order.status.toLowerCase()) {
      case 'processing':
        statusDetail = "We're preparing your order carefully.";
        break;
      case 'packed':
        statusDetail = "Your order has been packed and is ready for dispatch.";
        break;
      case 'shipped':
        statusDetail = "Great news! Your order is on its way to you.";
        break;
      case 'out for delivery':
        statusDetail = "Your order is out for delivery and should reach you very soon!";
        break;
      default:
        statusDetail = `Current status: ${order.status}.`;
    }
    
    if (activeOrders.length === 1) {
      return `You have one active order with ${itemCount} ${itemText}. ${statusDetail} Your order number is ${order.orderNumber}. ${order.status === 'Shipped' || order.status === 'Out for Delivery' ? 'You should receive it shortly!' : 'We\'ll notify you once it ships.'}`;
    }
    
    return `You have ${activeOrders.length} active orders right now. Your most recent one has ${itemCount} ${itemText}. ${statusDetail} Order number: ${order.orderNumber}. Would you like details about your other orders?`;
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
      return "You don't have any upcoming appointments scheduled at the moment. Our expert team is ready to help you! Would you like to book a consultation for skincare, hair treatment, or any of our other premium services?";
    }

    const booking = upcomingBookings[0];
    const appointmentDate = new Date(booking.preferredDate);
    const today = new Date();
    const daysUntil = Math.ceil((appointmentDate - today) / (1000 * 60 * 60 * 24));
    
    const dateStr = appointmentDate.toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });

    let timeContext = '';
    if (daysUntil === 0) {
      timeContext = "That's today! ";
    } else if (daysUntil === 1) {
      timeContext = "That's tomorrow! ";
    } else if (daysUntil <= 7) {
      timeContext = `That's in ${daysUntil} days. `;
    }

    const treatmentName = booking.consultationId?.name || 'Your consultation';
    const branchName = booking.branchId?.name || booking.preferredLocation;
    const timeSlots = booking.preferredTimeSlots?.join(' or ') || 'your preferred time';

    if (upcomingBookings.length === 1) {
      return `You have one upcoming appointment! ${timeContext}${treatmentName} at our ${branchName} branch on ${dateStr} at ${timeSlots}. Your reference number is ${booking.referenceNumber}. ${booking.status === 'Confirmed' ? 'Your appointment is confirmed!' : 'We\'ll confirm your exact time slot soon.'} Need to reschedule or have any questions?`;
    }

    return `Great! You have ${upcomingBookings.length} upcoming appointments scheduled. Your next one is ${timeContext}${treatmentName} on ${dateStr} at our ${branchName} branch. Reference: ${booking.referenceNumber}. Would you like to know about your other appointments?`;
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
      return "We're currently updating our service portfolio with exciting new treatments. Please check back soon, or I can help you with anything else about your account!";
    }

    const categories = [...new Set(consultations.map(c => c.category))];
    const topServices = consultations.slice(0, 5).map(c => c.name);
    
    let response = `At Zennara, we pride ourselves on offering ${consultations.length} premium consultation and treatment services! `;
    
    if (categories.length > 0) {
      response += `We specialize in ${categories.length} main categories: ${categories.slice(0, 3).join(', ')}${categories.length > 3 ? ', and more' : ''}. `;
    }
    
    if (topServices.length > 0) {
      response += `Some of our most popular treatments are ${topServices.slice(0, 3).join(', ')}${topServices.length > 3 ? ', among others' : ''}. `;
    }
    
    response += "Each service is performed by our expert team using cutting-edge techniques. Would you like to know more about any specific treatment or book a consultation?";
    
    return response;
  }

  getAccountInfoResponse(user, bookings, orders) {
    const name = user.fullName || user.name || 'valued customer';
    const bookingCount = bookings.length;
    const orderCount = orders.length;
    const memberType = user.memberType || 'Regular Member';
    
    let response = `Hello ${name}! `;
    
    if (memberType === 'Zen Member') {
      response += "You're a Zen Member - thank you for being part of our exclusive community! ";
    }
    
    response += `Your account is active and in great standing. `;
    
    if (bookingCount > 0 || orderCount > 0) {
      response += `You've been with us for `;
      const activities = [];
      if (bookingCount > 0) activities.push(`${bookingCount} consultation${bookingCount > 1 ? 's' : ''}`);
      if (orderCount > 0) activities.push(`${orderCount} product order${orderCount > 1 ? 's' : ''}`);
      response += activities.join(' and ') + '. ';
    }
    
    response += `Your registered email is ${user.email}. `;
    
    if (user.phone || user.mobileNumber) {
      response += `Contact number: ${user.phone || user.mobileNumber}. `;
    }
    
    response += "Is there anything specific you'd like to know or update?";
    
    return response;
  }

  getHelpResponse() {
    return "I'm your Zennara AI assistant, and I'm here to make your experience seamless! I can help you with: tracking your product orders and deliveries, checking your appointment schedules, exploring our range of consultation services and treatments, viewing your account details and membership information, answering questions about past bookings or purchases. Just ask me anything in your own words - I'm designed to understand natural conversation. What would you like to know?";
  }

  getGeneralResponse(user) {
    const name = user.fullName || user.name || 'there';
    const greetings = [
      `Hi ${name}! Great to see you here.`,
      `Hello ${name}! Welcome back.`,
      `Hey ${name}! How can I assist you today?`
    ];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    
    return `${greeting} I'm your personal Zennara AI assistant. I can help you with information about your orders, track deliveries, check appointment schedules, explore our services, or manage your account. Feel free to ask me anything - I'm here to help! What's on your mind?`;
  }
}

module.exports = new VoiceAgentService();
