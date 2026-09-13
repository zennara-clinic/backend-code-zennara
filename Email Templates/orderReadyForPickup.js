/**
 * Order Ready for Pickup Email Template
 * Sent when a store-pickup order is packed and waiting at the centre.
 */

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const getOrderReadyForPickupTemplate = (customerName, orderData) => {
  const centre = escape(orderData.centreName || 'the centre');
  const address = escape(orderData.centreAddress || '');
  const phone = escape(orderData.centrePhone || '');
  const hours = escape(orderData.centreHours || '');
  const code = escape(orderData.pickupCode || '');
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
        .code-box { background: #0a6049; color: #ffffff; border-radius: 12px; padding: 22px; margin: 25px 0; text-align: center; }
        .code-box .label { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.85; margin-bottom: 8px; }
        .code-box .code { font-size: 34px; font-weight: 700; letter-spacing: 0.25em; font-family: 'Poppins', monospace; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .info-box p { font-size: 15px; color: #2d3748; line-height: 1.7; }
        .info-box .k { color: #718096; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Ready to collect</h1>
          <p>Your order is waiting at ${centre}</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${escape(customerName)},</div>
          <center><span class="status-badge">READY FOR PICKUP</span></center>
          <div class="order-number">Order #${escape(orderData.orderNumber)}</div>
          <div class="message">
            Your order is packed and waiting for you at our ${centre} centre. Show the code below at the reception desk and we will hand it over — it is already paid for, so there is nothing more to settle.
          </div>
          <div class="code-box">
            <div class="label">Your pickup code</div>
            <div class="code">${code}</div>
          </div>
          <div class="info-box">
            <p class="k">Collect from</p>
            <p><strong>${centre}</strong>${address ? `<br>${address}` : ''}</p>
            ${hours ? `<p class="k">Opening hours</p><p>${hours}</p>` : ''}
            ${phone ? `<p class="k">Phone</p><p>${phone}</p>` : ''}
          </div>
          <div class="message">Please bring the phone number this order was placed with. If someone is collecting on your behalf, they will need the code above.</div>
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

module.exports = getOrderReadyForPickupTemplate;
