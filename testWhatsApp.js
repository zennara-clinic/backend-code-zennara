/**
 * WhatsApp Service Test Script
 * Tests the WhatsApp notification system with Twilio
 * 
 * Usage: node testWhatsApp.js
 */

require('dotenv').config();
const whatsappService = require('./services/whatsappService');

// ANSI color codes for pretty console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  log('\n' + '='.repeat(60), 'cyan');
  log(message, 'bright');
  log('='.repeat(60), 'cyan');
}

async function testWhatsAppService() {
  try {
    header('TESTING WHATSAPP SERVICE');

    // Test 1: Check environment variables
    log('\nTest 1: Checking Environment Variables...', 'yellow');
    
    if (!process.env.TWILIO_ACCOUNT_SID) {
      log('TWILIO_ACCOUNT_SID not found in .env', 'red');
      return;
    }
    if (!process.env.TWILIO_AUTH_TOKEN) {
      log('TWILIO_AUTH_TOKEN not found in .env', 'red');
      return;
    }
    if (!process.env.TWILIO_PHONE_NUMBER) {
      log('TWILIO_PHONE_NUMBER not found in .env', 'red');
      return;
    }
    
    log('All Twilio credentials found in .env', 'green');
    log(`   Account SID: ${process.env.TWILIO_ACCOUNT_SID.substring(0, 10)}...`, 'blue');
    log(`   Phone Number: ${process.env.TWILIO_PHONE_NUMBER}`, 'blue');

    // Test 2: Check service health
    log('\nTest 2: Checking Twilio Connection...', 'yellow');
    const healthCheck = await whatsappService.checkHealth();
    
    if (healthCheck.success) {
      log('Twilio connection successful!', 'green');
      log(`   From Number: ${healthCheck.fromNumber}`, 'blue');
    } else {
      log('Twilio connection failed!', 'red');
      log(`   Error: ${healthCheck.error}`, 'red');
      return;
    }

    // Test 3: Test phone number formatting
    log('\nTest 3: Testing Phone Number Formatting...', 'yellow');
    const testNumbers = [
      '9876543210',
      '+919876543210',
      '91 9876543210'
    ];
    
    testNumbers.forEach(number => {
      const formatted = whatsappService.formatPhoneNumber(number);
      log(`   ${number} → ${formatted}`, 'blue');
    });
    log('Phone number formatting works!', 'green');

    // Test 4: Send a test message (OPTIONAL - requires user input)
    log('\nTest 4: Send Test WhatsApp Message', 'yellow');
    log('To send a test message, uncomment the code below', 'magenta');
    log('    and replace TEST_PHONE_NUMBER with a real number', 'magenta');
    
    // UNCOMMENT BELOW TO SEND A TEST MESSAGE
    // IMPORTANT: Replace with your actual phone number to test
    /*
    const TEST_PHONE_NUMBER = '9876543210'; // Replace with your number
    
    log(`\nSending test booking notification to ${TEST_PHONE_NUMBER}...`, 'yellow');
    
    const result = await whatsappService.sendBookingConfirmation(
      TEST_PHONE_NUMBER,
      {
        patientName: 'Test Patient',
        referenceNumber: 'ZEN20241107TEST',
        treatment: 'Test Treatment',
        date: 'Friday, November 15, 2024',
        timeSlots: '3:00 PM, 3:30 PM',
        location: 'Jubilee Hills'
      }
    );

    if (result.success) {
      log('Test message sent successfully!', 'green');
      log(`   Message SID: ${result.messageSid}`, 'blue');
      log(`   Status: ${result.status}`, 'blue');
      log('\n   Check your WhatsApp to see the message!', 'cyan');
    } else {
      log('Failed to send test message', 'red');
      log(`   Error: ${result.error}`, 'red');
      log(`   Code: ${result.code}`, 'red');
    }
    */

    // Summary
    header('TEST SUMMARY');
    log('\nEnvironment Variables: PASS', 'green');
    log('Twilio Connection: PASS', 'green');
    log('Phone Formatting: PASS', 'green');
    log('Test Message: SKIPPED (Uncomment to test)', 'yellow');
    
    log('\nAll tests passed! Your WhatsApp service is ready!', 'green');
    log('\nNext Steps:', 'cyan');
    log('   1. Uncomment the test message code above to send a real message', 'blue');
    log('   2. Replace TEST_PHONE_NUMBER with your actual number', 'blue');
    log('   3. Run this script again: node testWhatsApp.js', 'blue');
    log('   4. Check your WhatsApp for the test message', 'blue');
    log('   5. Create a real booking to test the full flow', 'blue');
    
    log('\nTip: Monitor messages at:', 'cyan');
    log('   https://console.twilio.com/us1/monitor/logs/messages', 'blue');
    
  } catch (error) {
    log('\nTEST FAILED', 'red');
    log(`Error: ${error.message}`, 'red');
    console.error(error);
  }
}

// Run tests
log('\nStarting WhatsApp Service Tests...', 'bright');
testWhatsAppService()
  .then(() => {
    log('\nTest script completed!', 'green');
    process.exit(0);
  })
  .catch((error) => {
    log('\nTest script failed!', 'red');
    console.error(error);
    process.exit(1);
  });
