// [일회성 검증 스크립트 — 서비스에 반영 안 됨]
// 대학원 수강신청 안내 게시글의 한글파일(일반/특수대학원)을 받아 파싱하고,
// 원본과 비교하기 쉽게 HTML 표로 저장한다.
const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const CFB = require('cfb');
const oc = require('../services/hansung_oc');

const BOARD = 'https://www.hansung.ac.kr/bbs/gshansung/1893';

// ── 1) 최신 "수강" 게시글 찾기 ───────────────────────────────
async function findLatestSugangPost() {
  const url = `${BOARD}/artclList.do?findType=sj&findWord=${encodeURIComponent('수강')}`;
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
  const t = r.data.toString('utf-8');
  const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const posts = [];
  for (const row of rows) {
    const seqM = row.match(/\/bbs\/gshansung\/1893\/(\d+)\/artclView\.do/);
    const dateM = row.match(/(\d{4}\.\d{2}\.\d{2})/);
    if (seqM && dateM) posts.push({ seq: seqM[1], date: dateM[1] });
  }
  posts.sort((a, b) => b.date.localeCompare(a.date));
  return posts[0];
}

// ── 2) 게시글에서 일반/특수대학원 hwp 다운로드 링크 ─────────────
async function getHwpLinks(seq) {
  const url = `${BOARD}/${seq}/artclView.do`;
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
  const t = r.data.toString('utf-8');
  // 다운로드 링크와 바로 뒤의 파일명 텍스트를 함께 추출
  const out = [];
  const re = /href="([^"]*\/download\.do[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(t))) {
    const href = m[1];
    const name = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ href, name });
  }
  // 파일명으로 일반/특수 구분
  const find = (kw) => out.find(f => f.name.includes(kw));
  return { ilban: find('일반대학원'), teuksu: find('특수대학원'), all: out };
}

async function download(href) {
  const url = href.startsWith('http') ? href : 'https://www.hansung.ac.kr' + href;
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': BOARD }, responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true });
  return Buffer.from(r.data);
}

// ── 3) HWP5 → 문단 셀 배열 ───────────────────────────────────
function hwpToCells(buf) {
  const cfb = CFB.read(buf, { type: 'buffer' });
  const fh = CFB.find(cfb, 'FileHeader');
  const compressed = ((fh ? fh.content[36] : 1) & 1) === 1;
  const secs = cfb.FullPaths.map((p, i) => ({ p, e: cfb.FileIndex[i] })).filter(x => /BodyText\/Section\d+/i.test(x.p));
  const cells = [];
  for (const s of secs) {
    let d = Buffer.from(s.e.content);
    if (compressed) { try { d = zlib.inflateRawSync(d); } catch (e) { continue; } }
    let o = 0;
    while (o + 4 <= d.length) {
      const h = d.readUInt32LE(o); o += 4;
      const tag = h & 0x3ff; let sz = (h >> 20) & 0xfff;
      if (sz === 0xfff) { sz = d.readUInt32LE(o); o += 4; }
      const rec = d.slice(o, o + sz); o += sz;
      if (tag === 67) {
        let txt = '';
        for (let i = 0; i + 1 < rec.length; i += 2) {
          const c = rec.readUInt16LE(i);
          if (c >= 32) txt += String.fromCharCode(c);
          else if (c >= 1 && c <= 23) i += 14; // inline control (8 WCHAR)
        }
        cells.push(txt.trim());
      }
    }
  }
  return cells.filter(x => x !== '' && !/^[∙·.\s]+$/.test(x));
}

// ── 4) 셀 배열 → 과목 레코드 ─────────────────────────────────
const CODE_RE = /^[A-Z]{1,2}\d{6,8}$/;
const DAY_RE = /([월화수목금토일])\s*\d{1,2}(?:\s*,\s*\d{1,2})*/;
const DAY_MAP = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const GUBUN_SET = new Set(['전선', '전필', '공통', '공선', '공필', '선수', '전공', '교직', '일선', '일필']);
const NAME_RE = /^[가-힣]{2,10}(\s*[,·․ㆍ/]\s*[가-힣]{2,10})*$/;

