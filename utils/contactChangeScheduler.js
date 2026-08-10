const cron = require('node-cron');
const ContactChangeRequest = require('../models/ContactChangeRequest');
const User = require('../models/User');
const logger = require('./logger');

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
      // The app refreshes the profile from /auth/me on focus, so the new value
      // shows up on its own — no separate push needed here.
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
