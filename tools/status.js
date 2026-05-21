const db = require('../database');

console.log('=== 학사운영위원회 현재 상태 ===\n');

const committee = db.prepare("SELECT * FROM committees WHERE name = '학사운영위원회'").get();
if (!committee) { console.log('❌ 학사운영위원회가 없어요. npm run seed 먼저!'); process.exit(0); }
console.log(`위원회 ID: ${committee.id} / 정족수: ${committee.quorum}명`);

const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(committee.id);
console.log(`\n위원 ${members.length}명:`);
const TYPE_LABEL = { faculty: '교원', staff: '직원', student: '학생', external: '외부' };
members.forEach(m => {
  console.log(`  · #${m.id} ${m.name.padEnd(8)} [${TYPE_LABEL[m.type]}] ${m.email || '(이메일 없음)'}`);
});

const meetings = db.prepare('SELECT * FROM meetings WHERE committee_id = ? ORDER BY id').all(committee.id);
console.log(`\n회의 ${meetings.length}건:`);
meetings.forEach(mt => {
  console.log(`  · #${mt.id} "${mt.title}" [${mt.status}]`);
});

console.log('\n=== 운영자 계정 ===');
const ops = db.prepare("SELECT username, name, role, status FROM operators").all();
ops.forEach(o => console.log(`  · ${o.username} / ${o.name} / ${o.role} / ${o.status}`));

console.log('\n=== SMTP 설정 ===');
const smtpRows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'smtp_%'").all();
if (smtpRows.length === 0) {
  console.log('  ⚠️ SMTP 미설정 → 메일 자동 발송 안 됨 (DB 로그만)');
} else {
  smtpRows.forEach(r => {
    const v = r.key === 'smtp_pass' && r.value ? '***' + r.value.slice(-2) : r.value;
    console.log(`  · ${r.key}: ${v}`);
  });
}
