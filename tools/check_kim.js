const db = require('../database');

const member = db.prepare(`
  SELECT m.*, c.name AS committee_name
    FROM members m JOIN committees c ON c.id = m.committee_id
   WHERE m.name = '김은주'
`).all();
console.log(`'김은주' 위원 검색 결과: ${member.length}건`);
member.forEach(m => console.log(`  · #${m.id}  ${m.committee_name}  / type=${m.type}  / created_at=${m.created_at}`));

if (member.length === 0) { console.log('\n→ 김은주가 DB에 없음'); process.exit(0); }

for (const m of member) {
  console.log(`\n--- 위원 #${m.id} (${m.name}, ${m.committee_name}) 분석 ---`);

  const meetings = db.prepare(`
    SELECT id, title, status, created_at FROM meetings WHERE committee_id = ? ORDER BY id
  `).all(m.committee_id);
  console.log(`해당 위원회의 회의: ${meetings.length}건`);

  for (const mt of meetings) {
    const token = db.prepare(`
      SELECT * FROM member_tokens WHERE meeting_id = ? AND member_id = ?
    `).get(mt.id, m.id);
    const responseCount = db.prepare(`
      SELECT COUNT(*) AS n FROM slot_responses sr
      JOIN meeting_slots ms ON ms.id = sr.slot_id
      WHERE ms.meeting_id = ? AND sr.member_id = ?
    `).get(mt.id, m.id).n;

    console.log(`  회의 #${mt.id} "${mt.title}" (${mt.status}, 생성 ${mt.created_at})`);
    console.log(`     · 토큰: ${token ? '✅ 있음 (' + token.token.slice(0,12) + '...)' : '❌ 없음 (응답 링크 발급 안 됨)'}`);
    console.log(`     · 위원 추가 시각: ${m.created_at}`);
    console.log(`     · 회의 생성 시각: ${mt.created_at}`);
    console.log(`     · 시점 비교: ${m.created_at > mt.created_at ? '⚠️ 회의가 먼저 만들어진 뒤 위원 추가됨' : '회의가 위원 추가 후에 생성됨'}`);
    console.log(`     · 응답 기록: ${responseCount}건`);
  }
}
