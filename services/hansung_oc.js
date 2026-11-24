const axios = require('axios');
const https = require('https');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

// Render 등에서 IPv6 라우팅이 막혀 info.hansung.ac.kr 연결이 ECONNRESET/ENETUNREACH로
// 끊기는 것을 막기 위해 IPv4 우선 조회를 강제한다(메일 SMTP 하드닝과 동일).
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}

// keepAlive 재사용 소켓을 학교 서버가 유휴로 끊으면 다음 요청에서 ECONNRESET이 난다.
// family:4로 IPv4를 강제하고, 실제 끊김은 아래 withRetry로 새 연결 재시도해 흡수한다.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4, family: 4 });

// 일시적 네트워크 오류(연결 끊김/리셋/타임아웃)는 "잠깐"인 경우가 많아, 새 연결로 재시도한다.
function isTransientNetError(err) {
  const code = String(err && err.code || '').toUpperCase();
  const msg = String(err && err.message || '').toLowerCase();
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|ECONNREFUSED|EPIPE|ENETUNREACH|EAI_AGAIN|ESOCKETTIMEDOUT/.test(code)
    || /socket hang up|timeout|reset|network/.test(msg);
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= tries - 1 || !isTransientNetError(err)) break;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));  // 0.6s, 1.2s 백오프
    }
  }
  throw lastErr;
}

const BASE = 'https://info.hansung.ac.kr/jsp_21/student/kyomu/';
const PAGE_URL = BASE + 'siganpyo_aui.jsp?viewMode=oc';
const DATA_URL = BASE + 'siganpyo_aui_data.jsp';

const DEFAULT_HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

const DAY_MAP = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };

async function getSessionCookie() {
  const r = await withRetry(() => axios.get(PAGE_URL, {
    responseType: 'arraybuffer',
    headers: DEFAULT_HEADERS_BASE,
    timeout: 15000,
    validateStatus: () => true,
    httpsAgent,
  }));
  const setCookie = r.headers['set-cookie'] || [];
  return setCookie.map(s => s.split(';')[0]).join('; ');
}

