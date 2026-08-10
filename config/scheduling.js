/**
 * One appointment occupies one full hour across every active booking flow.
 *
 * This is deliberately global rather than a per-branch or per-doctor setting:
 * allowing those stored values to drift is what made one screen offer 10:30
 * while another treated 10:00–11:00 as the same session.
 */
const SESSION_SLOT_MINUTES = 60;

module.exports = { SESSION_SLOT_MINUTES };
