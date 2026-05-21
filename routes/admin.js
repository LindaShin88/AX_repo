const express = require('express');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');
const { parseUploadedFile } = require('../services/timetable_parser');
const { fetchTimetableRaw, fcEventsToTimetable } = require('../services/timetable');
const hansungOc = require('../services/hansung_oc');
const hansungDirectory = require('../services/hansung_directory');
const mailer = require('../services/mailer');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'timetables');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
      cb(null, `member_${req.params.memberId}_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const { suggestTopSlots, defaultConstraints } = require('../services/scheduler');
const { getTimetable, getTimetableImageUrl, DAY_KO } = require('../services/timetable');
const notify = require('../services/notify');
const { generateMinutesPDF } = require('../services/pdf');
const { manualArsTrigger } = require('../services/escalation');
const { getOperatorStats, getMeetingProgress } = require('../services/stats');

const router = express.Router();

function normalizeDate(s) {
  if (!s) return '';
  const m = String(s).replace(/\./g, '-').replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})\.?$/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
}

function parseTimeToken(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const mins = m[2] ? parseInt(m[2]) : 0;
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
  return { h, m: mins };
}

function parseDateOverrides(text) {
  if (!text) return {};
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d{4}[-.\/]\d{1,2}[-.\/]\d{1,2}\.?)\s*[:\s]\s*(.+)$/);
    if (!m) continue;
    const date = normalizeDate(m[1].replace(/\.$/, ''));
    if (!date) continue;
    const tokens = m[2].split(/[\s,]+/).filter(Boolean).map(parseTimeToken).filter(Boolean);
    if (tokens.length) result[date] = tokens;
  }
  return result;
}

router.use(requireAdmin);

router.get('/', (req, res) => {
  if (req.session.operator?.role === 'super_admin') return res.redirect('/admin/users');
  const opId = req.session.operatorId;
  const committees = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.id) AS member_count,
           (SELECT COUNT(*) FROM meetings mt WHERE mt.committee_id = c.id) AS meeting_count,
           (SELECT COUNT(*) FROM meetings mt WHERE mt.committee_id = c.id AND mt.status = 'scheduling') AS active_count
    FROM committees c WHERE c.operator_id = ? ORDER BY c.created_at DESC
  `).all(opId);
  const recentMeetings = db.prepare(`
    SELECT mt.*, c.name AS committee_name
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ? ORDER BY mt.created_at DESC LIMIT 8
  `).all(opId);
  const stats = getOperatorStats(opId);
  res.render('admin/dashboard', { committees, recentMeetings, stats });
});

router.get('/insights', (req, res) => {
  if (req.session.operator?.role === 'super_admin') return res.redirect('/admin/users');
  const stats = getOperatorStats(req.session.operatorId);
  res.render('admin/insights', { stats });
});

router.get('/committees/new', (req, res) => {
  res.render('admin/committee_new');
});

router.post('/committees', (req, res) => {
  const { name, description, quorum } = req.body;
  const info = db.prepare(`
    INSERT INTO committees (name, description, operator_id, quorum) VALUES (?, ?, ?, ?)
  `).run(name, description || '', req.session.operatorId, parseInt(quorum) || 0);
  res.redirect(`/admin/committees/${info.lastInsertRowid}`);
});

router.get('/committees/:id', (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ? ORDER BY type, id').all(committee.id);
  const meetings = db.prepare(`
    SELECT mt.*,
           (SELECT COUNT(*) FROM meeting_slots ms WHERE ms.meeting_id = mt.id) AS slot_count,
           (SELECT COUNT(DISTINCT sr.member_id) FROM slot_responses sr
              JOIN meeting_slots ms ON ms.id = sr.slot_id
              WHERE ms.meeting_id = mt.id) AS responded_count
    FROM meetings mt WHERE mt.committee_id = ? ORDER BY mt.created_at DESC
  `).all(committee.id);
  const syncResult = req.session.lastSyncResult && req.session.lastSyncResult.committeeId === committee.id ? req.session.lastSyncResult : null;
  if (syncResult && req.query.sync !== 'done') {
    delete req.session.lastSyncResult;
  }
  const autoCrawl = req.session.lastFacultyAutoCrawl && req.session.lastFacultyAutoCrawl.committeeId === committee.id
    ? req.session.lastFacultyAutoCrawl : null;
  if (autoCrawl) delete req.session.lastFacultyAutoCrawl;
  const memberAddIssue = req.session.lastMemberAddIssue && req.session.lastMemberAddIssue.committeeId === committee.id
    ? req.session.lastMemberAddIssue : null;
  if (memberAddIssue) delete req.session.lastMemberAddIssue;
  res.render('admin/committee_detail', {
    committee, members, meetings,
    fromNewMeeting: req.query.from === 'new-meeting',
    syncResult,
    autoCrawl,
    memberAddIssue,
    errFlag: req.query.err || null,
  });
});