function buildHeaders(cookie) {
  return {
    ...DEFAULT_HEADERS_BASE,
    'Cookie': cookie,
    'Referer': PAGE_URL,
    'Origin': 'https://info.hansung.ac.kr',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/xml, text/xml, */*; q=0.01',
  };
}

async function postXml(cookie, gubun, params = {}) {
  const sp = new URLSearchParams();
  if (gubun) sp.append('gubun', gubun);
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  const url = gubun && (gubun === 'yearhakgilist' || gubun === 'jungonglist')
    ? `${DATA_URL}?gubun=${encodeURIComponent(gubun)}`
    : DATA_URL;
  const r = await withRetry(() => axios.post(url, sp, {
    responseType: 'arraybuffer',
    headers: buildHeaders(cookie),
    timeout: 20000,
    validateStatus: () => true,
    httpsAgent,
    maxRedirects: 0,
    decompress: true,
  }));
  const buf = Buffer.from(new Uint8Array(r.data));
  const text = iconv.decode(buf, 'euc-kr');
  r.data = null;
  return { status: r.status, text };
}

async function getYearHakgiList(cookie) {
  if (!cookie) cookie = await getSessionCookie();
  const { text } = await postXml(cookie, 'yearhakgilist');
  const $ = cheerio.load(text, { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const code = $(el).find('tcd').text().trim();
    const name = $(el).find('tnm').text().trim();
    if (code) out.push({ code, name });
  });
  return { cookie, items: out };
}

async function getJungongList(cookie, yearhakgi) {
  if (!cookie) cookie = await getSessionCookie();
  const { text } = await postXml(cookie, 'jungonglist', { syearhakgi: yearhakgi });
  const $ = cheerio.load(text, { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const code = $(el).find('tcd').text().trim();
    const name = $(el).find('tnm').text().trim();
    if (code) out.push({ code, name });
  });
  return { cookie, items: out };
}

const NEEDED_TAGS = ['kwamokcode','kwamokname','isugubun','hakjum','juya','bunban','haknean','prof','classroom','plan','ekname'];

function decodeCdata(s) {
  if (s == null) return '';
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseClassesXml(xmlText) {
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  const rows = [];
  let rm;
  while ((rm = rowRe.exec(xmlText))) {
    const inner = rm[1];
    const obj = {};
    for (const tag of NEEDED_TAGS) {
      const tagRe = new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>');
      const m = inner.match(tagRe);
      obj[tag] = m ? decodeCdata(m[1]).trim() : '';
    }
    rows.push(obj);
  }
  return rows;
}

async function getClassesForJungong(cookie, yearhakgi, jungongCode, filterFn = null) {
  if (!cookie) cookie = await getSessionCookie();
  const { text } = await postXml(cookie, null, {
    gubun: 'history',
    syearhakgi: yearhakgi,
    sjungong: jungongCode,
  });
  const rows = parseClassesXml(text);
  return filterFn ? rows.filter(filterFn) : rows;
}

// ── 한성대 2026 공식 강의시간표(수강신청 안내 PDF 기준) ──────────────────────
// 두 가지 수업 체계가 있다.
//  (1) 50분 수업: 정시 교시. 1교시 09:00~09:50 … 10교시 18:00~18:50, 이후 야간.
//  (2) 75분 수업: 교시번호 뒤 'M' 표기(예: "월5M~6M"). 블록제라 오후가 30분 늦게 시작.
// OC 시간표의 "강의실 및 교시" 칸은 교시번호로만 적혀 있어(실제 시각 필드 없음) 아래 표로 변환한다.

// (1) 50분 교시 번호 → [시작, 끝]
const PERIOD_50 = {
  1: ['09:00', '09:50'], 2: ['10:00', '10:50'], 3: ['11:00', '11:50'], 4: ['12:00', '12:50'],
  5: ['13:00', '13:50'], 6: ['14:00', '14:50'], 7: ['15:00', '15:50'], 8: ['16:00', '16:50'],
  9: ['17:00', '17:50'], 10: ['18:00', '18:50'], 11: ['18:55', '19:45'], 12: ['19:50', '20:40'],
  13: ['20:45', '21:35'], 14: ['21:40', '22:30'],
};

// (2) 75분 수업 블록 9개(하루) → [시작, 끝]. 75분 수업 + 15분 휴식 간격.
const BLOCK_75 = [
  ['09:00', '10:15'], ['10:30', '11:45'], ['12:00', '13:15'], ['13:30', '14:45'],
  ['15:00', '16:15'], ['16:30', '17:45'], ['18:00', '19:15'], ['19:25', '20:40'], ['20:45', '22:00'],
];

// 하위호환(기존 export 유지): 50분 교시 시작시각 맵
const PERIOD_START = Object.fromEntries(Object.entries(PERIOD_50).map(([k, v]) => [k, v[0]]));

function hhmmToMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function clampBlock(i) { return Math.max(1, Math.min(BLOCK_75.length, i)); }

// 75분 수업: 시작 교시번호 N → 블록 index(1~9).
//   (교시번호는 50분 교시 기준 위치. 75분 블록은 매 3교시마다 하나씩 건너뜀)
function block75StartIdx(p) { return clampBlock(p - Math.floor((p - 1) / 3)); }
// 75분 수업: 끝 교시번호 N → 블록 index(1~9).
//   끝이 '시작형 교시'(1·4·7·10·13)면 그 교시에 진행 중인 블록으로 본다(끝시각 과소추정 방지).
function block75EndIdx(p) {
  if (p % 3 === 1) return block75StartIdx(p);
  return clampBlock(p - Math.ceil(p / 3));
}

// 교시 범위(시작번호, 끝번호, 75분 여부) → {sMin, eMin}
function periodRangeToMinutes(startNum, endNum, isM) {
  const sN = parseInt(startNum, 10);
  const eN = parseInt(endNum != null && endNum !== '' ? endNum : startNum, 10);
  if (!sN) return null;
  if (isM) {
    const sB = BLOCK_75[block75StartIdx(sN) - 1];
    const eB = BLOCK_75[block75EndIdx(eN) - 1];
    if (!sB || !eB) return null;
    let sMin = hhmmToMin(sB[0]), eMin = hhmmToMin(eB[1]);
    if (eMin < sMin) eMin = hhmmToMin(sB[1]);
    return { sMin, eMin };
  }
  const s = PERIOD_50[sN], e = PERIOD_50[eN] || PERIOD_50[sN];
  if (!s || !e) return null;
  let sMin = hhmmToMin(s[0]), eMin = hhmmToMin(e[1]);
  if (eMin < sMin) eMin = hhmmToMin(s[1]);
  return { sMin, eMin };
}

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 요일 + 시작교시(M?) [~ 끝교시(M?)]. M은 각 교시번호 뒤에 붙는다(예: 월5M~6M, 월4~6M, 목2M~5).
const TIME_PATTERN = /([월화수목금토일])\s*(\d{1,2})(M?)\s*(?:~\s*(\d{1,2})(M?))?/g;

function parseClassroomField(classroom) {
  if (!classroom) return [];
  const parts = String(classroom).split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
  const slots = [];
  for (const part of parts) {
    if (/온라인/.test(part) && !/[월화수목금토일]/.test(part)) continue;
    const matches = [...part.matchAll(TIME_PATTERN)];
    if (matches.length === 0) continue;
    const location = part.replace(TIME_PATTERN, '').replace(/\s+/g, ' ').trim() || null;
    for (const m of matches) {
      const day = DAY_MAP[m[1]];
      const isM = !!(m[3] || m[5]);   // 시작·끝 어느 쪽이든 M이 있으면 75분 수업
      const rng = periodRangeToMinutes(m[2], m[4] || m[2], isM);
      if (!rng) continue;
      slots.push({
        day,
        start: minToTime(rng.sMin),
        end: minToTime(rng.eMin),
        location,
        raw: part,
      });
    }
  }
  return slots;
}

function classRowToTimetableEntries(row) {
  const slots = parseClassroomField(row.classroom);
  return slots.map(s => ({
    day: s.day,
    start: s.start,
    end: s.end,
    title: row.kwamokname || '수업',
    location: s.location,
    prof: row.prof,
    bunban: row.bunban,
    juya: row.juya,
    kwamokcode: row.kwamokcode,
    plan: row.plan,
    raw: s.raw,
  }));
}

async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 학기 시간표 "스냅샷" (미리 긁어둔 전체 데이터) 우선 사용 ──────────────────
// Render 등에서 라이브 크롤이 ECONNRESET으로 실패하는 문제를, 정규학기는 data/에
// 커밋해둔 스냅샷으로 네트워크 없이 연결하기 위함. 파일 없으면 라이브로 폴백.
const _snapshotCache = new Map(); // yearhakgi -> snapshot | null(없음)
function loadSnapshot(yearhakgi) {
  if (_snapshotCache.has(yearhakgi)) return _snapshotCache.get(yearhakgi);
  let snap = null;
  try {
    const p = require('path').join(__dirname, '..', 'data', `timetable-snapshot-${yearhakgi}.json`);
    const fs = require('fs');
    if (fs.existsSync(p)) snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { snap = null; }
  _snapshotCache.set(yearhakgi, snap);
  return snap;
}

// 스냅샷에서 교수 시간표를 뽑아 findProfessorClasses와 동일한 형태로 만든다.
function buildResultFromSnapshot(snap, yearhakgi, profName) {
  const profs = snap.professors || {};
  // 라이브 매칭(prof 필드 includes 검색어)과 맞추기 위해, 이름에 검색어가 포함된 키를 모두 수집.
  const keys = Object.keys(profs).filter(k => k.includes(profName));
  const merged = [];
  const seen = new Set();
  for (const k of keys) {
    for (const e of profs[k]) {
      const sig = `${e.day}-${e.start}-${e.end}-${e.title}-${e.bunban || ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      merged.push(e);
    }
  }
  merged.sort((a, b) => a.day - b.day || String(a.start).localeCompare(String(b.start)));

  const byMajor = new Map();
  const classKeys = new Set();
  for (const e of merged) {
    classKeys.add(`${e.majorCode || ''}|${e.title}|${e.bunban || ''}`);
    if (e.major || e.majorCode) {
      const mk = e.majorCode || e.major;
      if (!byMajor.has(mk)) byMajor.set(mk, { code: e.majorCode || null, name: e.major || null, set: new Set() });
      byMajor.get(mk).set.add(`${e.title}|${e.bunban || ''}`);
    }
  }
  const matchedMajors = [...byMajor.values()].map(v => ({ code: v.code, name: v.name, classCount: v.set.size }));
  const timetable = merged.map(e => ({
    day: e.day, start: e.start, end: e.end, title: e.title,
    location: e.location || null, bunban: e.bunban || null,
    juya: e.juya || null, major: e.major || null, majorCode: e.majorCode || null,
  }));
  return {
    yearhakgi,
    profName,
    totalMajorsScanned: snap.professorCount || 0,
    matchedMajors,
    classes: [...classKeys].map(k => ({ key: k })), // 길이=고유 강의수(메타 표시용)
    timetable,
    source: 'snapshot',
    snapshotAt: snap.generatedAt || null,
  };
}

// 해당 학기 스냅샷의 생성시각(없으면 null). 캐시가 스냅샷 재생성 이후 갱신돼야 하는지 판단용.
function snapshotGeneratedAt(yearhakgi) {
  const snap = loadSnapshot(yearhakgi);
  return snap && snap.generatedAt ? snap.generatedAt : null;
}

async function findProfessorClasses(yearhakgi, profName, { concurrency = 8, onProgress = null } = {}) {
  // 정규학기 스냅샷이 있으면 네트워크 없이 그걸로 응답(ECONNRESET 회피 + 속도).
  const snap = loadSnapshot(yearhakgi);
  if (snap && snap.professors) {
    if (onProgress) onProgress({ scanned: 1, total: 1, source: 'snapshot' });
    return buildResultFromSnapshot(snap, yearhakgi, profName);
  }

  const cookie = await getSessionCookie();
  const { items: majors } = await getJungongList(cookie, yearhakgi);
  const seenPlans = new Set();
  const matchedRaw = [];
  const matchedByMajor = new Map();
  let scanned = 0;

  await pMapLimit(majors, concurrency, async (major) => {
    try {
      const matches = await getClassesForJungong(cookie, yearhakgi, major.code,
        r => r.prof && r.prof.includes(profName));
      for (const m of matches) {
        const key = m.plan || `${m.kwamokcode}-${m.bunban}`;
        if (seenPlans.has(key)) continue;
        seenPlans.add(key);
        matchedRaw.push({ ...m, _majorCode: major.code, _majorName: major.name });
        if (!matchedByMajor.has(major.code)) {
          matchedByMajor.set(major.code, { majorName: major.name, count: 0 });
        }
        matchedByMajor.get(major.code).count += 1;
      }
    } catch (_) {} finally {
      scanned += 1;
      if (onProgress) onProgress({ scanned, total: majors.length });
    }
  });

  const timetable = [];
  for (const row of matchedRaw) {
    for (const e of classRowToTimetableEntries(row)) {
      e.major = row._majorName;
      e.majorCode = row._majorCode;
      timetable.push(e);
    }
  }

  const seen = new Set();
  const deduped = timetable.filter(e => {
    const k = `${e.day}-${e.start}-${e.end}-${e.title}-${e.bunban}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));

  return {
    yearhakgi,
    profName,
    totalMajorsScanned: majors.length,
    matchedMajors: [...matchedByMajor.entries()].map(([code, v]) => ({ code, name: v.majorName, classCount: v.count })),
    classes: matchedRaw,
    timetable: deduped,
  };
}

function dateToYearHakgi(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  // 월 기준 고정 규칙(한성대 홈페이지 기본값이 미리 다음 학기로 바뀌어 있어도 무시):
  //  3~6월 = 1학기(1), 7~8월 = 여름학기(3), 9~12월 = 2학기(2), 1~2월 = 전년도 겨울학기(4)
  if (month >= 3 && month <= 6) return `${year}1`;   // 1학기
  if (month >= 7 && month <= 8) return `${year}3`;   // 여름학기
  if (month >= 9 && month <= 12) return `${year}2`;  // 2학기
  return `${year - 1}4`;                              // 1~2월: 전년도 겨울학기
}

function describeYearHakgi(code) {
  if (!code || code.length < 5) return code || '';
  const year = code.slice(0, 4);
  const sem = code.slice(4);
  const semNames = { '1': '1학기', '2': '2학기', '3': '여름학기', '4': '겨울학기' };
  return `${year}년 ${semNames[sem] || sem + '학기'}`;
}

module.exports = {
  getSessionCookie,
  getYearHakgiList,
  getJungongList,
  getClassesForJungong,
  parseClassroomField,
  classRowToTimetableEntries,
  findProfessorClasses,
  dateToYearHakgi,
  describeYearHakgi,
  snapshotGeneratedAt,
  PERIOD_START,
};
