/**
 * Welcome Email Template
 * Beautiful Apple-inspired design for new user registration
 */

const getWelcomeEmailTemplate = (fullName) => {
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
          padding: 56px 40px 64px;
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
        .welcome-icon {
          font-size: 56px;
          margin-bottom: 16px;
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
        .header-title {
          font-size: 28px;
          font-weight: 600;
          color: #ffffff;
          letter-spacing: -0.5px;
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
        .features-section {
          background: linear-gradient(135deg, #f5f5f7 0%, #fafafa 100%);
          border-radius: 20px;
          padding: 32px;
          margin: 32px 0;
          border: 1px solid rgba(0, 0, 0, 0.04);
        }
        .features-title {
          font-size: 18px;
          font-weight: 600;
          color: #1d1d1f;
          margin-bottom: 20px;
          letter-spacing: -0.3px;
        }
        .feature-item {
          display: flex;
          align-items: flex-start;
          margin-bottom: 16px;
          padding: 12px;
          background: white;
          border-radius: 12px;
          transition: transform 0.2s;
        }
        .feature-item:last-child {
          margin-bottom: 0;
        }
        .feature-icon {
          font-size: 24px;
          margin-right: 12px;
          flex-shrink: 0;
        }
        .feature-text {
          font-size: 15px;
          color: #1d1d1f;
          font-weight: 500;
          line-height: 1.5;
        }
        .cta-section {
          text-align: center;
          margin: 32px 0;
          padding: 24px;
          background: linear-gradient(135deg, #20594e 0%, #2d7461 100%);
          border-radius: 16px;
        }
        .cta-text {
          font-size: 16px;
          color: white;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .cta-subtext {
          font-size: 14px;
          color: rgba(255, 255, 255, 0.9);
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
            padding: 40px 24px 48px;
          }
          .content {
            padding: 32px 24px;
          }
          .features-section {
            padding: 24px;
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
          <div class="welcome-icon">🎉</div>
          <div class="logo">Zennara</div>
          <div class="header-title">Welcome to the Zen Family!</div>
        </div>
        
        <div class="content">
          <div class="greeting">Hi ${fullName},</div>
          <p class="message">
            Thank you for joining Zennara! We're thrilled to have you on board and excited to be part of your wellness journey.
          </p>
          
          <div class="features-section">
            <div class="features-title">Discover What You Can Do:</div>
            
            <div class="feature-item">
              <div class="feature-icon">🧘</div>
              <div class="feature-text">Book treatments and wellness sessions tailored to your needs</div>
            </div>
            
            <div class="feature-item">
              <div class="feature-icon">💊</div>
              <div class="feature-text">Order medicines and healthcare products with ease</div>
            </div>
            
            <div class="feature-item">
              <div class="feature-icon">📅</div>
              <div class="feature-text">Schedule appointments at your convenience</div>
            </div>
            
            <div class="feature-item">
              <div class="feature-icon">📊</div>
              <div class="feature-text">Track and manage your wellness journey</div>
            </div>
          </div>
          
          <div class="cta-section">
            <div class="cta-text">Ready to Get Started?</div>
            <div class="cta-subtext">Login to explore our services and book your first session</div>
          </div>
          
          <p class="message" style="margin-top: 24px; font-size: 14px; text-align: center;">
            Need help? We're here for you at <strong>support@zennara.com</strong>
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

module.exports = getWelcomeEmailTemplate;
