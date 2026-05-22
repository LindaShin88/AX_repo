const db = require('../database');

const meetings = db.prepare(`
  SELECT mt.*, c.name AS committee_name
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
   ORDER BY mt.id DESC LIMIT 10
`).all();

console.log(`최근 회의 ${meetings.length}건:\n`);

for (const mt of meetings) {
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(mt.committee_id);
  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(mt.id);
  const responded = db.prepare(`
    SELECT DISTINCT sr.member_id FROM slot_responses sr
    JOIN meeting_slots ms ON ms.id = sr.slot_id
    WHERE ms.meeting_id = ? AND sr.auto_filled = 0
  `).all(mt.id);
  const notifs = db.prepare(`
    SELECT type, COUNT(*) AS n FROM notifications WHERE meeting_id = ? GROUP BY type
  `).all(mt.id);

  const c = JSON.parse(mt.schedule_constraints || '{}');
  console.log(`#${mt.id} "${mt.title}" [${mt.status}]`);
  console.log(`  · 위원회: ${mt.committee_name} (위원 ${members.length}명)`);
  console.log(`  · 기간: ${c.window?.start} ~ ${c.window?.end}`);
  console.log(`  · 후보 슬롯: ${slots.length}개`);
  console.log(`  · 응답 완료: ${responded.length}/${members.length}명 ${responded.length === members.length ? '🎯전원완료' : ''}`);
  console.log(`  · 알림 발송 타입별:`, notifs.map(n => `${n.type}=${n.n}`).join(', '));
  console.log(`  · confirmed_slot_id: ${mt.confirmed_slot_id || '없음'}`);
  console.log();
}
