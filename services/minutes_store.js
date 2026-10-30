// 업로드된 회의록 파일을 "디스크 + DB blob" 양쪽에 두고 관리한다.
//
// 배경: Render의 파일 저장소는 임시(ephemeral)라 재배포·재시작 때 깨끗이 지워진다.
//       그래서 디스크에만 있던 회의록 PDF가 사라져 서명 페이지 "미리보기"가 비어 보였다.
// 해결: 업로드 시 파일 바이트를 DB(meetings.uploaded_minutes_blob)에도 저장한다.
//       DB(Turso)는 영구 보존되므로, 디스크가 비어 있으면 blob에서 파일을 다시 만들어
//       (rehydrate) 기존 디스크 기반 코드(sendFile/download/PDF 병합)가 그대로 동작한다.

const path = require('path');
const fs = require('fs');
const db = require('../database');

const ROOT = path.join(__dirname, '..');
const MINUTES_DIR = path.join(ROOT, 'data', 'uploaded_minutes');

// 파일명에서 안전한 확장자만 뽑는다(.pdf/.hwp 등). 한글 파일명이어도 확장자는 ASCII.
function safeExt(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? ('.' + m[1].toLowerCase()) : '';
}

// 업로드 핸들러에서 호출: 디스크 파일을 읽어 DB blob에 함께 저장한다.
function storeBlobFromFile(meetingId, absFilePath) {
  try {
    const buf = fs.readFileSync(absFilePath);
    db.prepare('UPDATE meetings SET uploaded_minutes_blob = ? WHERE id = ?').run(buf, meetingId);
    return true;
  } catch (e) {
    console.error('[minutes_store] blob 저장 실패:', e.message);
    return false;
  }
}

// 회의의 업로드 회의록 파일이 "로컬 디스크에 실제로 존재하도록" 보장한다.
// 디스크가 비어 있으면 DB blob에서 복구(rehydrate)한다.
// 반환: { absPath, relPath, originalName, ext } 또는 null(파일 자체가 없음)
function ensureMinutesFile(meetingId) {
  const meta = db.prepare(
    'SELECT uploaded_minutes_path AS relPath, uploaded_minutes_original_name AS originalName FROM meetings WHERE id = ?'
  ).get(meetingId);
  if (!meta) return null;

  let relPath = meta.relPath;
  let absPath = relPath ? path.join(ROOT, relPath) : null;

  // 1) 디스크에 이미 있으면 그대로 사용 (blob을 메모리에 올리지 않음)
  if (absPath && fs.existsSync(absPath)) {
    return { absPath, relPath, originalName: meta.originalName, ext: path.extname(absPath).toLowerCase() };
  }

  // 2) 디스크에 없으면 DB blob에서 복구
  const blobRow = db.prepare('SELECT uploaded_minutes_blob AS blob FROM meetings WHERE id = ?').get(meetingId);
  if (!blobRow || !blobRow.blob) return null; // 복구할 원본이 없음(구버전 업로드분 등)

  const buf = Buffer.isBuffer(blobRow.blob) ? blobRow.blob : Buffer.from(blobRow.blob);

  if (!fs.existsSync(MINUTES_DIR)) fs.mkdirSync(MINUTES_DIR, { recursive: true });
  if (!relPath) {
    // 경로 정보가 없으면 새로 만든다.
    relPath = 'data/uploaded_minutes/m' + meetingId + (safeExt(meta.originalName) || '.bin');
    absPath = path.join(ROOT, relPath);
    db.prepare('UPDATE meetings SET uploaded_minutes_path = ? WHERE id = ?').run(relPath, meetingId);
  }

  try {
    fs.writeFileSync(absPath, buf);
  } catch (e) {
    console.error('[minutes_store] blob→디스크 복구 실패:', e.message);
    return null;
  }
  return { absPath, relPath, originalName: meta.originalName, ext: path.extname(absPath).toLowerCase() };
}

// 삭제 시 blob도 비운다.
function clearBlob(meetingId) {
  try { db.prepare('UPDATE meetings SET uploaded_minutes_blob = NULL WHERE id = ?').run(meetingId); } catch (e) {}
}

module.exports = { storeBlobFromFile, ensureMinutesFile, clearBlob };
