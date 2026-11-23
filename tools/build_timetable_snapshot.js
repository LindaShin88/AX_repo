// 학기별 "시간표 스냅샷" 생성 도구.
// 한성대 학부 개설강좌(info.hansung.ac.kr siganpyo)를 한 번에 긁어,
// 교수명 -> 시간표 엔트리 맵으로 저장한다. 라이브(Render)에서 매번 긁다 ECONNRESET이
// 나던 문제를, 이 스냅샷을 "먼저" 사용해 네트워크 없이 연결하도록 하기 위함.
//
// 사용법:  node tools/build_timetable_snapshot.js [yearhakgi]
//   yearhakgi 생략 시 현재 날짜 기준(dateToYearHakgi)으로 자동 선택.
// 결과:    data/timetable-snapshot-<yearhakgi>.json

const fs = require('fs');
const path = require('path');
const oc = require('../services/hansung_oc');

(async () => {
  const yh = process.argv[2] || oc.dateToYearHakgi(new Date());
  if (!yh) { console.error('학기(yearhakgi)를 결정할 수 없습니다.'); process.exit(1); }
  console.log('스냅샷 생성 학기:', yh);

  const { cookie, items: majors } = await oc.getJungongList(null, yh);
  console.log('전공 수:', majors.length);

  // 교수명 -> raw class rows (동명이인은 라이브 로직과 동일하게 이름 기준으로 합쳐짐)
  const rawByProf = new Map();
  const seenPlanByProf = new Map(); // 교수별 중복 강의 제거
  let scanned = 0, failed = 0;
  let idx = 0;
  const LIMIT = 6;
  async function worker() {
    while (idx < majors.length) {
      const mj = majors[idx++];
      try {
        const rows = await oc.getClassesForJungong(cookie, yh, mj.code);
        for (const r of rows) {
          if (!r.prof) continue;
          // "박종언,홍승진"처럼 공동 담당이면 각 교수 이름별로 넣는다.
          const profNames = String(r.prof).split(/[,/·]/).map(s => s.trim()).filter(Boolean);
          for (const pn of profNames) {
            if (!rawByProf.has(pn)) { rawByProf.set(pn, []); seenPlanByProf.set(pn, new Set()); }
            const key = r.plan || `${r.kwamokcode}-${r.bunban}`;
            const seen = seenPlanByProf.get(pn);
            if (seen.has(key)) continue;
            seen.add(key);
            rawByProf.get(pn).push({ ...r, _mj: mj.name, _mjCode: mj.code });
          }
        }
        scanned++;
      } catch (e) { failed++; }
    }
  }
  await Promise.all(Array.from({ length: LIMIT }, worker));
  console.log(`스캔 성공 ${scanned} / 실패 ${failed}`);
  if (failed > 0) { console.error('⚠️ 일부 전공 조회 실패 — 스냅샷이 불완전할 수 있어 저장 보류'); process.exit(2); }

  // raw -> 시간표 엔트리(서비스와 동일 변환) + 교수별 중복 슬롯 제거
  const professors = {};
  let totalEntries = 0;
  for (const [prof, rows] of rawByProf) {
    const entries = [];
    const seen = new Set();
    for (const row of rows) {
      for (const e of oc.classRowToTimetableEntries(row)) {
        const k = `${e.day}-${e.start}-${e.end}-${e.title}-${e.bunban}`;
        if (seen.has(k)) continue;
        seen.add(k);
        entries.push({
          day: e.day, start: e.start, end: e.end, title: e.title,
          location: e.location || null, juya: e.juya || null, bunban: e.bunban || null,
          major: row._mj || null, majorCode: row._mjCode || null,
        });
      }
    }
    entries.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
    professors[prof] = entries;
    totalEntries += entries.length;
  }

  const snapshot = {
    yearhakgi: yh,
    generatedAt: new Date().toISOString(),
    source: 'info.hansung.ac.kr siganpyo (학부 개설강좌)',
    professorCount: Object.keys(professors).length,
    entryCount: totalEntries,
    professors,
  };

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `timetable-snapshot-${yh}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot), 'utf8');
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✅ 저장: ${outPath}`);
  console.log(`   교수 ${snapshot.professorCount}명, 강의슬롯 ${snapshot.entryCount}건, 파일 ${sizeKB} KB`);
  process.exit(0);
})().catch(e => { console.error('생성 실패:', e.message); process.exit(1); });
