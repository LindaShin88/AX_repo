const db = require('../database');

const mt = db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT 1').get();
if (!mt) { console.log('회의 없음'); process.exit(0); }

const window = JSON.parse(mt.schedule_constraints || '{}').window || {};
console.log(`최신 회의: #${mt.id} "${mt.title}"   기간: ${window.start} ~ ${window.end}\n`);

const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(mt.id);
console.log(`후보 슬롯: ${slots.length}개`);
const DAY = ['일','월','화','수','목','금','토'];
slots.forEach(s => {
  const d = new Date(s.start_time);
  console.log(`  · ${s.start_time}  (${DAY[d.getDay()]}요일)  score=${s.suggested_score.toFixed(3)}`);
});

console.log('\n=== slot_responses (스케줄러가 자동 마킹한 것) ===');
const resps = db.prepare(`
  SELECT sr.*, m.name AS member_name, ms.start_time
    FROM slot_responses sr
    JOIN members m ON m.id = sr.member_id
    JOIN meeting_slots ms ON ms.id = sr.slot_id
   WHERE ms.meeting_id = ?
   ORDER BY m.name, ms.start_time
`).all(mt.id);
console.log(`총 자동 마킹: ${resps.length}건\n`);

const byMember = new Map();
resps.forEach(r => {
  if (!byMember.has(r.member_name)) byMember.set(r.member_name, []);
  byMember.get(r.member_name).push(r);
});
for (const [name, rs] of byMember) {
  console.log(`-- ${name} (${rs.length}건)`);
  rs.forEach(r => {
    const d = new Date(r.start_time);
    console.log(`   · ${r.start_time}  (${DAY[d.getDay()]})  →  ${r.response}  / ${r.note || ''}`);
  });
}

console.log('\n=== 오종택 시간표 캐시 ===');
const oj = db.prepare("SELECT * FROM members WHERE name='오종택' AND committee_id=?").get(mt.committee_id);
if (oj) {
  console.log(`type=${oj.type}, source=${oj.timetable_source}, fetched=${oj.timetable_fetched_at}`);
  const tt = JSON.parse(oj.timetable_cache || '[]');
  console.log(`슬롯 ${tt.length}개:`);
  tt.forEach(e => console.log(`   · ${DAY[e.day]} ${e.start}-${e.end} ${e.title} @ ${e.location || '-'}`));
  if (oj.timetable_meta) {
    const meta = JSON.parse(oj.timetable_meta);
    console.log(`meta: yearhakgi=${meta.yearhakgi}, matchedMajors=${meta.matchedMajors.length}, classes=${meta.classCount}`);
  }
}
