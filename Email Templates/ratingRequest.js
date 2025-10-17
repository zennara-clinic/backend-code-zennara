/**
 * Rating Request Email Template
 * Sent 24 hours after completed appointment
 */

const getRatingRequestTemplate = (fullName, appointmentData, branch = 'Zennara Clinic') => {
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
        .treatment-info {
          background: #f9f9f9;
          padding: 20px;
          border-radius: 8px;
          margin: 25px 0;
          text-align: center;
        }
        .treatment-name {
          font-size: 16px;
          font-weight: 600;
          color: #0a6049;
          margin-bottom: 5px;
        }
        .treatment-date {
          font-size: 14px;
          color: #666666;
        }
        .rating-box {
          background: #fff9e6;
          padding: 30px;
          border-radius: 8px;
          margin: 25px 0;
          text-align: center;
        }
        .rating-title {
          font-size: 18px;
          font-weight: 600;
          color: #0a6049;
          margin-bottom: 15px;
        }
        .rating-subtitle {
          font-size: 14px;
          color: #555555;
          line-height: 1.6;
          margin-bottom: 20px;
        }
        .app-note {
          background: #eff6ff;
          padding: 20px;
          border-radius: 8px;
          margin: 25px 0;
          text-align: center;
        }
        .app-note-text {
          font-size: 14px;
          color: #1e40af;
          font-weight: 500;
          line-height: 1.6;
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
          .rating-box {
            padding: 25px 15px;
          }
          .star-display {
            font-size: 28px;
            letter-spacing: 6px;
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
          <div class="greeting">Hi ${fullName}!</div>
          <p class="message">
            We hope you're enjoying the results of your recent treatment! Your feedback means the world to us.
          </p>

          <div class="treatment-info">
            <div class="treatment-name">${appointmentData.treatment}</div>
            <div class="treatment-date">${appointmentData.date}</div>
          </div>

          <div class="rating-box">
            <div class="rating-title">How Was Your Experience?</div>
            <p class="rating-subtitle">
              Your feedback helps us maintain the highest quality of service.
            </p>
          </div>

          <div class="app-note">
            <p class="app-note-text">
              Please open the Zennara app to rate your experience and share your thoughts!
            </p>
          </div>
          
          <p class="message" style="margin-top: 25px; text-align: center;">
            Thank you for being a valued member of the Zennara family!
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

module.exports = getRatingRequestTemplate;
