/**
 * Phone push notifications through Expo's push API.
 *
 * Every in-app Notification created for a guest is also offered here. The
 * guest's preferences decide whether it goes out, and a token Expo reports as
 * dead is dropped so the list does not grow stale. No SDK: the API is one POST.
 */
const User = require('../models/User');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Notification type (+ metadata.kind) → the preference that governs it. */
function preferenceFor(notification) {
  const kind = String(notification.metadata?.kind || '');
  if (kind === 'refill' || kind === 'prescription') return 'prescriptions';
  if (kind === 'package') return 'packages';
  switch (notification.type) {
    case 'booking': return 'appointments';
    case 'order': case 'product': return 'orders';
    case 'consultation': return 'prescriptions';
    case 'promotion': return 'promotions';
    case 'reminder': return 'appointments';
    default: return null;
  }
}
exports.preferenceFor = preferenceFor;

/** True when this guest wants this notification on this channel. */
function allows(user, notification, channel = 'push') {
  const prefs = user?.notificationPreferences || {};
  if (channel === 'push' && prefs.push === false) return false;
  if (channel === 'whatsapp' && prefs.whatsapp === false) return false;
  const key = preferenceFor(notification);
  return !key || prefs[key] !== false;
}
exports.allows = allows;

async function sendToUser(userId, { title, body, data }) {
  if (!userId) return { sent: 0 };
  const user = await User.findById(userId).select('pushTokens notificationPreferences').lean();
  const tokens = (user?.pushTokens || []).map((t) => t.token).filter((t) => /^Expo(nent)?PushToken\[/.test(t));
  if (!tokens.length) return { sent: 0 };
  const messages = tokens.map((to) => ({ to, sound: 'default', title, body, data: data || {}, priority: 'high' }));
  let tickets = [];
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify(messages),
    });
    const json = await res.json().catch(() => ({}));
    tickets = Array.isArray(json?.data) ? json.data : [];
  } catch (error) {
    console.error('Expo push failed:', error.message);
    return { sent: 0, error: error.message };
  }
  // A device that uninstalled the app answers DeviceNotRegistered — forget it.
  const dead = tickets
    .map((t, i) => (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered' ? tokens[i] : null))
    .filter(Boolean);
  if (dead.length) await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: dead } } } }).catch(() => {});
  return { sent: tickets.filter((t) => t?.status === 'ok').length, dead: dead.length };
}
exports.sendToUser = sendToUser;

/** Offer a saved Notification to the guest's phone, honouring preferences. */
async function pushNotification(notification) {
  try {
    if (!notification?.userId) return;
    const user = await User.findById(notification.userId).select('pushTokens notificationPreferences').lean();
    if (!user || !allows(user, notification, 'push')) return;
    await sendToUser(notification.userId, {
      title: notification.title,
      body: notification.message,
      data: {
        notificationId: String(notification._id),
        type: notification.type,
        relatedModel: notification.relatedModel || null,
        relatedId: notification.relatedId ? String(notification.relatedId) : null,
        url: notification.actionUrl || null,
        ...(notification.metadata || {}),
      },
    });
  } catch (error) {
    console.error('pushNotification failed:', error.message);
  }
}
exports.pushNotification = pushNotification;