const VALID_MEMBER_TYPES = new Set(['faculty', 'staff', 'student', 'external']);

router.post('/committees/:id/members', async (req, res) => {
  const committee = db.prepare('SELECT id FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  if (!name || !email) return res.redirect(`/admin/committees/${req.params.id}?err=name-email-required`);

  let type = String(req.body.type || 'faculty').trim();
  if (!VALID_MEMBER_TYPES.has(type)) type = 'faculty';

  const phone = String(req.body.phone || '').trim() || null;
  const sabun = String(req.body.sabun || '').trim() || null;
  const role = String(req.body.role || '').trim() || null;
  const affiliation = String(req.body.affiliation || '').trim() || null;

  const info = db.prepare(`
    INSERT INTO members (committee_id, name, email, phone, type, sabun, role, affiliation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(committee.id, name, email, phone, type, sabun, role, affiliation);
  const memberId = info.lastInsertRowid;

  if (type === 'faculty') {
    const yearhakgi = hansungOc.dateToYearHakgi(new Date());
    try {
      const result = await hansungOc.findProfessorClasses(yearhakgi, name, { concurrency: 6 });
      const cacheEntries = result.timetable.map(e => ({
        day: e.day, start: e.start, end: e.end, title: e.title,
        location: e.location, bunban: e.bunban, major: e.major, majorCode: e.majorCode,
      }));
      const meta = {
        yearhakgi,
        crawledAt: new Date().toISOString(),
        matchedMajors: result.matchedMajors,
        classCount: result.classes.length,
        slotCount: cacheEntries.length,
        searchName: name,
      };
      db.prepare(`
        UPDATE members
           SET timetable_cache = ?, timetable_source = 'hansung_oc',
               timetable_fetched_at = CURRENT_TIMESTAMP, timetable_meta = ?
         WHERE id = ?
      `).run(JSON.stringify(cacheEntries), JSON.stringify(meta), memberId);
      req.session.lastFacultyAutoCrawl = {
        committeeId: committee.id, memberId, name,
        yearhakgi, matchedMajors: result.matchedMajors,
        classCount: result.classes.length, slotCount: cacheEntries.length,
      };
    } catch (err) {
      req.session.lastFacultyAutoCrawl = {
        committeeId: committee.id, memberId, name, yearhakgi,
        error: err.message,
      };
    }
  }

  const newMember = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  const openMeetings = db.prepare(`
    SELECT * FROM meetings WHERE committee_id = ? AND status = 'scheduling'
  `).all(committee.id);
  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  const issued = [];
  for (const mt of openMeetings) {
    const meetingFull = db.prepare(`
      SELECT mt.*, c.name AS committee_name FROM meetings mt
      JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ?
    `).get(mt.id);
    const token = uuidv4();
    db.prepare(`INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'availability')`)
      .run(memberId, mt.id, token);
    try { await notify.sendAvailabilityRequest(meetingFull, newMember, token, baseUrl); } catch (e) {}

    const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ?').all(mt.id);
    if (slots.length > 0) {
      const { getMemberTimetable } = require('../services/scheduler');
      const { busyAt } = require('../services/timetable');
      const tt = await getMemberTimetable(newMember, { referenceDate: new Date(mt.created_at) });
      if (tt && tt.length > 0) {
        const ins = db.prepare(`
          INSERT OR IGNORE INTO slot_responses (slot_id, member_id, response, auto_filled, note)
          VALUES (?, ?, ?, 1, ?)
        `);
        for (const sl of slots) {
          const conflict = busyAt(tt, sl.start_time, sl.end_time);
          if (conflict) {
            ins.run(sl.id, memberId, 'unavailable', `시간표 자동 인식: ${conflict.title} (${conflict.start}~${conflict.end})`);
          }
        }
      }
    }
    issued.push({ meetingId: mt.id, title: mt.title });
  }
  if (issued.length > 0) {
    req.session.lastMemberAddIssue = { committeeId: committee.id, memberName: name, meetings: issued };
  }

  res.redirect(`/admin/committees/${committee.id}`);
});

router.post('/committees/:id/members/:memberId/delete', (req, res) => {
  db.prepare('DELETE FROM members WHERE id = ? AND committee_id = ?').run(req.params.memberId, req.params.id);
  res.redirect(`/admin/committees/${req.params.id}`);
});

router.get('/committees/:id/members/:memberId/timetable', (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND committee_id = ?')
    .get(req.params.memberId, committee.id);
  if (!member) return res.status(404).send('Not found');
  let events = [];
  if (member.timetable_cache) {
    try { events = JSON.parse(member.timetable_cache) || []; } catch (e) {}
  }
  res.render('admin/timetable_edit', {
    committee, member, events,
    imagePath: member.timetable_image_path,
    source: member.timetable_source,
    parseNote: req.query.note || null,
  });
});

router.post('/committees/:id/members/:memberId/timetable/upload', upload.single('timetable_file'), (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND committee_id = ?')
    .get(req.params.memberId, committee.id);
  if (!member) return res.status(404).send('Not found');
  if (!req.file) return res.redirect(`/admin/committees/${committee.id}/members/${member.id}/timetable?note=no-file`);

  const parsed = parseUploadedFile(req.file.path, req.file.mimetype);
  const relPath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
  db.prepare(`UPDATE members SET timetable_image_path = ?, timetable_source = ?, timetable_cache = ?, timetable_fetched_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(relPath, parsed.source, JSON.stringify(parsed.events || []), member.id);

  const note = parsed.events && parsed.events.length > 0
    ? `parsed-${parsed.events.length}`
    : (parsed.note ? 'manual-entry' : 'no-events');
  res.redirect(`/admin/committees/${committee.id}/members/${member.id}/timetable?note=${note}`);
});

router.post('/committees/:id/members/:memberId/timetable/save', (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND committee_id = ?')
    .get(req.params.memberId, committee.id);
  if (!member) return res.status(404).send('Not found');

  const days = [].concat(req.body.day || []);
  const starts = [].concat(req.body.start || []);
  const ends = [].concat(req.body.end || []);
  const titles = [].concat(req.body.title || []);

  const events = [];
  for (let i = 0; i < days.length; i++) {
    const day = parseInt(days[i]);
    const start = String(starts[i] || '').trim();
    const end = String(ends[i] || '').trim();
    const title = String(titles[i] || '').trim() || '수업';
    if (isNaN(day) || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) continue;
    events.push({ day, start, end, title });
  }

  db.prepare(`UPDATE members SET timetable_cache = ?, timetable_fetched_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(JSON.stringify(events), member.id);
  res.redirect(`/admin/committees/${committee.id}/members/${member.id}/timetable?note=saved-${events.length}`);
});

router.post('/committees/:id/members/:memberId/timetable/clear', (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  db.prepare(`UPDATE members SET timetable_cache = NULL, timetable_image_path = NULL, timetable_source = NULL, timetable_fetched_at = NULL WHERE id = ? AND committee_id = ?`)
    .run(req.params.memberId, committee.id);
  res.redirect(`/admin/committees/${committee.id}/members/${req.params.memberId}/timetable`);
});

router.get('/hansung-cookie', (req, res) => {
  const internalMembers = db.prepare(`
    SELECT m.name, m.sabun FROM members m
    JOIN committees c ON c.id = m.committee_id
    WHERE c.operator_id = ? AND m.type = 'internal' AND m.sabun IS NOT NULL
    GROUP BY m.sabun LIMIT 5
  `).all(req.session.operatorId);
  res.render('admin/hansung_cookie', {
    hasCookie: !!req.session.hansungCookie,
    cookieMeta: req.session.hansungCookieMeta || null,
    testResult: null,
    sampleMembers: internalMembers,
  });
});

router.post('/hansung-cookie/save', (req, res) => {
  const raw = (req.body.cookie || '').trim();
  if (!raw) return res.redirect('/admin/hansung-cookie?err=empty');
  req.session.hansungCookie = raw;
  req.session.hansungCookieMeta = { savedAt: new Date().toISOString(), lastTest: null };
  res.redirect('/admin/hansung-cookie?saved=1');
});

router.post('/hansung-cookie/clear', (req, res) => {
  delete req.session.hansungCookie;
  delete req.session.hansungCookieMeta;
  res.redirect('/admin/hansung-cookie?cleared=1');
});

router.post('/hansung-cookie/test', async (req, res) => {
  const sabun = (req.body.sabun || '').trim();
  if (!sabun) return res.redirect('/admin/hansung-cookie?err=no-sabun');
  if (!req.session.hansungCookie) return res.redirect('/admin/hansung-cookie?err=no-cookie');
  const result = await fetchTimetableRaw(sabun, req.session.hansungCookie);
  const internalMembers = db.prepare(`
    SELECT m.name, m.sabun FROM members m
    JOIN committees c ON c.id = m.committee_id
    WHERE c.operator_id = ? AND m.type = 'internal' AND m.sabun IS NOT NULL
    GROUP BY m.sabun LIMIT 5
  `).all(req.session.operatorId);
  const events = result.ok ? fcEventsToTimetable(result.events) : [];
  req.session.hansungCookieMeta = {
    ...(req.session.hansungCookieMeta || {}),
    lastTest: new Date().toISOString(),
    lastTestOk: result.ok,
    lastTestReason: result.reason || null,
  };
  res.render('admin/hansung_cookie', {
    hasCookie: true,
    cookieMeta: req.session.hansungCookieMeta,
    testResult: { sabun, ok: result.ok, reason: result.reason, events, raw: result.raw },
    sampleMembers: internalMembers,
  });
});

router.post('/committees/:id/timetable-sync', async (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  if (!req.session.hansungCookie) return res.redirect('/admin/hansung-cookie?err=no-cookie&from=' + committee.id);

  const targets = db.prepare(`
    SELECT id, name, sabun FROM members WHERE committee_id = ? AND type = 'internal' AND sabun IS NOT NULL AND sabun != ''
  `).all(committee.id);

  const results = [];
  for (const m of targets) {
    const r = await fetchTimetableRaw(m.sabun, req.session.hansungCookie);
    if (r.ok) {
      const events = fcEventsToTimetable(r.events);
      db.prepare(`UPDATE members SET timetable_cache = ?, timetable_source = 'crawl', timetable_fetched_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(JSON.stringify(events), m.id);
      results.push({ id: m.id, name: m.name, sabun: m.sabun, ok: true, count: events.length });
    } else {
      results.push({ id: m.id, name: m.name, sabun: m.sabun, ok: false, reason: r.reason });
    }
  }
  req.session.lastSyncResult = { committeeId: committee.id, at: new Date().toISOString(), results };
  res.redirect(`/admin/committees/${committee.id}?sync=done`);
});

