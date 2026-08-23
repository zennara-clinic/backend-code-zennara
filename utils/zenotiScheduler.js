const cron = require('node-cron');
const zenoti = require('../services/zenotiService');
const importer = require('../services/zenotiImportService');
const User = require('../models/User');
const logger = require('./logger');

/**
 * Keeps the local mirror of Zenoti's customers current.
 *
 *  - Roster: nightly at 02:30 IST (new guests created at the front desk appear
 *    in the panel by morning), plus once at boot if nothing has ever been
 *    imported.
 *  - History: every 5 minutes, the 40 stalest guests — a rolling pass that
 *    covers the whole roster roughly daily inside Zenoti's rate limit.
 *
 * Disable with ZENOTI_SYNC_ENABLED=false (e.g. on a second PM2 instance).
 */
function startZenotiScheduler() {
  if (!zenoti.isConfigured()) {
    logger.info('Zenoti scheduler not started (integration not configured)');
    return;
  }
  if (String(process.env.ZENOTI_SYNC_ENABLED || 'true').toLowerCase() === 'false') {
    logger.info('Zenoti scheduler disabled by ZENOTI_SYNC_ENABLED=false');
    return;
  }

  cron.schedule('30 2 * * *', () => {
    importer.importRoster({ trigger: 'schedule' }).catch(() => {});
  }, { timezone: 'Asia/Kolkata' });

  cron.schedule('*/5 * * * *', () => {
    importer.crawlDetails({ limit: 40, trigger: 'schedule' }).catch(() => {});
  });

  // First boot on a fresh database: pull the roster straight away.
  setTimeout(async () => {
    try {
      const linked = await User.countDocuments({ source: 'zenoti' });
      if (linked === 0) {
        logger.info('No Zenoti guests mirrored yet — running initial roster import');
        await importer.importRoster({ trigger: 'boot' });
      }
    } catch (err) {
      logger.warn('Initial Zenoti roster import skipped', { error: err.message });
    }
  }, 15000);

  logger.info('Zenoti scheduler started (roster nightly 02:30 IST, history crawl every 5 min)');
}

module.exports = { startZenotiScheduler };
