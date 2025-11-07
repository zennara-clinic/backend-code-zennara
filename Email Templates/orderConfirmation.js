/**
 * Order Confirmation Email Template
 * Sent when user successfully places an order
 */

const getOrderConfirmationTemplate = (customerName, orderData) => {
  const itemsHtml = orderData.items.map(item => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
        <div style="display: flex; align-items: center;">
          <div>
            <div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${item.name}</div>
            <div style="font-size: 14px; color: #718096;">Quantity: ${item.quantity} x Rs.${item.price}</div>
          </div>
        </div>
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">
        <div style="font-weight: 600; color: #2d3748;">Rs.${item.subtotal}</div>
      </td>
    </tr>
  `).join('');

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
          background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%);
          padding: 40px 30px;
          text-align: center;
        }
        .header h1 {
          color: #ffffff;
          font-size: 28px;
          font-weight: 600;
          margin-bottom: 10px;
        }
        .header p {
          color: #ffffff;
          font-size: 16px;
          opacity: 0.95;
        }
        .content {
          padding: 40px 30px;
        }
        .greeting {
          font-size: 18px;
          color: #2d3748;
          margin-bottom: 20px;
          font-weight: 500;
        }
        .message {
          font-size: 15px;
          color: #4a5568;
          line-height: 1.7;
          margin-bottom: 30px;
        }
        .order-box {
          background: #f7fafc;
          border-radius: 8px;
          padding: 25px;
          margin: 25px 0;
        }
        .order-number {
          font-size: 20px;
          color: #0a6049;
          font-weight: 600;
          margin-bottom: 20px;
          text-align: center;
        }
        .order-details {
          margin: 20px 0;
        }
        .detail-row {
          display: flex;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid #e2e8f0;
        }
        .detail-label {
          color: #718096;
          font-size: 14px;
        }
        .detail-value {
          color: #2d3748;
          font-weight: 500;
          font-size: 14px;
        }
        .items-table {
          width: 100%;
          margin: 20px 0;
        }
        .total-section {
          margin-top: 20px;
          padding-top: 20px;
          border-top: 2px solid #e2e8f0;
        }
        .total-row {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
        }
        .total-label {
          font-size: 15px;
          color: #4a5568;
        }
        .total-value {
          font-size: 15px;
          font-weight: 600;
          color: #2d3748;
        }
        .grand-total {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 2px solid #0a6049;
        }
        .grand-total .total-label {
          font-size: 18px;
          font-weight: 600;
          color: #0a6049;
        }
        .grand-total .total-value {
          font-size: 18px;
          font-weight: 700;
          color: #0a6049;
        }
        .address-box {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 20px;
          margin: 20px 0;
        }
        .address-title {
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 10px;
          font-size: 15px;
        }
        .address-text {
          color: #4a5568;
          font-size: 14px;
          line-height: 1.6;
        }
        .cta-button {
          display: inline-block;
          background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%);
          color: #ffffff;
          text-decoration: none;
          padding: 14px 32px;
          border-radius: 8px;
          font-weight: 600;
          margin: 20px 0;
          text-align: center;
        }
        .footer {
          background: #f7fafc;
          padding: 30px;
          text-align: center;
          border-top: 1px solid #e2e8f0;
        }
        .footer-text {
          font-size: 14px;
          color: #718096;
          line-height: 1.6;
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Order Placed Successfully!</h1>
          <p>Thank you for your order</p>
        </div>
        
        <div class="content">
          <div class="greeting">Hello ${customerName},</div>
          
          <div class="message">
            Thank you for shopping with Zennara Clinic! We've received your order and it's awaiting confirmation from our team.
          </div>
          
          <div class="order-box">
            <div class="order-number">Order #${orderData.orderNumber}</div>
            
            <div class="order-details">
              <div class="detail-row">
                <span class="detail-label">Order Date</span>
                <span class="detail-value">${orderData.orderDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Payment Method</span>
                <span class="detail-value">${orderData.paymentMethod}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Order Status</span>
                <span class="detail-value" style="color: #0a6049; font-weight: 600;">Order Placed</span>
              </div>
            </div>

            <h3 style="margin-top: 25px; margin-bottom: 15px; color: #2d3748; font-size: 16px;">Order Items</h3>
            <table class="items-table">
              ${itemsHtml}
            </table>

            <div class="total-section">
              <div class="total-row">
                <span class="total-label">Subtotal</span>
                <span class="total-value">Rs.${orderData.subtotal}</span>
              </div>
              <div class="total-row">
                <span class="total-label">GST</span>
                <span class="total-value">Rs.${orderData.gst || 0}</span>
              </div>
              <div class="total-row">
                <span class="total-label">Delivery Fee</span>
                <span class="total-value">Rs.${orderData.deliveryFee}</span>
              </div>
              ${orderData.discount > 0 ? `
              <div class="total-row">
                <span class="total-label">Discount</span>
                <span class="total-value" style="color: #48bb78;">-Rs.${orderData.discount}</span>
              </div>
              ` : ''}
              <div class="total-row grand-total">
                <span class="total-label">Total Amount</span>
                <span class="total-value">Rs.${orderData.total}</span>
              </div>
            </div>
          </div>

          <div class="address-box">
            <div class="address-title">Delivery Address</div>
            <div class="address-text">${orderData.shippingAddress}</div>
          </div>

          <div class="message">
            You can track your order status in the Zennara App. We'll send you updates as your order progresses.
          </div>

          <center>
            <a href="zennara://orders/${orderData.orderNumber}" class="cta-button">Track Order in App</a>
          </center>
        </div>
        
        <div class="footer">
          <div class="footer-text">
            <strong>Need Help?</strong><br>
            Contact us through the Zennara App<br>
            <br>
            <strong>Zennara Clinic</strong><br>
            Your Wellness Partner
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getOrderConfirmationTemplate;