router.get('/lookup-professor', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.json({ matches: [], reason: 'empty-name' });
  try {
    const result = await hansungDirectory.lookupProfessor(name);
    res.json(result);
  } catch (e) {
    res.json({ matches: [], reason: 'error', error: e.message });
  }
});

router.get('/settings/smtp', (req, res) => {
  const cfg = mailer.getSmtpConfig();
  res.render('admin/smtp_settings', {
    cfg,
    configured: mailer.isSmtpConfigured(),
    publicBaseUrl: mailer.getPublicBaseUrl(),
    currentHost: `${req.protocol}://${req.get('host')}`,
    flash: req.session.smtpFlash || null,
  });
  delete req.session.smtpFlash;
});

router.post('/settings/smtp/save', (req, res) => {
  mailer.setSmtpConfig({
    host: req.body.host || '',
    port: req.body.port || '587',
    user: req.body.user || '',
    pass: req.body.pass || '',
    from: req.body.from || req.body.user || '',
    secure: req.body.secure === 'on' ? 'true' : 'false',
  });
  if (req.body.public_base_url !== undefined) {
    mailer.setPublicBaseUrl(req.body.public_base_url);
  }
  req.session.smtpFlash = { kind: 'ok', message: 'SMTP 설정 저장됨' };
  res.redirect('/admin/settings/smtp');
});

