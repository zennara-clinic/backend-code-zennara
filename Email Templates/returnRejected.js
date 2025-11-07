/**
 * Return Rejected Email Template
 * Sent when return request is rejected
 */

const getReturnRejectedTemplate = (customerName, orderData) => {
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
        .header { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px 30px; text-align: center; }
        .header h1 { color: #ffffff; font-size: 28px; font-weight: 600; margin-bottom: 10px; }
        .header p { color: #ffffff; font-size: 16px; opacity: 0.95; }
        .content { padding: 40px 30px; }
        .status-badge { display: inline-block; background: #fee2e2; color: #991b1b; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin: 20px 0; }
        .greeting { font-size: 18px; color: #2d3748; margin-bottom: 20px; font-weight: 500; }
        .message { font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px; }
        .order-number { font-size: 20px; color: #dc2626; font-weight: 600; margin: 20px 0; text-align: center; }
        .rejection-box { background: #fee2e2; border-left: 4px solid #ef4444; padding: 20px; border-radius: 8px; margin: 25px 0; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Return Request Update</h1>
          <p>Regarding your return request</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${customerName},</div>
          <center><span class="status-badge">RETURN DECLINED</span></center>
          <div class="order-number">Order #${orderData.orderNumber}</div>
          <div class="message">
            We've carefully reviewed your return request. Unfortunately, we're unable to process this return at this time.
          </div>
          <div class="rejection-box">
            <p style="color: #991b1b; font-weight: 600; margin-bottom: 8px;">Reason for Rejection:</p>
            <p style="color: #7f1d1d; font-size: 14px; line-height: 1.6;">
              ${orderData.rejectionReason}
            </p>
          </div>
          <div class="info-box">
            <p style="font-weight: 600; color: #2d3748; margin-bottom: 15px;">Common reasons for return rejection:</p>
            <ul style="padding-left: 20px; color: #4a5568; line-height: 1.8; font-size: 14px;">
              <li>Return window has expired (7 days from delivery)</li>
              <li>Product has been used or damaged</li>
              <li>Original packaging is not available</li>
              <li>Missing accessories or tags</li>
              <li>Product category not eligible for returns</li>
            </ul>
          </div>
          <div class="message">
            If you have questions or believe there's been a mistake, please contact our support team through the Zennara App. We're here to help!
          </div>
          <center>
            <a href="zennara://support" class="cta-button">Contact Support</a>
          </center>
        </div>
        <div class="footer">
          <div class="footer-text">
            <strong>Zennara Clinic</strong><br>
            Your Wellness Partner<br><br>
            Thank you for understanding
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getReturnRejectedTemplate;
