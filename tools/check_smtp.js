const db = require('../database');

const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'smtp_%' OR key = 'public_base_url'`).all();

console.log('\n========== SMTP 설정 상태 ==========');
if (rows.length === 0) {
  console.log('❌ 아무것도 설정 안됨 — 처음부터 다시 설정 필요');
  process.exit(0);
}

const cfg = {};
for (const r of rows) cfg[r.key] = r.value;

const display = (label, key) => {
  const v = cfg[key] || '';
  if (key === 'smtp_pass') {
    console.log(label.padEnd(15), ':', v ? `✓ 설정됨 (${v.length}자)` : '❌ 비어있음');
  } else {
    console.log(label.padEnd(15), ':', v || '❌ 비어있음');
  }
};

display('호스트', 'smtp_host');
display('포트', 'smtp_port');
display('SSL', 'smtp_secure');
display('아이디', 'smtp_user');
display('비밀번호', 'smtp_pass');
display('발신자 표시', 'smtp_from');
display('공개 URL', 'public_base_url');

console.log('\n========== 진단 ==========');
const ok = cfg.smtp_host && cfg.smtp_port && cfg.smtp_user && cfg.smtp_pass;
if (ok) {
  console.log('✅ SMTP 기본 설정 완료 — 메일 발송 가능 상태');
  if (cfg.smtp_host === 'smtp.gmail.com' && cfg.smtp_pass && cfg.smtp_pass.length !== 16) {
    console.log('⚠️ Gmail인데 비밀번호 길이가 16자가 아닙니다.');
    console.log('   → Gmail은 16자리 앱비밀번호 사용해야 함 (일반 비번 X)');
    console.log('   → https://myaccount.google.com/apppasswords 에서 발급');
  }
} else {
  console.log('❌ 빠진 항목이 있습니다. 위에 ❌ 표시된 항목을 채워주세요.');
}

console.log('\n========== 최근 메일 발송 로그 (5건) ==========');
const recent = db.prepare(`
  SELECT n.type, n.subject, n.content, n.sent_at, m.name AS member_name
  FROM notifications n LEFT JOIN members m ON m.id = n.member_id
  WHERE n.channel = 'email' ORDER BY n.sent_at DESC LIMIT 5
`).all();
if (recent.length === 0) {
  console.log('(아직 메일 발송 시도 없음)');
} else {
  for (const r of recent) {
    const statusMatch = (r.content || '').match(/\[발송상태:\s*([^\]]+)\]/);
    const status = statusMatch ? statusMatch[1] : '(상태 없음)';
    console.log(`- ${r.sent_at} | ${r.member_name || '(전체)'} | ${r.type}`);
    console.log(`  → ${status}`);
  }
}
console.log('');
