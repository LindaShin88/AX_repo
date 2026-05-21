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
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor('#666').text(`발급일: ${new Date().toLocaleString('ko-KR')}`, { align: 'right' });
    doc.fillColor('black');
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

      doc.fontSize(7).fillColor('#888').text(
        `서명일시: ${sig.signed_at}    IP: ${sig.ip_address || '-'}`,
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

async function generateFinalSignedPDF({ meeting, committee, externals, signatures, uploadedPath, outputPath }) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sigPagePath = outputPath + '.sigpage.tmp.pdf';
  await generateSignaturePagePDF({ meeting, committee, externals, signatures, outputPath: sigPagePath });

  const ext = uploadedPath ? path.extname(uploadedPath).toLowerCase() : '';
  const canMerge = ext === '.pdf' && fs.existsSync(uploadedPath);

  if (!canMerge) {
    fs.renameSync(sigPagePath, outputPath);
    return { outputPath, mergedWithUploaded: false, reason: ext === '.hwp' || ext === '.hwpx' ? 'hwp-uploaded' : 'no-pdf' };
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
