const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { getTimetable, busyAt, getTimetableImageUrl } = require('../services/timetable');
const notify = require('../services/notify');
const mailer = require('../services/mailer');
const { generateFinalSignedPDF } = require('../services/finalpdf');

const router = express.Router();

function decodeOriginalName(name) {
  if (!name) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (!/[�]/.test(fixed)) return fixed;
  } catch (e) {}
  return name;
}

router.get('/minutes/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, mt.uploaded_minutes_path, mt.uploaded_minutes_original_name
    FROM member_tokens t
    JOIN meetings mt ON mt.id = t.meeting_id
    WHERE t.token = ? AND t.purpose = 'signature'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  if (!token.uploaded_minutes_path) return res.status(404).render('public/error', { message: '업로드된 회의록이 없습니다.' });
  const fp = path.join(__dirname, '..', token.uploaded_minutes_path);
  if (!fs.existsSync(fp)) return res.status(404).render('public/error', { message: '파일을 찾을 수 없습니다.' });
  const cleanName = decodeOriginalName(token.uploaded_minutes_original_name) || path.basename(fp);
  res.download(fp, cleanName);
});

router.get('/minutes-inline/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, mt.uploaded_minutes_path, mt.uploaded_minutes_original_name
    FROM member_tokens t
    JOIN meetings mt ON mt.id = t.meeting_id
    WHERE t.token = ? AND t.purpose = 'signature'
  `).get(req.params.token);
  if (!token) return res.status(404).send('Not found');
  if (!token.uploaded_minutes_path) return res.status(404).send('No file');
  const fp = path.join(__dirname, '..', token.uploaded_minutes_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.pdf') res.type('application/pdf');
  else if (ext === '.hwp' || ext === '.hwpx') res.type('application/x-hwp');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(fp)) + '"');
  res.sendFile(fp);
});

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

router.post('/avail/:token', async (req, res) => {
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

  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  let autoResult = null;
  try { autoResult = await notify.maybeAutoConfirmMeeting(token.meeting_id, baseUrl); } catch (e) {}

  res.render('public/thanks', {
    title: '응답이 등록되었습니다',
    message: autoResult && autoResult.kind === 'auto-confirmed'
      ? '모든 위원의 응답이 완료되어 회의 일정이 자동 확정되었습니다. 확정 안내 메일을 곧 받으실 거예요.'
      : '가능 일정 응답이 정상 제출되었습니다. 감사합니다.',
  });
});

router.get('/sign/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, m.name AS member_name, m.role, m.affiliation, m.type AS member_type,
           mt.id AS meeting_id, mt.title, mt.description, mt.location, mt.minutes_text, mt.confirmed_slot_id,
           mt.uploaded_minutes_path, mt.uploaded_minutes_original_name, mt.uploaded_minutes_uploaded_at,
           c.name AS committee_name
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.token = ? AND t.purpose = 'signature'
  `).get(req.params.token);
  if (token && token.uploaded_minutes_original_name) {
    token.uploaded_minutes_original_name = decodeOriginalName(token.uploaded_minutes_original_name);
  }
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  const slot = token.confirmed_slot_id ? db.prepare('SELECT * FROM meeting_slots WHERE id = ?').get(token.confirmed_slot_id) : null;
  const existing = db.prepare('SELECT * FROM signatures WHERE meeting_id = ? AND member_id = ?').get(token.meeting_id, token.member_id);
  res.render('public/signature', { token, slot, existing });
});

router.post('/sign/:token', async (req, res) => {
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

  let allExternalsSigned = false;
  try {
    const meeting = db.prepare(`
      SELECT mt.*, c.name AS committee_name, c.id AS committee_id
      FROM meetings mt JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ?
    `).get(token.meeting_id);
    if (meeting) {
      const externals = db.prepare(`SELECT * FROM members WHERE committee_id = ? AND type = 'external'`).all(meeting.committee_id);
      const signatures = db.prepare('SELECT * FROM signatures WHERE meeting_id = ?').all(meeting.id);
      const signedIds = new Set(signatures.map(s => s.member_id));
      allExternalsSigned = externals.length > 0 && externals.every(e => signedIds.has(e.id));

      if (allExternalsSigned) {
        const committee = db.prepare('SELECT * FROM committees WHERE id = ?').get(meeting.committee_id);
        const uploadedAbs = meeting.uploaded_minutes_path ? path.join(__dirname, '..', meeting.uploaded_minutes_path) : null;
        const outDir = path.join(__dirname, '..', 'data', 'pdfs');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `final_${meeting.id}_${Date.now()}.pdf`);
        const result = await generateFinalSignedPDF({
          meeting, committee, externals, signatures,
          uploadedPath: uploadedAbs,
          uploadedOriginalName: meeting.uploaded_minutes_original_name,
          outputPath: outPath,
        });
        const relOut = path.relative(path.join(__dirname, '..'), result.outputPath).replace(/\\/g, '/');
        db.prepare(`UPDATE meetings SET final_pdf_path = ?, final_pdf_generated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(relOut, meeting.id);
      }
    }
  } catch (err) {
    console.error('[auto final-pdf]', err);
  }

  res.render('public/thanks', {
    title: '서명이 완료되었습니다',
    message: allExternalsSigned
      ? '회의록 전자서명이 정상 등록되었습니다. 모든 외부위원의 서명이 완료되어 최종 회의록 PDF가 자동 생성되었습니다.'
      : '회의록 전자서명이 정상 등록되었습니다. 감사합니다.',
  });
});

module.exports = router;
