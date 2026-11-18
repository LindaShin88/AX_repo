const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database');
const notify = require('../services/notify');
const { PRIVACY_POLICY_VERSION } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'hansung.kr')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function emailDomainOk(email) {
  if (!ALLOWED_DOMAINS.length) return true;
  const dom = (email || '').split('@')[1]?.toLowerCase();
  return dom && ALLOWED_DOMAINS.includes(dom);
}

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null, info: req.query.info || null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const op = db.prepare('SELECT * FROM operators WHERE username = ?').get(username);
  if (!op) return res.render('admin/login', { error: '아이디 또는 비밀번호가 잘못되었습니다.', info: null });
  const ok = await bcrypt.compare(password, op.password_hash);
  if (!ok) return res.render('admin/login', { error: '아이디 또는 비밀번호가 잘못되었습니다.', info: null });

  if (op.status === 'pending') {
    return res.render('admin/login', { error: '가입 신청이 아직 승인 대기중입니다. 시스템 관리자의 승인을 기다려주세요.', info: null });
  }
  if (op.status === 'rejected') {
    return res.render('admin/login', { error: `가입이 거절되었습니다. ${op.rejection_reason || ''}`, info: null });
  }
  if (op.status === 'disabled') {
    return res.render('admin/login', { error: '비활성화된 계정입니다. 시스템 관리자에게 문의하세요.', info: null });
  }

  req.session.operatorId = op.id;
  req.session.operator = {
    id: op.id, username: op.username, name: op.name,
    department: op.department, email: op.email, role: op.role, status: op.status,
    mail_sender_name: op.mail_sender_name || null,
    privacy_consent_version: op.privacy_consent_version || null,
  };
  // 개인정보 동의 안 한(또는 구버전) 운영자는 동의 화면으로. 동의하면 원래 가려던 곳으로.
  if (op.privacy_consent_version !== PRIVACY_POLICY_VERSION) return res.redirect('/admin/consent');
  res.redirect(op.role === 'super_admin' ? '/admin/users' : '/admin');
});

// 개인정보처리방침 전문 (로그인 없이도 열람 가능)
router.get('/privacy', (req, res) => {
  res.render('admin/privacy');
});

// 기존 운영자 동의 게이트
router.get('/consent', (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  res.render('admin/consent', { error: null });
});

