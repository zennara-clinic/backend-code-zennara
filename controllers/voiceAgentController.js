const voiceAgentService = require('../services/voiceAgentService');
const murfAIService = require('../services/murfAIService');

/**
 * Voice AI Agent Controller
 * Handles voice-based interactions with users
 */

// @desc    Process voice query
// @route   POST /api/voice-agent/query
// @access  Private
exports.processVoiceQuery = async (req, res) => {
  try {
    const { query } = req.body;
    const userId = req.user._id;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Query is required'
      });
    }

    console.log(`Voice query from user ${userId}: ${query}`);

    // Process the query
    const response = await voiceAgentService.processQuery(userId, query);

    if (!response.success) {
      return res.status(500).json({
        success: false,
        message: response.error || 'Failed to process query'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        intent: response.intent,
        textResponse: response.response,
        audioUrl: response.audio,
        duration: response.duration
      }
    });

  } catch (error) {
    console.error('Voice query error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process voice query'
    });
  }
};

// @desc    Get conversation suggestions
// @route   GET /api/voice-agent/suggestions
// @access  Private
exports.getConversationSuggestions = async (req, res) => {
  try {
    const suggestions = [
      "What are my upcoming appointments?",
      "Track my recent order",
      "What services do you offer?",
      "Show me my account details",
      "Do I have any pending orders?",
      "Tell me about my booking history",
      "What's the status of my order?",
      "How many consultations have I booked?"
    ];

    res.status(200).json({
      success: true,
      data: { suggestions }
    });

  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch suggestions'
    });
  }
};

// @desc    Get available voices
// @route   GET /api/voice-agent/voices
// @access  Private
exports.getAvailableVoices = async (req, res) => {
  try {
    const voicesResponse = await murfAIService.getAvailableVoices();

    if (!voicesResponse.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch available voices'
      });
    }

    res.status(200).json({
      success: true,
      data: voicesResponse.voices
    });

  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch voices'
    });
  }
};

// @desc    Convert text to speech
// @route   POST /api/voice-agent/text-to-speech
// @access  Private
exports.textToSpeech = async (req, res) => {
  try {
    const { text, voiceId, speed, pitch } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required'
      });
    }

    const response = await murfAIService.textToSpeech(text, {
      voiceId,
      speed,
      pitch
    });

    if (!response.success) {
      return res.status(500).json({
        success: false,
        message: response.error || 'Failed to generate speech'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        audioUrl: response.audioUrl,
        duration: response.duration,
        text: response.text
      }
    });

  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to convert text to speech'
    });
  }
};

// @desc    Get user's conversation history (placeholder for future enhancement)
// @route   GET /api/voice-agent/history
// @access  Private
exports.getConversationHistory = async (req, res) => {
  try {
    // This can be enhanced to store and retrieve actual conversation history
    res.status(200).json({
      success: true,
      data: {
        conversations: [],
        message: 'Conversation history feature coming soon'
      }
    });

  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch conversation history'
    });
  }
};

module.exports = exports;
