/**
 * Check-in Successful Email Template
 * Sent when patient checks in at clinic
 */

const getCheckInSuccessfulTemplate = (fullName, appointmentData, branch = 'Zennara Clinic') => {
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
          background: linear-gradient(135deg, #47d77d 0%, #0a6049 100%);
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
        .greeting {
          font-size: 22px;
          font-weight: 600;
          color: #0a6049;
          margin-bottom: 20px;
        }
        .message {
          font-size: 15px;
          color: #555555;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .checkin-box {
          background: #ecfdf5;
          padding: 25px;
          border-radius: 8px;
          margin: 25px 0;
          text-align: center;
        }
        .checkin-title {
          font-size: 18px;
          font-weight: 600;
          color: #047857;
          margin-bottom: 10px;
        }
        .checkin-text {
          font-size: 14px;
          color: #555555;
          line-height: 1.6;
        }
        .appointment-details {
          background: #f9f9f9;
          padding: 25px;
          border-radius: 8px;
          margin: 25px 0;
        }
        .detail-row {
          display: flex;
          justify-content: space-between;
          padding: 12px 0;
          border-bottom: 1px solid #e5e5e5;
        }
        .detail-row:last-child {
          border-bottom: none;
        }
        .detail-label {
          font-size: 14px;
          color: #666666;
          font-weight: 500;
        }
        .detail-value {
          font-size: 14px;
          color: #1a1a1a;
          font-weight: 600;
          text-align: right;
        }
        .wait-time-box {
          background: #eff6ff;
          padding: 20px;
          border-radius: 8px;
          margin: 25px 0;
          text-align: center;
        }
        .wait-time-title {
          font-size: 14px;
          color: #666666;
          margin-bottom: 10px;
        }
        .wait-time-value {
          font-size: 32px;
          font-weight: 700;
          color: #1e40af;
          margin: 10px 0;
        }
        .wait-time-note {
          font-size: 13px;
          color: #555555;
          margin-top: 10px;
        }
        .footer {
          background: #f9f9f9;
          padding: 25px 30px;
          text-align: center;
          border-top: 1px solid #e0e0e0;
        }
        .footer-text {
          font-size: 12px;
          color: #999999;
          line-height: 1.6;
        }
        .branch-info {
          font-size: 11px;
          color: #666666;
          margin-top: 10px;
          font-style: italic;
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
          .greeting {
            font-size: 20px;
          }
          .message {
            font-size: 14px;
          }
          .checkin-box, .appointment-details, .wait-time-box {
            padding: 20px 15px;
          }
          .checkin-icon {
            font-size: 40px;
          }
          .wait-time-value {
            font-size: 28px;
          }
          .detail-row {
            flex-direction: column;
            gap: 5px;
          }
          .detail-value {
            text-align: left;
          }
          .footer {
            padding: 20px 15px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <img src="https://res.cloudinary.com/dimlozhrx/image/upload/v1760513399/zennara_logo_white_2_zohjug.png" alt="Zennara Logo" class="logo-img">
          <div class="header-subtitle">Your Beauty Transformation Journey</div>
        </div>
        
        <div class="content">
          <div class="greeting">Welcome, ${fullName}!</div>
          <p class="message">
            Thank you for checking in! We're excited to see you today.
          </p>

          <div class="checkin-box">
            <div class="checkin-title">Check-in Confirmed</div>
            <p class="checkin-text">
              You're all set! Our team will be with you shortly.
            </p>
          </div>

          <div class="appointment-details">
            <div class="detail-row">
              <span class="detail-label">Treatment</span>
              <span class="detail-value">${appointmentData.treatment}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Time</span>
              <span class="detail-value">${appointmentData.time}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Location</span>
              <span class="detail-value">${appointmentData.location}</span>
            </div>
          </div>

          <div class="wait-time-box">
            <div class="wait-time-title">Estimated Wait Time</div>
            <div class="wait-time-value">${appointmentData.waitTime || '5-10'} min</div>
            <p class="wait-time-note">We'll notify you when it's your turn</p>
          </div>
          
          <p class="message" style="margin-top: 25px; text-align: center;">
            Please relax in our waiting area. We appreciate your patience!
          </p>
        </div>
        
        <div class="footer">
          <p class="footer-text">Thank you for choosing Zennara Clinic.</p>
          <p class="branch-info">Serving you from ${branch}</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = getCheckInSuccessfulTemplate;