// 2026-2학기 대학원 강의시간 안내(원본 한글파일 범례)에서 추출한 교시별 시작~종료 시각
const PERIOD_ILBAN = {
  1: ['09:00', '09:50'], 2: ['10:00', '10:50'], 3: ['11:00', '11:50'], 4: ['12:00', '12:50'],
  5: ['13:00', '13:50'], 6: ['14:00', '14:50'], 7: ['15:00', '15:50'], 8: ['16:00', '16:50'],
  9: ['17:00', '17:50'], 10: ['18:00', '18:50'], 11: ['18:55', '19:45'], 12: ['19:50', '20:40'],
  13: ['20:45', '21:35'], 14: ['21:40', '22:30'],
};
const PERIOD_TEUKSU = {
  1: ['09:00', '09:50'], 2: ['10:00', '10:50'], 3: ['11:00', '11:50'], 4: ['12:00', '12:50'],
  5: ['13:00', '13:50'], 6: ['14:00', '14:50'], 7: ['15:00', '15:50'], 8: ['16:00', '16:50'],
  9: ['17:00', '17:50'], 10: ['18:00', '18:50'], 11: ['18:30', '19:20'], 12: ['19:25', '20:15'],
  13: ['20:20', '21:10'], 14: ['21:15', '22:05'],
};

function parseDayPeriod(s, level) {
  const table = level === '특수대학원' ? PERIOD_TEUKSU : PERIOD_ILBAN;
  const out = [];
  const re = /([월화수목금토일])\s*((?:\d{1,2})(?:\s*,\s*\d{1,2})*)/g;
  let m;
  while ((m = re.exec(s))) {
    const day = DAY_MAP[m[1]];
    const ps = m[2].split(',').map(x => parseInt(x.trim())).filter(n => !isNaN(n));
    if (!ps.length) continue;
    const first = table[ps[0]]; const last = table[ps[ps.length - 1]];
    if (!first || !last) continue;
    out.push({ day, start: first[0], end: last[1] });
  }
  return out;
}

function parseCourses(cells, level) {
  let dept = '(미지정)';
  const courses = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    // 학과 헤더
    if (/\((박사|석사|석박사통합|박사과정|석사과정)\)\s*$/.test(cell) && /(학과|학부|계열|전공|과정)/.test(cell)) {
      dept = cell.replace(/^[^\w가-힣]+/, '').trim();
      continue;
    }
    if (CODE_RE.test(cell)) {
      const bunban = cells[i + 1] || '';
      // 교수명: 분반 다음부터 숫자(학점) 전까지 이름 형태 셀을 모두 수집 (공동강의 2명 이상 대응)
      const profs = [];
      let j = i + 2;
      while (j < cells.length && j <= i + 5 && NAME_RE.test(cells[j])) { profs.push(cells[j].trim()); j++; }
      const prof = profs.length ? profs.join(', ') : (cells[i + 2] || '') + ' (?)';
      // 주/야 + 요일교시: 교수명 뒤에서 탐색
      let dayCell = '', juya = '';
      for (let k = j; k <= i + 10 && k < cells.length; k++) {
        if (!juya && /^(주|야|주야|주\/야)$/.test(cells[k])) juya = cells[k];
        if (DAY_RE.test(cells[k]) && cells[k].length < 25) { dayCell = cells[k]; break; }
      }
      // 교과목명: 코드 앞 셀(들). 줄바꿈으로 분리된 긴 이름은 앞 셀과 합침(구분 셀은 제외)
      let subject = (cells[i - 1] || '').trim();
      const prev2 = (cells[i - 2] || '').trim();
      // 줄바꿈으로 쪼개진 교과목명만 합침: 앞 셀이 순수 한글(숫자/괄호/영문/구분 아님)일 때만
      if (/^[가-힣]{2,}$/.test(prev2) && !GUBUN_SET.has(prev2)) {
        subject = prev2 + subject;
      }
      courses.push({
        dept, level,
        subject, code: cell, bunban,
        prof, juya,
        dayRaw: dayCell,
        times: parseDayPeriod(dayCell, level),
      });
    }
  }
  return courses;
}

// ── 5) HTML 리포트 생성 ──────────────────────────────────────
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function timesToStr(times) {
  const KODAY = ['일', '월', '화', '수', '목', '금', '토'];
  if (!times.length) return '<span style="color:#c00">⚠ 시간 파싱 실패</span>';
  return times.map(t => `${KODAY[t.day]} ${t.start}~${t.end}`).join(', ');
}

