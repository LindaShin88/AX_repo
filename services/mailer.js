const nodemailer = require('nodemailer');
const db = require('../database');

// IPv6 라우팅이 막힌 호스트(Render 등)에서 smtp.gmail.com 연결이 ENETUNREACH로
// 실패하는 것을 막기 위해 IPv4 우선 DNS 조회를 강제한다.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}

function getSmtpConfig() {
  // 컬럼명 'key'가 예약어성이라 일부 드라이버(Turso/libsql 임베디드 복제)에서
  // 행 객체에 .key 프로퍼티가 안 잡히는 경우가 있어 별칭(k, v)으로 받고 방어 처리한다.
  const rows = db.prepare("SELECT key AS k, value AS v FROM app_settings WHERE key LIKE 'smtp_%'").all();
  const cfg = {};
  for (const r of rows) {
    if (!r) continue;
    const k = r.k != null ? r.k : (Array.isArray(r) ? r[0] : undefined);
    const v = r.v !== undefined ? r.v : (Array.isArray(r) ? r[1] : undefined);
    if (typeof k === 'string') cfg[k.replace(/^smtp_/, '')] = v;
  }
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
async function buildTransport() {
  const c = getSmtpConfig();
  const sig = JSON.stringify(c);
  if (cachedTransport && cachedSignature === sig) return { transport: cachedTransport, cfg: c };
  if (!isSmtpConfigured()) return { transport: null, cfg: c };

  // nodemailer가 family:4를 무시하고 IPv6로 붙으려다 Render에서 ENETUNREACH로
  // 실패하는 문제를, 호스트명을 직접 IPv4 주소로 해석해 꽂아 원천 차단한다.
  // (IP로 접속하되 TLS 인증서 검증은 원래 호스트명으로 하도록 servername 지정)
  let host = c.host;
  const servername = c.host;
  try {
    // OS 리졸버(getaddrinfo)로 IPv4 주소만 받아 직접 꽂는다. resolve4(직접 DNS질의)보다
    // 환경 제약에 강함. 실패하면 원래 호스트명으로 폴백.
    const r = await require('dns').promises.lookup(c.host, { family: 4 });
    if (r && r.address) host = r.address;
  } catch (e) { /* 해석 실패 시 원래 호스트명으로 시도 */ }

  cachedTransport = nodemailer.createTransport({
    host,
    port: parseInt(c.port) || 587,
    secure: c.secure === 'true',
    auth: { user: c.user, pass: c.pass },
    family: 4,                  // IPv4 강제 (보조 안전장치)
    connectionTimeout: 15000,   // 연결 대기 한도
    greetingTimeout: 10000,     // 서버 인사 대기 한도
    socketTimeout: 20000,       // 발송 중 소켓 무응답 한도(행 방지)
    tls: { servername },        // IP 접속이어도 인증서는 원래 호스트명으로 검증
  });
  cachedSignature = sig;
  return { transport: cachedTransport, cfg: c };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text) {
  if (!text) return '';
  const urlRe = /(https?:\/\/[^\s<>"]+)/g;
  return escapeHtml(text)
    .replace(urlRe, (url) => `<a href="${url}" style="color:#4F46E5;text-decoration:underline;word-break:break-all" target="_blank">${url}</a>`)
    .replace(/\n/g, '<br>');
}

function extractEmailAddress(s) {
  if (!s) return '';
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim();
}

async function sendMail({ to, subject, text, html, fromName }) {
  if (!to) return { ok: false, reason: 'no-recipient' };
  const { transport, cfg } = await buildTransport();
  if (!transport) return { ok: false, reason: 'smtp-not-configured' };
  try {
    // 발신 주소는 인증된 공용 계정으로 고정하되, fromName이 있으면 표시 이름만 바꾼다.
    let fromHeader = cfg.from || cfg.user;
    if (fromName) {
      const addr = extractEmailAddress(cfg.from || cfg.user) || cfg.user;
      const safeName = String(fromName).replace(/["\r\n]/g, '').trim();
      if (safeName && addr) fromHeader = `"${safeName}" <${addr}>`;
    }
    const finalHtml = html || (text ? `<div style="font-family:'Pretendard','맑은 고딕',sans-serif;line-height:1.6;color:#1f2937;">${textToHtml(text)}</div>` : '');
    const info = await transport.sendMail({
      from: fromHeader,
      to, subject,
      text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
      html: finalHtml,
    });
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    return { ok: false, reason: err.code || 'send-error', error: err.message };
  }
}

async function verifySmtp() {
  const { transport, cfg } = await buildTransport();
  if (!transport) return { ok: false, reason: 'smtp-not-configured', cfg };
  try {
    await transport.verify();
    return { ok: true, cfg };
  } catch (err) {
    return { ok: false, reason: err.code || 'verify-error', error: err.message, cfg };
  }
}

function getPublicBaseUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'public_base_url'").get();
  if (row && row.value) return row.value.replace(/\/+$/, '');
  const envUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  return envUrl.replace(/\/+$/, '');
}

function setPublicBaseUrl(url) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('public_base_url', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(clean);
}

module.exports = {
  getSmtpConfig, setSmtpConfig, isSmtpConfigured,
  getPublicBaseUrl, setPublicBaseUrl,
  sendMail, verifySmtp,
};
