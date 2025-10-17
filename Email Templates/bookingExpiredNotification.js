const bookingExpiredNotification = (name, bookingDetails) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Request Expired - Zennara</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f7fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          
          <!-- Header with Orange/Red Alert Color -->
          <tr>
            <td style="background: linear-gradient(135deg, #FF6B6B 0%, #FF8E53 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">
                ⏰ Booking Request Expired
              </h1>
              <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 16px; opacity: 0.95;">
                Your appointment request was not confirmed in time
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              
              <!-- Greeting -->
              <p style="margin: 0 0 20px 0; color: #2d3748; font-size: 18px; font-weight: 600;">
                Dear ${name},
              </p>

              <!-- Main Message -->
              <p style="margin: 0 0 25px 0; color: #4a5568; font-size: 16px; line-height: 1.6;">
                Unfortunately, your appointment request could not be confirmed before the scheduled time passed. The appointment has been automatically removed from our system.
              </p>

              <!-- Booking Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fff5f5; border-left: 4px solid #FF6B6B; border-radius: 8px; margin: 25px 0;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 15px 0; color: #c53030; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      📋 Expired Booking Details
                    </p>
                    
                    <table width="100%" cellpadding="8" cellspacing="0">
                      <tr>
                        <td style="color: #718096; font-size: 14px; padding: 8px 0;">
                          <strong>Reference Number:</strong>
                        </td>
                        <td style="color: #2d3748; font-size: 14px; font-weight: 600; padding: 8px 0; text-align: right;">
                          ${bookingDetails.referenceNumber}
                        </td>
                      </tr>
                      <tr>
                        <td style="color: #718096; font-size: 14px; padding: 8px 0;">
                          <strong>Treatment:</strong>
                        </td>
                        <td style="color: #2d3748; font-size: 14px; font-weight: 600; padding: 8px 0; text-align: right;">
                          ${bookingDetails.treatment}
                        </td>
                      </tr>
                      <tr>
                        <td style="color: #718096; font-size: 14px; padding: 8px 0;">
                          <strong>Date:</strong>
                        </td>
                        <td style="color: #2d3748; font-size: 14px; font-weight: 600; padding: 8px 0; text-align: right;">
                          ${bookingDetails.date}
                        </td>
                      </tr>
                      <tr>
                        <td style="color: #718096; font-size: 14px; padding: 8px 0;">
                          <strong>Time:</strong>
                        </td>
                        <td style="color: #2d3748; font-size: 14px; font-weight: 600; padding: 8px 0; text-align: right;">
                          ${bookingDetails.time}
                        </td>
                      </tr>
                      <tr>
                        <td style="color: #718096; font-size: 14px; padding: 8px 0;">
                          <strong>Location:</strong>
                        </td>
                        <td style="color: #2d3748; font-size: 14px; font-weight: 600; padding: 8px 0; text-align: right;">
                          ${bookingDetails.location}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Information Message -->
              <div style="background-color: #fffaf0; border-left: 4px solid #f6ad55; border-radius: 8px; padding: 20px; margin: 25px 0;">
                <p style="margin: 0 0 10px 0; color: #744210; font-size: 15px; font-weight: 600;">
                  ℹ️ What Happened?
                </p>
                <p style="margin: 0; color: #744210; font-size: 14px; line-height: 1.6;">
                  Your booking was in "Awaiting Confirmation" status and could not be confirmed by our team before the scheduled appointment time. To ensure data accuracy, expired unconfirmed bookings are automatically removed from our system.
                </p>
              </div>

              <!-- Next Steps -->
              <div style="background-color: #f0fdf4; border-left: 4px solid #10b981; border-radius: 8px; padding: 20px; margin: 25px 0;">
                <p style="margin: 0 0 10px 0; color: #065f46; font-size: 15px; font-weight: 600;">
                  💚 Book Again
                </p>
                <p style="margin: 0 0 15px 0; color: #065f46; font-size: 14px; line-height: 1.6;">
                  We'd love to serve you! Please book a new appointment through our app or website, and our team will confirm it promptly.
                </p>
              </div>

              <!-- Call to Action -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="https://zennara.app/book" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.3);">
                      📅 Book New Appointment
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Support Message -->
              <p style="margin: 30px 0 0 0; color: #718096; font-size: 14px; line-height: 1.6; text-align: center;">
                Have questions? Our support team is here to help!<br>
                <a href="mailto:support@zennara.com" style="color: #10b981; text-decoration: none; font-weight: 600;">support@zennara.com</a>
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0 0 10px 0; color: #10b981; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                Zennara
              </p>
              <p style="margin: 0 0 15px 0; color: #718096; font-size: 14px;">
                Your Wellness Partner
              </p>
              <p style="margin: 0; color: #a0aec0; font-size: 12px;">
                © ${new Date().getFullYear()} Zennara. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};

module.exports = bookingExpiredNotification;
