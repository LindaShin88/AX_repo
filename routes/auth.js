const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database');

const router = express.Router();

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'hansung.ac.kr')
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
  };
  res.redirect(op.role === 'super_admin' ? '/admin/users' : '/admin');
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

  const exists = db.prepare('SELECT 1 FROM operators WHERE username = ? OR email = ?').get(username, email);
  if (exists) return fail('이미 사용중인 아이디 또는 이메일입니다.');

  const hash = await bcrypt.hash(password, 10);
  db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status)
    VALUES (?, ?, ?, ?, ?, 'operator', 'pending')
  `).run(username, hash, name, department || null, email);

  res.redirect('/admin/login?info=registered');
});

router.get('/profile', (req, res) => {
  if (!req.session.operatorId) return res.redirect('/admin/login');
  res.render('admin/profile', { error: null, info: null });
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
