require('dotenv').config();
const twilioVoiceService = require('./services/twilioVoiceService');

/**
 * Test script for Twilio voice call service
 * Usage: node testVoiceCall.js
 */

async function testVoiceCall() {
  console.log('========================================');
  console.log('Testing Twilio Voice Call Service');
  console.log('========================================\n');

  // Test booking details
  const testBookingDetails = {
    patientName: 'Test Patient',
    referenceNumber: 'ZENN123456',
    treatment: 'Hair Restoration Consultation',
    date: 'Monday, December 25, 2024',
    timeSlots: '10:00 AM, 10:30 AM',
    branchName: 'Jubilee Hills',
    branchAddress: 'Road No 36, Jubilee Hills, Hyderabad'
  };

  // Replace with a test phone number (your own number for testing)
  const testPhoneNumber = '+918945515335'; // CHANGE THIS TO YOUR TEST NUMBER

  console.log('Test Booking Details:');
  console.log(JSON.stringify(testBookingDetails, null, 2));
  console.log('\nInitiating voice call to:', testPhoneNumber);
  console.log('========================================\n');

  try {
    const result = await twilioVoiceService.makeBookingConfirmationCall(
      testPhoneNumber,
      testBookingDetails
    );

    if (result.success) {
      console.log('✅ Voice call initiated successfully!');
      console.log('Call SID:', result.callSid);
      console.log('Status:', result.status);
      console.log('\nThe recipient should receive a call shortly.');
      
      // Wait a few seconds and check call status
      console.log('\nWaiting 10 seconds to check call status...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      const status = await twilioVoiceService.getCallStatus(result.callSid);
      if (status.success) {
        console.log('\n📞 Call Status Update:');
        console.log('Status:', status.status);
        console.log('Duration:', status.duration, 'seconds');
        console.log('Start Time:', status.startTime);
      }
    } else {
      console.error('❌ Voice call failed!');
      console.error('Error:', result.error);
    }
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    console.error(error.stack);
  }

  console.log('\n========================================');
  console.log('Test Complete');
  console.log('========================================');
}

// Run the test
testVoiceCall()
  .then(() => {
    console.log('\nTest execution completed. You can now exit.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
