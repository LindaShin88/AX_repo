const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database');
const { requireSuperAdmin } = require('../middleware/auth');
const { emailDomainOk, ALLOWED_DOMAINS } = require('./auth');
const { getOrgStats } = require('../services/stats');

const router = express.Router();
router.use(requireSuperAdmin);

router.get('/', (req, res) => {
  const pending = db.prepare(`SELECT * FROM operators WHERE status = 'pending' ORDER BY created_at DESC`).all();
  const active = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM committees c WHERE c.operator_id = o.id) AS committee_count,
           (SELECT name FROM operators WHERE id = o.approved_by) AS approver_name
    FROM operators o WHERE status = 'active' AND role = 'operator' ORDER BY o.approved_at DESC
  `).all();
  const others = db.prepare(`
    SELECT * FROM operators WHERE status IN ('rejected','disabled') ORDER BY created_at DESC
  `).all();
  const supers = db.prepare(`SELECT * FROM operators WHERE role = 'super_admin'`).all();
  const orgStats = getOrgStats();
  res.render('admin/users', { pending, active, others, supers, allowedDomains: ALLOWED_DOMAINS, orgStats });
});

router.post('/:id/approve', (req, res) => {
  const id = req.params.id;
  db.prepare(`
    UPDATE operators SET status = 'active', approved_by = ?, approved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(req.session.operatorId, id);
  res.redirect('/admin/users');
});

router.post('/:id/reject', (req, res) => {
  const id = req.params.id;
  const reason = req.body.reason || '';
  db.prepare(`
    UPDATE operators SET status = 'rejected', rejection_reason = ?
    WHERE id = ? AND status = 'pending'
  `).run(reason, id);
  res.redirect('/admin/users');
});

router.post('/:id/disable', (req, res) => {
  const id = req.params.id;
  db.prepare(`UPDATE operators SET status = 'disabled' WHERE id = ? AND role = 'operator'`).run(id);
  res.redirect('/admin/users');
});

router.post('/:id/reactivate', (req, res) => {
  const id = req.params.id;
  db.prepare(`
    UPDATE operators SET status = 'active', rejection_reason = NULL,
      approved_by = ?, approved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND role = 'operator'
  `).run(req.session.operatorId, id);
  res.redirect('/admin/users');
});

router.post('/:id/reset-password', async (req, res) => {
  const id = req.params.id;
  const tempPw = Math.random().toString(36).slice(-10) + 'A1!';
  const hash = await bcrypt.hash(tempPw, 10);
  db.prepare(`UPDATE operators SET password_hash = ? WHERE id = ? AND role = 'operator'`).run(hash, id);
  const op = db.prepare('SELECT username, name FROM operators WHERE id = ?').get(id);
  res.render('admin/users_action_result', {
    title: '임시 비밀번호 발급',
    message: `${op.name} (${op.username}) 의 임시 비밀번호: <strong class="text-rose-600 font-mono text-lg">${tempPw}</strong>`,
    note: '※ 이 비밀번호를 본인에게 안전하게 전달하시고, 첫 로그인 후 즉시 변경하도록 안내해주세요.'
  });
});

router.post('/add', async (req, res) => {
  const { username, password, name, email, department } = req.body;
  if (!username || !password || !name || !email) return res.redirect('/admin/users?error=missing');
  if (!emailDomainOk(email)) return res.redirect('/admin/users?error=domain');
  const exists = db.prepare('SELECT 1 FROM operators WHERE username = ? OR email = ?').get(username, email);
  if (exists) return res.redirect('/admin/users?error=duplicate');
  const hash = await bcrypt.hash(password, 10);
  db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, 'operator', 'active', ?, CURRENT_TIMESTAMP)
  `).run(username, hash, name, department || null, email, req.session.operatorId);
  res.redirect('/admin/users');
});

module.exports = router;
