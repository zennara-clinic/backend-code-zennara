const cron = require('node-cron');
const zenoti = require('../services/zenotiService');
const importer = require('../services/zenotiImportService');
const appointmentSync = require('../services/zenotiAppointmentSyncService');
const practitionerSync = require('../services/zenotiPractitionerService');
const User = require('../models/User');
const ZenotiGuestData = require('../models/ZenotiGuestData');
const logger = require('./logger');

/**
 * Keeps the local mirror of Zenoti's customers current.
 *
 *  - Roster: nightly at 02:30 IST (new guests created at the front desk appear
 *    in the panel by morning), plus once at boot if nothing has ever been
 *    imported.
 *  - History: every 5 minutes, the 40 stalest guests — a rolling pass that
 *    covers the whole roster roughly daily inside Zenoti's rate limit.
 *  - Appointment book: every 2 minutes, one compact request per clinic for
 *    yesterday through the next five days. These rows become real Bookings.
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

  cron.schedule('*/5 * * * *', () => {
    practitionerSync.syncPractitioners({ trigger: 'schedule' }).catch(() => {});
  });

  /*
   * Zenoti catalogue + per-centre stock → Product, hourly.
   *
   * Read-only and hourly rather than every few minutes: stock does not move
   * fast enough to justify the API budget, and this walks every centre.
   */
  cron.schedule('20 * * * *', () => {
    require('../services/zenotiProductSyncService').syncProducts({ trigger: 'schedule' }).catch(() => {});
  });

  // Zenoti services + packages → Consultation/Package, hourly. Read-only;
  // creates hidden shells and links names, never publishes or reprices
  // (unless ZENOTI_SYNC_SERVICE_PRICES=true).
  cron.schedule('40 * * * *', () => {
    require('../services/zenotiCatalogSyncService').syncCatalog({ trigger: 'schedule' }).catch(() => {});
  });

  // Panel working hours → Zenoti shifts, daily at 03:15 IST, so Zenoti's slot
  // engine can accept app bookings (see zenotiScheduleWriteService).
  cron.schedule('15 3 * * *', () => {
    require('../services/zenotiScheduleWriteService').publishDoctorHours({ trigger: 'schedule' }).catch(() => {});
  }, { timezone: 'Asia/Kolkata' });

  // Zenoti roster → app availability (narrow-only; see zenotiPractitionerService).
  // Opt-in: it changes what the app sells based on Zenoti's published shifts.
  if (String(process.env.ZENOTI_ROSTER_TO_AVAILABILITY || 'false').toLowerCase() === 'true') {
    cron.schedule('7,37 * * * *', () => {
      practitionerSync.syncDoctorShiftsFromZenoti({ trigger: 'schedule' }).catch(() => {});
    });
  }

  cron.schedule('*/2 * * * *', () => {
    appointmentSync.syncRecentAppointments({ trigger: 'schedule' }).catch(() => {});
  });

  /*
   * Retry app/reception bookings whose push to Zenoti failed.
   *
   * Every 10 minutes and at most 10 at a time: a booking confirmed to a patient
   * must not live only in Zennara, but a systemic Zenoti failure must not turn
   * this into a write storm either. Only future, still-live bookings are ever
   * retried — see retryFailedBookingPushes.
   */
  cron.schedule('*/10 * * * *', () => {
    require('../services/zenotiWriteService')
      .retryFailedBookingPushes({ limit: 10, trigger: 'schedule' })
      .catch(() => {});
  });

  // Booking-horizon pass: day +6 → +62 in seven-day chunks, every 15 minutes.
  // Keeps far-out Zenoti reservations blocking the app's consultation slots
  // (the near window above only reaches six days ahead; the slot engine offers
  // up to the dermatologist's horizon, 60 days by default).
  cron.schedule('*/15 * * * *', () => {
    appointmentSync.syncUpcomingAppointments({ trigger: 'schedule' }).catch(() => {});
  });

  // On boot, resume whichever part of the initial import is incomplete. A
  // restart must not leave thousands of roster-only patients waiting for tiny
  // five-minute batches before their histories appear in the panel.
  setTimeout(async () => {
    try {
      // Classify/link Zenoti providers before ingesting the appointment book,
      // so treatment therapists cannot be mistaken for dermatologists.
      await practitionerSync.syncPractitioners({ trigger: 'boot' });
      // The appointment book is the operational priority and takes only one
      // request per clinic. Do it before a potentially long history backlog.
      await appointmentSync.syncRecentAppointments({ trigger: 'boot' });
      // Then the horizon, so far-out Zenoti bookings block slots immediately
      // after a deploy rather than waiting for the first 15-minute pass.
      await appointmentSync.syncUpcomingAppointments({ trigger: 'boot' });
      const [linked, mirrored] = await Promise.all([
        User.countDocuments({ zenotiGuestId: { $exists: true, $ne: null } }),
        ZenotiGuestData.countDocuments({ syncedAt: { $ne: null } }),
      ]);
      if (linked === 0) {
        logger.info('No Zenoti guests mirrored yet — running initial roster import');
        await importer.fullImport({ trigger: 'boot' });
      } else if (mirrored < linked) {
        logger.info('Zenoti history import incomplete — resuming full backlog', { linked, mirrored });
        await importer.crawlDetails({
          limit: Number.MAX_SAFE_INTEGER,
          trigger: 'boot',
          mode: 'full',
        });
      }
    } catch (err) {
      logger.warn('Initial Zenoti roster import skipped', { error: err.message });
    }
  }, 15000);

  logger.info('Zenoti scheduler started (appointments every 2 min, practitioners/history every 5 min, roster nightly 02:30 IST)');
}

module.exports = { startZenotiScheduler };
