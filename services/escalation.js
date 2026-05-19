const db = require('../database');
const notify = require('./notify');

function findArsCandidates(baseUrl) {
  const rows = db.prepare(`
    SELECT t.id AS token_id, t.token, t.member_id, t.meeting_id, t.last_sms_at, t.ars_called_at,
           m.name, m.email, m.phone, m.type, m.role, m.affiliation,
           mt.title, mt.committee_id, mt.notify_channels, mt.ars_after_minutes,
           c.name AS committee_name,
           (SELECT COUNT(*) FROM slot_responses sr
            JOIN meeting_slots ms ON ms.id = sr.slot_id
            WHERE ms.meeting_id = mt.id AND sr.member_id = t.member_id AND sr.auto_filled = 0) AS responded_count
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.purpose = 'availability'
      AND mt.status = 'scheduling'
      AND mt.ars_after_minutes > 0
      AND t.last_sms_at IS NOT NULL
      AND t.ars_called_at IS NULL
  `).all();
  const dueRows = [];
  const now = Date.now();
  for (const r of rows) {
    if (r.responded_count > 0) continue;
    const lastSms = new Date(r.last_sms_at + ' UTC').getTime();
    const dueTime = lastSms + (r.ars_after_minutes * 60 * 1000);
    if (now >= dueTime) dueRows.push(r);
  }
  return dueRows;
}

function processArsEscalation(baseUrl) {
  const due = findArsCandidates(baseUrl);
  let count = 0;
  for (const r of due) {
    const meeting = { id: r.meeting_id, title: r.title, committee_name: r.committee_name };
    const member = { id: r.member_id, name: r.name, phone: r.phone, email: r.email, type: r.type, role: r.role };
    notify.logArsCall(meeting, member, r.token, baseUrl);
    count++;
  }
  return count;
}

function startEscalationWorker(baseUrl) {
  console.log('▶ ARS 에스컬레이션 워커 시작 (60초 간격)');
  setInterval(() => {
    try {
      const n = processArsEscalation(baseUrl);
      if (n > 0) console.log(`  ARS 자동 전화 ${n}건 발송`);
    } catch (e) {
      console.error('escalation error:', e.message);
    }
  }, 60 * 1000);
}

function manualArsTrigger(meetingId, baseUrl) {
  const rows = db.prepare(`
    SELECT t.id AS token_id, t.token, t.member_id, t.meeting_id,
           m.name, m.email, m.phone, m.type, m.role, m.affiliation,
           mt.title, mt.committee_id, mt.notify_channels,
           c.name AS committee_name,
           (SELECT COUNT(*) FROM slot_responses sr
            JOIN meeting_slots ms ON ms.id = sr.slot_id
            WHERE ms.meeting_id = mt.id AND sr.member_id = t.member_id AND sr.auto_filled = 0) AS responded_count
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.purpose = 'availability' AND t.meeting_id = ? AND m.phone IS NOT NULL
  `).all(meetingId);
  let count = 0;
  for (const r of rows) {
    if (r.responded_count > 0) continue;
    const meeting = { id: r.meeting_id, title: r.title, committee_name: r.committee_name };
    const member = { id: r.member_id, name: r.name, phone: r.phone, email: r.email, type: r.type, role: r.role };
    notify.logArsCall(meeting, member, r.token, baseUrl);
    count++;
  }
  return count;
}

module.exports = {
  findArsCandidates,
  processArsEscalation,
  startEscalationWorker,
  manualArsTrigger,
};
