const db = require('../database');
const url = process.argv[2];
if (!url) { console.log('Usage: node tools/set_public_url.js <url>'); process.exit(1); }
const clean = url.trim().replace(/\/+$/, '');
db.prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES ('public_base_url', ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`).run(clean);
const r = db.prepare("SELECT value FROM app_settings WHERE key = 'public_base_url'").get();
console.log(`✅ public_base_url 저장됨: ${r.value}`);
