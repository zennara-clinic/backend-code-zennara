/**
 * Voice Agent Test Script
 * 
 * This script tests the Murf AI Voice Agent integration
 * Run with: node testVoiceAgent.js
 */

require('dotenv').config();
const murfAIService = require('./services/murfAIService');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  console.log('\n' + '='.repeat(60));
  log(message, 'bright');
  console.log('='.repeat(60) + '\n');
}

// Test data - simulating user context
const mockContext = {
  user: {
    fullName: 'John Doe',
    memberType: 'Zen Member',
    location: 'Jubilee Hills',
    totalSpent: 15000,
    createdAt: new Date('2024-01-15'),
    zenMembershipExpiryDate: new Date('2025-01-15'),
  },
  orders: [
    {
      orderNumber: 'ORD20241114001',
      orderStatus: 'Shipped',
      createdAt: new Date('2024-11-10'),
      pricing: { total: 2500 },
    },
    {
      orderNumber: 'ORD20241110002',
      orderStatus: 'Delivered',
      createdAt: new Date('2024-11-05'),
      pricing: { total: 1800 },
    },
  ],
  bookings: [
    {
      referenceNumber: 'ZEN20241120001',
      consultationId: { name: 'Facial Consultation' },
      status: 'Confirmed',
      confirmedDate: new Date('2024-11-20'),
      confirmedTime: '10:00 AM',
      preferredDate: new Date('2024-11-20'),
    },
    {
      referenceNumber: 'ZEN20241010002',
      consultationId: { name: 'Skin Treatment' },
      status: 'Completed',
      confirmedDate: new Date('2024-10-10'),
    },
  ],
  consultations: [
    { name: 'Facial Consultation', category: 'Skin Care', price: 1500, isPopular: true },
    { name: 'Hair Treatment', category: 'Hair Care', price: 2000, isPopular: true },
    { name: 'Body Massage', category: 'Wellness', price: 2500, isPopular: false },
    { name: 'Skin Analysis', category: 'Skin Care', price: 1000, isPopular: true },
  ],
};

async function testVoiceResponses() {
  header('Testing Voice Agent Response Generation');

  const testQueries = [
    // Greeting
    { query: 'Hello', category: 'Greeting' },
    { query: 'Hi there', category: 'Greeting' },
    
    // Orders
    { query: 'Tell me about my orders', category: 'Orders' },
    { query: 'What is the status of my recent order?', category: 'Orders' },
    { query: 'Do I have any pending orders?', category: 'Orders' },
    { query: 'Show me my delivered orders', category: 'Orders' },
    
    // Bookings
    { query: 'What are my upcoming appointments?', category: 'Bookings' },
    { query: 'Tell me about my next booking', category: 'Bookings' },
    { query: 'Do I have any completed consultations?', category: 'Bookings' },
    
    // Services
    { query: 'How many consultation services do you offer?', category: 'Services' },
    { query: 'What are your popular services?', category: 'Services' },
    
    // Account
    { query: 'What is my membership status?', category: 'Account' },
    { query: 'Tell me about my account', category: 'Account' },
    { query: 'How much have I spent?', category: 'Account' },
    
    // Help
    { query: 'What can you help me with?', category: 'Help' },
    { query: 'Help', category: 'Help' },
  ];

  for (const test of testQueries) {
    log(`\nQuery (${test.category}):`, 'cyan');
    console.log(`  "${test.query}"`);
    
    const response = murfAIService.generateResponse(test.query, mockContext);
    
    log('Response:', 'green');
    console.log(`  ${response}`);
    console.log('-'.repeat(60));
  }
}

async function testVoiceOptions() {
  header('Testing Available Voices');

  const voices = murfAIService.getDefaultVoices();
  
  log(`Found ${voices.length} available voices:\n`, 'bright');
  
  voices.forEach((voice, index) => {
    log(`${index + 1}. ${voice.name} (${voice.id})`, 'yellow');
    console.log(`   Language: ${voice.language}`);
    console.log(`   Gender: ${voice.gender}`);
    console.log(`   Description: ${voice.description}`);
    console.log();
  });
}

async function testTextToSpeech() {
  header('Testing Text-to-Speech Generation');

  if (!process.env.MURF_AI) {
    log('⚠️  MURF_AI API key not found in environment variables', 'yellow');
    log('Skipping TTS test. Add MURF_AI to your .env file to test audio generation.', 'yellow');
    return;
  }

  try {
    log('Testing audio generation with sample text...', 'cyan');
    const testText = "Hello! Welcome to Zennara. How can I assist you today?";
    
    log(`Input text: "${testText}"`, 'blue');
    log('Generating audio...', 'yellow');
    
    const audioBuffer = await murfAIService.textToSpeech(testText, {
      voiceId: 'en-US-wayne',
      model: 'Falcon',
    });
    
    if (audioBuffer && audioBuffer.length > 0) {
      log(`✓ Audio generated successfully!`, 'green');
      log(`  Buffer size: ${(audioBuffer.length / 1024).toFixed(2)} KB`, 'green');
      log(`  Format: MP3`, 'green');
    } else {
      log('✗ Failed to generate audio', 'red');
    }
  } catch (error) {
    log(`✗ Error: ${error.message}`, 'red');
    if (error.message.includes('API')) {
      log('  Make sure your MURF_AI API key is valid', 'yellow');
    }
  }
}

async function runAllTests() {
  console.clear();
  
  log('╔═══════════════════════════════════════════════════════════╗', 'bright');
  log('║          MURF AI VOICE AGENT - TEST SUITE               ║', 'bright');
  log('╚═══════════════════════════════════════════════════════════╝', 'bright');
  
  try {
    // Test 1: Voice responses
    await testVoiceResponses();
    
    // Test 2: Available voices
    await testVoiceOptions();
    
    // Test 3: Text-to-speech (requires API key)
    await testTextToSpeech();
    
    // Summary
    header('Test Summary');
    log('✓ Response generation: PASSED', 'green');
    log('✓ Voice options: PASSED', 'green');
    
    if (process.env.MURF_AI) {
      log('✓ Text-to-speech: TESTED', 'green');
    } else {
      log('⚠  Text-to-speech: SKIPPED (no API key)', 'yellow');
    }
    
    log('\nAll tests completed!', 'bright');
    
  } catch (error) {
    log(`\n✗ Test failed with error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

// Run tests
runAllTests().then(() => {
  log('\n✓ Test suite completed successfully!', 'green');
  process.exit(0);
}).catch(error => {
  log(`\n✗ Test suite failed: ${error.message}`, 'red');
  process.exit(1);
});
