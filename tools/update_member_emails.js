const db = require('../database');

const COMMITTEE_NAME = '학사운영위원회';
const UPDATES = [
  { name: '신영헌', email: 'lindasofiasyshin@gmail.com' },
  { name: '김교수', email: 'tkdsid012@naver.com' },
  { name: '이교수', email: 'clubsafari@naver.com' },
  { name: '김은주', email: 'soyungshin@hansung.kr' },
];

const committee = db.prepare("SELECT * FROM committees WHERE name = ?").get(COMMITTEE_NAME);
if (!committee) { console.log(`❌ "${COMMITTEE_NAME}" 위원회 없음`); process.exit(1); }

console.log(`\n=== ${COMMITTEE_NAME} (#${committee.id}) 위원 이메일 업데이트 ===\n`);

const stmt = db.prepare('UPDATE members SET email = ? WHERE committee_id = ? AND name = ?');
for (const u of UPDATES) {
  const r = stmt.run(u.email, committee.id, u.name);
  if (r.changes === 0) {
    console.log(`  ⚠️ ${u.name} 위원 없음 (스킵)`);
  } else {
    console.log(`  ✓ ${u.name.padEnd(8)} → ${u.email}`);
  }
}

console.log('\n=== 업데이트 후 전체 위원 명단 ===\n');
const members = db.prepare('SELECT id, name, type, email FROM members WHERE committee_id = ? ORDER BY id').all(committee.id);
const TYPE_LABEL = { faculty: '교원', staff: '직원', student: '학생', external: '외부' };
members.forEach(m => {
  const recv = UPDATES.some(u => u.email === m.email) ? '📩 실제 수신 가능' : '🚫 더미 이메일';
  console.log(`  #${m.id} ${m.name.padEnd(8)} [${TYPE_LABEL[m.type]}] ${m.email.padEnd(35)} ${recv}`);
});

console.log(`\n✅ 완료. 이제 새 회의 만들면 위 4명에게 실제 이메일 도착.\n`);
