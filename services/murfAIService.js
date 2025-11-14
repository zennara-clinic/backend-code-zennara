const axios = require('axios');

/**
 * Murf AI Service for Text-to-Speech
 * Converts text responses to natural-sounding voice
 */
class MurfAIService {
  constructor() {
    this.apiKey = process.env.MURF_AI_API_KEY;
    this.baseUrl = 'https://api.murf.ai/v1';
    
    if (!this.apiKey) {
      console.error('Murf AI API key not found in environment variables');
    }
  }

  /**
   * Generate speech from text using Murf AI
   * @param {string} text - Text to convert to speech
   * @param {object} options - Voice options
   * @returns {Promise<object>} Audio URL and metadata
   */
  async textToSpeech(text, options = {}) {
    try {
      if (!this.apiKey) {
        throw new Error('Murf AI API key not configured');
      }

      const {
        voiceId = 'en-IN-male-1', // Indian English male voice
        speed = 1.0,
        pitch = 1.0,
        format = 'mp3'
      } = options;

      const response = await axios.post(
        `${this.baseUrl}/speech`,
        {
          text: text,
          voiceId: voiceId,
          audioFormat: format,
          speed: speed,
          pitch: pitch,
          sampleRate: 24000
        },
        {
          headers: {
            'api-key': this.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      return {
        success: true,
        audioUrl: response.data.audioFile,
        duration: response.data.audioDuration,
        text: text
      };

    } catch (error) {
      console.error('Murf AI TTS Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get available voices from Murf AI
   */
  async getAvailableVoices() {
    try {
      if (!this.apiKey) {
        throw new Error('Murf AI API key not configured');
      }

      const response = await axios.get(`${this.baseUrl}/voices`, {
        headers: {
          'api-key': this.apiKey
        }
      });

      return {
        success: true,
        voices: response.data.voices
      };

    } catch (error) {
      console.error('Error fetching Murf voices:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new MurfAIService();
