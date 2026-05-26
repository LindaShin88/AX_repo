// Simple Markdown → HTML converter for final-presentation.md
// Supports: # headers, lists, - [ ] checkboxes, tables, blockquotes,
//           **bold**, `code`, hr, paragraphs. Tuned for our doc.
//
// Usage: node tools/md_to_html.js <input.md> <output.html>

const fs = require('fs');
const path = require('path');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node tools/md_to_html.js <input.md> <output.html>');
  process.exit(1);
}

const src = fs.readFileSync(inPath, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Inline formatting: **bold**, `code`, **bold** inside, [text](url)
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

let html = [];
let i = 0;

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableSep(line) {
  return /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/.test(line);
}

while (i < lines.length) {
  const line = lines[i];

  // Blank line
  if (/^\s*$/.test(line)) { i++; continue; }

  // Horizontal rule
  if (/^---+\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

  // Headings
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const lvl = h[1].length;
    html.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
    i++; continue;
  }

  // Blockquote (possibly multi-line)
  if (/^>\s?/.test(line)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      buf.push(lines[i].replace(/^>\s?/, ''));
      i++;
    }
    html.push('<blockquote>' + buf.map(b => inline(b)).join('<br>') + '</blockquote>');
    continue;
  }

  // Table
  if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
    const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    i += 2; // skip header + separator
    const rows = [];
    while (i < lines.length && isTableRow(lines[i])) {
      const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      rows.push(cells);
      i++;
    }
    let t = '<table><thead><tr>';
    headerCells.forEach(c => t += `<th>${inline(c)}</th>`);
    t += '</tr></thead><tbody>';
    rows.forEach(r => {
      t += '<tr>';
      r.forEach(c => t += `<td>${inline(c)}</td>`);
      t += '</tr>';
    });
    t += '</tbody></table>';
    html.push(t);
    continue;
  }

  // List (- item, with possible checkbox)
  if (/^\s*-\s+/.test(line)) {
    let t = '<ul>';
    while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
      let item = lines[i].replace(/^\s*-\s+/, '');
      let checkbox = '';
      const cb = item.match(/^\[( |x|X)\]\s+(.*)$/);
      if (cb) {
        const checked = cb[1].toLowerCase() === 'x';
        checkbox = `<span class="cb">${checked ? '☑' : '☐'}</span> `;
        item = cb[2];
      }
      t += `<li>${checkbox}${inline(item)}</li>`;
      i++;
    }
    t += '</ul>';
    html.push(t);
    continue;
  }

  // Paragraph (collect consecutive non-blank non-special lines)
  const para = [];
  while (i < lines.length && !/^\s*$/.test(lines[i])
         && !/^---+\s*$/.test(lines[i])
         && !/^#{1,6}\s/.test(lines[i])
         && !/^>\s?/.test(lines[i])
         && !/^\s*-\s+/.test(lines[i])
         && !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
    para.push(lines[i]);
    i++;
  }
  if (para.length) {
    html.push('<p>' + para.map(p => inline(p)).join('<br>') + '</p>');
  }
}

const title = path.basename(inPath, '.md');

const out = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: "맑은 고딕", "Malgun Gothic", "Pretendard", sans-serif;
         font-size: 11pt; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22pt; border-bottom: 3px solid #003478; padding-bottom: 8px; margin-top: 24px; color: #003478; }
  h2 { font-size: 16pt; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 28px; color: #003478; }
  h3 { font-size: 13pt; margin-top: 20px; color: #1a1a1a; }
  h4 { font-size: 11.5pt; margin-top: 16px; color: #444; }
  p { margin: 8px 0; }
  ul { padding-left: 24px; margin: 8px 0; }
  li { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 10.5pt; }
  th, td { border: 1px solid #aaa; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f0f3f8; color: #003478; font-weight: 600; }
  blockquote { border-left: 4px solid #6366F1; background: #f5f6fb; padding: 8px 14px;
               margin: 10px 0; color: #2a2a2a; }
  code { background: #f4f4f8; padding: 1px 5px; border-radius: 3px; font-size: 10pt;
         font-family: Consolas, "Courier New", monospace; }
  strong { color: #003478; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 24px 0; }
  .cb { color: #6366F1; font-weight: bold; }
  a { color: #6366F1; text-decoration: none; }
</style>
</head>
<body>
${html.join('\n')}
</body>
</html>
`;

fs.writeFileSync(outPath, out, 'utf8');
console.log('Wrote', outPath);