function buildHtml(sections) {
  let html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>대학원 시간표 추출 검증</title>
  <style>body{font-family:'Malgun Gothic',sans-serif;margin:24px;color:#222}h1{font-size:20px}h2{margin-top:32px;background:#1e293b;color:#fff;padding:8px 12px;border-radius:6px}h3{margin-top:20px;color:#1e40af}
  table{border-collapse:collapse;width:100%;margin:8px 0 20px;font-size:13px}th,td{border:1px solid #cbd5e1;padding:5px 8px;text-align:left}th{background:#f1f5f9}
  .sum{background:#fef9c3;border:1px solid #fde047;padding:10px 14px;border-radius:8px;margin:10px 0}.n{color:#64748b}</style></head><body>`;
  html += `<h1>🏫 대학원 강의시간표 — 한글파일 자동 추출 결과 (검증용)</h1>`;
  html += `<p class="n">※ 이 페이지는 프로그램이 한글파일에서 자동으로 뽑아낸 결과입니다. 원본 한글파일(일반대학원/특수대학원)과 아래 숫자·교수명·시간이 일치하는지 비교해주세요.</p>`;
  let grandTotal = 0;
  for (const sec of sections) {
    grandTotal += sec.courses.length;
    html += `<h2>📄 ${esc(sec.title)} — 추출 과목 ${sec.courses.length}개</h2>`;
    html += `<div class="sum">게시글: <b>${esc(sec.postTitle)}</b> (${esc(sec.date)}) · 파일명: ${esc(sec.fileName)}</div>`;
    // 학과별 그룹
    const byDept = {};
    for (const c of sec.courses) (byDept[`${c.dept} [${c.level}]`] = byDept[`${c.dept} [${c.level}]`] || []).push(c);
    for (const [dept, list] of Object.entries(byDept)) {
      html += `<h3>${esc(dept)} — ${list.length}과목</h3><table><tr><th>교수명</th><th>요일교시(원본)</th><th>→ 변환된 시간</th><th>교과목명</th><th>과목코드</th><th>분반</th></tr>`;
      for (const c of list) {
        html += `<tr><td><b>${esc(c.prof)}</b></td><td>${esc(c.dayRaw || '-')}</td><td>${timesToStr(c.times)}</td><td>${esc(c.subject)}</td><td>${esc(c.code)}</td><td>${esc(c.bunban)}</td></tr>`;
      }
      html += `</table>`;
    }
  }
  html += `<div class="sum" style="font-size:16px"><b>✅ 전체 추출 과목 수: ${grandTotal}개</b> (일반+특수 합계) · 교수 중복 제거 전 기준</div>`;
  html += `</body></html>`;
  return html;
}

(async () => {
  const post = await findLatestSugangPost();
  console.log('최신 수강 게시글:', post);
  const links = await getHwpLinks(post.seq);
  // 게시글 제목
  const vr = await axios.get(`${BOARD}/${post.seq}/artclView.do`, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
  const vt = vr.data.toString('utf-8');
  const ptM = vt.match(/<h2[^>]*class="[^"]*view[^"]*"[^>]*>([\s\S]*?)<\/h2>/) || vt.match(/artclView[\s\S]{0,400}?<strong[^>]*>([\s\S]*?)<\/strong>/);
  const postTitle = ptM ? ptM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : `게시글 ${post.seq}`;

  const sections = [];
  for (const [key, label] of [['ilban', '일반대학원'], ['teuksu', '특수대학원']]) {
    const f = links[key];
    if (!f) { console.log(`${label} 파일 없음`); continue; }
    const buf = await download(f.href);
    const cells = hwpToCells(buf);
    const courses = parseCourses(cells, label);
    console.log(`${label}: ${courses.length}과목 추출 (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
    sections.push({ title: label, fileName: f.name, postTitle, date: post.date, courses });
    if (process.env.DUMP_CELLS) {
      fs.writeFileSync(path.join(require('os').homedir(), 'Desktop', `_cells_${key}.json`), JSON.stringify(cells), 'utf-8');
    }
  }

  const html = buildHtml(sections);
  const outPath = path.join(require('os').homedir(), 'Desktop', '대학원시간표_검증.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log('\n✅ 검증 페이지 저장:', outPath);

  // 교차검증용 JSON 덤프 (학과별 과목 구조)
  const jsonPath = path.join(require('os').homedir(), 'Desktop', '대학원시간표_검증.json');
  fs.writeFileSync(jsonPath, JSON.stringify(sections, null, 1), 'utf-8');
  console.log('✅ JSON 덤프:', jsonPath);

  // 콘솔 요약
  const allProfs = new Set();
  sections.forEach(s => s.courses.forEach(c => c.prof.split(/[,·]/).forEach(p => allProfs.add(p.trim()))));
  console.log('총 교수(중복제거):', allProfs.size);
  const failed = sections.flatMap(s => s.courses).filter(c => !c.times.length);
  console.log('시간 파싱 실패 과목:', failed.length, failed.slice(0, 5).map(c => c.prof + '/' + c.dayRaw));
})().catch(e => { console.error('ERROR:', e.message); });
