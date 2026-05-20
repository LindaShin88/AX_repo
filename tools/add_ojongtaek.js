const db = require('../database');
const oc = require('../services/hansung_oc');

const TARGET_COMMITTEE = '학사운영위원회';
const PROF_NAME = '오종택';
const YEARHAKGI = '20261';

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

async function main() {
  console.log(`\n🔍 ${YEARHAKGI.slice(0,4)}년 ${YEARHAKGI.slice(4)}학기 ${PROF_NAME} 교수 강의 검색...`);
  const t0 = Date.now();
  const result = await oc.findProfessorClasses(YEARHAKGI, PROF_NAME, {
    concurrency: 6,
    onProgress: ({ scanned, total }) => {
      if (scanned % 30 === 0 || scanned === total) {
        process.stdout.write(`\r  진행: ${scanned}/${total} 전공/트랙 스캔...   `);
      }
    },
  });
  console.log(`\n  ⏱️ ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  console.log(`  📊 매칭 트랙/학과: ${result.matchedMajors.length}개, 강의: ${result.classes.length}건, 시간표 슬롯: ${result.timetable.length}개\n`);

  console.log(`--- 매칭된 전공/트랙 ---`);
  result.matchedMajors.forEach(m => console.log(`  ${m.code} ${m.name} (강의 ${m.classCount}건)`));

  console.log(`\n--- 강의 목록 ---`);
  result.classes.forEach(c => {
    console.log(`  · [${c.kwamokcode}-${c.bunban}] ${c.kwamokname} | ${c.classroom} | ${c.juya}/${c.hakjum}학점 | 출처: ${c._majorName}`);
  });

  console.log(`\n--- 파싱된 시간표 ---`);
  result.timetable.forEach(e => {
    console.log(`  ${DAY_KO[e.day]} ${e.start}-${e.end} | ${e.title} @ ${e.location || '-'} (분반 ${e.bunban})`);
  });

  const committee = db.prepare('SELECT * FROM committees WHERE name = ?').get(TARGET_COMMITTEE);
  if (!committee) {
    console.error(`\n❌ "${TARGET_COMMITTEE}" 위원회를 찾을 수 없습니다.`);
    process.exit(1);
  }
  console.log(`\n✅ 대상 위원회: [#${committee.id}] ${committee.name}`);

  const existing = db.prepare('SELECT id FROM members WHERE committee_id = ? AND name = ?').get(committee.id, PROF_NAME);
  let memberId;
  if (existing) {
    memberId = existing.id;
    console.log(`  ℹ️ ${PROF_NAME} 위원이 이미 존재 (id=${memberId}) → 시간표 캐시 업데이트`);
  } else {
    const info = db.prepare(`
      INSERT INTO members (committee_id, name, email, phone, type, sabun, role, affiliation)
      VALUES (?, ?, ?, ?, 'faculty', ?, ?, ?)
    `).run(
      committee.id,
      PROF_NAME,
      'ojt@hansung.ac.kr',
      null,
      null,
      '위원',
      result.matchedMajors.map(m => m.name.replace(/^\[[^\]]+\]\s*/, '')).join(', ') || '전자트랙',
    );
    memberId = info.lastInsertRowid;
    console.log(`  ✓ 신규 위원 추가: id=${memberId}`);
  }

  const cacheEntries = result.timetable.map(e => ({
    day: e.day,
    start: e.start,
    end: e.end,
    title: e.title,
    location: e.location,
    bunban: e.bunban,
    major: e.major,
  }));

  db.prepare(`
    UPDATE members SET timetable_cache = ?, timetable_source = 'hansung_oc', timetable_fetched_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(JSON.stringify(cacheEntries), memberId);
  console.log(`  ✓ 시간표 캐시 저장 완료 (${cacheEntries.length}개 슬롯, source='hansung_oc')`);

  const saved = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📌 저장 결과`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  위원회: ${committee.name}`);
  console.log(`  이름:   ${saved.name}`);
  console.log(`  소속:   ${saved.affiliation}`);
  console.log(`  유형:   ${saved.type} / 역할: ${saved.role}`);
  console.log(`  이메일: ${saved.email || '-'}`);
  console.log(`  시간표 소스: ${saved.timetable_source}`);
  console.log(`  시간표 수집 시각: ${saved.timetable_fetched_at}`);
  console.log(`\n📅 시간표 (DB 저장된 상태):`);
  const stored = JSON.parse(saved.timetable_cache);
  stored.forEach(e => {
    console.log(`   · ${DAY_KO[e.day]} ${e.start}-${e.end}  ${e.title.padEnd(15)} @ ${e.location || '-'}  [분반 ${e.bunban}]`);
  });
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n🌐 웹에서 확인: http://localhost:3000/admin/committees/${committee.id}`);
  console.log(`   시간표 상세: http://localhost:3000/admin/committees/${committee.id}/members/${memberId}/timetable\n`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
