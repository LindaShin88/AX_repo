const db = require('../database');
const mailer = require('./mailer');

const DAY_KO = ['일','월','화','수','목','금','토'];

function formatKoreanDateTime(dt) {
  if (!dt) return '';
  const d = dt instanceof Date ? dt : new Date(typeof dt === 'string' ? dt.replace(' ', 'T') : dt);
  if (isNaN(d.getTime())) return String(dt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}. ${d.getMonth()+1}. ${d.getDate()}.(${DAY_KO[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildConfirmedAnnouncement(meeting, slot) {
  const when = formatKoreanDateTime(slot.start_time);
  const lines = [
    `[${meeting.committee_name}] ${meeting.title}`,
    `회의 일정이 확정되었습니다.`,
    ``,
    `- 일시: ${when}`,
    `- 장소: ${meeting.location || '추후 공지'}`,
  ];
  if (meeting.description && meeting.description.trim()) {
    lines.push(`- 안건`);
    for (const al of meeting.description.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      lines.push(al);
    }
  }
  lines.push(``, `참석 부탁드립니다.`, `감사합니다.`);
  return lines.join('\n');
}

function logNotification({ meetingId, memberId = null, type, channel = 'email', subject, content, recipient = null, status = null }) {
  const decorated = status ? `${content}\n\n[발송상태: ${status}]` : content;
  const stmt = db.prepare(`
    INSERT INTO notifications (meeting_id, member_id, type, channel, subject, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(meetingId, memberId, type, channel, subject, decorated).lastInsertRowid;
}

async function deliverEmail(member, subject, content) {
  if (!member.email) return { ok: false, reason: 'no-email' };
  if (!mailer.isSmtpConfigured()) return { ok: false, reason: 'smtp-not-configured' };
  return await mailer.sendMail({
    to: member.email,
    subject,
    text: content,
  });
}

function pickChannels(meeting, member) {
  const channels = (meeting.notify_channels || 'email,sms').split(',').map(s => s.trim()).filter(Boolean);
  const result = [];
  for (const ch of channels) {
    if (ch === 'email' && member.email) result.push({ channel: 'email', recipient: member.email });
    if (ch === 'sms' && member.phone) result.push({ channel: 'sms', recipient: member.phone });
  }
  if (result.length === 0) {
    if (member.email) result.push({ channel: 'email', recipient: member.email });
    else if (member.phone) result.push({ channel: 'sms', recipient: member.phone });
  }
  return result;
}

async function sendAvailabilityRequest(meeting, member, token, baseUrl) {
  const link = `${baseUrl}/avail/${token}`;
  const channels = pickChannels(meeting, member);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[${meeting.committee_name}] 가능일정 회신 요청`;
      content = `[${meeting.committee_name}]\n${member.name} 위원님, "${meeting.title}" 가능일정 회신 부탁드립니다.\n로그인 불필요: ${link}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'availability_request', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 가능일정 회신 요청`;
      content = `${member.name} 위원님, 안녕하세요.\n"${meeting.title}" 회의 일정 조율을 위해 가능 일정을 확인 부탁드립니다.\n\n별도 로그인 없이 아래 링크에서 1분 안에 응답 가능합니다.\n${link}\n\n감사합니다.`;
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'availability_request', channel, subject, content, status }));
    }
  }
  if (channels.some(c => c.channel === 'sms')) {
    db.prepare(`UPDATE member_tokens SET last_sms_at = CURRENT_TIMESTAMP WHERE meeting_id = ? AND member_id = ? AND purpose = 'availability'`)
      .run(meeting.id, member.id);
  }
  return ids;
}

