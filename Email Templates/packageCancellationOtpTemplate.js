const packageCancellationOtpTemplate = (customerName, otp, packageName, assignmentId) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Package Cancellation Verification</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 500px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    .header {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      padding: 32px 24px;
      text-align: center;
    }
    .icon {
      width: 64px;
      height: 64px;
      background-color: rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    .header h1 {
      color: #ffffff;
      font-size: 24px;
      font-weight: 600;
      margin: 0;
    }
    .content {
      padding: 32px 24px;
    }
    .greeting {
      font-size: 16px;
      color: #374151;
      margin-bottom: 16px;
    }
    .message {
      font-size: 14px;
      color: #6b7280;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .otp-container {
      background-color: #f9fafb;
      border: 2px solid #e5e7eb;
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      margin-bottom: 24px;
    }
    .otp-label {
      font-size: 12px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .otp-code {
      font-size: 36px;
      font-weight: 700;
      color: #1f2937;
      letter-spacing: 8px;
      font-family: 'Courier New', monospace;
    }
    .package-info {
      background-color: #fef2f2;
      border-left: 4px solid #ef4444;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 24px;
    }
    .package-info-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .package-info-item:last-child {
      margin-bottom: 0;
    }
    .package-info-label {
      color: #6b7280;
    }
    .package-info-value {
      color: #1f2937;
      font-weight: 600;
    }
    .warning {
      background-color: #fef3c7;
      border: 1px solid #fbbf24;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #92400e;
      text-align: center;
    }
    .footer {
      text-align: center;
      padding: 24px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
    }
    .brand {
      color: #059669;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Package Cancellation</h1>
    </div>

    <div class="content">
      <p class="greeting">Hello ${customerName},</p>
      
      <p class="message">
        A cancellation request has been initiated for your package. Please verify this action using the OTP below.
      </p>

      <div class="otp-container">
        <div class="otp-label">Your Verification Code</div>
        <div class="otp-code">${otp}</div>
      </div>

      <div class="package-info">
        <div class="package-info-item">
          <span class="package-info-label">Package:</span>
          <span class="package-info-value">${packageName}</span>
        </div>
        <div class="package-info-item">
          <span class="package-info-label">Assignment ID:</span>
          <span class="package-info-value">${assignmentId}</span>
        </div>
      </div>

      <div class="warning">
        This OTP expires in 5 minutes
      </div>

      <p class="message" style="margin-bottom: 0;">
        If you didn't request this cancellation, please contact us immediately.
      </p>
    </div>

    <div class="footer">
      <span class="brand">Zennara</span> • Your Wellness Partner
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = packageCancellationOtpTemplate;
