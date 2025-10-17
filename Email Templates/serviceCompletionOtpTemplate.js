/**
 * Service Completion OTP Email Template
 * Clean, modern design for package service completion verification
 */

const getServiceCompletionOTPTemplate = (fullName, otp, serviceName, packageName) => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: 'Poppins', sans-serif;
          background-color: #f5f5f5;
          padding: 20px;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .email-wrapper {
          max-width: 600px;
          margin: 0 auto;
          background: #ffffff;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%);
          padding: 40px 30px;
          text-align: center;
        }
        .logo-img {
          max-width: 200px;
          height: auto;
          margin: 0 auto 15px;
          display: block;
        }
        .header-subtitle {
          font-size: 16px;
          color: #ffffff;
          font-weight: 400;
          letter-spacing: 0.5px;
        }
        .content {
          padding: 40px 30px;
        }
        .greeting {
          font-size: 24px;
          font-weight: 600;
          color: #0a6049;
          margin-bottom: 20px;
        }
        .message {
          font-size: 15px;
          color: #555555;
          line-height: 1.7;
          margin-bottom: 25px;
        }
        .service-info {
          background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
          border-left: 4px solid #47d77d;
          padding: 20px 25px;
          margin: 25px 0;
          border-radius: 10px;
        }
        .service-label {
          font-size: 12px;
          font-weight: 600;
          color: #0a6049;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 5px;
        }
        .service-name {
          font-size: 18px;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 10px;
        }
        .package-label {
          font-size: 11px;
          color: #666666;
          margin-top: 8px;
        }
        .package-name {
          font-size: 14px;
          font-weight: 600;
          color: #0a6049;
        }
        .otp-section {
          background: #ffffff;
          border: 2px dashed #47d77d;
          border-radius: 16px;
          padding: 40px 30px;
          text-align: center;
          margin: 30px 0;
          box-shadow: 0 2px 8px rgba(71, 215, 125, 0.1);
        }
        .otp-label {
          font-size: 14px;
          font-weight: 600;
          color: #0a6049;
          margin-bottom: 20px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .otp-code {
          font-size: 52px;
          font-weight: 700;
          color: #0a6049;
          letter-spacing: 16px;
          margin: 20px 0;
          font-family: 'Poppins', sans-serif;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }
        .otp-validity {
          font-size: 13px;
          color: #666666;
          margin-top: 15px;
          font-style: italic;
        }
        .footer {
          background: #f9fafb;
          padding: 30px;
          text-align: center;
          border-top: 1px solid #e5e7eb;
        }
        .footer-text {
          font-size: 13px;
          color: #9ca3af;
          line-height: 1.8;
        }
        .contact-info {
          margin-top: 15px;
          font-size: 12px;
          color: #6b7280;
        }
        .signature {
          margin-top: 20px;
          font-size: 14px;
          font-weight: 600;
          color: #0a6049;
        }
        @media only screen and (max-width: 600px) {
          body {
            padding: 10px;
          }
          .email-wrapper {
            border-radius: 12px;
          }
          .header {
            padding: 30px 20px;
          }
          .logo-img {
            max-width: 160px;
          }
          .content {
            padding: 30px 20px;
          }
          .greeting {
            font-size: 22px;
          }
          .message {
            font-size: 14px;
          }
          .service-info {
            padding: 15px 20px;
          }
          .service-name {
            font-size: 16px;
          }
          .otp-section {
            padding: 30px 20px;
          }
          .otp-code {
            font-size: 40px;
            letter-spacing: 12px;
          }
          .footer {
            padding: 25px 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <img src="https://res.cloudinary.com/dimlozhrx/image/upload/v1760513399/zennara_logo_white_2_zohjug.png" alt="Zennara Logo" class="logo-img">
          <div class="header-subtitle">Service Completion Verification</div>
        </div>
        
        <div class="content">
          <div class="greeting">Hello ${fullName}!</div>
          <p class="message">
            Your service is about to be marked as completed. Please use the verification code below to confirm the service completion.
          </p>
          
          <div class="service-info">
            <div class="service-label">Service Being Completed</div>
            <div class="service-name">${serviceName}</div>
            <div class="package-label">From Package:</div>
            <div class="package-name">${packageName}</div>
          </div>

          <p class="message">
            Please share this verification code with our staff:
          </p>
          
          <div class="otp-section">
            <div class="otp-label">Your Verification Code</div>
            <div class="otp-code">${otp}</div>
            <div class="otp-validity">Valid for 5 minutes only</div>
          </div>
        </div>
        
        <div class="footer">
          <p class="footer-text">
            This is an automated notification from Zennara Clinic.<br>
            Please do not reply to this email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getServiceCompletionOTPTemplate;
