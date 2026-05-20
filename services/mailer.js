const nodemailer = require('nodemailer');
const db = require('../database');

function getSmtpConfig() {
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'smtp_%'").all();
  const cfg = {};
  for (const r of rows) cfg[r.key.replace(/^smtp_/, '')] = r.value;
  if (!cfg.host) cfg.host = process.env.SMTP_HOST || '';
  if (!cfg.port) cfg.port = process.env.SMTP_PORT || '';
  if (!cfg.user) cfg.user = process.env.SMTP_USER || '';
  if (!cfg.pass) cfg.pass = process.env.SMTP_PASS || '';
  if (!cfg.from) cfg.from = process.env.SMTP_FROM || cfg.user || '';
  if (!cfg.secure) cfg.secure = String(cfg.port) === '465' ? 'true' : 'false';
  return cfg;
}

function setSmtpConfig(updates) {
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    upsert.run(`smtp_${k}`, v == null ? '' : String(v));
  }
}

function isSmtpConfigured() {
  const c = getSmtpConfig();
  return !!(c.host && c.port && c.user && c.pass);
}

let cachedTransport = null;
let cachedSignature = '';
function buildTransport() {
  const c = getSmtpConfig();
  const sig = JSON.stringify(c);
  if (cachedTransport && cachedSignature === sig) return { transport: cachedTransport, cfg: c };
  if (!isSmtpConfigured()) return { transport: null, cfg: c };
  cachedTransport = nodemailer.createTransport({
    host: c.host,
    port: parseInt(c.port) || 587,
    secure: c.secure === 'true',
    auth: { user: c.user, pass: c.pass },
  });
  cachedSignature = sig;
  return { transport: cachedTransport, cfg: c };
}

async function sendMail({ to, subject, text, html }) {
  if (!to) return { ok: false, reason: 'no-recipient' };
  const { transport, cfg } = buildTransport();
  if (!transport) return { ok: false, reason: 'smtp-not-configured' };
  try {
    const info = await transport.sendMail({
      from: cfg.from || cfg.user,
      to, subject,
      text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
      html: html || (text ? text.replace(/\n/g, '<br>') : ''),
    });
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    return { ok: false, reason: err.code || 'send-error', error: err.message };
  }
}

async function verifySmtp() {
  const { transport, cfg } = buildTransport();
  if (!transport) return { ok: false, reason: 'smtp-not-configured', cfg };
  try {
    await transport.verify();
    return { ok: true, cfg };
  } catch (err) {
    return { ok: false, reason: err.code || 'verify-error', error: err.message, cfg };
  }
}

module.exports = {
  getSmtpConfig, setSmtpConfig, isSmtpConfigured,
  sendMail, verifySmtp,
};
