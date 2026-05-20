const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const notify = require('../services/notify');
const { getMemberTimetable } = require('../services/scheduler');
const { busyAt } = require('../services/timetable');

(async () => {
  const openMeetings = db.prepare(`SELECT * FROM meetings WHERE status = 'scheduling'`).all();
  console.log(`진행중인 회의: ${openMeetings.length}건`);

  const ins = db.prepare(`INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'availability')`);
  const insResp = db.prepare(`
    INSERT OR IGNORE INTO slot_responses (slot_id, member_id, response, auto_filled, note)
    VALUES (?, ?, ?, 1, ?)
  `);

  let issued = 0;
  let conflictMarks = 0;
  for (const mt of openMeetings) {
    const meetingFull = db.prepare(`
      SELECT mt.*, c.name AS committee_name FROM meetings mt
      JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ?
    `).get(mt.id);

    const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(mt.committee_id);
    const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ?').all(mt.id);
    const baseUrl = 'http://localhost:3000';
    const refDate = new Date(mt.created_at);

    for (const m of members) {
      const existing = db.prepare('SELECT id FROM member_tokens WHERE member_id = ? AND meeting_id = ?').get(m.id, mt.id);
      if (existing) continue;
      const token = uuidv4();
      ins.run(m.id, mt.id, token, );
      try { notify.sendAvailabilityRequest(meetingFull, m, token, baseUrl); } catch (e) {}
      issued++;
      console.log(`  ✓ token issued: 회의 #${mt.id} (${mt.title}) ← 위원 ${m.name} (#${m.id})`);

      if (slots.length > 0) {
        try {
          const tt = await getMemberTimetable(m, { referenceDate: refDate });
          if (tt && tt.length > 0) {
            for (const sl of slots) {
              const cf = busyAt(tt, sl.start_time, sl.end_time);
              if (cf) {
                insResp.run(sl.id, m.id, 'unavailable', `시간표 자동 인식: ${cf.title} (${cf.start}~${cf.end})`);
                conflictMarks++;
              }
            }
          }
        } catch (e) { console.warn('    (timetable lookup failed:', e.message + ')'); }
      }
    }
  }

  console.log(`\n✅ 완료: 토큰 ${issued}개 신규 발급, 자동 충돌 마킹 ${conflictMarks}건`);
})().catch(e => { console.error(e); process.exit(1); });
