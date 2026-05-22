const { PDFDocument } = require('pdf-lib');
const PDFKit = require('pdfkit');
const path = require('path');
const fs = require('fs');

const FONT_PATHS = [
  'C:\\Windows\\Fonts\\malgun.ttf',
  'C:\\Windows\\Fonts\\malgunbd.ttf',
  'C:\\Windows\\Fonts\\NanumGothic.ttf',
];

function findKoreanFont() {
  for (const p of FONT_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function generateSignaturePagePDF({ meeting, committee, externals, signatures, outputPath }) {
  return new Promise((resolve, reject) => {
    const fontPath = findKoreanFont();
    const doc = new PDFKit({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    if (fontPath) {
      doc.registerFont('ko', fontPath);
      doc.font('ko');
    }

    doc.fontSize(18).text(`${committee.name}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(14).text(`「${meeting.title}」 외부위원 전자서명`, { align: 'center' });
    doc.moveDown(1);

    const signedExternals = externals.map(ext => ({
      member: ext,
      sig: signatures.find(s => s.member_id === ext.id),
    })).filter(x => x.sig);

    if (signedExternals.length === 0) {
      doc.fontSize(11).fillColor('#999').text('(아직 서명한 외부위원이 없습니다)', { align: 'center' });
      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
      return;
    }

    let y = doc.y;
    const sigBoxH = 120;
    const sigBoxW = 240;
    let col = 0;

    for (const { member, sig } of signedExternals) {
      const x = 50 + col * (sigBoxW + 16);
      if (y + sigBoxH > 780) {
        doc.addPage();
        if (fontPath) doc.font('ko');
        y = 50;
        col = 0;
      }
      doc.rect(x, y, sigBoxW, sigBoxH).strokeColor('#cccccc').stroke();
      const aff = [member.affiliation, member.role].filter(Boolean).join(' / ');
      doc.fontSize(11).fillColor('black').text(`${member.name}`, x + 10, y + 10, { width: sigBoxW - 20 });
      if (aff) doc.fontSize(8).fillColor('#666').text(aff, x + 10, y + 26, { width: sigBoxW - 20 });
      doc.fontSize(8).fillColor('#7c3aed').text('[외부위원]', x + 10, y + 38);

      try {
        const base64 = String(sig.signature_data || '').replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(base64, 'base64');
        doc.image(imgBuf, x + 10, y + 52, { fit: [sigBoxW - 20, 50] });
      } catch (e) {
        doc.fontSize(9).fillColor('red').text('(서명 이미지 오류)', x + 10, y + 52);
      }

      const signedDateOnly = (() => {
        const d = new Date(typeof sig.signed_at === 'string' ? sig.signed_at.replace(' ', 'T') : sig.signed_at);
        if (isNaN(d.getTime())) return String(sig.signed_at || '').slice(0, 10);
        return `${d.getFullYear()}. ${d.getMonth()+1}. ${d.getDate()}.`;
      })();
      doc.fontSize(7).fillColor('#888').text(
        `서명일: ${signedDateOnly}`,
        x + 10, y + sigBoxH - 14, { width: sigBoxW - 20 }
      );
      doc.fillColor('black');

      col += 1;
      if (col >= 2) { col = 0; y += sigBoxH + 14; }
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

async function generateHwpNoticePagePDF({ meeting, committee, uploadedOriginalName, outputPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    const fontPath = findKoreanFont();
    if (fontPath) doc.registerFont('ko', fontPath).font('ko');
    doc.fontSize(18).text(`${committee.name}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).text(`「${meeting.title}」 — 외부위원 서명`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).fillColor('#444').text(
      `※ 본 회의의 회의록 본문은 별도 한글(.hwp/.hwpx) 파일로 제공됩니다.`,
      { align: 'center' }
    );
    doc.moveDown(0.4);
    if (uploadedOriginalName) {
      doc.fontSize(10).fillColor('#666').text(`회의록 파일명: ${uploadedOriginalName}`, { align: 'center' });
    }
    doc.moveDown(0.8);
    doc.fontSize(10).fillColor('#666').text(
      `회의록 본문과 본 PDF(서명 페이지)를 함께 보관해주세요.`,
      { align: 'center' }
    );
    doc.fillColor('black');
    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

async function generateFinalSignedPDF({ meeting, committee, externals, signatures, uploadedPath, uploadedOriginalName, outputPath }) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sigPagePath = outputPath + '.sigpage.tmp.pdf';
  await generateSignaturePagePDF({ meeting, committee, externals, signatures, outputPath: sigPagePath });

  const ext = uploadedPath ? path.extname(uploadedPath).toLowerCase() : '';
  const canMerge = ext === '.pdf' && fs.existsSync(uploadedPath);
  const isHwp = ext === '.hwp' || ext === '.hwpx';

  if (!canMerge && !isHwp) {
    fs.renameSync(sigPagePath, outputPath);
    return { outputPath, mergedWithUploaded: false, reason: 'no-pdf' };
  }

  if (isHwp) {
    const noticePath = outputPath + '.notice.tmp.pdf';
    try {
      await generateHwpNoticePagePDF({ meeting, committee, uploadedOriginalName, outputPath: noticePath });
      const noticeBytes = fs.readFileSync(noticePath);
      const sigBytes = fs.readFileSync(sigPagePath);
      const finalDoc = await PDFDocument.load(noticeBytes);
      const sigDoc = await PDFDocument.load(sigBytes);
      const copied = await finalDoc.copyPages(sigDoc, sigDoc.getPageIndices());
      for (const p of copied) finalDoc.addPage(p);
      const finalBytes = await finalDoc.save();
      fs.writeFileSync(outputPath, finalBytes);
      try { fs.unlinkSync(sigPagePath); } catch (e) {}
      try { fs.unlinkSync(noticePath); } catch (e) {}
      return { outputPath, mergedWithUploaded: false, reason: 'hwp-uploaded', notice: true };
    } catch (e) {
      fs.renameSync(sigPagePath, outputPath);
      try { fs.unlinkSync(noticePath); } catch (e2) {}
      return { outputPath, mergedWithUploaded: false, reason: 'hwp-uploaded', error: e.message };
    }
  }

  try {
    const uploadedBytes = fs.readFileSync(uploadedPath);
    const sigBytes = fs.readFileSync(sigPagePath);
    const finalDoc = await PDFDocument.load(uploadedBytes);
    const sigDoc = await PDFDocument.load(sigBytes);
    const copied = await finalDoc.copyPages(sigDoc, sigDoc.getPageIndices());
    for (const p of copied) finalDoc.addPage(p);
    const finalBytes = await finalDoc.save();
    fs.writeFileSync(outputPath, finalBytes);
    try { fs.unlinkSync(sigPagePath); } catch (e) {}
    return { outputPath, mergedWithUploaded: true };
  } catch (err) {
    fs.renameSync(sigPagePath, outputPath);
    return { outputPath, mergedWithUploaded: false, reason: 'merge-failed', error: err.message };
  }
}

module.exports = { generateFinalSignedPDF };
