const axios = require('axios');
const https = require('https');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const BASE = 'https://info.hansung.ac.kr/jsp_21/student/kyomu/';
const PAGE_URL = BASE + 'siganpyo_aui.jsp?viewMode=oc';
const DATA_URL = BASE + 'siganpyo_aui_data.jsp';

const DEFAULT_HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

const DAY_MAP = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };

async function getSessionCookie() {
  const r = await axios.get(PAGE_URL, {
    responseType: 'arraybuffer',
    headers: DEFAULT_HEADERS_BASE,
    timeout: 15000,
    validateStatus: () => true,
  });
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
  const r = await axios.post(url, sp, {
    responseType: 'arraybuffer',
    headers: buildHeaders(cookie),
    timeout: 20000,
    validateStatus: () => true,
    httpsAgent,
    maxRedirects: 0,
    decompress: true,
  });
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

const PERIOD_START = {
  0: '08:00',
  1: '09:00', 2: '10:00', 3: '11:00', 4: '12:00', 5: '13:00',
  6: '14:00', 7: '15:00', 8: '16:00', 9: '17:00', 10: '18:00',
  11: '19:00', 12: '20:00', 13: '21:00', 14: '22:00',
};

function periodToStartMin(periodStr) {
  const m = String(periodStr).match(/^(\d{1,2})/);
  if (!m) return null;
  const p = parseInt(m[1]);
  if (!PERIOD_START[p]) return null;
  const [h, mm] = PERIOD_START[p].split(':').map(Number);
  return h * 60 + mm;
}

function periodToEndMin(periodStr) {
  const start = periodToStartMin(periodStr);
  if (start === null) return null;
  return start + 50;
}

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const TIME_PATTERN = /([월화수목금토일])\s*(\d{1,2})\s*M?\s*(?:~\s*(\d{1,2})\s*M?)?/g;

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
      const startP = m[2];
      const endP = m[3] || m[2];
      const sMin = periodToStartMin(startP);
      const eMin = periodToEndMin(endP);
      if (sMin === null || eMin === null) continue;
      slots.push({
        day,
        start: minToTime(sMin),
        end: minToTime(eMin),
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

async function findProfessorClasses(yearhakgi, profName, { concurrency = 8, onProgress = null } = {}) {
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
  if (month >= 3 && month <= 8) return `${year}1`;
  if (month >= 9 && month <= 12) return `${year}2`;
  return `${year - 1}2`;
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
  PERIOD_START,
};
