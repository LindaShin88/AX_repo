// 현재 시행 중인 개인정보처리방침 버전. 이 값을 바꾸면 전원 재동의가 필요해진다.
const PRIVACY_POLICY_VERSION = '2026-11-10';

function requireAdmin(req, res, next) {
  if (req.session && req.session.operatorId && req.session.operator?.status === 'active') {
    // 개인정보 수집·이용에 동의하지 않은(또는 구버전에 동의한) 운영자는 동의 화면으로 보낸다.
    if (req.session.operator?.privacy_consent_version !== PRIVACY_POLICY_VERSION) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ error: 'consent-required' });
      }
      return res.redirect('/admin/consent');
    }
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/admin/login');
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.operator?.role === 'super_admin' && req.session.operator?.status === 'active') {
    if (req.session.operator?.privacy_consent_version !== PRIVACY_POLICY_VERSION) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ error: 'consent-required' });
      }
      return res.redirect('/admin/consent');
    }
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return res.status(403).render('public/error', { message: '관리자만 접근 가능합니다.' });
}

function attachAdmin(req, res, next) {
  res.locals.operator = req.session?.operator || null;
  res.locals.currentPath = req.path;
  next();
}

module.exports = { requireAdmin, requireSuperAdmin, attachAdmin, PRIVACY_POLICY_VERSION };
