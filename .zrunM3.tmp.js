require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const ZGD = require('./models/ZenotiGuestData');
  const User = require('./models/User');
  const { isZenMembership, isActiveMembershipStatus } = require('./config/zenoti');
  const { isMembershipCurrentlyActive } = require('./services/zenotiSyncService');
  const docs = await ZGD.find({ 'memberships.0': { $exists: true } }).lean();
  const statusTally = {};
  const rows = [];
  for (const d of docs) {
    for (const m of d.memberships) {
      statusTally[m.status] = (statusTally[m.status] || 0) + 1;
      rows.push({ userId: String(d.userId), name: m.name, code: m.code, status: m.status, memberSince: m.memberSince, expiryDate: m.expiryDate, centre: m.centerName, refunded: m.isRefunded, invoice: m.invoice?.number, zenMatch: isZenMembership(m.name) || isZenMembership(m.code), statusActive: isActiveMembershipStatus(m.status), currentlyActive: isMembershipCurrentlyActive(m) });
    }
  }
  console.log('STATUS TALLY:', JSON.stringify(statusTally));
  const byName = {};
  rows.forEach(r => { const k = r.name; byName[k] = byName[k] || { total:0, notExpired:0, zenMatch:0, currentlyActive:0 }; byName[k].total++; if (new Date(r.expiryDate) > new Date()) byName[k].notExpired++; if (r.zenMatch) byName[k].zenMatch++; if (r.currentlyActive) byName[k].currentlyActive++; });
  console.log('BY PLAN NAME:', JSON.stringify(byName, null, 1));
  // Zen Membership named rows in detail
  const zen = rows.filter(r => /zen membership/i.test(r.name || ''));
  console.log('\n"Zen Membership" rows:', zen.length);
  const uids = [...new Set(rows.map(r=>r.userId))];
  const users = await User.find({ _id: { $in: uids } }).select('fullName phone memberType zenMembershipPlan zenMembershipStartDate zenMembershipExpiryDate zenMembershipSource').lean();
  const umap = Object.fromEntries(users.map(u=>[String(u._id),u]));
  const notMarked = rows.filter(r => r.currentlyActive && umap[r.userId]?.memberType !== 'Zen Member');
  console.log('Rows currently ACTIVE but user NOT marked Zen Member:', notMarked.length);
  notMarked.slice(0,20).forEach(r=>console.log('  ', umap[r.userId]?.fullName, '|', r.name, '| status', r.status, '| exp', r.expiryDate));
  const markedNoActive = users.filter(u => u.memberType === 'Zen Member' && !rows.some(r => r.userId === String(u._id) && r.currentlyActive));
  console.log('\nUsers marked Zen Member with NO currently-active zenoti row:', markedNoActive.length);
  markedNoActive.slice(0,30).forEach(u=>console.log('  ', u.fullName, '|', u.zenMembershipPlan, '| exp', u.zenMembershipExpiryDate));
  require('fs').writeFileSync('/tmp/zenrows.json', JSON.stringify({rows, users}, null, 1));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
