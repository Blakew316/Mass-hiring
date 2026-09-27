// The markdown-ish templates in assets/onboarding/templates, rendered into
// branded PDF documents — WPI Hire's src/packet.js. Supported template syntax:
// # / ## headings, - bullets, [ ] checkboxes, > callouts, 1. numbered items,
// --- rules, **bold** inline, {{tokens}}, and [signature] which renders
// signature/date lines.
//
// WPI Hire drew these with pdfkit, which reads its fonts from files beside it
// at run time and so cannot work from inside this app's single-file function.
// The same layout is drawn here with pdf-lib — the library already used for
// the signed paperwork — whose standard fonts are built in.
const fs = require('fs');
const path = require('path');

// What the standard PDF fonts can draw: WinAnsi, which — unlike the plainer
// rule the signed paperwork uses — includes the dashes, curly quotes and
// bullets these letters are written with. Accents are decomposed; anything
// else is dropped rather than allowed to abort the document.
const WIN_ANSI_EXTRA = '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178';
function winAnsi(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) { out += ch; continue; }
    // A path through BambooHR's menus ("Files → Benefits") keeps its
    // separator rather than running the two words together.
    if (ch === '\u2192') { out += '->'; continue; }
    const plain = ch.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
    if (plain && [...plain].every((p) => p.codePointAt(0) >= 0x20 && p.codePointAt(0) <= 0x7e)) out += plain;
  }
  return out;
}

const TEMPLATE_DIR = path.join(__dirname, '..', 'assets', 'onboarding', 'templates');

const PACKET_DOCUMENTS = [
  { key: 'welcome-letter', title: 'Welcome Letter', default: true },
  { key: 'offer-letter', title: 'Offer Letter', default: true },
  { key: 'first-day-checklist', title: 'First-Day Checklist', default: true },
  { key: 'benefits-overview', title: 'Benefits Overview', default: true },
  { key: 'it-equipment', title: 'IT & Equipment Setup', default: true },
  { key: 'payroll-forms', title: 'Payroll & Required Forms', default: true },
  { key: 'handbook-acknowledgment', title: 'Handbook Acknowledgment', default: true },
];

// Loaded on first use, like the signed paperwork's (lib/paperwork.js).
let lib = null;
async function loadPdfLib() {
  if (!lib) {
    const m = await import('pdf-lib');
    const { PDFDocument, StandardFonts, rgb } = m.PDFDocument ? m : m.default;
    const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
    lib = { PDFDocument, StandardFonts, INK: hex('#1c2433'), ACCENT: hex('#0b1b5e'), MUTED: hex('#66738a'), RULE: hex('#dde3ec') };
  }
  return lib;
}
function pdfLib() {
  if (!lib) throw new Error('pdf-lib is not loaded yet.');
  return lib;
}
// pdfkit sets a line's baseline below its top by the font's ascender:
// 718/1000 of the size for Helvetica.
const ASC = 0.718;

function buildTokens(hire, company) {
  const fullName = `${hire.firstName || ''} ${hire.lastName || ''}`.trim();
  return {
    firstName: hire.firstName || 'there',
    lastName: hire.lastName || '',
    fullName: fullName || 'New Hire',
    email: hire.email || 'on file',
    phone: hire.phone || 'on file',
    jobTitle: hire.jobTitle || 'your new role',
    department: hire.department || 'your',
    startDate: hire.startDate || 'your start date',
    manager: hire.manager || 'your manager',
    salary: hire.salary || 'as discussed in your offer conversation',
    employmentType: hire.employmentType || 'Full-Time',
    workLocation: hire.workLocation || 'your work location',
    companyName: company.name,
    companyAddress: company.address,
    hrContactName: company.hrName,
    hrContactEmail: company.hrEmail,
    today: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
  };
}

function interpolate(text, tokens) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    tokens[key] !== undefined ? String(tokens[key]) : `{{${key}}}`
  );
}

// Each template ships inside the deployed bundle (text loader); locally the
// require fails and the file is read from disk.
function readTemplate(key) {
  if (!PACKET_DOCUMENTS.some((d) => d.key === key)) return null;
  const bundled = {
    'welcome-letter': () => require('../assets/onboarding/templates/welcome-letter.md'),
    'offer-letter': () => require('../assets/onboarding/templates/offer-letter.md'),
    'first-day-checklist': () => require('../assets/onboarding/templates/first-day-checklist.md'),
    'benefits-overview': () => require('../assets/onboarding/templates/benefits-overview.md'),
    'it-equipment': () => require('../assets/onboarding/templates/it-equipment.md'),
    'payroll-forms': () => require('../assets/onboarding/templates/payroll-forms.md'),
    'handbook-acknowledgment': () => require('../assets/onboarding/templates/handbook-acknowledgment.md'),
  };
  try {
    const m = bundled[key]();
    const t = m && m.default !== undefined ? m.default : m;
    if (typeof t === 'string' && t) return t;
  } catch {}
  try { return fs.readFileSync(path.join(TEMPLATE_DIR, `${key}.md`), 'utf8'); } catch { return null; }
}

