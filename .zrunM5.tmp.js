require('dotenv').config();
const zenoti = require('./services/zenotiService');
const cfg = require('./config/zenoti');
(async () => {
  const centers = await zenoti.getCenters();
  for (const c of centers) {
    let ms = [];
    try { ms = await zenoti.getCenterMemberships(c.id); } catch (e) { console.log(c.name, 'ERR', e.message); continue; }
    console.log('\n===', c.name, c.id, '| memberships:', ms.length);
    ms.forEach(m => console.log('   ', JSON.stringify({ id: m.id, name: m.name, displayName: m.displayName, price: m.price, discounted: m.discountedPrice, type: m.membershipType, recurring: m.isRecurring, showPrice: m.showPrice })));
  }
})().catch(e => { console.error(e); process.exit(1); });
