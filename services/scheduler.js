const { getTimetable, busyAt } = require('./timetable');
const hansungOc = require('./hansung_oc');
const db = require('../database');

function fmtLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function parseConstraints(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function defaultConstraints() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return {
    window: { start: fmtDate(start), end: fmtDate(end) },
    excludedDates: [],
    morningHours: [10],
    afternoonHours: [13, 14, 15],
    dateOverrides: {},
  };
}

function generateCandidatesFromConstraints(constraintsRaw, durationMinutes) {
  const c = { ...defaultConstraints(), ...parseConstraints(constraintsRaw) };
  const start = new Date(c.window.start + 'T00:00:00');
  const end = new Date(c.window.end + 'T00:00:00');
  const excluded = new Set(c.excludedDates || []);
  const candidates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (excluded.has(dateStr)) continue;
    const hasOverride = c.dateOverrides && c.dateOverrides[dateStr];
    const dow = d.getDay();
    if (!hasOverride && (dow === 0 || dow === 6)) continue;
    const allowedHours = hasOverride
      ? c.dateOverrides[dateStr]
      : [...(c.morningHours || []), ...(c.afternoonHours || [])];
    for (const h of allowedHours) {
      const slotStart = new Date(d);
      slotStart.setHours(h, 0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
      candidates.push({ start: fmtLocal(slotStart), end: fmtLocal(slotEnd) });
    }
  }
  return candidates;
}

function readCachedTimetable(member) {
  if (member.timetable_cache) {
    try {
      const parsed = JSON.parse(member.timetable_cache);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {}
  }
  return null;
}

function readCachedMeta(member) {
  if (member.timetable_meta) {
    try { return JSON.parse(member.timetable_meta); } catch (e) {}
  }
  return null;
}

async function getMemberTimetable(member, opts = {}) {
  const refDate = opts.referenceDate ? new Date(opts.referenceDate) : new Date();
  const targetYearHakgi = hansungOc.dateToYearHakgi(refDate);

  if (member.type === 'faculty') {
    const meta = readCachedMeta(member);
    const cached = readCachedTimetable(member);
    if (cached && meta && meta.yearhakgi === targetYearHakgi) return cached;

    try {
      const result = await hansungOc.findProfessorClasses(targetYearHakgi, member.name, { concurrency: 6 });
      const cacheEntries = result.timetable.map(e => ({
        day: e.day, start: e.start, end: e.end, title: e.title,
        location: e.location, bunban: e.bunban, major: e.major, majorCode: e.majorCode,
      }));
      const newMeta = {
        yearhakgi: targetYearHakgi,
        crawledAt: new Date().toISOString(),
        matchedMajors: result.matchedMajors,
        classCount: result.classes.length,
        slotCount: cacheEntries.length,
        searchName: member.name,
      };
      db.prepare(`
        UPDATE members SET timetable_cache = ?, timetable_source = 'hansung_oc',
                           timetable_fetched_at = CURRENT_TIMESTAMP, timetable_meta = ?
         WHERE id = ?
      `).run(JSON.stringify(cacheEntries), JSON.stringify(newMeta), member.id);
      return cacheEntries;
    } catch (e) {
      return cached || [];
    }
  }

  const cached = readCachedTimetable(member);
  if (cached) return cached;
  const fresh = db.prepare('SELECT timetable_cache FROM members WHERE id = ?').get(member.id);
  if (fresh) {
    const parsed = readCachedTimetable(fresh);
    if (parsed) return parsed;
  }
  if (member.sabun) {
    try {
      const tt = await getTimetable(member.sabun);
      return tt.data || [];
    } catch (e) {}
  }
  return [];
}

async function scoreSlotsAgainstMembers(slots, members, opts = {}) {
  const memberTimetables = await Promise.all(
    members.map(async (m) => ({ member: m, timetable: await getMemberTimetable(m, opts) }))
  );
  return slots.map((s) => {
    let conflicts = 0;
    let unknown = 0;
    for (const { member, timetable } of memberTimetables) {
      if (timetable && timetable.length > 0) {
        if (busyAt(timetable, s.start, s.end)) conflicts += 1;
      } else {
        unknown += 1;
      }
    }
    const total = members.length || 1;
    const score = (total - conflicts) / total - 0.05 * unknown / total;
    return { ...s, conflicts, unknown, score };
  });
}

async function suggestTopSlots(members, opts = {}) {
  const topN = opts.topN || 6;
  const duration = opts.durationMinutes || 60;
  const candidates = generateCandidatesFromConstraints(opts.constraints, duration);
  if (candidates.length === 0) return [];
  const scored = await scoreSlotsAgainstMembers(candidates, members, { referenceDate: opts.referenceDate });
  scored.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
  const top = scored.slice(0, Math.min(topN, scored.length));
  top.sort((a, b) => a.start.localeCompare(b.start));
  return top;
}

module.exports = {
  generateCandidatesFromConstraints,
  scoreSlotsAgainstMembers,
  suggestTopSlots,
  getMemberTimetable,
  defaultConstraints,
  parseConstraints,
};
