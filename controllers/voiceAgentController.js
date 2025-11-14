const murfAIService = require('../services/murfAIService');
const VoiceConversation = require('../models/VoiceConversation');
const User = require('../models/User');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const Consultation = require('../models/Consultation');

/**
 * Start a new voice conversation session
 */
exports.startSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { metadata, voiceSettings } = req.body;

    // Check if there's an active session
    let session = await VoiceConversation.getActiveSession(userId);

    if (session) {
      return res.status(200).json({
        success: true,
        message: 'Active session found',
        session: {
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          totalInteractions: session.totalInteractions
        }
      });
    }

    // Create new session
    session = await VoiceConversation.createSession(userId, metadata, voiceSettings);

    res.status(201).json({
      success: true,
      message: 'Voice session started successfully',
      session: {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        voiceSettings: session.voiceSettings
      }
    });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start voice session',
      error: error.message
    });
  }
};

/**
 * Process voice query and generate response
 */
exports.processQuery = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query, sessionId, includeAudio = true, voiceId, queryType = 'text' } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Query is required'
      });
    }

    // Get or create session
    let session = sessionId 
      ? await VoiceConversation.findOne({ sessionId, userId })
      : await VoiceConversation.getActiveSession(userId);

    if (!session) {
      session = await VoiceConversation.createSession(userId);
    }

    // Gather user context
    const context = await gatherUserContext(userId);

    // Generate text response using AI service
    const textResponse = murfAIService.generateResponse(query, context);

    // Generate audio if requested
    let audioBuffer = null;
    let audioUrl = null;

    if (includeAudio) {
      try {
        const selectedVoiceId = voiceId || session.voiceSettings.voiceId;
        audioBuffer = await murfAIService.textToSpeech(textResponse, {
          voiceId: selectedVoiceId,
          model: session.voiceSettings.model
        });

        // Convert buffer to base64 for transmission
        audioUrl = `data:audio/mp3;base64,${audioBuffer.toString('base64')}`;
      } catch (audioError) {
        console.error('Audio generation error:', audioError);
        // Continue without audio
      }
    }

    // Save conversation
    await session.addConversation(query, textResponse, {
      userQueryType: queryType,
      responseType: includeAudio ? 'audio' : 'text',
      audioUrl: audioUrl ? 'generated' : null,
      context: {
        ordersCount: context.orders?.length || 0,
        bookingsCount: context.bookings?.length || 0,
        consultationsCount: context.consultations?.length || 0
      }
    });

    res.status(200).json({
      success: true,
      data: {
        query,
        response: textResponse,
        audio: audioUrl,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Process query error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process query',
      error: error.message
    });
  }
};

/**
 * Stream voice response for real-time interaction
 */
exports.streamResponse = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query, sessionId } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Query is required'
      });
    }

    // Get session
    let session = sessionId 
      ? await VoiceConversation.findOne({ sessionId, userId })
      : await VoiceConversation.getActiveSession(userId);

    if (!session) {
      session = await VoiceConversation.createSession(userId);
    }

    // Gather context and generate response
    const context = await gatherUserContext(userId);
    const textResponse = murfAIService.generateResponse(query, context);

    // Stream audio response
    const audioStream = await murfAIService.streamTextToSpeech(textResponse, {
      voiceId: session.voiceSettings.voiceId,
      model: session.voiceSettings.model
    });

    // Set headers for streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Response-Text', encodeURIComponent(textResponse));
    res.setHeader('X-Session-Id', session.sessionId);

    // Pipe audio stream to response
    audioStream.pipe(res);

    // Save conversation after streaming
    audioStream.on('end', async () => {
      await session.addConversation(query, textResponse, {
        responseType: 'audio',
        audioUrl: 'streamed'
      });
    });

  } catch (error) {
    console.error('Stream response error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stream response',
      error: error.message
    });
  }
};

/**
 * Get conversation history
 */
