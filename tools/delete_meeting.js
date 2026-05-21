const db = require('../database');
const meetingId = parseInt(process.argv[2]);
if (!meetingId) { console.log('Usage: node tools/delete_meeting.js <meeting_id>'); process.exit(1); }
const mt = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
if (!mt) { console.log('회의 없음'); process.exit(0); }
console.log(`삭제 대상: #${mt.id} "${mt.title}" (상태: ${mt.status})`);
db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
console.log('✅ 삭제됨 (관련 slot/response/token도 CASCADE 삭제)');
