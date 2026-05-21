const db = require('../database');
const mt = db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT 1').get();
const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(mt.committee_id);
console.log(`회의 #${mt.id} 의 위원회 멤버 ${members.length}명:\n`);
members.forEach(m => {
  let ttCount = 0;
  if (m.timetable_cache) { try { ttCount = (JSON.parse(m.timetable_cache) || []).length; } catch(e){} }
  console.log(`  · ${m.name.padEnd(8)} [${m.type.padEnd(8)}] ${m.email.padEnd(35)} 시간표:${ttCount}슬롯`);
});
