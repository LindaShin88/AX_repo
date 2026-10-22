const axios = require('axios');

const SEARCH_URL = 'https://www.hansung.ac.kr/search/front/Search.jsp';
const DETAIL_URL = (sabun) => `https://www.hansung.ac.kr/prsnInt/${sabun}/artclView.do`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().replace(/\s+/g, ' ');
}

function cleanField(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

async function searchHits(name) {
  const r = await axios.get(SEARCH_URL, {
    params: { qt: name },
    headers: HEADERS,
    responseType: 'arraybuffer',
    timeout: 15000,
    validateStatus: () => true,
  });
  const txt = r.data.toString('utf-8');
  const trMatches = [...txt.matchAll(/<tr>[\s\S]*?<\/tr>/g)].filter(m => m[0].includes('prsnInt'));
  const hits = [];
  for (const m of trMatches) {
    const row = m[0];
    const sabunM = row.match(/prsnInt\/(\d+)\/artclView/);
    if (!sabunM) continue;
    const sabun = sabunM[1];
    // 이름은 prsnInt 링크가 달린 <th class="btn-open"> 안에 있다. 검색어 하이라이트가
    // 이름 일부를 <span class="p-color1">…</span>로 감싸 이름을 쪼개므로(예: "<span>이형</span>용"),
    // span만 떼지 말고 <th> 내부 전체 텍스트에서 태그를 제거해 온전한 이름을 얻는다.
    const thM = row.match(/<th[^>]*btn-open[^>]*>([\s\S]*?)<\/th>/i) || row.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const profName = stripTags(thM ? thM[1] : '');
    if (!profName || !profName.replace(/\s/g, '').includes(name.replace(/\s/g, ''))) continue;
    const tdMatches = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => cleanField(m[1]));
    hits.push({
      sabun,
      name: profName,
      affiliation: tdMatches[0] || '',
      position: tdMatches[1] || '',
      phone: tdMatches[2] || '',
    });
  }
  return hits;
}

async function fetchDetail(sabun) {
  const r = await axios.get(DETAIL_URL(sabun), {
    headers: HEADERS,
    responseType: 'arraybuffer',
    timeout: 10000,
    validateStatus: () => true,
  });
  const txt = r.data.toString('utf-8');
  const emailM = txt.match(/mailto:\s*([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/);
  const majorM = txt.match(/<em>\s*전공\s*<\/em>\s*<i>\s*([^<]+?)\s*<\/i>/);
  const phoneM = txt.match(/<em>\s*연락처\s*<\/em>\s*<i>\s*([^<]+?)\s*<\/i>/);
  const affM = txt.match(/<em>\s*소속\s*<\/em>[\s\S]*?<i>\s*([^<]+?)\s*</);
  return {
    sabun,
    email: emailM ? cleanField(emailM[1]) : null,
    major: majorM ? cleanField(majorM[1]) : null,
    phone: phoneM ? cleanField(phoneM[1]) : null,
    affiliation: affM ? cleanField(affM[1]) : null,
  };
}

async function lookupProfessor(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { matches: [], reason: 'empty-name' };

  const hits = await searchHits(trimmed);
  if (hits.length === 0) return { matches: [], reason: 'not-found' };

  for (const h of hits) {
    try {
      const detail = await fetchDetail(h.sabun);
      h.email = detail.email;
      h.major = detail.major;
      if (detail.affiliation) h.affiliation = detail.affiliation;
      if (detail.phone) h.phone = detail.phone;
    } catch (e) { h.email = null; }
  }

  function splitAffiliation(s) {
    if (!s) return [];
    return String(s).split(/\s*,\s*/).map(cleanField).filter(Boolean);
  }

  // 사번은 사람마다 유일하므로 사번으로 묶는다.
  // → 같은 사람이 여러 학과에 걸쳐 검색돼도 하나로 합쳐지고(학과는 소속에 누적),
  //   사번이 다른 "진짜 동명이인"만 별도 후보로 남아 위원 추가 시 선택할 수 있다.
  const bySabun = new Map();
  for (const h of hits) {
    const key = `sabun:${h.sabun}`;
    if (!bySabun.has(key)) bySabun.set(key, []);
    bySabun.get(key).push(h);
  }

  const merged = [];
  for (const [, group] of bySabun) {
    const first = group[0];
    merged.push({
      sabun: first.sabun,
      name: first.name,
      email: group.map(g => g.email).find(Boolean) || first.email,
      phone: group.map(g => g.phone).find(Boolean) || first.phone,
      position: first.position,
      major: group.map(g => g.major).find(Boolean) || first.major,
      affiliations: [...new Set(group.flatMap(g => splitAffiliation(g.affiliation)))],
      sabuns: [first.sabun],
    });
  }
  return { matches: merged };
}

module.exports = { lookupProfessor, searchHits, fetchDetail };
