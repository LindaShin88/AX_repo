const db = require('../database');
const mailer = require('./mailer');

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
      content = `[${meeting.committee_name}]\n${member.name}님, "${meeting.title}" 가능일정 회신 부탁드립니다.\n로그인 불필요: ${link}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'availability_request', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 가능일정 회신 요청`;
      content = `${member.name}${member.role ? ' '+member.role : ''}님 안녕하세요.\n"${meeting.title}" 회의 일정 조율을 위해 가능 일정을 확인 부탁드립니다.\n\n별도 로그인 없이 아래 링크에서 1분 안에 응답 가능합니다.\n${link}\n\n감사합니다.`;
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
      content = `[리마인드] ${member.name}님 "${meeting.title}" 가능일정 회신 부탁드립니다.\n${link}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'reminder', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[리마인드] ${meeting.title} 가능일정 회신 부탁드립니다`;
      content = `${member.name}님, 아직 "${meeting.title}" 회의 가능 일정 응답이 확인되지 않습니다.\n빠른 회신 부탁드립니다: ${link}`;
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
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[일정확정] ${meeting.title}`;
      content = `[${meeting.committee_name}] "${meeting.title}" 일정 확정\n· ${slot.start_time} ~ ${slot.end_time}\n· 장소: ${meeting.location || '추후 공지'}\n참석 부탁드립니다.`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'meeting_confirmed', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 일정 확정 안내`;
      content = `${member.name}님, "${meeting.title}" 회의 일정이 다음과 같이 확정되었습니다.\n\n- 일시: ${slot.start_time} ~ ${slot.end_time}\n- 장소: ${meeting.location || '추후 공지'}\n${meeting.description ? '- 안건: ' + meeting.description : ''}\n\n참석 부탁드립니다.`;
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'meeting_confirmed', channel, subject, content, status }));
    }
  }
  return ids;
}

async function sendSignatureRequest(meeting, member, token, baseUrl) {
  const link = `${baseUrl}/sign/${token}`;
  const channels = pickChannels(meeting, member);
  const ids = [];
  for (const { channel } of channels) {
    let subject, content;
    if (channel === 'sms') {
      subject = `[서명요청] ${meeting.title}`;
      content = `[${meeting.committee_name}] ${member.name}님 "${meeting.title}" 회의록 전자서명 부탁드립니다.\n${link}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_request', channel, subject, content, status: 'SMS는 운영자가 직접 발송' }));
    } else {
      subject = `[${meeting.committee_name}] ${meeting.title} 회의록 서명 요청`;
      content = `${member.name}님, "${meeting.title}" 회의록 확인 및 서명 부탁드립니다.\n별도 로그인 없이 아래 링크에서 진행 가능합니다.\n\n${link}`;
      const result = await deliverEmail(member, subject, content);
      const status = result.ok ? `발송 OK (${result.messageId || ''})` : `실패: ${result.reason}${result.error ? ' / ' + result.error : ''}`;
      ids.push(logNotification({ meetingId: meeting.id, memberId: member.id, type: 'signature_request', channel, subject, content, status }));
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
  sendSignatureRequest,
  logArsCall,
};
