const db = require('../database');

const TOKEN = 'f4fcf697-a345-483f-8809-6b9af6194afd';

const tokenRow = db.prepare(`
  SELECT t.*, m.name AS member_name, mt.id AS mid, mt.title, mt.schedule_constraints, mt.created_at
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
   WHERE t.token = ?
`).get(TOKEN);

if (!tokenRow) { console.log('토큰 없음'); process.exit(0); }

console.log(`회의: #${tokenRow.mid} "${tokenRow.title}" (생성: ${tokenRow.created_at})`);
console.log(`위원: ${tokenRow.member_name} (#${tokenRow.member_id})`);
console.log();
console.log('=== schedule_constraints ===');
try {
  const c = JSON.parse(tokenRow.schedule_constraints || '{}');
  console.log(JSON.stringify(c, null, 2));
} catch (e) { console.log(tokenRow.schedule_constraints); }
console.log();

const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(tokenRow.mid);
console.log(`=== meeting_slots: ${slots.length}개 ===`);
slots.forEach(s => console.log(`  · ${s.start_time} ~ ${s.end_time}  score=${s.suggested_score?.toFixed(3)}`));
