const db = require('../database');
const mt = db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT 1').get();
const facMembers = db.prepare("SELECT * FROM members WHERE committee_id = ? AND type = 'faculty'").all(mt.committee_id);
const DAY = ['일','월','화','수','목','금','토'];
for (const m of facMembers) {
  console.log(`\n=== ${m.name} 의 시간표 캐시 ===`);
  try {
    const tt = JSON.parse(m.timetable_cache || '[]');
    if (tt.length === 0) console.log('(비어있음)');
    tt.forEach(e => console.log(`  · ${DAY[e.day]} ${e.start}-${e.end}  ${e.title}  @${e.location || '-'}  분반${e.bunban || ''}`));
    const meta = m.timetable_meta ? JSON.parse(m.timetable_meta) : null;
    if (meta) {
      console.log(`  meta: 학기=${meta.yearhakgi}, 매칭=${meta.matchedMajors.length}개 트랙, 강의=${meta.classCount}건`);
      meta.matchedMajors.forEach(mm => console.log(`    · ${mm.name} (${mm.classCount}건)`));
    }
  } catch (e) { console.log('파싱 에러:', e.message); }
}
console.log(`\n=== 후보 슬롯 (모두 2026-05-22 금요일) ===`);
console.log('  · 09:00, 10:00, 11:00, 12:00, 13:00, 14:00 (1시간씩)');
console.log('  → 위 시간표에 금요일 09:00-15:00 사이 강의 있는 교수가 있어야 충돌 표시됨');
