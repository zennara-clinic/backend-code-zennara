/**
 * OTP Email Template
 * Beautiful Apple-inspired design for OTP verification emails
 */

const getOTPEmailTemplate = (fullName, otp) => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', sans-serif;
          background: linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%);
          padding: 40px 20px;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .email-wrapper {
          max-width: 600px;
          margin: 0 auto;
          background: #ffffff;
          border-radius: 24px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.08),
                      0 8px 16px rgba(0, 0, 0, 0.04);
        }
        .header {
          background: linear-gradient(135deg, #20594e 0%, #2d7461 100%);
          padding: 48px 40px 56px;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .header::before {
          content: '';
          position: absolute;
          top: -50%;
          right: -10%;
          width: 300px;
          height: 300px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 50%;
        }
        .logo {
          font-size: 36px;
          font-weight: 700;
          color: #ffffff;
          letter-spacing: -0.5px;
          margin-bottom: 12px;
          position: relative;
          z-index: 1;
        }
        .header-subtitle {
          font-size: 17px;
          color: rgba(255, 255, 255, 0.9);
          font-weight: 400;
          letter-spacing: 0.2px;
          position: relative;
          z-index: 1;
        }
        .content {
          padding: 48px 40px;
        }
        .greeting {
          font-size: 20px;
          font-weight: 600;
          color: #1d1d1f;
          margin-bottom: 16px;
          letter-spacing: -0.3px;
        }
        .message {
          font-size: 16px;
          color: #6e6e73;
          line-height: 1.6;
          margin-bottom: 32px;
        }
        .otp-section {
          background: linear-gradient(135deg, #f5f5f7 0%, #fafafa 100%);
          border-radius: 20px;
          padding: 40px;
          text-align: center;
          margin: 32px 0;
          border: 1px solid rgba(0, 0, 0, 0.04);
        }
        .otp-label {
          font-size: 13px;
          font-weight: 600;
          color: #86868b;
          text-transform: uppercase;
          letter-spacing: 1.2px;
          margin-bottom: 16px;
        }
        .otp-code {
          font-size: 56px;
          font-weight: 700;
          color: #20594e;
          letter-spacing: 16px;
          margin: 16px 0;
          font-variant-numeric: tabular-nums;
          text-align: center;
          padding-left: 16px;
        }
        .otp-validity {
          font-size: 14px;
          color: #86868b;
          margin-top: 16px;
          font-weight: 500;
        }
        .security-notice {
          background: #fff9e6;
          border-left: 4px solid #f5a623;
          border-radius: 12px;
          padding: 20px 24px;
          margin: 32px 0;
        }
        .security-notice-title {
          font-size: 15px;
          font-weight: 600;
          color: #1d1d1f;
          margin-bottom: 8px;
          display: flex;
          align-items: center;
        }
        .security-notice-icon {
          display: inline-block;
          width: 20px;
          height: 20px;
          margin-right: 8px;
          font-size: 16px;
        }
        .security-notice-text {
          font-size: 14px;
          color: #6e6e73;
          line-height: 1.5;
        }
        .footer {
          background: #fafafa;
          padding: 32px 40px;
          text-align: center;
          border-top: 1px solid #e5e5e7;
        }
        .footer-text {
          font-size: 13px;
          color: #86868b;
          line-height: 1.6;
          margin-bottom: 8px;
        }
        .footer-brand {
          font-size: 12px;
          color: #a1a1a6;
          margin-top: 16px;
        }
        @media only screen and (max-width: 600px) {
          .email-wrapper {
            border-radius: 16px;
          }
          .header {
            padding: 36px 24px 44px;
          }
          .content {
            padding: 32px 24px;
          }
          .otp-code {
            font-size: 48px;
            letter-spacing: 12px;
            padding-left: 12px;
          }
          .footer {
            padding: 24px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <div class="logo">Zennara</div>
          <div class="header-subtitle">Wellness & Healthcare</div>
        </div>
        
        <div class="content">
          <div class="greeting">Hi ${fullName},</div>
          <p class="message">
            Your one-time verification code is ready. Enter this code to complete your login to Zennara.
          </p>
          
          <div class="otp-section">
            <div class="otp-label">Verification Code</div>
            <div class="otp-code">${otp}</div>
            <div class="otp-validity">Valid for 5 minutes</div>
          </div>
          
          <div class="security-notice">
            <div class="security-notice-title">
              <span class="security-notice-icon">🔒</span>
              Keep Your Account Secure
            </div>
            <div class="security-notice-text">
              Never share this code with anyone. Zennara will never ask for your verification code via phone, email, or any other medium.
            </div>
          </div>
          
          <p class="message" style="margin-top: 24px; font-size: 14px;">
            If you didn't request this code, you can safely ignore this email. Your account remains secure.
          </p>
        </div>
        
        <div class="footer">
          <p class="footer-text">This is an automated message. Please do not reply to this email.</p>
          <p class="footer-brand">&copy; ${new Date().getFullYear()} Zennara Health. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getOTPEmailTemplate;
