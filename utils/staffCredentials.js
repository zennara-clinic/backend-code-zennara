/**
 * Send a staff member their sign-in details — Zenoti's "Reset Password: send
 * username and password via Email/Text Message", in one place.
 *
 * `channel`: 'email' | 'whatsapp' | 'both' | 'none'. Each channel is
 * best-effort and reported separately, so a missing phone or a mail outage
 * never blocks the password being set.
 */
const { sendDoctorCredentials } = require('./emailService');
const whatsapp = require('../services/whatsappService');

const PANEL_LABEL = { doctor: 'Dermatologist', therapist: 'Therapist', staff: 'Admin', super_admin: 'Admin' };
const PANEL_URL = (role) => (role === 'doctor'
  ? process.env.DOCTOR_PANEL_URL
  : role === 'therapist' ? process.env.THERAPIST_PANEL_URL : process.env.ADMIN_PANEL_URL) || '';

async function sendStaffCredentials(admin, { password, mode = 'created', channel = 'email' } = {}) {
  const result = { email: null, whatsapp: null };
  if (!password || channel === 'none') return result;
  const panel = PANEL_LABEL[admin.role] || 'Admin';
  const name = admin.name || admin.email;

  if (channel === 'email' || channel === 'both') {
    try {
      await sendDoctorCredentials(admin.email, name, { password, mode, panel });
      result.email = 'sent';
    } catch (error) {
      result.email = `failed: ${error.message}`;
    }
  }
  if (channel === 'whatsapp' || channel === 'both') {
    if (!admin.phone) {
      result.whatsapp = 'skipped: no phone on the account';
    } else {
      try {
        const url = PANEL_URL(admin.role);
        const text = [
          `Zennara ${panel} Panel — your sign-in details`,
          `Email: ${admin.email}`,
          `Temporary password: ${password}`,
          url ? `Sign in: ${url}` : null,
          'You will be asked to choose your own password at first sign-in.',
        ].filter(Boolean).join('\n');
        await whatsapp.sendMessage(admin.phone, text);
        result.whatsapp = 'sent';
      } catch (error) {
        result.whatsapp = `failed: ${error.message}`;
      }
    }
  }
  return result;
}

module.exports = { sendStaffCredentials, PANEL_LABEL };
