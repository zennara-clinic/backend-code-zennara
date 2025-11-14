const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const voiceAgentController = require('../controllers/voiceAgentController');

// All routes require authentication
router.use(protect);

/**
 * @route   POST /api/voice-agent/session/start
 * @desc    Start a new voice conversation session
 * @access  Private
 */
router.post('/session/start', voiceAgentController.startSession);

/**
 * @route   POST /api/voice-agent/session/end
 * @desc    End a voice conversation session
 * @access  Private
 */
router.post('/session/end', voiceAgentController.endSession);

/**
 * @route   POST /api/voice-agent/query
 * @desc    Process a voice or text query and get response
 * @access  Private
 */
router.post('/query', voiceAgentController.processQuery);

/**
 * @route   POST /api/voice-agent/stream
 * @desc    Stream voice response in real-time
 * @access  Private
 */
router.post('/stream', voiceAgentController.streamResponse);

/**
 * @route   GET /api/voice-agent/history
 * @desc    Get conversation history
 * @access  Private
 */
router.get('/history', voiceAgentController.getHistory);

/**
 * @route   GET /api/voice-agent/voices
 * @desc    Get available voice options
 * @access  Private
 */
router.get('/voices', voiceAgentController.getVoices);

/**
 * @route   PUT /api/voice-agent/settings
 * @desc    Update voice settings for session
 * @access  Private
 */
router.put('/settings', voiceAgentController.updateVoiceSettings);

/**
 * @route   GET /api/voice-agent/account-summary
 * @desc    Get quick account summary for voice agent
 * @access  Private
 */
router.get('/account-summary', voiceAgentController.getAccountSummary);

module.exports = router;
