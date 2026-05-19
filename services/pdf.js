const PDFDocument = require('pdfkit');
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

function generateMinutesPDF({ meeting, committee, slot, members, signatures, outputPath }) {
  return new Promise((resolve, reject) => {
    const fontPath = findKoreanFont();
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    if (fontPath) {
      doc.registerFont('ko', fontPath);
      doc.font('ko');
    }

    doc.fontSize(20).text(committee.name, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(16).text(`「${meeting.title}」 회의록`, { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(11);
    const meta = [
      ['회의명', meeting.title],
      ['소속 위원회', committee.name],
      ['일시', slot ? `${slot.start_time} ~ ${slot.end_time}` : '미정'],
      ['장소', meeting.location || '-'],
      ['안건', meeting.description || '-'],
    ];
    for (const [k, v] of meta) {
      doc.text(`${k}: ${v}`);
    }
    doc.moveDown(0.8);

    doc.fontSize(13).text('1. 참석 위원', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11);
    const attendees = members.filter(m => signatures.find(s => s.member_id === m.id));
    if (attendees.length === 0) {
      doc.text('  (서명 수집 전)');
    } else {
      attendees.forEach((m, i) => {
        const aff = [m.affiliation, m.role].filter(Boolean).join(' / ');
        doc.text(`  ${i + 1}. ${m.name}${aff ? '  (' + aff + ')' : ''}${m.type === 'external' ? '  [외부위원]' : ''}`);
      });
    }
    doc.moveDown(0.8);

    doc.fontSize(13).text('2. 회의 내용', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11).text(meeting.minutes_text || '(회의록 작성 전)', {
      align: 'left',
      lineGap: 4,
    });
    doc.moveDown(1.5);

    doc.fontSize(13).text('3. 위원 서명', { underline: true });
    doc.moveDown(0.5);

    let y = doc.y;
    const colW = 250;
    const sigH = 70;
    let col = 0;
    for (const sig of signatures) {
      const member = members.find(m => m.id === sig.member_id);
      if (!member) continue;
      const x = 50 + col * colW;
      if (y + sigH > 780) {
        doc.addPage();
        if (fontPath) doc.font('ko');
        y = 50;
        col = 0;
      }
      doc.fontSize(10).text(`${member.name}${member.type === 'external' ? ' [외부위원]' : ''}`, x, y);
      try {
        const base64 = sig.signature_data.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(base64, 'base64');
        doc.image(imgBuf, x, y + 14, { fit: [200, 50] });
      } catch (e) {
        doc.text('(서명 이미지 오류)', x, y + 14);
      }
      doc.fontSize(8).fillColor('#666').text(`서명일시: ${sig.signed_at}`, x, y + sigH - 10);
      doc.fillColor('black');
      col += 1;
      if (col >= 2) { col = 0; y += sigH + 20; }
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generateMinutesPDF };
