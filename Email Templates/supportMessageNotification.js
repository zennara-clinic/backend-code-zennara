/**
 * Support Message Notification Email Template
 * Sent to admin when a new support message is received
 */

const getSupportMessageNotificationTemplate = (messageData) => {
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
          background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
          padding: 40px 30px;
          text-align: center;
        }
        .header-icon {
          font-size: 48px;
          margin-bottom: 10px;
        }
        .header-title {
          font-size: 28px;
          color: #ffffff;
          font-weight: 700;
          margin-bottom: 8px;
        }
        .header-subtitle {
          font-size: 14px;
          color: rgba(255, 255, 255, 0.9);
          font-weight: 400;
        }
        .content {
          padding: 40px 30px;
        }
        .title {
          font-size: 22px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 20px;
        }
        .intro-text {
          font-size: 15px;
          color: #4b5563;
          line-height: 1.6;
          margin-bottom: 24px;
        }
        .ticket-details {
          background: #fef3c7;
          border-left: 4px solid #f59e0b;
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
          color: #92400e;
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
        .customer-details {
          line-height: 1.8;
        }
        .timestamp {
          font-size: 13px;
          color: #6b7280;
          margin-bottom: 24px;
          line-height: 1.5;
        }
        .cta-container {
          text-align: center;
          margin-top: 32px;
        }
        .cta-button {
          display: inline-block;
          color: #ffffff;
          text-decoration: none;
          padding: 14px 32px;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
          margin: 0 6px 12px;
        }
        .cta-button.primary {
          background-color: #20594e;
        }
        .cta-button.secondary {
          background-color: #6b7280;
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
          .header-title {
            font-size: 24px;
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
          .cta-button {
            display: block;
            margin: 0 0 12px 0;
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
          <div class="header-icon">🔔</div>
          <div class="header-title">New Support Message</div>
          <div class="header-subtitle">Zennara Support Ticket</div>
        </div>
        
        <div class="content">
          <div class="title">New Support Request</div>
          
          <p class="intro-text">
            A new support message has been received from a customer.
          </p>
          
          <div class="ticket-details">
            <div class="detail-item">
              <div class="detail-label">Ticket ID</div>
              <div class="detail-value ticket-id">#${messageData.ticketId.substring(0, 8).toUpperCase()}</div>
            </div>
            
            <div class="detail-item">
              <div class="detail-label">Customer Details</div>
              <div class="detail-value customer-details">
                <strong>${messageData.name}</strong><br/>
                📧 ${messageData.email}<br/>
                📱 ${messageData.phone}<br/>
                📍 ${messageData.location}
              </div>
            </div>
            
            <div class="detail-item">
              <div class="detail-label">Subject</div>
              <div class="detail-value" style="font-weight: 600;">${messageData.subject}</div>
            </div>
            
            <div class="detail-item">
              <div class="detail-label">Message</div>
              <div class="detail-value">${messageData.message}</div>
            </div>
          </div>
          
          <p class="timestamp">
            Received at: ${new Date(messageData.timestamp).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
          
          <div class="cta-container">
            <a href="mailto:${messageData.email}" class="cta-button primary">Reply to Customer</a>
          </div>
        </div>
        
        <div class="footer">
          <p class="footer-text">Zennara Admin Panel</p>
          <p class="footer-subtext">This is an automated notification</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getSupportMessageNotificationTemplate;