router.post('/consent', (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  if (!req.body.agree_privacy) {
    return res.render('admin/consent', { error: '계속하려면 동의가 필요합니다.' });
  }
  db.prepare('UPDATE operators SET privacy_consent_at = CURRENT_TIMESTAMP, privacy_consent_version = ? WHERE id = ?')
    .run(PRIVACY_POLICY_VERSION, req.session.operatorId);
  if (req.session.operator) req.session.operator.privacy_consent_version = PRIVACY_POLICY_VERSION;
  res.redirect(req.session.operator?.role === 'super_admin' ? '/admin/users' : '/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/register', (req, res) => {
  res.render('admin/register', { error: null, form: {}, allowedDomains: ALLOWED_DOMAINS });
});

router.post('/register', async (req, res) => {
  const { username, password, password_confirm, name, email, department } = req.body;
  const form = { username, name, email, department };
  const fail = (msg) => res.render('admin/register', { error: msg, form, allowedDomains: ALLOWED_DOMAINS });

  if (!username || !password || !name || !email) return fail('모든 필수 항목을 입력해주세요.');
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) return fail('아이디는 영문/숫자/언더스코어 4-20자입니다.');
  if (password.length < 8) return fail('비밀번호는 8자 이상이어야 합니다.');
  if (password !== password_confirm) return fail('비밀번호 확인이 일치하지 않습니다.');
  if (!emailDomainOk(email)) return fail(`이메일은 ${ALLOWED_DOMAINS.map(d => '@' + d).join(', ')} 도메인만 가입 가능합니다.`);
  if (!req.body.agree_privacy) return fail('개인정보 수집·이용 동의가 필요합니다.');

  const exists = db.prepare('SELECT 1 FROM operators WHERE username = ? OR email = ?').get(username, email);
  if (exists) return fail('이미 사용중인 아이디 또는 이메일입니다.');

  const hash = await bcrypt.hash(password, 10);
  db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status, privacy_consent_at, privacy_consent_version)
    VALUES (?, ?, ?, ?, ?, 'operator', 'pending', CURRENT_TIMESTAMP, ?)
  `).run(username, hash, name, department || null, email, PRIVACY_POLICY_VERSION);

  // 새 가입 신청 시 관리자(super_admin)에게 "로그인 없이" 받는 알림 메일을 보낸다.
  // 메일 실패가 가입 자체를 막지 않도록 try/catch + fire-and-forget 처리.
  try {
    const admins = db.prepare(
      "SELECT name, email FROM operators WHERE role = 'super_admin' AND email IS NOT NULL AND TRIM(email) != ''"
    ).all();
    if (admins.length) {
      const when = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const subject = `[위원회 자동화] 새 가입 신청: ${name}님`;
      const content =
        `새로운 운영자 아이디 신청이 접수되었습니다. 승인/거절이 필요합니다.\n\n` +
        `• 이름: ${name}\n` +
        `• 아이디: ${username}\n` +
        `• 이메일: ${email}\n` +
        `• 소속: ${department || '-'}\n` +
        `• 신청 시각: ${when}\n\n` +
        `관리자 페이지에 로그인하여 '사용자 관리'에서 승인 또는 거절해 주세요.`;
      for (const a of admins) {
        notify.deliverEmail({ email: a.email, name: a.name }, subject, content).catch(() => {});
      }
    }
  } catch (e) { /* 알림 실패는 가입을 막지 않는다 */ }

  res.redirect('/admin/login?info=registered');
});

router.get('/profile', (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  res.render('admin/profile', { error: null, info: null });
});

router.post('/profile/info', (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const department = String(req.body.department || '').trim() || null;
  const senderName = String(req.body.mail_sender_name || '').trim() || null;
  if (!name || !email) return res.render('admin/profile', { error: '이름과 이메일은 필수입니다.', info: null });
  try {
    db.prepare('UPDATE operators SET name = ?, email = ?, department = ?, mail_sender_name = ? WHERE id = ?')
      .run(name, email, department, senderName, req.session.operatorId);
    if (req.session.operator) {
      req.session.operator.name = name;
      req.session.operator.email = email;
      req.session.operator.department = department;
      req.session.operator.mail_sender_name = senderName;
    }
    res.render('admin/profile', { error: null, info: '계정 정보가 변경되었습니다. 이제 회의 자동 확정/동률 알림이 이 이메일로 발송됩니다.' });
  } catch (e) {
    res.render('admin/profile', { error: '저장 실패: ' + (e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '이미 사용 중인 이메일입니다.' : e.message), info: null });
  }
});

router.post('/profile/password', async (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  const { current_password, new_password, new_password_confirm } = req.body;
  const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.session.operatorId);
  const ok = await bcrypt.compare(current_password, op.password_hash);
  if (!ok) return res.render('admin/profile', { error: '현재 비밀번호가 일치하지 않습니다.', info: null });
  if (!new_password || new_password.length < 8) return res.render('admin/profile', { error: '새 비밀번호는 8자 이상이어야 합니다.', info: null });
  if (new_password !== new_password_confirm) return res.render('admin/profile', { error: '새 비밀번호 확인이 일치하지 않습니다.', info: null });
  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE operators SET password_hash = ? WHERE id = ?').run(hash, req.session.operatorId);
  res.render('admin/profile', { error: null, info: '비밀번호가 변경되었습니다.' });
});

module.exports = { router, emailDomainOk, ALLOWED_DOMAINS };
