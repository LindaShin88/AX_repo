const db = require('../database');

const COMMITTEE_NAME = process.argv[2];
const MAPPING_FILE = process.argv[3];

if (!COMMITTEE_NAME || !MAPPING_FILE) {
  console.log('Usage: node tools/update_member_emails.js <committeeName> <mappingJsonFile>');
  console.log('');
  console.log('Mapping JSON file format:');
  console.log('  [');
  console.log('    { "name": "신영헌", "email": "real@example.com" },');
  console.log('    { "name": "김교수", "email": "another@example.com" }');
  console.log('  ]');
  process.exit(1);
}

const fs = require('fs');
let updates;
try {
  updates = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
} catch (e) {
  console.error('Failed to read mapping file:', e.message);
  process.exit(1);
}

const committee = db.prepare('SELECT * FROM committees WHERE name = ?').get(COMMITTEE_NAME);
if (!committee) {
  console.log(`Committee "${COMMITTEE_NAME}" not found.`);
  process.exit(1);
}

console.log(`Updating emails in committee "${COMMITTEE_NAME}" (#${committee.id}):\n`);
const stmt = db.prepare('UPDATE members SET email = ? WHERE committee_id = ? AND name = ?');
for (const u of updates) {
  const r = stmt.run(u.email, committee.id, u.name);
  console.log(r.changes === 0
    ? `  - ${u.name}: not found (skipped)`
    : `  ✓ ${u.name} -> ${u.email}`);
}

console.log('\nDone.');
