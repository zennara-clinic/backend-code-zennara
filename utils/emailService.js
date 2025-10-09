const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const getOTPEmailTemplate = require('../Email Templates/otpEmailTemplate');
const getWelcomeEmailTemplate = require('../Email Templates/welcomeEmailTemplate');

// Create AWS SES client
const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function to send email via AWS SES
const sendEmail = async (to, subject, htmlContent) => {
  const params = {
    Source: `${process.env.FROM_NAME} <${process.env.FROM_EMAIL}>`,
    Destination: {
      ToAddresses: [to],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: htmlContent,
          Charset: 'UTF-8',
        },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    const response = await sesClient.send(command);
    return response;
  } catch (error) {
    console.error('AWS SES Error:', error);
    throw error;
  }
};

// Send OTP Email
exports.sendOTPEmail = async (email, fullName, otp) => {
  try {
    const htmlContent = getOTPEmailTemplate(fullName, otp);
    
    const response = await sendEmail(email, 'Your Zennara Verification Code', htmlContent);
    console.log('✅ OTP email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};


// Send Welcome Email
exports.sendWelcomeEmail = async (email, fullName) => {
  try {
    const htmlContent = getWelcomeEmailTemplate(fullName);
    
    const response = await sendEmail(email, 'Welcome to Zennara!', htmlContent);
    console.log('✅ Welcome email sent successfully');
    return response;
  } catch (error) {
    console.error('❌ Email sending failed');
    throw error;
  }
};

