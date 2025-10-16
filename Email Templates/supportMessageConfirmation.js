/**
 * Support Message Confirmation Email Template
 * Sent to user after submitting a support message
 */

const getSupportMessageConfirmationTemplate = (name, messageData) => {
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
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #20594e 0%, #2d7a69 100%);
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
          letter-spacing: 0.3px;
        }
        .content {
          padding: 40px 30px;
        }
        .title {
          font-size: 24px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 20px;
        }
        .greeting {
          font-size: 15px;
          color: #4b5563;
          margin-bottom: 16px;
          line-height: 1.6;
        }
        .message {
          font-size: 15px;
          color: #4b5563;
          line-height: 1.6;
          margin-bottom: 24px;
        }
        .ticket-details {
          background: #f9fafb;
          border-left: 4px solid #20594e;
          border-radius: 8px;
          padding: 20px;
          margin: 24px 0;
        }
        .detail-item {
          margin-bottom: 16px;
        }
        .detail-item:last-child {
          margin-bottom: 0;
        }
        .detail-label {
          font-size: 12px;
          color: #6b7280;
          text-transform: uppercase;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .detail-value {
          font-size: 15px;
          color: #1f2937;
          line-height: 1.5;
        }
        .detail-value.ticket-id {
          font-weight: 600;
        }
        .cta-container {
          text-align: center;
          margin-top: 32px;
        }
        .cta-button {
          display: inline-block;
          background-color: #20594e;
          color: #ffffff;
          text-decoration: none;
          padding: 14px 32px;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
        }
        .footer {
          background: #f9fafb;
          padding: 30px;
          text-align: center;
          border-top: 1px solid #e5e7eb;
        }
        .footer-text {
          font-size: 13px;
          color: #6b7280;
          margin-bottom: 8px;
        }
        .footer-subtext {
          font-size: 12px;
          color: #9ca3af;
        }
        @media only screen and (max-width: 600px) {
          body {
            padding: 10px;
          }
          .email-wrapper {
            border-radius: 8px;
          }
          .header {
            padding: 30px 20px;
          }
          .logo-img {
            max-width: 150px;
          }
          .content {
            padding: 30px 20px;
          }
          .title {
            font-size: 20px;
          }
          .ticket-details {
            padding: 16px;
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
          <div class="header-subtitle">Celebrity Doctors and Aestheticians</div>
        </div>
        
        <div class="content">
          <div class="title">We've Received Your Message!</div>
          
          <p class="greeting">Hi ${name},</p>
          
          <p class="message">
            Thank you for reaching out to Zennara. We've received your message and our support team will get back to you as soon as possible.
          </p>
          
          <div class="ticket-details">
            <div class="detail-item">
              <div class="detail-label">Support Ticket ID</div>
              <div class="detail-value ticket-id">#${messageData.ticketId.substring(0, 8).toUpperCase()}</div>
            </div>
            
            <div class="detail-item">
              <div class="detail-label">Subject</div>
              <div class="detail-value">${messageData.subject}</div>
            </div>
            
            <div class="detail-item">
              <div class="detail-label">Your Message</div>
              <div class="detail-value">${messageData.message}</div>
            </div>
          </div>
          
          <p class="message">
            Our team typically responds within 24 hours during business days. We will get back to you via email as soon as possible.
          </p>
        </div>
        
        <div class="footer">
          <p class="footer-text">© 2025 Zennara. All rights reserved.</p>
          <p class="footer-subtext">Celebrity Doctors and Aestheticians</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getSupportMessageConfirmationTemplate;
