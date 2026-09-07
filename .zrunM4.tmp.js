const rows = require('/tmp/zenrows.json').rows;
const byPlan = {};
rows.forEach(r => { (byPlan[r.name] ||= []).push(r); });
for (const [name, rs] of Object.entries(byPlan)) {
  rs.sort((a,b)=> new Date(b.memberSince) - new Date(a.memberSince));
  console.log('\n==', name, '| n=', rs.length, '| latest sale:', rs[0].memberSince, '| earliest:', rs[rs.length-1].memberSince);
  const centres = {}; rs.forEach(r=>centres[r.centre]=(centres[r.centre]||0)+1);
  console.log('   centres:', JSON.stringify(centres));
  console.log('   sample codes:', [...new Set(rs.map(r=>r.code))].slice(0,6).join(' | '));
}
