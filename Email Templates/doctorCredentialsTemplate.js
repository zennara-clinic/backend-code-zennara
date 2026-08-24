/**
 * Dermatologist panel credentials email.
 *
 * Sent when the clinic admin creates a dermatologist's login (mode 'created')
 * or resets their password (mode 'reset'). Dermatologists sign in with email +
 * password only — there is no emailed-code flow for them — so this mail is the
 * one place they learn their credentials.
 */

const getDoctorCredentialsTemplate = (name, { email, password, panelUrl = '', mode = 'created' } = {}) => {
  const created = mode !== 'reset';
  const title = created ? 'Your Zennara panel login' : 'Your panel password was reset';
  const intro = created
    ? 'The clinic has created your Dermatologist panel account. You can sign in with the details below.'
    : 'The clinic has reset your Dermatologist panel password. Use the new details below the next time you sign in.';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          line-height: 1.6; color: #1F2937;
          background: #f5f7fa; padding: 40px 20px;
        }
        .container {
          max-width: 600px; margin: 0 auto; background: white;
          border-radius: 20px; overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12);
        }
        .header {
          background: linear-gradient(135deg, #20594e 0%, #154239 100%);
          color: white; padding: 40px 30px; text-align: center;
        }
        .header h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
        .header p { font-size: 14px; margin-top: 8px; opacity: 0.85; }
        .body { padding: 34px 30px; }
        .body p { font-size: 14.5px; margin-bottom: 16px; color: #374151; }
        .creds {
          background: #f4f7f5; border: 1px solid #dde5e0; border-radius: 14px;
          padding: 20px 22px; margin: 22px 0;
        }
        .creds .row { display: block; padding: 6px 0; }
        .creds .label {
          display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
          text-transform: uppercase; color: #6B7280; margin-bottom: 2px;
        }
        .creds .value { font-size: 16px; font-weight: 600; color: #154239; word-break: break-all; }
        .btn {
          display: inline-block; background: #154239; color: #ffffff !important;
          font-size: 14px; font-weight: 600; text-decoration: none;
          padding: 12px 26px; border-radius: 10px; margin: 6px 0 18px;
        }
        .note { font-size: 12.5px; color: #6B7280; }
        .footer {
          background: #f9fafb; border-top: 1px solid #eceff1;
          padding: 18px 30px; text-align: center; font-size: 12px; color: #9CA3AF;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
          <p>Zennara — Skin · Aesthetics · Wellness</p>
        </div>
        <div class="body">
          <p>Dear ${name || 'Doctor'},</p>
          <p>${intro}</p>
          <div class="creds">
            <span class="row"><span class="label">Sign-in email</span><span class="value">${email}</span></span>
            <span class="row"><span class="label">Password</span><span class="value">${password}</span></span>
          </div>
          ${panelUrl ? `<a class="btn" href="${panelUrl}">Open the Dermatologist panel</a><br/>` : ''}
          <p class="note">
            Sign-in is by email and password only — no codes are emailed to dermatologist accounts.
            You can change this password any time from <strong>My profile → Account &amp; security</strong>
            inside the panel. If you did not expect this email, contact the clinic admin immediately.
          </p>
        </div>
        <div class="footer">This is an automated message from the Zennara clinic panel.</div>
      </div>
    </body>
    </html>
  `;
};

module.exports = { getDoctorCredentialsTemplate };
