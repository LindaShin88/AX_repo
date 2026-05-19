const db = require('../database');

const MANUAL_HOURS_PER_MEETING = 50;
const SYSTEM_HOURS_PER_MEETING = 1.5;
const SAVED_HOURS_PER_MEETING = MANUAL_HOURS_PER_MEETING - SYSTEM_HOURS_PER_MEETING;
const EXTERNAL_VISIT_HOURS = 2;

function getOperatorStats(operatorId) {
  const meetingCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN mt.status = 'scheduling' THEN 1 ELSE 0 END) AS scheduling,
      SUM(CASE WHEN mt.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN mt.status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM meetings mt JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ?
  `).get(operatorId) || { total: 0, scheduling: 0, confirmed: 0, completed: 0 };

  const committeeCount = db.prepare(`SELECT COUNT(*) AS n FROM committees WHERE operator_id = ?`).get(operatorId).n;

  const memberCount = db.prepare(`
    SELECT COUNT(*) AS n FROM members m JOIN committees c ON c.id = m.committee_id WHERE c.operator_id = ?
  `).get(operatorId).n;

  const externalSignatures = db.prepare(`
    SELECT COUNT(*) AS n FROM signatures s
    JOIN members m ON m.id = s.member_id
    JOIN meetings mt ON mt.id = s.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ? AND m.type = 'external'
  `).get(operatorId).n;

  const notificationCount = db.prepare(`
    SELECT COUNT(*) AS n FROM notifications n
    JOIN meetings mt ON mt.id = n.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ?
  `).get(operatorId).n;

  const channelBreakdown = db.prepare(`
    SELECT n.channel, COUNT(*) AS cnt FROM notifications n
    JOIN meetings mt ON mt.id = n.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ? GROUP BY n.channel
  `).all(operatorId);

  const responsesCollected = db.prepare(`
    SELECT COUNT(*) AS n FROM slot_responses sr
    JOIN meeting_slots ms ON ms.id = sr.slot_id
    JOIN meetings mt ON mt.id = ms.meeting_id
    JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ? AND sr.auto_filled = 0
  `).get(operatorId).n;

  const recentMeetings = db.prepare(`
    SELECT date(mt.created_at) AS d, COUNT(*) AS n FROM meetings mt
    JOIN committees c ON c.id = mt.committee_id
    WHERE c.operator_id = ? AND mt.created_at >= date('now', '-30 days')
    GROUP BY date(mt.created_at) ORDER BY d
  `).all(operatorId);

  const committeeDistribution = db.prepare(`
    SELECT c.name, c.id,
           COUNT(mt.id) AS meeting_count,
           (SELECT COUNT(*) FROM members WHERE committee_id = c.id) AS member_count
    FROM committees c LEFT JOIN meetings mt ON mt.committee_id = c.id
    WHERE c.operator_id = ? GROUP BY c.id ORDER BY meeting_count DESC
  `).all(operatorId);

  const total = meetingCounts.total || 0;
  const completed = meetingCounts.completed || 0;
  const savedHours = total * SAVED_HOURS_PER_MEETING;
  const savedDays = savedHours / 8;

  return {
    committees: committeeCount,
    members: memberCount,
    meetings: meetingCounts,
    externalSignatures,
    notificationCount,
    channelBreakdown,
    responsesCollected,
    recentMeetings,
    committeeDistribution,
    savedHours,
    savedDays,
    manualHours: MANUAL_HOURS_PER_MEETING,
    systemHours: SYSTEM_HOURS_PER_MEETING,
    reductionPct: Math.round((SAVED_HOURS_PER_MEETING / MANUAL_HOURS_PER_MEETING) * 100),
    externalVisitHoursSaved: externalSignatures * EXTERNAL_VISIT_HOURS,
  };
}

function getOrgStats() {
  const totalMeetings = db.prepare(`SELECT COUNT(*) AS n FROM meetings`).get().n;
  const totalCommittees = db.prepare(`SELECT COUNT(*) AS n FROM committees`).get().n;
  const totalOperators = db.prepare(`SELECT COUNT(*) AS n FROM operators WHERE role = 'operator' AND status = 'active'`).get().n;
  const pendingOps = db.prepare(`SELECT COUNT(*) AS n FROM operators WHERE status = 'pending'`).get().n;
  const totalMembers = db.prepare(`SELECT COUNT(*) AS n FROM members`).get().n;
  const totalSignatures = db.prepare(`SELECT COUNT(*) AS n FROM signatures`).get().n;
  const totalNotifications = db.prepare(`SELECT COUNT(*) AS n FROM notifications`).get().n;

  const byOperator = db.prepare(`
    SELECT o.name, o.department, o.id,
           COUNT(DISTINCT c.id) AS committee_count,
           COUNT(DISTINCT mt.id) AS meeting_count
    FROM operators o
    LEFT JOIN committees c ON c.operator_id = o.id
    LEFT JOIN meetings mt ON mt.committee_id = c.id
    WHERE o.role = 'operator' AND o.status = 'active'
    GROUP BY o.id ORDER BY meeting_count DESC
  `).all();

  return {
    totalMeetings, totalCommittees, totalOperators, pendingOps,
    totalMembers, totalSignatures, totalNotifications,
    byOperator,
    savedHours: totalMeetings * SAVED_HOURS_PER_MEETING,
    savedDays: (totalMeetings * SAVED_HOURS_PER_MEETING) / 8,
    reductionPct: Math.round((SAVED_HOURS_PER_MEETING / MANUAL_HOURS_PER_MEETING) * 100),
  };
}

function getMeetingProgress(meetingId) {
  const m = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
  if (!m) return null;
  const memberCount = db.prepare(`SELECT COUNT(*) AS n FROM members WHERE committee_id = ?`).get(m.committee_id).n;
  const respondedCount = db.prepare(`
    SELECT COUNT(DISTINCT sr.member_id) AS n FROM slot_responses sr
    JOIN meeting_slots ms ON ms.id = sr.slot_id
    WHERE ms.meeting_id = ? AND sr.auto_filled = 0
  `).get(m.id).n;
  const signatureCount = db.prepare(`SELECT COUNT(*) AS n FROM signatures WHERE meeting_id = ?`).get(m.id).n;

  const stages = [
    { key: 'scheduling', label: '1. 일정 조율', done: m.confirmed_slot_id != null,
      detail: respondedCount > 0 ? `${respondedCount}/${memberCount}명 응답` : '응답 수집중' },
    { key: 'confirmed', label: '2. 일정 확정', done: m.confirmed_slot_id != null,
      detail: m.confirmed_at ? '확정 완료' : '미확정' },
    { key: 'signature', label: '3. 위원 서명', done: signatureCount >= memberCount && memberCount > 0,
      detail: `${signatureCount}/${memberCount}명 서명` },
    { key: 'pdf', label: '4. PDF 생성', done: !!m.pdf_path,
      detail: m.pdf_path ? '생성 완료' : '대기' },
  ];

  const doneCount = stages.filter(s => s.done).length;
  const progressPct = Math.round((doneCount / stages.length) * 100);

  const elapsedHours = m.created_at && m.completed_at
    ? Math.max(0.5, (new Date(m.completed_at + 'Z').getTime() - new Date(m.created_at + 'Z').getTime()) / 3600000)
    : null;

  return {
    stages, progressPct, doneCount,
    memberCount, respondedCount, signatureCount,
    savedHours: SAVED_HOURS_PER_MEETING,
    manualHours: MANUAL_HOURS_PER_MEETING,
    systemHours: SYSTEM_HOURS_PER_MEETING,
    elapsedHours,
  };
}

module.exports = {
  getOperatorStats,
  getOrgStats,
  getMeetingProgress,
  MANUAL_HOURS_PER_MEETING,
  SYSTEM_HOURS_PER_MEETING,
  SAVED_HOURS_PER_MEETING,
};
