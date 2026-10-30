const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { getTimetable, busyAt, getTimetableImageUrl } = require('../services/timetable');
const notify = require('../services/notify');
const mailer = require('../services/mailer');
const { generateFinalSignedPDF } = require('../services/finalpdf');
const minutesStore = require('../services/minutes_store');

const router = express.Router();

function decodeOriginalName(name) {
  if (!name) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (!/[�]/.test(fixed)) return fixed;
  } catch (e) {}
  return name;
}

function fmtKorDateTime(dt) {
  const d = new Date(String(dt).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(dt);
  const day = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${day}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 회의가 확정/완료된 경우 투표를 막고 안내 페이지를 띄운다. (막았으면 true)
function blockIfNotScheduling(token, res) {
  if (!token.meeting_status || token.meeting_status === 'scheduling') return false;
  let whenStr = '';
  if (token.confirmed_slot_id) {
    const cs = db.prepare('SELECT start_time FROM meeting_slots WHERE id = ?').get(token.confirmed_slot_id);
    if (cs) whenStr = fmtKorDateTime(cs.start_time);
  }
  res.render('public/thanks', {
    title: '일정이 확정된 회의예요',
    message: (whenStr ? `회의 일정이 ${whenStr} 로 확정되었습니다. ` : '회의 일정이 확정되었습니다. ')
      + '더 이상 응답을 받지 않아요. (확정 안내는 메일/문자로 받으실 수 있어요)',
  });
  return true;
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
  const info = minutesStore.ensureMinutesFile(token.meeting_id);
  if (!info) return res.status(404).render('public/error', { message: '파일을 찾을 수 없습니다.' });
  const cleanName = decodeOriginalName(token.uploaded_minutes_original_name) || path.basename(info.absPath);
  res.download(info.absPath, cleanName);
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
  const info = minutesStore.ensureMinutesFile(token.meeting_id);
  if (!info) return res.status(404).send('File missing');
  const ext = info.ext;
  if (ext === '.pdf') res.type('application/pdf');
  else if (ext === '.hwp' || ext === '.hwpx') res.type('application/x-hwp');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(info.absPath)) + '"');
  res.sendFile(info.absPath);
});

router.get('/avail/:token', (req, res) => {
  const token = db.prepare(`
    SELECT t.*, m.name AS member_name, m.role, m.affiliation, m.type AS member_type, m.sabun,
           mt.id AS meeting_id, mt.title, mt.description, mt.location, mt.duration_minutes,
           mt.status AS meeting_status, mt.confirmed_slot_id,
           c.name AS committee_name
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.token = ? AND t.purpose = 'availability'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  if (blockIfNotScheduling(token, res)) return; // 확정/완료되면 투표 페이지 차단
  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(token.meeting_id);
  const responses = db.prepare(`
    SELECT * FROM slot_responses WHERE member_id = ? AND slot_id IN (SELECT id FROM meeting_slots WHERE meeting_id = ?)
  `).all(token.member_id, token.meeting_id);
  res.render('public/availability', { token, slots, responses });
});

router.post('/avail/:token', async (req, res) => {
  const token = db.prepare(`
    SELECT t.*, m.name AS member_name, m.role, m.affiliation, m.type AS member_type, m.sabun,
           mt.id AS meeting_id, mt.title, mt.description, mt.location, mt.duration_minutes,
           mt.status AS meeting_status, mt.confirmed_slot_id,
           c.name AS committee_name
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE t.token = ? AND t.purpose = 'availability'
  `).get(req.params.token);
  if (!token) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });
  if (blockIfNotScheduling(token, res)) return; // 확정/완료되면 응답 저장 차단
  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(token.meeting_id);

  // 모든 후보 일정에 응답했는지 검증 — 하나라도 빠지면 저장하지 않고 다시 표시
  const missing = slots.filter(s => !req.body[`slot_${s.id}`]);
  if (missing.length > 0) {
    const picks = slots
      .filter(s => req.body[`slot_${s.id}`])
      .map(s => ({ slot_id: s.id, response: req.body[`slot_${s.id}`], auto_filled: 0 }));
    return res.status(400).render('public/availability', {
      token, slots, responses: picks,
      error: `모든 후보 일정에 가능/불가능을 표시해야 제출할 수 있어요. (남은 항목 ${missing.length}개)`,
    });
  }

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
  // 자동 확정은 하지 않음. 전원 응답 시 운영자에게 "확정 요청" 알림만 보냄.
  try { await notify.maybeAutoConfirmMeeting(token.meeting_id, baseUrl); } catch (e) {}

  res.render('public/thanks', {
    title: '응답이 등록되었습니다',
    message: '가능 일정 응답이 정상 제출되었습니다. 감사합니다.',
  });
});

// 공유 투표 링크: 한 주소를 전체에게 보내고, 받는 사람이 본인 이름을 골라 응답
router.get('/g/:code', (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.id, mt.committee_id, mt.title, mt.description, mt.location, mt.duration_minutes, mt.status,
           c.name AS committee_name
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.group_token = ?
  `).get(req.params.code);
  if (!meeting) return res.status(404).render('public/error', { message: '유효하지 않은 링크입니다.' });

  const members = db.prepare(`SELECT id, name, type, role, affiliation FROM members WHERE committee_id = ? ORDER BY id`).all(meeting.committee_id);
  const tokenRows = db.prepare(`SELECT member_id, token FROM member_tokens WHERE meeting_id = ? AND purpose = 'availability'`).all(meeting.id);
  const tokenByMember = {};
  tokenRows.forEach(t => { tokenByMember[t.member_id] = t.token; });

  // 회의 생성 후 추가된 위원 등 토큰이 없는 경우 즉석 생성
  const { v4: uuidv4 } = require('uuid');
  const insertToken = db.prepare(`INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'availability')`);
  for (const m of members) {
    if (!tokenByMember[m.id]) {
      const tk = uuidv4();
      insertToken.run(m.id, meeting.id, tk);
      tokenByMember[m.id] = tk;
    }
  }

  const responded = db.prepare(`SELECT DISTINCT member_id FROM slot_responses WHERE auto_filled = 0 AND slot_id IN (SELECT id FROM meeting_slots WHERE meeting_id = ?)`).all(meeting.id);
  const respondedSet = new Set(responded.map(r => r.member_id));

  res.render('public/avail_group', { meeting, members, tokenByMember, respondedSet });
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
      const externals = db.prepare(`SELECT * FROM members WHERE committee_id = ? AND type IN ('external', 'student')`).all(meeting.committee_id);
      const signatures = db.prepare('SELECT * FROM signatures WHERE meeting_id = ?').all(meeting.id);
      const signedIds = new Set(signatures.map(s => s.member_id));
      allExternalsSigned = externals.length > 0 && externals.every(e => signedIds.has(e.id));

      if (allExternalsSigned) {
        const committee = db.prepare('SELECT * FROM committees WHERE id = ?').get(meeting.committee_id);
        const uploadedAbs = meeting.uploaded_minutes_path ? (minutesStore.ensureMinutesFile(meeting.id) || {}).absPath || null : null;
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
