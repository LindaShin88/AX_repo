function requireAdmin(req, res, next) {
  if (req.session && req.session.operatorId && req.session.operator?.status === 'active') return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/admin/login');
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.operator?.role === 'super_admin' && req.session.operator?.status === 'active') return next();
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

module.exports = { requireAdmin, requireSuperAdmin, attachAdmin };
