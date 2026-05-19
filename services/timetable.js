const axios = require('axios');
const iconv = require('iconv-lite');

const HANSUNG_BASE = 'https://info.hansung.ac.kr/fuz/sugang';
const TIMETABLE_PAGE = `${HANSUNG_BASE}/gyo_h_siganpyo_nopasswd.jsp`;
const TIMETABLE_DATA = `${HANSUNG_BASE}/gyo_sigan_main_data_nopasswd.jsp`;

const MOCK_TIMETABLES = {
  '110579': [
    { day: 1, start: '09:00', end: '10:15', title: '컴퓨터공학개론' },
    { day: 1, start: '10:30', end: '11:45', title: '데이터구조' },
    { day: 3, start: '13:00', end: '14:15', title: '알고리즘' },
    { day: 3, start: '14:30', end: '15:45', title: '대학원 세미나' },
    { day: 4, start: '09:00', end: '10:15', title: '컴퓨터공학개론' },
  ],
  '110850': [
    { day: 2, start: '10:00', end: '11:50', title: '경영학원론' },
    { day: 4, start: '13:00', end: '14:50', title: '재무관리' },
    { day: 5, start: '10:00', end: '11:50', title: '마케팅' },
  ],
  '110814': [
    { day: 1, start: '13:00', end: '14:15', title: '디자인 사고' },
    { day: 2, start: '09:00', end: '10:50', title: '시각디자인' },
    { day: 3, start: '10:30', end: '11:45', title: '디자인 사고' },
    { day: 4, start: '13:00', end: '14:50', title: '졸업작품 지도' },
  ],
};

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function normalizeCookie(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/=/.test(trimmed)) return trimmed.replace(/^Cookie:\s*/i, '');
  return `JSESSIONID=${trimmed}`;
}

function mergeCookies(existing, setCookieHeaders) {
  const cookies = new Map();
  if (existing) {
    for (const pair of existing.split(/;\s*/)) {
      const [k, ...rest] = pair.split('=');
      if (k && rest.length) cookies.set(k.trim(), rest.join('='));
    }
  }
  if (Array.isArray(setCookieHeaders)) {
    for (const sc of setCookieHeaders) {
      const first = sc.split(';')[0];
      const [k, ...rest] = first.split('=');
      if (k && rest.length) cookies.set(k.trim(), rest.join('='));
    }
  }
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchTimetableRaw(sabun, sessionCookie = null) {
  try {
    let cookie = normalizeCookie(sessionCookie);
    const headersBase = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    };

    if (cookie) {
      const getResp = await axios.get(`${TIMETABLE_PAGE}?as_sabun=${sabun}`, {
        headers: { ...headersBase, 'Cookie': cookie, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        responseType: 'arraybuffer',
        timeout: 10000,
        validateStatus: () => true,
      });
      const setCookie = getResp.headers['set-cookie'];
      if (setCookie) cookie = mergeCookies(cookie, setCookie);
    }

    const postHeaders = {
      ...headersBase,
      'Referer': `${TIMETABLE_PAGE}?as_sabun=${sabun}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://info.hansung.ac.kr',
    };
    if (cookie) postHeaders['Cookie'] = cookie;

    const params = new URLSearchParams();
    params.append('as_sabun', sabun);
    const resp = await axios.post(TIMETABLE_DATA, params, {
      headers: postHeaders,
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: () => true,
    });
    const text = iconv.decode(Buffer.from(resp.data), 'euc-kr');
    if (text.includes('로그인 정보를 잃었습니다') || text.includes('parent.location') || text.includes('return_url=')) {
      return { ok: false, reason: 'auth_required', raw: text.slice(0, 200) };
    }
    try {
      const json = JSON.parse(text);
      return { ok: true, events: json };
    } catch (e) {
      return { ok: false, reason: 'parse_error', raw: text.slice(0, 200) };
    }
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

function fcEventsToTimetable(events) {
  if (!Array.isArray(events)) return [];
  const seen = new Set();
  const result = [];
  for (const ev of events) {
    if (!ev || !ev.start) continue;
    const startDate = new Date(ev.start.replace(' ', 'T'));
    const endDate = ev.end ? new Date(ev.end.replace(' ', 'T')) : new Date(startDate.getTime() + 60 * 60 * 1000);
    if (isNaN(startDate) || isNaN(endDate)) continue;
    const day = startDate.getDay();
    const pad = (n) => String(n).padStart(2, '0');
    const start = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
    const end = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
    const title = String(ev.title || '수업').replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const key = `${day}-${start}-${end}-${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ day, start, end, title });
  }
  result.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return result;
}

function getMockTimetable(sabun) {
  return MOCK_TIMETABLES[sabun] || [];
}

function busyAt(timetable, startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const day = start.getDay();
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  for (const cls of timetable) {
    if (cls.day !== day) continue;
    const [sh, sm] = cls.start.split(':').map(Number);
    const [eh, em] = cls.end.split(':').map(Number);
    const cs = sh * 60 + sm;
    const ce = eh * 60 + em;
    if (startMin < ce && endMin > cs) return cls;
  }
  return null;
}

async function getTimetable(sabun, { useMock = true, sessionCookie = null } = {}) {
  if (sabun) {
    const real = await fetchTimetableRaw(sabun, sessionCookie);
    if (real.ok) return { source: 'live', data: real.events };
  }
  if (useMock) return { source: 'mock', data: getMockTimetable(sabun) };
  return { source: 'none', data: [] };
}

function getTimetableImageUrl(sabun) {
  return `${TIMETABLE_PAGE}?as_sabun=${sabun}`;
}

module.exports = {
  getTimetable,
  getMockTimetable,
  busyAt,
  getTimetableImageUrl,
  fetchTimetableRaw,
  fcEventsToTimetable,
  normalizeCookie,
  DAY_KO,
};