router.post('/settings/smtp/test', async (req, res) => {
  const verify = await mailer.verifySmtp();
  if (!verify.ok) {
    req.session.smtpFlash = { kind: 'err', message: `SMTP 검증 실패: ${verify.reason} ${verify.error || ''}` };
    return res.redirect('/admin/settings/smtp');
  }
  const to = (req.body.test_to || '').trim();
  if (!to) {
    req.session.smtpFlash = { kind: 'ok', message: 'SMTP 연결 OK (테스트 수신자 없음)' };
    return res.redirect('/admin/settings/smtp');
  }
  const result = await mailer.sendMail({
    to,
    subject: '[테스트] 위원회 자동화 플랫폼 SMTP 연결 확인',
    text: `이 메일은 SMTP 설정 테스트입니다.\n\n발송 시각: ${new Date().toLocaleString('ko-KR')}\n\n이 메일이 잘 도착했다면 SMTP 설정이 정상입니다.`,
  });
  if (result.ok) {
    req.session.smtpFlash = { kind: 'ok', message: `테스트 메일 발송 OK → ${to}` };
  } else {
    req.session.smtpFlash = { kind: 'err', message: `발송 실패: ${result.reason} ${result.error || ''}` };
  }
  res.redirect('/admin/settings/smtp');
});

