/**
 * Handover Code Email Template
 *
 * The code the guest reads out when they receive the order — at the reception
 * desk for store pickup, at the door for delivery. One template, because it is
 * one idea; only where they go and who they show it to differ.
 */

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const getHandoverCodeTemplate = (customerName, data) => {
  const pickup = data.fulfilment === 'pickup';
  const centre = escape(data.centreName || 'the centre');
  const code = escape(data.code || '');
  const heading = pickup ? 'Your pickup code' : 'Your delivery code';
  const strap = pickup ? `Show this when you collect at ${centre}` : 'Read this out to the delivery partner';
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
        .greeting { font-size: 18px; color: #2d3748; margin-bottom: 20px; font-weight: 500; }
        .message { font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px; }
        .order-number { font-size: 20px; color: #0a6049; font-weight: 600; margin: 20px 0; text-align: center; }
        .code-box { background: #0a6049; color: #ffffff; border-radius: 12px; padding: 24px; margin: 25px 0; text-align: center; }
        .code-box .label { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.85; margin-bottom: 10px; }
        .code-box .code { font-size: 36px; font-weight: 700; letter-spacing: 0.3em; }
        .info-box { background: #f7fafc; border-radius: 8px; padding: 25px; margin: 25px 0; }
        .info-box p { font-size: 15px; color: #2d3748; line-height: 1.7; }
        .info-box .k { color: #718096; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 14px; }
        .warn { border-left: 3px solid #d69e2e; background: #fffaf0; padding: 14px 16px; border-radius: 0 8px 8px 0; font-size: 14px; color: #744210; line-height: 1.6; margin: 22px 0; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 14px; color: #718096; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>${heading}</h1>
          <p>${strap}</p>
        </div>
        <div class="content">
          <div class="greeting">Hello ${escape(customerName)},</div>
          <div class="order-number">Order #${escape(data.orderNumber)}</div>
          <div class="code-box">
            <div class="label">${pickup ? 'Pickup code' : 'Delivery code'}</div>
            <div class="code">${code}</div>
          </div>
          <div class="message">
            ${pickup
              ? `Keep this code safe. When your order is ready we will message you again, and the reception desk at ${centre} will ask for it before handing your order over. It is already paid for, so there is nothing to settle.`
              : 'Keep this code safe. The delivery partner will ask for it before handing your order over. Your order is already paid for, so there is nothing to pay at the door.'}
          </div>
          <div class="info-box">
            ${pickup ? `
              <p class="k">Collect from</p>
              <p><strong>${centre}</strong>${data.centreAddress ? `<br>${escape(data.centreAddress)}` : ''}</p>
              ${data.centreHours ? `<p class="k">Opening hours</p><p>${escape(data.centreHours)}</p>` : ''}
              ${data.centrePhone ? `<p class="k">Phone</p><p>${escape(data.centrePhone)}</p>` : ''}
            ` : `
              <p class="k">Delivering to</p>
              <p>${escape(data.deliveryAddress || 'your saved address')}</p>
              ${data.deliveryPartner ? `<p class="k">Delivery partner</p><p>${escape(data.deliveryPartner)}</p>` : ''}
              ${data.trackingId ? `<p class="k">Tracking</p><p>${escape(data.trackingId)}</p>` : ''}
            `}
          </div>
          <div class="warn">
            Share this code only with ${escape(data.showTo)} at the moment you receive your order. Nobody from Zennara will ask you for it over the phone.
          </div>
          <center><a href="zennara://orders/${escape(data.orderNumber)}" class="cta-button">View order</a></center>
        </div>
        <div class="footer">
          <div class="footer-text"><strong>Zennara Clinic</strong><br>Your Wellness Partner</div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getHandoverCodeTemplate;
