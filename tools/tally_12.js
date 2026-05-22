const db = require('../database');
const slots = db.prepare(`
  SELECT ms.id, ms.start_time,
    (SELECT COUNT(*) FROM slot_responses WHERE slot_id = ms.id AND response = 'available') AS av,
    (SELECT COUNT(*) FROM slot_responses WHERE slot_id = ms.id AND response = 'unavailable') AS un
  FROM meeting_slots ms
  WHERE meeting_id = 12
  ORDER BY ms.start_time
`).all();
console.log('회의 #12 슬롯별 응답:');
slots.forEach(s => console.log(`  · ${s.start_time}  → 가능 ${s.av}명, 불가 ${s.un}명`));
const max = Math.max(...slots.map(s => s.av));
const top = slots.filter(s => s.av === max);
console.log(`\n최대 가능 응답수: ${max}명`);
console.log(`동률 슬롯 개수: ${top.length}개`);
if (top.length > 1) console.log('  → 동률이라 자동 확정 안 됨 (생성자에게 동률 안내 메일 발송)');
