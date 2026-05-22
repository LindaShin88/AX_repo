const bcrypt = require('bcrypt');
const db = require('./database');

async function seed() {
  console.log('🌱 시드 데이터 생성중...');

  db.exec(`
    DELETE FROM signatures;
    DELETE FROM slot_responses;
    DELETE FROM meeting_slots;
    DELETE FROM member_tokens;
    DELETE FROM notifications;
    DELETE FROM meetings;
    DELETE FROM members;
    DELETE FROM committees;
    DELETE FROM operators;
    DELETE FROM sqlite_sequence;
  `);

  const superHash = await bcrypt.hash('admin1234', 10);
  const superInfo = db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status, approved_at)
    VALUES (?, ?, ?, ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP)
  `).run('admin', superHash, 'Linda', '시스템 운영', 'admin@hansung.ac.kr');
  const superId = superInfo.lastInsertRowid;
  console.log(`  ✓ 슈퍼관리자 계정: admin / admin1234`);

  const opHash = await bcrypt.hash('demo1234', 10);
  const opInfo = db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, 'operator', 'active', ?, CURRENT_TIMESTAMP)
  `).run('haksa1', opHash, '김행정', '학사팀', 'haksa1@hansung.ac.kr', superId);
  const opId = opInfo.lastInsertRowid;
  console.log(`  ✓ 운영자 계정 (active): haksa1 / demo1234`);

  const pendingHash = await bcrypt.hash('test1234', 10);
  db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status)
    VALUES (?, ?, ?, ?, ?, 'operator', 'pending')
  `).run('insa1', pendingHash, '박인사', '인사팀', 'insa1@hansung.ac.kr');
  console.log(`  ✓ 가입 대기 계정: insa1 (승인 대기)`);
  db.prepare(`
    INSERT INTO operators (username, password_hash, name, department, email, role, status)
    VALUES (?, ?, ?, ?, ?, 'operator', 'pending')
  `).run('yeongu1', pendingHash, '이연구', '연구지원팀', 'yeongu1@hansung.ac.kr');
  console.log(`  ✓ 가입 대기 계정: yeongu1 (승인 대기)`);

  const committees = [
    { name: '학사운영위원회', desc: '학사 제도 및 학칙 개정 심의', quorum: 5 },
    { name: '학생복지위원회', desc: '학생 복지 및 장학금 심의', quorum: 4 },
    { name: '입학사정관위원회', desc: '입학 전형 심의 및 평가', quorum: 6 },
  ];
  const insertCommittee = db.prepare(`
    INSERT INTO committees (name, description, operator_id, quorum) VALUES (?, ?, ?, ?)
  `);
  const cIds = committees.map(c => insertCommittee.run(c.name, c.desc, opId, c.quorum).lastInsertRowid);
  console.log(`  · 위원회는 운영자 haksa1 (학사팀) 소유로 생성됨`);
  console.log(`  ✓ 위원회 ${cIds.length}건 생성`);

  const insertMember = db.prepare(`
    INSERT INTO members (committee_id, name, email, phone, type, sabun, role, affiliation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const c1Members = [
    { name: '신영헌', email: 'shin@hansung.ac.kr', phone: '010-1111-1111', type: 'faculty', sabun: '110579', role: '위원장', affiliation: '컴퓨터공학부' },
    { name: '김교수', email: 'kim@hansung.ac.kr', phone: '010-2222-2222', type: 'faculty', sabun: '110850', role: '위원', affiliation: '경영학부' },
    { name: '이교수', email: 'lee@hansung.ac.kr', phone: '010-3333-3333', type: 'faculty', sabun: '110814', role: '위원', affiliation: '디자인학부' },
    { name: '박외부', email: 'park.ext@example.com', phone: '010-4444-4444', type: 'external', sabun: null, role: '외부전문가', affiliation: '한국교육개발원' },
    { name: '최외부', email: 'choi.ext@example.com', phone: '010-5555-5555', type: 'external', sabun: null, role: '외부위원', affiliation: '서울교육청' },
  ];
  c1Members.forEach(m => insertMember.run(cIds[0], m.name, m.email, m.phone, m.type, m.sabun, m.role, m.affiliation));

  const c2Members = [
    { name: '신영헌', email: 'shin@hansung.ac.kr', phone: '010-1111-1111', type: 'faculty', sabun: '110579', role: '위원', affiliation: '컴퓨터공학부' },
    { name: '정교수', email: 'jung@hansung.ac.kr', phone: '010-6666-6666', type: 'faculty', sabun: '110850', role: '위원장', affiliation: '경영학부' },
    { name: '윤학생처', email: 'yoon@hansung.ac.kr', phone: '010-7777-7777', type: 'staff', sabun: null, role: '학생처장', affiliation: '학생처' },
    { name: '강복지', email: 'kang.ext@example.com', phone: '010-8888-8888', type: 'external', sabun: null, role: '외부전문가', affiliation: '청소년재단' },
  ];
  c2Members.forEach(m => insertMember.run(cIds[1], m.name, m.email, m.phone, m.type, m.sabun, m.role, m.affiliation));

  const c3Members = [
    { name: '이교수', email: 'lee@hansung.ac.kr', phone: '010-3333-3333', type: 'faculty', sabun: '110814', role: '위원장', affiliation: '디자인학부' },
    { name: '신영헌', email: 'shin@hansung.ac.kr', phone: '010-1111-1111', type: 'faculty', sabun: '110579', role: '위원', affiliation: '컴퓨터공학부' },
    { name: '김교수', email: 'kim@hansung.ac.kr', phone: '010-2222-2222', type: 'faculty', sabun: '110850', role: '위원', affiliation: '경영학부' },
    { name: '윤학생', email: 'student.yoon@hansung.ac.kr', phone: '010-1212-1212', type: 'student', sabun: null, role: '학생대표', affiliation: '총학생회' },
    { name: '한입학', email: 'han.ext@example.com', phone: '010-9999-9999', type: 'external', sabun: null, role: '외부사정관', affiliation: '한국대학교육협의회' },
    { name: '오평가', email: 'oh.ext@example.com', phone: '010-1010-1010', type: 'external', sabun: null, role: '외부평가위원', affiliation: '교육부' },
    { name: '서고교', email: 'seo.ext@example.com', phone: '010-2020-2020', type: 'external', sabun: null, role: '고교 진학지도', affiliation: '서울고등학교' },
  ];
  c3Members.forEach(m => insertMember.run(cIds[2], m.name, m.email, m.phone, m.type, m.sabun, m.role, m.affiliation));

  console.log(`  ✓ 위원 총 ${c1Members.length + c2Members.length + c3Members.length}명 생성`);

  // === 랜딩 페이지 위원 데모용 회의 + 토큰 ===
  // (1) 일정 투표 데모 회의 (scheduling)
  const demoVoteInfo = db.prepare(`
    INSERT INTO meetings (committee_id, title, description, location, duration_minutes, status, schedule_constraints, notify_channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cIds[0], '[데모] 위원 시점 일정 투표 체험',
         '랜딩 페이지 방문자가 위원의 일정 응답 화면을 직접 클릭해볼 수 있는 데모 회의입니다.\n실제 회의에 영향을 주지 않습니다.',
         '본관 회의실 301', 60, 'scheduling',
         '{"window":{"start":"2026-06-01","end":"2026-06-05"}}', 'email');
  const demoVoteMeetingId = demoVoteInfo.lastInsertRowid;

  const demoVoteSlots = [
    ['2026-06-01T10:00:00', '2026-06-01T11:00:00'],
    ['2026-06-02T14:00:00', '2026-06-02T15:00:00'],
    ['2026-06-03T10:00:00', '2026-06-03T11:00:00'],
    ['2026-06-04T15:00:00', '2026-06-04T16:00:00'],
    ['2026-06-05T10:00:00', '2026-06-05T11:00:00'],
  ];
  const insertDemoSlot = db.prepare('INSERT INTO meeting_slots (meeting_id, start_time, end_time, suggested_score) VALUES (?, ?, ?, 1.0)');
  for (const [s, e] of demoVoteSlots) insertDemoSlot.run(demoVoteMeetingId, s, e);

  const demoVoter = db.prepare('SELECT id FROM members WHERE committee_id = ? AND type = ? ORDER BY id LIMIT 1').get(cIds[0], 'faculty');
  if (demoVoter) {
    db.prepare(`INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'availability')`)
      .run(demoVoter.id, demoVoteMeetingId, 'demo-avail-voter');
  }
  console.log(`  ✓ 데모 회의 #${demoVoteMeetingId} (위원 일정 투표 체험) 생성`);

  // (2) 서명 데모 회의 (confirmed + 회의록 텍스트)
  const demoSignInfo = db.prepare(`
    INSERT INTO meetings (committee_id, title, description, location, duration_minutes, status, schedule_constraints, notify_channels, minutes_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cIds[0], '[데모] 외부위원 서명 체험',
         '랜딩 페이지 방문자가 외부위원의 전자서명 화면을 직접 그어볼 수 있는 데모 회의입니다.',
         '본관 회의실 301', 60, 'confirmed',
         '{"window":{"start":"2026-06-01","end":"2026-06-01"}}', 'email',
         '[데모 회의록]\n\n일시: 2026. 6. 1. (월) 10:00\n장소: 본관 회의실 301\n\n안건\n1. 학사 운영 규정 개정안 심의\n2. 2026학년도 2학기 계획 검토\n\n결의 사항: 원안 가결\n\n※ 본 회의록은 랜딩 페이지 데모용입니다.');
  const demoSignMeetingId = demoSignInfo.lastInsertRowid;
  const demoSignSlotInfo = insertDemoSlot.run(demoSignMeetingId, '2026-06-01T10:00:00', '2026-06-01T11:00:00');
  db.prepare(`UPDATE meetings SET confirmed_slot_id = ? WHERE id = ?`).run(demoSignSlotInfo.lastInsertRowid, demoSignMeetingId);

  const demoSigner = db.prepare('SELECT id FROM members WHERE committee_id = ? AND type = ? ORDER BY id LIMIT 1').get(cIds[0], 'external');
  if (demoSigner) {
    db.prepare(`INSERT INTO member_tokens (member_id, meeting_id, token, purpose) VALUES (?, ?, ?, 'signature')`)
      .run(demoSigner.id, demoSignMeetingId, 'demo-sign-external');
  }
  console.log(`  ✓ 데모 회의 #${demoSignMeetingId} (외부위원 서명 체험) 생성`);

  console.log('\n✅ 시드 완료!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  서버 실행:    npm start');
  console.log('  접속:         http://localhost:3000');
  console.log('  운영자 로그인: admin / admin1234');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

seed().catch(err => { console.error(err); process.exit(1); });