exports.getHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, sessionId } = req.query;

    let history;

    if (sessionId) {
      // Get specific session
      const session = await VoiceConversation.findOne({ sessionId, userId });
      if (!session) {
        return res.status(404).json({
          success: false,
          message: 'Session not found'
        });
      }
      history = [session];
    } else {
      // Get all sessions
      history = await VoiceConversation.getUserHistory(userId, parseInt(limit));
    }

    res.status(200).json({
      success: true,
      data: history.map(session => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        totalInteractions: session.totalInteractions,
        isActive: session.isActive,
        conversations: session.conversations.map(conv => ({
          timestamp: conv.timestamp,
          userQuery: conv.userQuery,
          aiResponse: conv.aiResponse,
          responseType: conv.responseType
        }))
      }))
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation history',
      error: error.message
    });
  }
};

/**
 * End voice conversation session
 */
exports.endSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.body;

    const session = await VoiceConversation.findOne({ sessionId, userId });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    if (!session.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Session already ended'
      });
    }

    await session.endSession();

    res.status(200).json({
      success: true,
      message: 'Session ended successfully',
      data: {
        sessionId: session.sessionId,
        totalInteractions: session.totalInteractions,
        duration: session.sessionDuration
      }
    });
  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end session',
      error: error.message
    });
  }
};

/**
 * Get available voices
 */
exports.getVoices = async (req, res) => {
  try {
    const voices = await murfAIService.getAvailableVoices();

    res.status(200).json({
      success: true,
      data: voices
    });
  } catch (error) {
    console.error('Get voices error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available voices',
      error: error.message
    });
  }
};

/**
 * Update voice settings for session
 */
exports.updateVoiceSettings = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId, voiceId, model, language } = req.body;

    const session = await VoiceConversation.findOne({ sessionId, userId });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Update voice settings
    if (voiceId) session.voiceSettings.voiceId = voiceId;
    if (model) session.voiceSettings.model = model;
    if (language) session.voiceSettings.language = language;

    await session.save();

    res.status(200).json({
      success: true,
      message: 'Voice settings updated successfully',
      data: {
        voiceSettings: session.voiceSettings
      }
    });
  } catch (error) {
    console.error('Update voice settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update voice settings',
      error: error.message
    });
  }
};

/**
 * Get quick account summary for voice agent
 */
exports.getAccountSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const context = await gatherUserContext(userId);

    const summary = {
      user: {
        name: context.user.fullName,
        memberType: context.user.memberType,
        location: context.user.location
      },
      orders: {
        total: context.orders?.length || 0,
        pending: context.orders?.filter(o => 
          !['Delivered', 'Cancelled', 'Returned'].includes(o.orderStatus)
        ).length || 0,
        delivered: context.orders?.filter(o => o.orderStatus === 'Delivered').length || 0
      },
      bookings: {
        total: context.bookings?.length || 0,
        upcoming: context.bookings?.filter(b => 
          ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'].includes(b.status) &&
          new Date(b.preferredDate || b.confirmedDate) >= new Date()
        ).length || 0,
        completed: context.bookings?.filter(b => b.status === 'Completed').length || 0
      },
      consultations: {
        total: context.consultations?.length || 0,
        categories: [...new Set(context.consultations?.map(c => c.category) || [])]
      }
    };

    res.status(200).json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Get account summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch account summary',
      error: error.message
    });
  }
};

/**
 * Helper function to gather user context
 */
async function gatherUserContext(userId) {
  try {
    const [user, orders, bookings, consultations] = await Promise.all([
      User.findById(userId).select('-otp -otpExpiry -password'),
      ProductOrder.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Booking.find({ userId })
        .populate('consultationId', 'name category price')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Consultation.find({ isActive: true })
        .select('name category price isPopular')
        .lean()
    ]);

    return {
      user,
      orders,
      bookings,
      consultations
    };
  } catch (error) {
    console.error('Error gathering user context:', error);
    return {
      user: {},
      orders: [],
      bookings: [],
      consultations: []
    };
  }
}
