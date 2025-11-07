/**
 * Order Out for Delivery Email Template
 * Sent when order is out for delivery
 */

const getOrderOutForDeliveryTemplate = (customerName, orderData) => {
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
        .status-badge { display: inline-block; background: #fef3c7; color: #92400e; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin: 20px 0; }
        .greeting { font-size: 18px; color: #2d3748; margin-bottom: 20px; font-weight: 500; }
        .message { font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px; }
        .order-number { font-size: 20px; color: #0a6049; font-weight: 600; margin: 20px 0; text-align: center; }
        .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 20px; border-radius: 8px; margin: 25px 0; }
        .alert-text { color: #78350f; font-size: 15px; font-weight: 500; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
        .info-label { color: #718096; font-size: 14px; }
        .info-value { color: #2d3748; font-weight: 500; font-size: 14px; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Out for Delivery!</h1>
          <p>Your order will arrive today</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${customerName},</div>
          <center><span class="status-badge">OUT FOR DELIVERY</span></center>
          <div class="order-number">Order #${orderData.orderNumber}</div>
          <div class="alert-box">
            <div class="alert-text">Your order is out for delivery today! Please keep your phone handy.</div>
          </div>
          <div class="info-box">
            <div class="info-row">
              <span class="info-label">Expected By</span>
              <span class="info-value">${orderData.expectedTime || 'End of day'}</span>
            </div>
            ${orderData.deliveryPartner ? `
            <div class="info-row">
              <span class="info-label">Delivery Partner</span>
              <span class="info-value">${orderData.deliveryPartner}</span>
            </div>
            ` : ''}
            <div class="info-row">
              <span class="info-label">Delivery Address</span>
              <span class="info-value">${orderData.shippingAddress}</span>
            </div>
          </div>
          <div class="message">
            Our delivery partner may call you for delivery confirmation. Please ensure someone is available to receive the order.
          </div>
          <center><a href="zennara://orders/${orderData.orderNumber}" class="cta-button">Track Order</a></center>
        </div>
        <div class="footer">
          <div class="footer-text"><strong>Zennara Clinic</strong><br>Your Wellness Partner</div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getOrderOutForDeliveryTemplate;
