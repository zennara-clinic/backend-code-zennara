/**
 * Admin OTP Email Template
 * Professional design for admin authentication
 */

const getAdminOTPEmailTemplate = (adminName, otp) => {
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
          font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          line-height: 1.6;
          color: #1F2937;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          padding: 40px 20px;
        }
        
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
        }
        
        .header {
          background: linear-gradient(135deg, #20594e 0%, #154239 100%);
          color: white;
          padding: 40px 30px;
          text-align: center;
        }
        
        .logo {
          width: 160px;
          height: auto;
          margin-bottom: 20px;
        }
        
        .header h1 {
          font-size: 28px;
          font-weight: 700;
          margin: 0;
          letter-spacing: -0.5px;
        }
        
        .header p {
          font-size: 15px;
          margin: 8px 0 0;
          opacity: 0.95;
          font-weight: 400;
        }
        
        .content {
          padding: 40px 30px;
        }
        
        .greeting {
          font-size: 18px;
          font-weight: 600;
          color: #1F2937;
          margin-bottom: 20px;
        }
        
        .message {
          font-size: 15px;
          color: #6B7280;
          margin-bottom: 30px;
          line-height: 1.8;
        }
        
        
        .otp-container {
          background: linear-gradient(135deg, #F0FDF4 0%, #DCFCE7 100%);
          border: 3px dashed #10B981;
          border-radius: 16px;
          padding: 30px;
          text-align: center;
          margin: 30px 0;
        }
        
        .otp-label {
          font-size: 13px;
          font-weight: 600;
          color: #065F46;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          margin-bottom: 12px;
        }
        
        .otp-code {
          font-size: 42px;
          font-weight: 700;
          color: #047857;
          letter-spacing: 12px;
          font-family: 'Courier New', monospace;
          margin: 10px 0;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .otp-validity {
          font-size: 14px;
          color: #059669;
          font-weight: 500;
          margin-top: 12px;
        }
        
        .otp-validity strong {
          font-weight: 700;
        }
        
        
        
        .divider {
          height: 1px;
          background: linear-gradient(to right, transparent, #E5E7EB, transparent);
          margin: 30px 0;
        }
        
        .footer {
          background: #F9FAFB;
          padding: 30px;
          text-align: center;
          border-top: 1px solid #E5E7EB;
        }
        
        .footer p {
          font-size: 13px;
          color: #6B7280;
          margin: 8px 0;
        }
        
        .footer-links {
          margin: 20px 0;
        }
        
        .footer-links a {
          color: #20594e;
          text-decoration: none;
          font-weight: 500;
          margin: 0 15px;
          font-size: 13px;
        }
        
        .social-links {
          margin-top: 20px;
        }
        
        .social-links a {
          display: inline-block;
          margin: 0 10px;
          color: #20594e;
          text-decoration: none;
          font-size: 20px;
        }
        
        .admin-panel-link {
          display: inline-block;
          background: linear-gradient(135deg, #20594e 0%, #154239 100%);
          color: white;
          padding: 14px 32px;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 600;
          font-size: 15px;
          margin: 20px 0;
          box-shadow: 0 4px 12px rgba(32, 89, 78, 0.3);
          transition: all 0.3s ease;
        }
        
        @media (max-width: 600px) {
          body {
            padding: 20px 10px;
          }
          
          .container {
            border-radius: 16px;
          }
          
          .header {
            padding: 30px 20px;
          }
          
          .header h1 {
            font-size: 24px;
          }
          
          .content {
            padding: 30px 20px;
          }
          
          .otp-code {
            font-size: 36px;
            letter-spacing: 8px;
          }
          
          .footer {
            padding: 25px 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header -->
        <div class="header">
          <img src="https://res.cloudinary.com/dimlozhrx/image/upload/v1760513399/zennara_logo_white_2_zohjug.png" alt="Zennara Logo" class="logo">
          <h1>Admin Panel Access</h1>
          <p>Secure login verification code</p>
        </div>
        
        <!-- Content -->
        <div class="content">
          <p class="greeting">Hello Admin ${adminName},</p>
          
          <p class="message">
            Please use the verification code below to complete your admin panel login.
          </p>
          
          <!-- OTP Box -->
          <div class="otp-container">
            <div class="otp-label">Your Admin OTP Code</div>
            <div class="otp-code">${otp}</div>
            <div class="otp-validity">Valid for <strong>10 minutes</strong></div>
          </div>
          <p class="message" style="font-size: 13px; color: #9CA3AF; text-align: center;">
            Secured by Zennara Authentication System
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = { getAdminOTPEmailTemplate };
