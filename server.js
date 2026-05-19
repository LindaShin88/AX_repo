const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const bodyParser = require('body-parser');

const { router: authRoutes } = require('./routes/auth');
const superAdminRoutes = require('./routes/super_admin');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const { attachAdmin } = require('./middleware/auth');
const { startEscalationWorker } = require('./services/escalation');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/', (req, res) => res.redirect('/admin'));

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
