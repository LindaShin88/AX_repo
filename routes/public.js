const express = require('express');
const db = require('../database');
const { getTimetable, busyAt, getTimetableImageUrl } = require('../services/timetable');

const router = express.Router();

router.get('/avail/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, m.name AS member_name, m.role, m.affiliation, m.type AS member_type, m.sabun,
           mt.id AS meeting_id, mt.title, mt.description, mt.location, mt.duration_minutes,
           c.name AS committee_name
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.token = ? AND t.purpose = 'availability'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(token.meeting_id);
  const responses = db.prepare(`
    SELECT * FROM slot_responses WHERE member_id = ? AND slot_id IN (SELECT id FROM meeting_slots WHERE meeting_id = ?)
  `).all(token.member_id, token.meeting_id);
  res.render('public/availability', { token, slots, responses });
});

router.post('/avail/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, mt.id AS meeting_id FROM member_tokens t
    JOIN meetings mt ON mt.id = t.meeting_id
    WHERE t.token = ? AND t.purpose = 'availability'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  const slots = db.prepare('SELECT id FROM meeting_slots WHERE meeting_id = ?').all(token.meeting_id);
  const upsert = db.prepare(`
    INSERT INTO slot_responses (slot_id, member_id, response, auto_filled, note)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(slot_id, member_id) DO UPDATE SET
      response = excluded.response,
      auto_filled = 0,
      note = excluded.note,
      responded_at = CURRENT_TIMESTAMP
  `);
  for (const slot of slots) {
    const key = `slot_${slot.id}`;
    const value = req.body[key];
    if (!value) continue;
    upsert.run(slot.id, token.member_id, value, req.body[`note_${slot.id}`] || null);
  }
  db.prepare('UPDATE member_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(token.id);
  res.render('public/thanks', {
    title: '응답이 등록되었습니다',
    message: '가능 일정 응답이 정상 제출되었습니다. 감사합니다.',
  });
});

router.get('/sign/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, m.name AS member_name, m.role, m.affiliation, m.type AS member_type,
           mt.id AS meeting_id, mt.title, mt.description, mt.location, mt.minutes_text, mt.confirmed_slot_id,
           c.name AS committee_name
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.token = ? AND t.purpose = 'signature'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  const slot = token.confirmed_slot_id ? db.prepare('SELECT * FROM meeting_slots WHERE id = ?').get(token.confirmed_slot_id) : null;
  const existing = db.prepare('SELECT * FROM signatures WHERE meeting_id = ? AND member_id = ?').get(token.meeting_id, token.member_id);
  res.render('public/signature', { token, slot, existing });
});

router.post('/sign/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, mt.id AS meeting_id FROM member_tokens t
    JOIN meetings mt ON mt.id = t.meeting_id
    WHERE t.token = ? AND t.purpose = 'signature'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  const { signature_data } = req.body;
  if (!signature_data || !signature_data.startsWith('data:image')) {
    return res.status(400).render('public/error', { message: '서명 데이터가 누락되었습니다.' });
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';
  db.prepare(`
    INSERT INTO signatures (meeting_id, member_id, signature_data, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(meeting_id, member_id) DO UPDATE SET
      signature_data = excluded.signature_data,
      ip_address = excluded.ip_address,
      user_agent = excluded.user_agent,
      signed_at = CURRENT_TIMESTAMP
  `).run(token.meeting_id, token.member_id, signature_data, ip, ua);
  db.prepare('UPDATE member_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(token.id);
  res.render('public/thanks', {
    title: '서명이 완료되었습니다',
    message: '회의록 전자서명이 정상 등록되었습니다. 감사합니다.',
  });
});

module.exports = router;