async function sendReminder(meeting, member, token, baseUrl) {
  const link = `${baseUrl}/avail/${token}`;
  const channels = pickChannels(meeting, member);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[리마인드] ${meeting.title}`;
      content = `[리마인드] ${member.name} 위원님, "${meeting.title}" 가능일정 회신 부탁드립니다.\n${link}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'reminder', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[리마인드] ${meeting.title} 가능일정 회신 부탁드립니다`;
      content = `${member.name} 위원님, 아직 "${meeting.title}" 회의 가능 일정 응답이 확인되지 않습니다.\n빠른 회신 부탁드립니다.\n${link}`;
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'reminder', channel, subject, content, status }));
    }
  }
  if (channels.some(c => c.channel === 'sms')) {
    db.prepare(`UPDATE member_tokens SET last_sms_at = CURRENT_TIMESTAMP WHERE meeting_id = ? AND member_id = ? AND purpose = 'availability'`)
      .run(meeting.id, member.id);
  }
  return ids;
}

async function sendMeetingConfirmed(meeting, member, slot) {
  const channels = pickChannels(meeting, member);
  const announcement = buildConfirmedAnnouncement(meeting, slot);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[일정확정] ${meeting.title}`;
      content = announcement;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'meeting_confirmed', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 일정 확정 안내`;
      content = `${member.name} 위원님, 안녕하세요.\n\n${announcement}`;
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'meeting_confirmed', channel, subject, content, status }));
    }
  }
  return ids;
}

async function sendCreatorConfirmation(meeting, operator, slot, baseUrl) {
  const announcement = buildConfirmedAnnouncement(meeting, slot);
  const subject = `[자동확정] ${meeting.title} — 회의 일정 확정 안내`;
  const content = `${operator.name} 운영자님, 안녕하세요.\n\n"${meeting.title}" 회의 일정이 모든 위원의 응답에 따라 자동으로 확정되었습니다.\n전체 위원에게 확정 메일이 발송되었습니다.\n\n${announcement}\n\n──────── 📱 SMS / 카톡 전달용 ────────\n${announcement}\n──────────────────────────────\n\n관리자 페이지: ${baseUrl}/admin/meetings/${meeting.id}\n감사합니다.`;
  const result = await deliverEmail({ email: operator.email, name: operator.name }, subject, content);
  const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
  return logNotification({ meetingId: meeting.id, memberId: null, type: 'creator_confirmed', channel: 'email', subject, content, status });
}

async function sendCreatorTieChoice(meeting, operator, topSlots, baseUrl) {
  const subject = `[일정 동률] ${meeting.title} — 최종 일정 선택 필요`;
  const lines = [
    `${operator.name} 운영자님, 안녕하세요.`,
    ``,
    `"${meeting.title}" 회의의 모든 위원 응답이 완료되었습니다.`,
    `다만 다음 ${topSlots.length}개 일정이 동일한 가능 응답 수(${topSlots[0].available}명)로 동률입니다:`,
    ``,
    ...topSlots.map(s => `- ${formatKoreanDateTime(s.slot.start_time)} (가능 ${s.available}명)`),
    ``,
    `아래 관리자 페이지에서 최종 일정을 선택해주세요:`,
    `${baseUrl}/admin/meetings/${meeting.id}`,
    ``,
    `감사합니다.`,
  ];
  const content = lines.join('\n');
  const result = await deliverEmail({ email: operator.email, name: operator.name }, subject, content);
  const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
  return logNotification({ meetingId: meeting.id, memberId: null, type: 'creator_tie', channel: 'email', subject, content, status });
}

async function maybeAutoConfirmMeeting(meetingId, baseUrl) {
  const meeting = db.prepare(`
    SELECT mt.*, c.name AS committee_name, c.operator_id, c.quorum
      FROM meetings mt JOIN committees c ON c.id = mt.committee_id
     WHERE mt.id = ?
  `).get(meetingId);
  if (!meeting || meeting.status !== 'scheduling') return { ok: false, reason: 'not-scheduling' };

  const members = db.prepare('SELECT * FROM members WHERE committee_id = ?').all(meeting.committee_id);
  if (members.length === 0) return { ok: false, reason: 'no-members' };

  const responded = db.prepare(`
    SELECT DISTINCT sr.member_id FROM slot_responses sr
      JOIN meeting_slots ms ON ms.id = sr.slot_id
     WHERE ms.meeting_id = ? AND sr.auto_filled = 0
  `).all(meetingId);
  const respondedSet = new Set(responded.map(r => r.member_id));
  const allResponded = members.every(m => respondedSet.has(m.id));
  if (!allResponded) return { ok: false, reason: 'not-all-responded' };

  const slots = db.prepare('SELECT * FROM meeting_slots WHERE meeting_id = ? ORDER BY start_time').all(meetingId);
  const counts = slots.map(slot => {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM slot_responses WHERE slot_id = ? AND response = 'available'`).get(slot.id).n;
    return { slot, available: n };
  });
  if (counts.length === 0) return { ok: false, reason: 'no-slots' };
  const maxAvail = Math.max(...counts.map(c => c.available));
  if (maxAvail === 0) return { ok: false, reason: 'no-available' };
  const topSlots = counts.filter(c => c.available === maxAvail);

  const operator = db.prepare('SELECT * FROM operators WHERE id = ?').get(meeting.operator_id);

  if (topSlots.length === 1) {
    const win = topSlots[0].slot;
    db.prepare(`UPDATE meetings SET status = 'confirmed', confirmed_slot_id = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(win.id, meetingId);
    for (const m of members) {
      await sendMeetingConfirmed(meeting, m, win);
    }
    if (operator && operator.email) {
      await sendCreatorConfirmation(meeting, operator, win, baseUrl);
    }
    return { ok: true, kind: 'auto-confirmed', slot: win };
  } else {
    if (operator && operator.email) {
      await sendCreatorTieChoice(meeting, operator, topSlots, baseUrl);
    }
    return { ok: true, kind: 'tie', topSlots };
  }
}

async function sendSignatureRequest(meeting, member, token, baseUrl, opts = {}) {
  const link = `${baseUrl}/sign/${token}`;
  const minutesLink = opts.hasUploadedMinutes ? `${baseUrl}/minutes/${token}` : null;
  const channels = pickChannels(meeting, member);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[서명요청] ${meeting.title}`;
      content = `[${meeting.committee_name}] ${member.name} 위원님, "${meeting.title}" 회의록 전자서명 부탁드립니다.\n${link}`;
      if (minutesLink) content += `\n회의록: ${minutesLink}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_request', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 회의록 서명 요청`;
      const parts = [
        `${member.name} 위원님, "${meeting.title}" 회의록 확인 및 서명 부탁드립니다.`,
        `별도 로그인 없이 아래 링크에서 진행 가능합니다.`,
        ``,
        `▶ 서명 페이지: ${link}`,
      ];
      if (minutesLink) {
        parts.push(`▶ 회의록 파일 다운로드: ${minutesLink}`);
      }
      content = parts.join('\n');
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_request', channel, subject, content, status }));
    }
  }
  return ids;
}

