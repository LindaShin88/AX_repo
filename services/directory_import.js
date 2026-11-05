// 교직원 주소록(엑셀) 파서.
// 한성대 "Works Enterprise 연락처" 내보내기 .xlsx 를 읽어, 위원 추가 시
// 이메일·소속 자동채움 / 동명이인 구분에 쓸 수 있는 행 배열로 변환한다.
//
// 열 순서가 조금 달라도 동작하도록, 첫 줄(헤더)의 한국어 제목을 보고 열을 찾는다.
// 아는 포맷의 열: 이름 | ID* | 기본이메일 | 보조 이메일 | 직급 | 조직 | 조직장(Y/N)
//               | 직책 | 사내 전화번호 | 휴대폰/국가코드 | 언어 | 근무처 | 담당업무
const XLSX = require('xlsx');

function norm(s) {
  return String(s == null ? '' : s).trim();
}
function normName(s) {
  return norm(s).replace(/\s+/g, '');
}

// 조직 경로("한성대학교 | 단과대학 | ... | 회계재무경영트랙")에서 마지막 칸(학과/트랙)만 뽑는다.
function lastDept(org) {
  const parts = norm(org).split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  // 맨 앞 "한성대학교" 하나뿐이면 그대로, 아니면 마지막 토큰
  return parts[parts.length - 1];
}

// 헤더 한 칸이 어떤 필드인지 판정 (부분일치). 더 구체적인 조건을 먼저 본다.
function classifyHeader(h) {
  const t = norm(h);
  if (!t) return null;
  if (/이름|성명/.test(t)) return 'name';
  if (/이메일|이-?메일|e-?mail/i.test(t) && !/보조/.test(t)) return 'email';   // 기본이메일(보조 제외)
  if (/^id\*?$/i.test(t) || /아이디/.test(t)) return 'email_id';
  if (/직급/.test(t)) return 'jikgup';
  if (/조직|소속|부서/.test(t) && !/장/.test(t)) return 'org';                 // "조직장(Y/N)" 제외
  if (/사내\s*전화|내선|전화번호/.test(t)) return 'tel';
  if (/휴대폰|핸드폰|모바일|mobile/i.test(t)) return 'mobile';
  return null;
}

// 버퍼(또는 파일 경로)에서 주소록 행을 파싱.
// 반환: { rows: [{name,name_norm,email,email_id,jikgup,org,dept,tel,mobile}], total, skipped, headerRow, cols }
function parseDirectory(input) {
  const wb = typeof input === 'string'
    ? XLSX.readFile(input)
    : XLSX.read(input, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error('엑셀에 시트가 없습니다.');

  // 2차원 배열로 (셀 값은 계산된 결과 사용: 수식 열도 값으로 나옴)
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!grid.length) throw new Error('엑셀이 비어 있습니다.');

  // 헤더 행 찾기: "이름"과 "이메일"이 함께 있는 첫 줄
  let headerRow = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = grid[i].map(norm);
    const hasName = cells.some(c => /이름|성명/.test(c));
    const hasMail = cells.some(c => /이메일|e-?mail/i.test(c));
    if (hasName && hasMail) { headerRow = i; break; }
  }
  if (headerRow === -1) headerRow = 0; // 못 찾으면 첫 줄로 가정

  // 열 인덱스 매핑
  const cols = {};
  grid[headerRow].forEach((h, idx) => {
    const field = classifyHeader(h);
    if (field && cols[field] == null) cols[field] = idx;
  });
  if (cols.name == null) throw new Error('"이름" 열을 찾지 못했습니다. 엑셀 첫 줄에 이름 칸이 있는지 확인하세요.');

  const rows = [];
  let skipped = 0;
  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i];
    const name = norm(r[cols.name]);
    if (!name) { skipped++; continue; }
    const org = cols.org != null ? norm(r[cols.org]) : '';
    rows.push({
      name,
      name_norm: normName(name),
      email: cols.email != null ? norm(r[cols.email]) : '',
      email_id: cols.email_id != null ? norm(r[cols.email_id]) : '',
      jikgup: cols.jikgup != null ? norm(r[cols.jikgup]) : '',
      org,
      dept: lastDept(org),
      tel: cols.tel != null ? norm(r[cols.tel]) : '',
      mobile: cols.mobile != null ? norm(r[cols.mobile]) : '',
    });
  }

  return { rows, total: rows.length, skipped, headerRow, cols };
}

module.exports = { parseDirectory, lastDept, normName };
