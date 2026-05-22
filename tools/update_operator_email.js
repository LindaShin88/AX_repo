const db = require('../database');

const username = 'haksa1';
const newEmail = 'soyungshin@hansung.kr';

const before = db.prepare('SELECT username, name, email FROM operators WHERE username = ?').get(username);
console.log(`변경 전: ${before?.username} / ${before?.name} / ${before?.email}`);

const r = db.prepare('UPDATE operators SET email = ? WHERE username = ?').run(newEmail, username);
console.log(`업데이트된 행: ${r.changes}`);

const after = db.prepare('SELECT username, name, email FROM operators WHERE username = ?').get(username);
console.log(`변경 후: ${after.username} / ${after.name} / ${after.email}`);
