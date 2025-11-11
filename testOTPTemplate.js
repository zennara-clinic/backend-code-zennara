/**
 * Test OTP Template Sending
 * Tests the approved WhatsApp OTP template
 * 
 * Usage: node testOTPTemplate.js YOUR_PHONE_NUMBER
 * Example: node testOTPTemplate.js 9876543210
 */

require('dotenv').config();
const whatsappService = require('./services/whatsappService');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testOTPTemplate() {
  try {
    // Get phone number from command line
    const phoneNumber = process.argv[2];
    
    if (!phoneNumber) {
      log('\nERROR: Please provide a phone number', 'red');
      log('Usage: node testOTPTemplate.js YOUR_PHONE_NUMBER', 'yellow');
      log('Example: node testOTPTemplate.js 9876543210', 'yellow');
      process.exit(1);
    }

    log('\n' + '='.repeat(60), 'cyan');
    log('TESTING WHATSAPP OTP TEMPLATE', 'bright');
    log('='.repeat(60), 'cyan');

    // Check environment variables
    log('\nStep 1: Checking Configuration...', 'yellow');
    
    if (!process.env.WHATSAPP_OTP_TEMPLATE_SID) {
      log('ERROR: WHATSAPP_OTP_TEMPLATE_SID not found in .env', 'red');
      log('Please add: WHATSAPP_OTP_TEMPLATE_SID=HXb5f1fdff12f388440516a86e93f8894f', 'yellow');
      process.exit(1);
    }

    if (process.env.WHATSAPP_OTP_TEMPLATE_SID.includes('xxx')) {
      log('ERROR: WHATSAPP_OTP_TEMPLATE_SID contains placeholder value', 'red');
      log('Please set it to: HXb5f1fdff12f388440516a86e93f8894f', 'yellow');
      process.exit(1);
    }

    log('Template SID configured:', 'green');
    log(`   ${process.env.WHATSAPP_OTP_TEMPLATE_SID}`, 'blue');

    // Check Twilio credentials
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      log('ERROR: Twilio credentials not found', 'red');
      process.exit(1);
    }

    log('Twilio credentials found', 'green');

    // Generate test OTP (4-digit, same as User model)
    const testOTP = Math.floor(1000 + Math.random() * 9000).toString();
    
    log('\nStep 2: Sending OTP Template...', 'yellow');
    log(`   Phone: ${phoneNumber}`, 'blue');
    log(`   Test OTP: ${testOTP}`, 'blue');
    log(`   Template: zennara_otp_v2`, 'blue');

    // Send OTP
    const result = await whatsappService.sendOTP(phoneNumber, testOTP, 5);

    log('\nStep 3: Results...', 'yellow');
    
    if (result.success) {
      log('\nSUCCESS! OTP template sent successfully!', 'green');
      log(`   Message SID: ${result.messageSid}`, 'blue');
      log(`   Status: ${result.status}`, 'blue');
      log('\nCheck your WhatsApp for the OTP message!', 'cyan');
      log('The message should say:', 'cyan');
      log(`   "${testOTP} is your verification code for your security do not share this code"`, 'blue');
    } else {
      log('\nFAILED to send OTP template', 'red');
      log(`   Error: ${result.error}`, 'red');
      log(`   Error Code: ${result.code}`, 'red');
      
      log('\nPossible Issues:', 'yellow');
      log('   1. Phone number format incorrect', 'blue');
      log('   2. WhatsApp Business Account not verified', 'blue');
      log('   3. Template SID incorrect', 'blue');
      log('   4. Twilio account has restrictions', 'blue');
      log('   5. Phone number not registered with WhatsApp', 'blue');
      
      log('\nDebugging Steps:', 'yellow');
      log('   1. Check Twilio console: https://console.twilio.com/us1/monitor/logs/messages', 'blue');
      log('   2. Verify template is approved in Twilio', 'blue');
      log('   3. Make sure phone has WhatsApp installed', 'blue');
      log('   4. Try with a different phone number', 'blue');
    }

    log('\n' + '='.repeat(60), 'cyan');

  } catch (error) {
    log('\nUNEXPECTED ERROR', 'red');
    log(`Error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

// Run test
testOTPTemplate()
  .then(() => {
    log('\nTest completed!', 'green');
    process.exit(0);
  })
  .catch((error) => {
    log('\nTest failed!', 'red');
    console.error(error);
    process.exit(1);
  });
