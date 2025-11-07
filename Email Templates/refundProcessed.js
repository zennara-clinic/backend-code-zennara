/**
 * Refund Processed Email Template
 * Sent when refund is initiated
 */

const getRefundProcessedTemplate = (customerName, orderData) => {
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
        .refund-amount { font-size: 32px; color: #10b981; font-weight: 700; text-align: center; margin: 30px 0; }
        .success-box { background: #d1fae5; border-left: 4px solid #10b981; padding: 20px; border-radius: 8px; margin: 25px 0; text-align: center; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
        .info-label { color: #718096; font-size: 14px; }
        .info-value { color: #2d3748; font-weight: 500; font-size: 14px; }
        .timeline-box { background: #fff; border: 2px solid #d1fae5; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Refund Processed!</h1>
          <p>Your refund has been initiated</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${customerName},</div>
          <center><span class="status-badge">REFUND PROCESSED</span></center>
          <div class="order-number">Order #${orderData.orderNumber}</div>
          <div class="success-box">
            <p style="color: #065f46; font-weight: 600; margin-bottom: 10px;">Refund Amount</p>
            <div class="refund-amount">Rs.${orderData.refundAmount}</div>
            <p style="color: #047857; font-size: 14px; margin-top: 10px;">
              Your refund has been successfully processed!
            </p>
          </div>
          <div class="info-box">
            <div class="info-row">
              <span class="info-label">Refund Date</span>
              <span class="info-value">${orderData.refundDate}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Refund Method</span>
              <span class="info-value">${orderData.refundMethod}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Transaction ID</span>
              <span class="info-value">${orderData.transactionId || 'Will be updated soon'}</span>
            </div>
          </div>
          <div class="timeline-box">
            <p style="font-weight: 600; color: #2d3748; margin-bottom: 15px;">When will I receive my refund?</p>
            <p style="color: #4a5568; font-size: 14px; line-height: 1.8;">
              The refund amount will be credited to your account within <strong>5-7 business days</strong> from the date of processing. 
              The exact timing may vary depending on your bank or payment provider.
            </p>
          </div>
          <div class="message">
            If you don't receive the refund within 7 business days, please check with your bank or contact us through the Zennara App.
          </div>
          <div class="message" style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b;">
            <p style="color: #78350f; font-size: 14px;">
              <strong>Note:</strong> Some banks may take additional 2-3 days for the refund to reflect in your statement.
            </p>
          </div>
          <center>
            <a href="zennara://shop" class="cta-button">Continue Shopping</a>
          </center>
        </div>
        <div class="footer">
          <div class="footer-text">
            <strong>Zennara Clinic</strong><br>
            Your Wellness Partner<br><br>
            Thank you for your patience!
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getRefundProcessedTemplate;
