const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const voiceAgentController = require('../controllers/voiceAgentController');

// All routes require authentication
router.use(protect);

// @route   POST /api/voice-agent/query
// @desc    Process user voice query
// @access  Private
router.post('/query', voiceAgentController.processVoiceQuery);

// @route   GET /api/voice-agent/suggestions
// @desc    Get conversation suggestions
// @access  Private
router.get('/suggestions', voiceAgentController.getConversationSuggestions);

// @route   GET /api/voice-agent/voices
// @desc    Get available Murf AI voices
// @access  Private
router.get('/voices', voiceAgentController.getAvailableVoices);

// @route   POST /api/voice-agent/text-to-speech
// @desc    Convert text to speech
// @access  Private
router.post('/text-to-speech', voiceAgentController.textToSpeech);

// @route   GET /api/voice-agent/history
// @desc    Get conversation history
// @access  Private
router.get('/history', voiceAgentController.getConversationHistory);

module.exports = router;
