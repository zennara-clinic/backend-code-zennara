const cron = require('node-cron');
const ContactChangeRequest = require('../models/ContactChangeRequest');
const User = require('../models/User');
const { sendContactUpdatedEmail } = require('./emailService');
const whatsappService = require('../services/whatsappService');
const logger = require('./logger');

const isPlaceholderEmail = (e) => !e || /@guest\.zennara\.in$/i.test(e);
const maskEmail = (e) => {
  if (!e) return '';
  const [name, domain] = e.split('@');
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, name.length - 1))}@${domain || ''}`;
};

/**
 * Tell the customer the change went through. Email change → confirm to the new
 * address + a security alert to the old one; phone change → confirm by email
 * and WhatsApp the new number. All best-effort; a failure never matters here.
 */
async function notifyApplied(user, request) {
  try {
    if (request.type === 'email') {
      await sendContactUpdatedEmail(request.newValue, user.fullName, {
        type: 'email',
        detail: request.newValue,
      });
      if (!isPlaceholderEmail(request.currentValue)) {
        await sendContactUpdatedEmail(request.currentValue, user.fullName, {
          type: 'email',
          alert: true,
          detail: maskEmail(request.newValue),
        });
      }
    } else {
      if (!isPlaceholderEmail(user.email)) {
        await sendContactUpdatedEmail(user.email, user.fullName, {
          type: 'phone',
          detail: `+91 ${request.newValue}`,
        });
      }
      whatsappService
        .sendMessage(
          request.newValue,
          'Your Zennara mobile number has been updated successfully — this number is now linked to your account.'
        )
        .catch(() => {});
    }
  } catch (error) {
    logger.warn('contact-change confirmation failed (non-blocking)', { error: error.message });
  }
}

/**
 * Apply every contact change whose scheduled time has passed. Idempotent and
 * self-healing: it only touches `scheduled` rows, re-checks the target value is
 * still free, and marks each row applied/failed so it is never processed twice.
 */
async function applyDueContactChanges() {
  const due = await ContactChangeRequest.find({
    status: 'scheduled',
    scheduledApplyAt: { $lte: new Date() },
  });

  let applied = 0;
  for (const request of due) {
    try {
      const user = await User.findById(request.userId);
      if (!user) {
        request.status = 'failed';
        request.failureReason = 'account not found';
        await request.save();
        continue;
      }

      // The value could have been taken during the delay window — re-check.
      if (request.type === 'email') {
        const taken = await User.findOne({ email: request.newValue, _id: { $ne: user._id } }).select('_id');
        if (taken) {
          request.status = 'failed';
          request.failureReason = 'email now in use by another account';
          await request.save();
          continue;
        }
        user.email = request.newValue;
      } else {
        const taken = await User.findOne({ phone: request.newValue, _id: { $ne: user._id } }).select('_id');
        if (taken) {
          request.status = 'failed';
          request.failureReason = 'number now in use by another account';
          await request.save();
          continue;
        }
        user.phone = request.newValue;
      }

      await user.save({ validateModifiedOnly: true });
      request.status = 'applied';
      request.appliedAt = new Date();
      await request.save();
      applied += 1;
      logger.info('Applied scheduled contact change', { userId: user._id, type: request.type });

      // Confirm to the customer automatically (email + WhatsApp). Best-effort —
      // the change is already saved; a notification failure changes nothing.
      await notifyApplied(user, request);
    } catch (error) {
      request.status = 'failed';
      request.failureReason = error.message;
      await request.save().catch(() => {});
      logger.error('Failed to apply contact change', { requestId: request._id, error: error.message });
    }
  }
  if (applied) logger.info(`Contact-change scheduler applied ${applied} change(s)`);
  return applied;
}

/** Register the cron (every 10 minutes) and run once on boot. */
const startContactChangeScheduler = () => {
  cron.schedule('*/10 * * * *', () => {
    applyDueContactChanges().catch((e) => logger.error('contact-change cron error', { error: e.message }));
  });
  console.log('✉️  Contact-change scheduler started - runs every 10 minutes');
  applyDueContactChanges().catch(() => {});
};

module.exports = { startContactChangeScheduler, applyDueContactChanges };