// A small flowing-text layout: words (plain or **bold**) wrapped to a width,
// a new page when the bottom margin is reached — what pdfkit did for free.
class Flow {
  constructor(doc, fonts, company) {
    this.doc = doc;
    this.fonts = fonts;
    this.company = company;
    this.W = 612;
    this.H = 792;
    this.margin = { top: 64, bottom: 64, left: 72, right: 72 };
    this.width = this.W - this.margin.left - this.margin.right;
    this.size = 12;
    // pdfkit's line height is the font's bounding box: 1.156 of the size for
    // Helvetica, 1.19 for Helvetica-Bold — and moveDown goes by the last used.
    this.factor = 1.156;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.W, this.H]);
    this.y = this.H - this.margin.top;   // the top of the next line
  }

  ensure(h) {
    if (this.y - h < this.margin.bottom) this.newPage();
  }

  // Like pdfkit's moveDown: in lines of whatever size was used last.
  down(lines) {
    this.y -= lines * this.size * this.factor;
  }

  lineFactor(font) {
    return font === this.fonts.bold ? 1.19 : 1.156;
  }

  // Words with their weight, from a line that may contain **bold** spans.
  runs(text) {
    const out = [];
    for (const part of String(text).split(/(\*\*[^*]+\*\*)/g)) {
      if (!part) continue;
      const bold = part.startsWith('**') && part.endsWith('**');
      const body = winAnsi(bold ? part.slice(2, -2) : part);
      for (const w of body.split(/(\s+)/)) if (w) out.push({ w, bold });
    }
    return out;
  }

  // Writes wrapped text starting at x; returns the lines used.
  write(text, { x = this.margin.left, width = this.width, size = 11, color = pdfLib().INK, font = null, gap = 0 } = {}) {
    const words = this.runs(text);
    this.size = size;
    const lineH = size * this.lineFactor(font || this.fonts.regular) + gap;
    // As pdfkit's font was after writing: the last run's.
    const last = words[words.length - 1];
    this.factor = this.lineFactor(font || (last && last.bold ? this.fonts.bold : this.fonts.regular));
    const lines = [];
    let line = [];
    let w = 0;
    for (const t of words) {
      const f = font || (t.bold ? this.fonts.bold : this.fonts.regular);
      const tw = f.widthOfTextAtSize(t.w, size);
      if (/^\s+$/.test(t.w)) {
        if (line.length) { line.push({ ...t, f, tw }); w += tw; }
        continue;
      }
      if (w + tw > width && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].w)) line.pop();
        lines.push(line);
        line = [];
        w = 0;
      }
      line.push({ ...t, f, tw });
      w += tw;
    }
    if (line.length) lines.push(line);
    for (const l of lines) {
      this.ensure(lineH);
      let cx = x;
      const base = this.y - size * ASC;
      for (const t of l) {
        if (!/^\s+$/.test(t.w)) this.page.drawText(t.w, { x: cx, y: base, size, font: t.f, color });
        cx += t.tw;
      }
      this.y -= lineH;
    }
    return lines.length;
  }
}