router.get('/timetables/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const fp = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

router.get('/committees/:id/meetings/new', async (req, res) => {
  const committee = db.prepare('SELECT * FROM committees WHERE id = ? AND operator_id = ?')
    .get(req.params.id, req.session.operatorId);
  if (!committee) return res.status(404).send('Not found');
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(committee.id);
  res.render('admin/meeting_new', { committee, members, defaults: defaultConstraints() });
});

router.post('/committees/:id/meetings', async (req, res) => {
  const { title, description, location, duration_minutes } = req.body;
  const committeeId = req.params.id;
  const morningHours = [].concat(req.body.morning_hours || []).map(parseTimeToken).filter(Boolean);
  const afternoonHours = [].concat(req.body.afternoon_hours || []).map(parseTimeToken).filter(Boolean);
  const constraints = {
    window: {
      start: normalizeDate(req.body.window_start) || req.body.window_start,
      end: normalizeDate(req.body.window_end) || req.body.window_end,
    },
    excludedDates: (req.body.excluded_dates || '').split(/[\s,]+/).map(normalizeDate).filter(Boolean),
    morningHours: morningHours.length > 0 ? morningHours : [{ h: 10, m: 0 }],
    afternoonHours: afternoonHours.length > 0 ? afternoonHours : [{ h: 14, m: 0 }, { h: 15, m: 0 }],
    dateOverrides: parseDateOverrides(req.body.date_overrides),
  };
  const channelsArr = [].concat(req.body.notify_channels || ['email','sms']);
  const channels = channelsArr.length ? channelsArr.join(',') : 'email,sms';
  const arsAfter = parseInt(req.body.ars_after_minutes) || 0;
  const info = db.prepare(`
    INSERT INTO meetings (committee_id, title, description, location, duration_minutes, schedule_constraints, notify_channels, ars_after_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(committeeId, title, description || '', location || '', parseInt(duration_minutes) || 60,
         JSON.stringify(constraints), channels, arsAfter);
  const meetingId = info.lastInsertRowid;

  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(committeeId);
  const meetingCreatedAt = new Date();
  const suggestedResult = await suggestTopSlots(members, {
    durationMinutes: parseInt(duration_minutes) || 60,
    constraints,
    topN: 6,
    referenceDate: meetingCreatedAt,
  });
  const suggested = suggestedResult.slots || [];
  const insertSlot = db.prepare('INSERT INTO meeting_slots (meeting_id, start_time, end_time, suggested_score) VALUES (?, ?, ?, ?)');
  const insertResp = db.prepare(`
    INSERT OR IGNORE INTO slot_responses (slot_id, member_id, response, auto_filled, note)
    VALUES (?, ?, ?, 1, ?)
  `);
  const slotIds = [];
  for (const s of suggested) {
    const r = insertSlot.run(meetingId, s.start, s.end, s.score);
    slotIds.push(r.lastInsertRowid);
  }

  if (suggestedResult.debug && suggestedResult.debug.fallback) {
    const { getMemberTimetable } = require('../services/scheduler');
    const { busyAt } = require('../services/timetable');
    for (const m of members) {
      const tt = await getMemberTimetable(m, { referenceDate: meetingCreatedAt });
      if (!tt || tt.length === 0) continue;
      for (let i = 0; i < suggested.length; i++) {
        const slot = suggested[i];
        const slotId = slotIds[i];
        const conflict = busyAt(tt, slot.start, slot.end);
        if (conflict) {
          insertResp.run(slotId, m.id, 'unavailable', `시간표 자동 인식: ${conflict.title} (${conflict.start}~${conflict.end})`);
        }
      }
    }
  }
  req.session.lastMeetingDebug = { meetingId, ...suggestedResult.debug };

  const insertToken = db.prepare(`
    INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'availability')
  `);
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ?
  `).get(meetingId);
  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  for (const m of members) {
    const token = uuidv4();
    insertToken.run(m.id, meetingId, token);
    await notify.sendAvailabilityRequest(meeting, m, token, baseUrl);
  }

  res.redirect(`/admin/meetings/${meetingId}`);
});

