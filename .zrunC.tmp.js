require('dotenv').config(); const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const imp = require('./services/zenotiImportService');
  const started = Date.now(); let batches = 0, last = null;
  while (Date.now() - started < 4.5 * 60 * 1000) {
    const r = await imp.crawlDetails({ limit: 40, trigger: 'manual' }).catch((e) => ({ error: e.message }));
    batches += 1; last = r;
    if (r?.error || (r && r.processed === 0)) break;
  }
  console.log(`histories: ${batches} batch(es) in ${Math.round((Date.now()-started)/1000)}s; last: ${JSON.stringify(last).slice(0, 200)}`);
  const ZG = require('./models/ZenotiGuestData'); const PA = require('./models/PackageAssignment'); const PO = require('./models/ProductOrder');
  console.log('guests with histories:', await ZG.countDocuments(), '| clinic-bought packages as assignments:', await PA.countDocuments({ source: 'zenoti' }), '| counter sales as orders:', await PO.countDocuments({ source: 'zenoti' }));
  await mongoose.disconnect();
})();
