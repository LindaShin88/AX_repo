// express-session 저장소를 Turso/SQLite(DB)에 둔다.
// 기본 MemoryStore는 서버 재시작(배포)마다 세션이 전부 날아가 로그인이 풀리므로,
// DB에 저장해 재시작해도 로그인이 유지되도록 한다.
const session = require('express-session');
const db = require('../database');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  )`);
} catch (e) { console.error('[session store] 테이블 생성 실패:', e.message); }

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000; // 30일

function expiryOf(sess) {
  if (sess && sess.cookie && sess.cookie.expires) {
    const t = new Date(sess.cookie.expires).getTime();
    if (!isNaN(t)) return t;
  }
  return Date.now() + DEFAULT_TTL;
}

class DbSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expire && row.expire < Date.now()) {
        try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); } catch (e) {}
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (e) { return cb(e); }
  }
  set(sid, sess, cb) {
    try {
      db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
                  ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`)
        .run(sid, JSON.stringify(sess), expiryOf(sess));
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expiryOf(sess), sid);
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }
}

module.exports = DbSessionStore;