router.get('/meetings/:id', (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name, c.id AS committee_id, c.quorum
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(meeting.id);
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(meeting.committee_id);
  const responses = db.prepare(`
    SELECT sr.*, ms.start_time, ms.end_time FROM slot_responses sr
    JOIN meeting_slots ms ON ms.id = sr.slot_id WHERE ms.meeting_id = ?
  `).all(meeting.id);
  const tokens = db.prepare(`
    SELECT * FROM member_tokens WHERE meeting_id = ?
  `).all(meeting.id);
  const signatures = db.prepare('SELECT * FROM signatures WHERE meeting_id = ?').all(meeting.id);
  const notifications = db.prepare(`
    SELECT n.*, m.name AS member_name FROM notifications n
    LEFT JOIN members m ON m.id = n.member_id
    WHERE n.meeting_id = ? ORDER BY n.sent_at DESC
  `).all(meeting.id);
  const confirmedSlot = meeting.confirmed_slot_id
    ? db.prepare('SELECT * FROM meeting_slots WHERE id = ?').get(meeting.confirmed_slot_id)
    : null;

  const slotMatrix = slots.map(slot => {
    const cells = members.map(m => {
      const r = responses.find(rs => rs.slot_id === slot.id && rs.member_id === m.id);
      return { member: m, response: r };
    });
    const availableCount = cells.filter(c => c.response?.response === 'available').length;
    const unavailableCount = cells.filter(c => c.response?.response === 'unavailable').length;
    const noResp = cells.filter(c => !c.response).length;
    return { slot, cells, availableCount, unavailableCount, noResp };
  });

  const progress = getMeetingProgress(meeting.id);
  res.render('admin/meeting_detail', {
    meeting, slots, members, responses, tokens, signatures, notifications,
    confirmedSlot, slotMatrix, baseUrl: `${req.protocol}://${req.get('host')}`,
    getTimetableImageUrl, progress,
    actionFlag: req.query.action || null,
    smtpConfigured: mailer.isSmtpConfigured(),
  });
});

router.post('/meetings/:id/remind', async (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const members = db.prepare(`
    SELECT m.* FROM members m
    LEFT JOIN slot_responses sr ON sr.member_id = m.id
      AND sr.slot_id IN (SELECT id FROM meeting_slots WHERE meeting_id = ?)
      AND sr.auto_filled = 0
    WHERE m.committee_id = ? GROUP BY m.id HAVING COUNT(sr.id) = 0
  `).all(meeting.id, meeting.committee_id);
  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  for (const m of members) {
    const token = db.prepare(`
      SELECT token FROM member_tokens WHERE meeting_id = ? AND member_id = ? AND purpose = 'availability'
    `).get(meeting.id, m.id);
    if (token) await notify.sendReminder(meeting, m, token.token, baseUrl);
  }
  res.redirect(`/admin/meetings/${meeting.id}?action=remind-sent`);
});