async function renderTemplateToPdf(templateKey, tokens, company) {
  const raw = readTemplate(templateKey);
  if (raw === null) throw new Error(`Unknown document: ${templateKey}`);
  const content = interpolate(raw, tokens);

  const { PDFDocument, StandardFonts, INK, ACCENT, MUTED, RULE } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const flow = new Flow(doc, fonts, company);
  const { left } = flow.margin;
  const width = flow.width;

  // Brand header band
  flow.page.drawRectangle({ x: 0, y: flow.H - 6, width: flow.W, height: 6, color: ACCENT });
  const brand = winAnsi(company.name).toUpperCase();
  let bx = left;
  for (const ch of brand) {
    flow.page.drawText(ch, { x: bx, y: flow.H - 28 - 9 * ASC, size: 9, font: fonts.regular, color: MUTED });
    bx += fonts.regular.widthOfTextAtSize(ch, 9) + 1.5;
  }
  flow.y = flow.H - 64;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();

    if (line === '') { flow.down(0.5); continue; }
    if (line === '---') {
      flow.down(0.4);
      flow.ensure(8);
      flow.page.drawLine({ start: { x: left, y: flow.y }, end: { x: left + width, y: flow.y }, thickness: 0.5, color: RULE });
      flow.down(0.6);
      continue;
    }
    if (line === '[signature]') {
      flow.down(2.5);
      flow.ensure(40);
      const lineWidth = width * 0.55;
      const y = flow.y;
      flow.page.drawLine({ start: { x: left, y }, end: { x: left + lineWidth, y }, thickness: 0.8, color: INK });
      flow.page.drawLine({ start: { x: left + lineWidth + 24, y }, end: { x: left + width, y }, thickness: 0.8, color: INK });
      flow.page.drawText('Signature', { x: left, y: y - 5 - 9 * ASC, size: 9, font: fonts.regular, color: MUTED });
      flow.page.drawText('Date', { x: left + lineWidth + 24, y: y - 5 - 9 * ASC, size: 9, font: fonts.regular, color: MUTED });
      flow.size = 9;
      flow.y = y - 5 - 9 * 1.156;
      flow.down(2);
      continue;
    }
    if (line.startsWith('# ')) {
      flow.write(line.slice(2), { size: 22, font: fonts.bold, color: INK });
      flow.down(0.6);
      continue;
    }
    if (line.startsWith('## ')) {
      flow.down(0.4);
      flow.write(line.slice(3), { size: 13, font: fonts.bold, color: ACCENT });
      flow.down(0.3);
      continue;
    }
    if (line.startsWith('> ')) {
      flow.down(0.2);
      const top = flow.y;
      const page = flow.page;
      // Upright, as WPI Hire's pdfkit drew it: its inline writer set the
      // regular or bold face for every run, over the oblique chosen first.
      flow.write(line.slice(2), { width: width - 16, size: 10.5, color: MUTED });
      if (flow.page === page) page.drawRectangle({ x: left - 12, y: flow.y - 2, width: 3, height: top - flow.y + 4, color: ACCENT });
      flow.down(0.4);
      continue;
    }
    if (line.startsWith('[ ] ')) {
      flow.ensure(14);
      flow.page.drawRectangle({ x: left, y: flow.y - 1.5 - 9, width: 9, height: 9, borderWidth: 0.9, borderColor: ACCENT });
      flow.write(line.slice(4), { x: left + 18, width: width - 18, size: 11 });
      flow.down(0.35);
      continue;
    }
    if (line.startsWith('- ')) {
      flow.ensure(14);
      flow.page.drawText('\u2022', { x: left + 4, y: flow.y - 11 * ASC, size: 11, font: fonts.bold, color: ACCENT });
      flow.write(line.slice(2), { x: left + 18, width: width - 18, size: 11 });
      flow.down(0.25);
      continue;
    }
    const numbered = line.match(/^(\d+)\. (.*)$/);
    if (numbered) {
      flow.ensure(14);
      flow.page.drawText(`${numbered[1]}.`, { x: left + 2, y: flow.y - 11 * ASC, size: 11, font: fonts.bold, color: ACCENT });
      flow.write(numbered[2], { x: left + 20, width: width - 20, size: 11 });
      flow.down(0.25);
      continue;
    }

    flow.write(line, { width, size: 11, gap: 2 });
    flow.down(0.2);
  }

  // Footer (final page)
  const footer = winAnsi(`${company.name} — ${company.address}`);
  const fw = fonts.regular.widthOfTextAtSize(footer, 8.5);
  flow.page.drawText(footer, { x: left + (width - fw) / 2, y: 46 - 8.5 * ASC, size: 8.5, font: fonts.regular, color: MUTED });

  return Buffer.from(await doc.save());
}

// Builds every selected document; returns [{key, title, filename, buffer}]
async function buildPacket(hire, company, documentKeys) {
  const tokens = buildTokens(hire, company);
  const selected = PACKET_DOCUMENTS.filter((d) => documentKeys.includes(d.key));
  const lastName = (hire.lastName || 'NewHire').replace(/[^\w-]/g, '');
  const out = [];
  for (const docDef of selected) {
    const buffer = await renderTemplateToPdf(docDef.key, tokens, company);
    out.push({
      key: docDef.key,
      title: docDef.title,
      filename: `${lastName}-${docDef.key}.pdf`,
      buffer,
    });
  }
  return out;
}

module.exports = { PACKET_DOCUMENTS, buildTokens, renderTemplateToPdf, buildPacket };