async function sendSignatureReminder(meeting, member, token, baseUrl, opts = {}) {
  const link = `${baseUrl}/sign/${token}`;
  const minutesLink = opts.hasUploadedMinutes ? `${baseUrl}/minutes/${token}` : null;
  const channels = pickChannels(meeting, member);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[서명 리마인드] ${meeting.title}`;
      content = `[리마인드][${meeting.committee_name}] ${member.name} 위원님, "${meeting.title}" 회의록 전자서명을 아직 받지 못했습니다. 빠른 진행 부탁드립니다.\n${link}`;
      if (minutesLink) content += `\n회의록: ${minutesLink}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_reminder', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[리마인드] ${meeting.title} 회의록 서명을 아직 받지 못했습니다`;
      const parts = [
        `${member.name} 위원님, 안녕하세요.`,
        ``,
        `"${meeting.title}" 회의록 전자서명이 아직 등록되지 않아 다시 한 번 안내드립니다.`,
        `별도 로그인 없이 아래 링크에서 진행 가능합니다.`,
        ``,
        `▶ 서명 페이지: ${link}`,
      ];
      if (minutesLink) parts.push(`▶ 회의록 파일 다운로드: ${minutesLink}`);
      parts.push('', '바쁘신 와중에 죄송하지만 확인 부탁드립니다.', '감사합니다.');
      content = parts.join('\n');
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_reminder', channel, subject, content, status }));
    }
  }
  return ids;
}

function logArsCall(meeting, member, token, baseUrl) {
  const link = `${baseUrl}/avail/${token}`;
  const phone = member.phone || '(번호 없음)';
  const subject = `[ARS 자동전화] ${meeting.title} → ${member.name}`;
  const content = `▶ ARS 자동 전화 발신
대상: ${member.name} (${phone})
회의: ${meeting.title}

[ARS 음성 안내문]
"안녕하세요. ${meeting.committee_name} ${meeting.title} 회의 일정 조율 안내입니다.
${member.name}님께서 SMS로 발송된 가능일정 응답이 확인되지 않아 ARS 안내 드립니다.
삐 소리 후 가능 일정 번호를 입력해주시거나, 추후 다음 링크로 응답 부탁드립니다: ${link}
응답을 원하시면 1번, 다시 듣기는 2번, 종료는 #번을 눌러주세요."`;
  const id = logNotification({ meetingId: meeting.id, memberId: member.id, type: 'ars_call', channel: 'ars', subject, content });
  db.prepare(`UPDATE member_tokens SET ars_called_at = CURRENT_TIMESTAMP WHERE meeting_id = ? AND member_id = ? AND purpose = 'availability'`)
    .run(meeting.id, member.id);
  return id;
}

module.exports = {
  logNotification,
  pickChannels,
  sendAvailabilityRequest,
  sendReminder,
  sendMeetingConfirmed,
  sendCreatorConfirmation,
  sendCreatorTieChoice,
  maybeAutoConfirmMeeting,
  sendSignatureRequest,
  sendSignatureReminder,
  logArsCall,
  formatKoreanDateTime,
  buildConfirmedAnnouncement,
};
