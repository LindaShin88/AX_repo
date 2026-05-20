const db = require('../database');
const { scoreSlotsAgainstMembers, getMemberTimetable } = require('../services/scheduler');
const { dateToYearHakgi } = require('../services/hansung_oc');

(async () => {
  const oj = db.prepare("SELECT * FROM members WHERE name='오종택' AND committee_id=1").get();
  if (!oj) { console.log('오종택 위원 없음. 먼저 추가 필요.'); process.exit(1); }

  const refDate = new Date('2026-05-25');
  console.log(`기준일: ${refDate.toISOString().slice(0,10)} → 학기: ${dateToYearHakgi(refDate)}`);
  console.log();

  console.log('=== 오종택 단독 점수 매트릭스 (월~토, 09-18시) ===');
  const candidates = [];
  const dates = ['2026-05-25','2026-05-26','2026-05-27','2026-05-28','2026-05-29','2026-05-30'];
  const hours = [9, 10, 11, 13, 14, 15, 16];
  for (const d of dates) {
    for (const h of hours) {
      candidates.push({
        start: `${d}T${String(h).padStart(2,'0')}:00:00`,
        end: `${d}T${String(h).padStart(2,'0')}:50:00`,
      });
    }
  }

  const scored = await scoreSlotsAgainstMembers(candidates, [oj], { referenceDate: refDate });

  const DAY = ['일','월','화','수','목','금','토'];
  const grid = {};
  for (const s of scored) {
    const d = new Date(s.start);
    const dayLabel = `${DAY[d.getDay()]} (${d.toISOString().slice(5,10)})`;
    const hour = d.getHours();
    if (!grid[dayLabel]) grid[dayLabel] = {};
    grid[dayLabel][hour] = s.conflicts > 0 ? '❌충돌' : '✅가능';
  }
  const header = '             ' + hours.map(h => String(h).padStart(2,'0')+'시').join('  ');
  console.log(header);
  for (const day of Object.keys(grid)) {
    let line = day.padEnd(13);
    for (const h of hours) {
      line += (grid[day][h] || '?').padEnd(6);
    }
    console.log(line);
  }
})().catch(e => { console.error(e); process.exit(1); });
