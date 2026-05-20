const db = require('../database');
const rows = db.prepare(`
  SELECT t.token, m.name AS member_name, mt.title AS meeting_title
    FROM member_tokens t
    JOIN members m ON m.id = t.member_id
    JOIN meetings mt ON mt.id = t.meeting_id
   WHERE t.purpose = 'availability'
   ORDER BY t.id
`).all();
rows.forEach(r => console.log(`${r.token}\t${r.member_name}\t${r.meeting_title}`));
