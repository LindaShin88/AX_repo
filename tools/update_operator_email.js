const db = require('../database');

const username = process.argv[2];
const newEmail = process.argv[3];

if (!username || !newEmail) {
  console.log('Usage: node tools/update_operator_email.js <username> <newEmail>');
  console.log('Example: node tools/update_operator_email.js haksa1 your.name@example.com');
  process.exit(1);
}

const before = db.prepare('SELECT username, name, email FROM operators WHERE username = ?').get(username);
if (!before) {
  console.log(`❌ Operator '${username}' not found.`);
  process.exit(1);
}
console.log(`Before: ${before.username} / ${before.name} / ${before.email}`);

const r = db.prepare('UPDATE operators SET email = ? WHERE username = ?').run(newEmail, username);
console.log(`Updated rows: ${r.changes}`);

const after = db.prepare('SELECT username, name, email FROM operators WHERE username = ?').get(username);
console.log(`After: ${after.username} / ${after.name} / ${after.email}`);
