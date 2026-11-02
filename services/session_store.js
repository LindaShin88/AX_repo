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

// 세션 저장용 쓰기. Turso 연결이 순간적으로 끊기면("connection closed before message completed")
// 즉시 다시 시도한다(다음 호출 때 libsql이 새 연결을 맺으므로 대개 바로 복구됨).
// 끝까지 실패해도 cb(null)로 "성공"처럼 넘긴다 → 세션 한 번 저장이 누락될 뿐,
// 서버가 죽거나 응답이 깨지지 않는다(이전엔 이 지점에서 프로세스가 종료돼 502가 났다).
function runWrite(label, fn, cb) {
  const ATTEMPTS = 3;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      fn();
      return cb && cb(null);
    } catch (e) {
      if (i === ATTEMPTS) {
        console.error(`[session store] ${label} 저장 실패(${i}회 시도 후 포기, 서비스는 계속):`, e.message);
        return cb && cb(null);
      }
      // 즉시 재시도
    }
  }
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
    runWrite('set', () => {
      db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
                  ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`)
        .run(sid, JSON.stringify(sess), expiryOf(sess));
    }, cb);
  }
  touch(sid, sess, cb) {
    runWrite('touch', () => {
      db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expiryOf(sess), sid);
    }, cb);
  }
  destroy(sid, cb) {
    runWrite('destroy', () => {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    }, cb);
  }
}

module.exports = DbSessionStore;
