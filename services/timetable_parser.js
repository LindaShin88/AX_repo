const cheerio = require('cheerio');
const fs = require('fs');
const iconv = require('iconv-lite');

const DAY_MAP = { '일': 0, 'Sun': 0, '월': 1, 'Mon': 1, '화': 2, 'Tue': 2, '수': 3, 'Wed': 3, '목': 4, 'Thu': 4, '금': 5, 'Fri': 5, '토': 6, 'Sat': 6 };

function detectEncoding(buf) {
  const head = buf.slice(0, 1024).toString('ascii');
  if (/charset=\s*["']?euc-?kr/i.test(head)) return 'euc-kr';
  if (/charset=\s*["']?utf-?8/i.test(head)) return 'utf-8';
  return 'utf-8';
}

function readHtmlFile(filepath) {
  const buf = fs.readFileSync(filepath);
  const enc = detectEncoding(buf);
  return iconv.decode(buf, enc);
}

function parse12h(text) {
  const m = String(text).match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm|오전|오후)?/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const meridian = (m[3] || '').toUpperCase();
  if (meridian === 'PM' || meridian === '오후') {
    if (h < 12) h += 12;
  } else if (meridian === 'AM' || meridian === '오전') {
    if (h === 12) h = 0;
  }
  return { h, m: min };
}

function fmtTime(t) {
  if (!t) return '';
  return `${String(t.h).padStart(2,'0')}:${String(t.m).padStart(2,'0')}`;
}

function parseDataFull(dataFull) {
  if (!dataFull) return null;
  const parts = dataFull.split(/\s*[-~–]\s*/);
  if (parts.length < 2) return null;
  const start = parse12h(parts[0]);
  const end = parse12h(parts[1]);
  if (!start || !end) return null;
  return { start, end };
}

function parseFullCalendarHtml(html) {
  const $ = cheerio.load(html);
  const events = [];

  const dateColumns = [];
  $('td[data-date]').each((_, el) => {
    const v = $(el).attr('data-date');
    if (v && !dateColumns.includes(v)) dateColumns.push(v);
  });

  $('.fc-time-grid-event, a.fc-event, .fc-event').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.fc-title').first().html() || $el.find('.fc-event-title').first().html() || $el.find('.fc-title').first().text() || '';
    const cleanTitle = title.replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, '').trim() || '수업';

    const dataFull = $el.find('[data-full]').attr('data-full') || $el.attr('data-full');
    let timeInfo = parseDataFull(dataFull);

    if (!timeInfo) {
      const timeText = $el.find('.fc-time span').first().text() || $el.find('.fc-time, .fc-event-time').first().text();
      const tm = timeText.match(/(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})/);
      if (tm) {
        let sh = parseInt(tm[1]), eh = parseInt(tm[3]);
        const sm = parseInt(tm[2]), em = parseInt(tm[4]);
        if (sh < 8 && eh < 8) { sh += 12; eh += 12; }
        else if (sh < 8 && eh >= 8) { sh += 12; }
        timeInfo = { start: { h: sh, m: sm }, end: { h: eh, m: em } };
      }
    }
    if (!timeInfo) return;

    let day = null;
    const dataDateEl = $el.closest('[data-date]');
    const dataDate = dataDateEl.attr('data-date');
    if (dataDate) {
      const d = new Date(dataDate);
      if (!isNaN(d)) day = d.getDay();
    }

    if (day === null) {
      const $td = $el.closest('td');
      const $tr = $td.parent('tr');
      const tds = $tr.children('td').toArray();
      let colIdx = -1;
      let visibleIdx = 0;
      for (let i = 0; i < tds.length; i++) {
        const cls = $(tds[i]).attr('class') || '';
        if (cls.includes('fc-axis')) continue;
        if (tds[i] === $td[0]) { colIdx = visibleIdx; break; }
        visibleIdx++;
      }
      if (colIdx >= 0 && dateColumns[colIdx]) {
        const d = new Date(dateColumns[colIdx]);
        if (!isNaN(d)) day = d.getDay();
      }
    }
    if (day === null) return;

    events.push({
      day,
      start: fmtTime(timeInfo.start),
      end: fmtTime(timeInfo.end),
      title: cleanTitle,
    });
  });

  const seen = new Set();
  const deduped = events.filter(e => {
    const k = `${e.day}-${e.start}-${e.end}-${e.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (deduped.length === 0) {
    const bodyText = $('body').text();
    for (const line of bodyText.split(/\n/)) {
      const m = line.match(/([월화수목금토일])\s*[:,]?\s*(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})\s*(.+)?/);
      if (m) {
        deduped.push({
          day: DAY_MAP[m[1]],
          start: `${m[2].padStart(2,'0')}:${m[3]}`,
          end: `${m[4].padStart(2,'0')}:${m[5]}`,
          title: (m[6] || '수업').trim(),
        });
      }
    }
  }

  deduped.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return deduped;
}

function parseUploadedFile(filepath, mimetype) {
  const isHtml = /\.(html?|htm)$/i.test(filepath) || /html/i.test(mimetype || '');
  if (isHtml) {
    try {
      const html = readHtmlFile(filepath);
      return { events: parseFullCalendarHtml(html), source: 'html' };
    } catch (e) {
      return { events: [], source: 'html', error: e.message };
    }
  }
  return { events: [], source: 'image', note: 'OCR이 아직 구현되지 않아 빈 시간표로 시작합니다. 아래에서 수동으로 입력해주세요.' };
}

module.exports = { parseUploadedFile, parseFullCalendarHtml, DAY_MAP };
