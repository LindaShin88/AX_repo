const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const bodyParser = require('body-parser');
const { execSync } = require('child_process');

const db = require('./database');

if (process.env.AUTO_SEED === '1') {
  try {
    const ops = db.prepare('SELECT COUNT(*) AS n FROM operators').get();
    if (ops.n === 0) {
      console.log('[startup] DB empty — running seed...');
      execSync('node seed.js', { stdio: 'inherit' });
    } else {
      console.log(`[startup] DB has ${ops.n} operators — skipping seed`);
    }
  } catch (e) { console.error('[startup] auto-seed failed:', e.message); }
}

if (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL) {
  const url = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  try {
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('public_base_url', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(url);
    console.log(`[startup] public_base_url set to ${url}`);
  } catch (e) { console.error('[startup] public_base_url save failed:', e.message); }
}

const { router: authRoutes } = require('./routes/auth');
const superAdminRoutes = require('./routes/super_admin');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const { attachAdmin } = require('./middleware/auth');
const { startEscalationWorker } = require('./services/escalation');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'committee-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true },
}));

app.use(attachAdmin);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));

app.use('/admin', authRoutes);
app.use('/admin/users', superAdminRoutes);
app.use('/admin', adminRoutes);
app.use('/', publicRoutes);

app.use((req, res) => res.status(404).render('public/error', { message: '페이지를 찾을 수 없습니다.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('public/error', { message: '서버 오류가 발생했습니다: ' + err.message });
});

app.listen(PORT, () => {
  console.log(`▶ 위원회 자동화 플랫폼이 http://localhost:${PORT} 에서 실행중`);
  startEscalationWorker(`http://localhost:${PORT}`);
});