router.post('/meetings/:id/confirm', async (req, res) => {
  const { slot_id } = req.body;
  const force = req.body.force === '1';
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const slot = db.prepare('SELECT * FROM meeting_slots WHERE id = ? AND meeting_id = ?').get(slot_id, meeting.id);
  if (!slot) return res.status(400).send('Invalid slot');
  db.prepare(`UPDATE meetings SET status = 'confirmed', confirmed_slot_id = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(slot.id, meeting.id);
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(meeting.committee_id);
  for (const m of members) {
    await notify.sendMeetingConfirmed(meeting, m, slot);
  }
  const operator = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.session.operatorId);
  if (operator && operator.email) {
    const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
    await notify.sendCreatorConfirmation(meeting, operator, slot, baseUrl);
  }
  res.redirect(`/admin/meetings/${meeting.id}?action=${force ? 'force-confirmed' : 'confirmed'}`);
});

router.post('/meetings/:id/minutes', (req, res) => {
  const { minutes_text } = req.body;
  const meeting = db.prepare(`
    SELECT mt.* FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  db.prepare('UPDATE meetings SET minutes_text = ? WHERE id = ?').run(minutes_text, meeting.id);
  res.redirect(`/admin/meetings/${meeting.id}`);
});

router.post('/meetings/:id/request-signatures', async (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(meeting.committee_id);
  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  const insertToken = db.prepare(`
    INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'signature')
  `);
  for (const m of members) {
    const existing = db.prepare(`
      SELECT * FROM member_tokens WHERE meeting_id = ? AND member_id = ? AND purpose = 'signature'
    `).get(meeting.id, m.id);
    let token;
    if (existing) {
      token = existing.token;
    } else {
      token = uuidv4();
      insertToken.run(m.id, meeting.id, token);
    }
    await notify.sendSignatureRequest(meeting, m, token, baseUrl);
  }
  res.redirect(`/admin/meetings/${meeting.id}`);
});

router.post('/meetings/:id/generate-pdf', async (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name, c.id AS committee_id FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const committee = db.prepare('SELECT * FROM committees WHERE id = ?').get(meeting.committee_id);
  const slot = meeting.confirmed_slot_id ? db.prepare('SELECT * FROM meeting_slots WHERE id = ?').get(meeting.confirmed_slot_id) : null;
  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(meeting.committee_id);
  const signatures = db.prepare('SELECT * FROM signatures WHERE meeting_id = ?').all(meeting.id);
  const outDir = path.join(__dirname, '..', 'data', 'pdfs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `meeting_${meeting.id}_${Date.now()}.pdf`);
  await generateMinutesPDF({ meeting, committee, slot, members, signatures, outputPath: outPath });
  db.prepare(`UPDATE meetings SET pdf_path = ?, status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(outPath, meeting.id);
  res.redirect(`/admin/meetings/${meeting.id}`);
});

router.get('/meetings/:id/pdf', (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.* FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting || !meeting.pdf_path) return res.status(404).send('PDF not generated yet');
  res.download(meeting.pdf_path, `회의록_${meeting.id}.pdf`);
});

router.post('/meetings/:id/ars-now', (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.* FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const baseUrl = mailer.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
  const count = manualArsTrigger(meeting.id, baseUrl);
  res.redirect(`/admin/meetings/${meeting.id}#ars-result-${count}`);
});

router.get('/meetings/:id/sms-send', (req, res) => {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name, c.id AS committee_id, c.operator_id
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE mt.id = ? AND c.operator_id = ?
  `).get(req.params.id, req.session.operatorId);
  if (!meeting) return res.status(404).send('Not found');
  const purpose = req.query.purpose || 'availability';
  const rows = db.prepare(`
    SELECT n.*, m.name AS member_name, m.phone, m.type AS member_type
    FROM notifications n
    JOIN members m ON m.id = n.member_id
    WHERE n.meeting_id = ? AND n.channel = 'sms'
      AND n.type IN (?, 'reminder', 'meeting_confirmed', 'signature_request')
      AND m.phone IS NOT NULL
    ORDER BY n.sent_at DESC
  `).all(meeting.id, purpose === 'availability' ? 'availability_request' : purpose);
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.member_id)) seen.set(r.member_id, r);
  }
  const messages = [...seen.values()];
  res.render('admin/sms_send', { meeting, messages, purpose });
});

router.get('/notifications', (req, res) => {
  const notifs = db.prepare(`
    SELECT n.*, m.name AS member_name, mt.title AS meeting_title, c.name AS committee_name
    FROM notifications n
    LEFT JOIN members m ON m.id = n.member_id
    LEFT JOIN meetings mt ON mt.id = n.meeting_id
    LEFT JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ?
    ORDER BY n.sent_at DESC LIMIT 200
  `).all(req.session.operatorId);
  res.render('admin/notifications', { notifications: notifs });
});

module.exports = router;
