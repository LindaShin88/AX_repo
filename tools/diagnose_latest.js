const db = require('../database');

const mt = db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT 1').get();
if (!mt) { console.log('회의 없음'); process.exit(0); }

console.log(`\n=== 최신 회의: #${mt.id} "${mt.title}" ===`);
console.log(`생성 시각: ${mt.created_at}`);
console.log();

const c = JSON.parse(mt.schedule_constraints || '{}');
console.log('=== schedule_constraints ===');
console.log(`기간: ${c.window?.start} ~ ${c.window?.end}`);
console.log(`제외 날짜: ${JSON.stringify(c.excludedDates)}`);
console.log(`오전 시간: ${JSON.stringify(c.morningHours)}`);
console.log(`오후 시간: ${JSON.stringify(c.afternoonHours)}`);
console.log();

const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(mt.id);
console.log(`=== 후보 슬롯 ${slots.length}개 ===`);
const DAY = ['일','월','화','수','목','금','토'];
slots.forEach(s => {
  const d = new Date(s.start_time);
  console.log(`  · ${s.start_time}  (${DAY[d.getDay()]})  score=${s.suggested_score?.toFixed(3)}`);
});
console.log();

console.log('=== 슬롯별 자동 마킹 (시간표 충돌 = unavailable) ===');
const resps = db.prepare(`
  SELECT sr.*, m.name AS mname, ms.start_time
    FROM slot_responses sr
    JOIN members m ON m.id = sr.member_id
    JOIN meeting_slots ms ON ms.id = sr.slot_id
   WHERE ms.meeting_id = ? AND sr.auto_filled = 1
   ORDER BY ms.start_time, m.name
`).all(mt.id);
console.log(`자동 마킹 ${resps.length}건:`);
resps.forEach(r => {
  const d = new Date(r.start_time);
  console.log(`  · ${r.start_time} (${DAY[d.getDay()]})  ${r.mname}  → ${r.response}  / ${r.note}`);
});
console.log();

console.log('=== 응답 토큰 (위원별 링크) ===');
const tokens = db.prepare(`
  SELECT t.token, m.name, m.email FROM member_tokens t
  JOIN members m ON m.id = t.member_id
  WHERE t.meeting_id = ? AND t.purpose = 'availability' ORDER BY m.id
`).all(mt.id);
tokens.forEach(t => console.log(`  · ${t.name.padEnd(8)} ${t.email.padEnd(35)} → http://localhost:3000/avail/${t.token}`));
