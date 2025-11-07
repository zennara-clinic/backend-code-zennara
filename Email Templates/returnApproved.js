/**
 * Return Approved Email Template
 * Sent when return request is approved
 */

const getReturnApprovedTemplate = (customerName, orderData) => {
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
        .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 40px 30px; text-align: center; }
        .header h1 { color: #ffffff; font-size: 28px; font-weight: 600; margin-bottom: 10px; }
        .header p { color: #ffffff; font-size: 16px; opacity: 0.95; }
        .content { padding: 40px 30px; }
        .status-badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin: 20px 0; }
        .greeting { font-size: 18px; color: #2d3748; margin-bottom: 20px; font-weight: 500; }
        .message { font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px; }
        .order-number { font-size: 20px; color: #059669; font-weight: 600; margin: 20px 0; text-align: center; }
        .success-box { background: #d1fae5; border-left: 4px solid #10b981; padding: 20px; border-radius: 8px; margin: 25px 0; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .instruction-box { background: #fff; border: 2px solid #10b981; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Return Approved!</h1>
          <p>Your return request has been accepted</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${customerName},</div>
          <center><span class="status-badge">RETURN APPROVED</span></center>
          <div class="order-number">Order #${orderData.orderNumber}</div>
          <div class="success-box">
            <p style="color: #065f46; font-weight: 600; margin-bottom: 8px;">Great news! Your return has been approved.</p>
            <p style="color: #047857; font-size: 14px;">
              Our logistics partner will contact you within 24-48 hours to schedule a pickup.
            </p>
          </div>
          <div class="instruction-box">
            <p style="font-weight: 600; color: #2d3748; margin-bottom: 15px;">Before Pickup - Please Ensure:</p>
            <ul style="padding-left: 20px; color: #4a5568; line-height: 2;">
              <li>Items are in original packaging</li>
              <li>All accessories and tags are included</li>
              <li>Products are unused and in resalable condition</li>
              <li>Keep the items ready for pickup</li>
            </ul>
          </div>
          <div class="info-box">
            <p style="font-weight: 600; color: #2d3748; margin-bottom: 15px;">Refund Process:</p>
            <p style="color: #4a5568; font-size: 14px; line-height: 1.8;">
              Once we receive and verify the returned items, your refund will be processed within 5-7 business days. 
              The amount will be credited to your original payment method.
            </p>
          </div>
          <div class="message">
            Track your return status in the Zennara App. Our team will keep you updated throughout the process.
          </div>
          <center>
            <a href="zennara://orders/${orderData.orderNumber}/return" class="cta-button">Track Return Status</a>
          </center>
        </div>
        <div class="footer">
          <div class="footer-text">
            <strong>Zennara Clinic</strong><br>
            Your Wellness Partner<br><br>
            Thank you for your patience
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getReturnApprovedTemplate;
