const getBirthdayWishTemplate = (name) => {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Happy Birthday from Zennara!</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8f9fa;">
      <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8f9fa;">
        <tr>
          <td style="padding: 40px 20px;">
            <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
              
              <!-- Header with Birthday Decoration -->
              <tr>
                <td style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 50px 40px; text-align: center;">
                  <div style="font-size: 60px; margin-bottom: 15px;">🎂🎉🎈</div>
                  <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    Happy Birthday!
                  </h1>
                </td>
              </tr>

              <!-- Main Content -->
              <tr>
                <td style="padding: 50px 40px;">
                  <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 26px; font-weight: 600;">
                    Dear ${name},
                  </h2>
                  
                  <p style="margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.7;">
                    🎊 On behalf of the entire Zennara family, we wish you a very <strong>Happy Birthday</strong>! 🎊
                  </p>

                  <p style="margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.7;">
                    May this special day bring you joy, health, and happiness. Thank you for being a valued member of our wellness community.
                  </p>

                  <p style="margin: 0 0 30px 0; color: #4b5563; font-size: 16px; line-height: 1.7;">
                    We hope your day is filled with love, laughter, and wonderful moments with your loved ones!
                  </p>

                  <!-- Special Birthday Offer Card -->
                  <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; padding: 30px; text-align: center; margin-bottom: 30px; border: 2px dashed #f59e0b;">
                    <div style="font-size: 40px; margin-bottom: 15px;">🎁</div>
                    <h3 style="margin: 0 0 10px 0; color: #92400e; font-size: 22px; font-weight: 600;">
                      Special Birthday Treat!
                    </h3>
                    <p style="margin: 0 0 15px 0; color: #78350f; font-size: 16px; line-height: 1.6;">
                      As a birthday gift, enjoy <strong>10% OFF</strong> on your next consultation or service booking!
                    </p>
                    <p style="margin: 0; color: #78350f; font-size: 14px; font-style: italic;">
                      Valid for 30 days from your birthday
                    </p>
                  </div>

                  <!-- Wishes -->
                  <div style="background-color: #f0fdf4; border-left: 4px solid #10b981; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                    <p style="margin: 0; color: #065f46; font-size: 16px; line-height: 1.7; font-style: italic;">
                      "May your birthday mark the beginning of a wonderful journey towards wellness, happiness, and good health!"
                    </p>
                  </div>

                  <p style="margin: 0 0 10px 0; color: #4b5563; font-size: 16px; line-height: 1.7;">
                    With warm wishes and heartfelt gratitude,
                  </p>
                  
                  <p style="margin: 0; color: #1f2937; font-size: 16px; font-weight: 600;">
                    The Zennara Wellness Team 💚
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color: #f9fafb; padding: 30px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
                  <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 14px;">
                    📍 Zennara Wellness Clinic<br>
                    Your Partner in Health & Wellness
                  </p>
                  
                  <div style="margin: 20px 0;">
                    <a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; color: #10b981; font-size: 24px;">📱</a>
                    <a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; color: #10b981; font-size: 24px;">📧</a>
                    <a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; color: #10b981; font-size: 24px;">🌐</a>
                  </div>

                  <p style="margin: 15px 0 0 0; color: #9ca3af; font-size: 12px;">
                    This is an automated birthday greeting from Zennara.<br>
                    You're receiving this because you're a valued member of our wellness community.
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

module.exports = getBirthdayWishTemplate;
