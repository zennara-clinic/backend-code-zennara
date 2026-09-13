/**
 * Order Collected Email Template
 * Sent when a store-pickup order has been handed to the guest at the centre.
 */

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const getOrderCollectedTemplate = (customerName, orderData) => {
  const centre = escape(orderData.centreName || 'our centre');
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Poppins', sans-serif; background-color: #f5f5f5; padding: 20px; }
        .email-wrapper { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
        .header { background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); padding: 40px 30px; text-align: center; }
        .header h1 { color: #ffffff; font-size: 28px; font-weight: 600; margin-bottom: 10px; }
        .header p { color: #ffffff; font-size: 16px; opacity: 0.95; }
        .content { padding: 40px 30px; }
        .status-badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin: 20px 0; }
        .greeting { font-size: 18px; color: #2d3748; margin-bottom: 20px; font-weight: 500; }
        .message { font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px; }
        .order-number { font-size: 20px; color: #0a6049; font-weight: 600; margin: 20px 0; text-align: center; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Collected</h1>
          <p>Thank you for visiting ${centre}</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${escape(customerName)},</div>
          <center><span class="status-badge">COLLECTED</span></center>
          <div class="order-number">Order #${escape(orderData.orderNumber)}</div>
          <div class="message">
            Your order was collected at ${centre} on ${escape(orderData.collectedAt || '')}. We hope the products serve you well.
          </div>
          <div class="info-box">
            <p style="font-size: 15px; color: #2d3748; line-height: 1.7;">If anything is not right with what you received, you can request a return from the order in the Zennara App within 7 days.</p>
          </div>
          <center><a href="zennara://orders/${escape(orderData.orderNumber)}" class="cta-button">View order</a></center>
        </div>
        <div class="footer">
          <div class="footer-text"><strong>Zennara Clinic</strong><br>Your Wellness Partner</div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getOrderCollectedTemplate;
