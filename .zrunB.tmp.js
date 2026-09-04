require('dotenv').config(); const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const started = Date.now(); const budgetMs = 8.5 * 60 * 1000;
  const t = async (label, fn) => { const s = Date.now(); try { const r = await fn(); console.log(`${label.padEnd(13)} ${Math.round((Date.now()-s)/1000)}s ${JSON.stringify(r).slice(0, 200)}`); } catch (e) { console.log(`${label.padEnd(13)} ERR ${e.message.slice(0, 120)}`); } };
  const appt = require('./services/zenotiAppointmentSyncService');
  await t('appts-recent', () => appt.syncRecentAppointments({ trigger: 'manual' }));
  await t('appts-ahead', () => appt.syncUpcomingAppointments({ trigger: 'manual' }));
  const imp = require('./services/zenotiImportService');
  await t('roster', () => imp.importRoster({ trigger: 'manual', mode: 'incremental' }));
  // Guest histories: as many 40-guest batches as fit in the remaining budget.
  let batches = 0, total = null;
  while (Date.now() - started < budgetMs) {
    const r = await imp.crawlDetails({ limit: 40, trigger: 'manual' }).catch((e) => ({ error: e.message }));
    batches += 1; total = r;
    if (r?.error || (r?.processed !== undefined && r.processed === 0)) break;
  }
  console.log(`histories     ${batches} batch(es) in ${Math.round((Date.now()-started)/1000)}s; last: ${JSON.stringify(total).slice(0, 160)}`);
  const ZG = require('./models/ZenotiGuestData'); const U = require('./models/User');
  console.log('guests with histories:', await ZG.countDocuments(), '/ users linked to Zenoti:', await U.countDocuments({ zenotiGuestId: { $exists: true } }));
  await mongoose.disconnect();
})();
