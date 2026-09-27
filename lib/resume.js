// Resume parsing, ported from WPI Hire (src/resume.js): extract text from an
// uploaded PDF/DOCX/TXT resume and pull out the candidate's name, email, and
// phone with lightweight heuristics.
//
// Parsing libraries are imported lazily inside the function so that a library
// failing to load in the serverless bundle can never take down the whole API —
// at worst, extraction returns empty fields and the user types the details.

async function extractResumeText(filename, buffer) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    // unpdf ships a self-contained serverless build of pdf.js (no worker file).
    const { extractText } = await import('unpdf');
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
    return text || '';
  }
  if (ext === 'docx') {
    const m = await import('mammoth');
    const mammoth = m.extractRawText ? m : m.default;
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  // Fall back to treating the file as plain text (txt, md, rtf-ish).
  return buffer.toString('utf8');
}

const NON_NAME_LINE =
  /resume|curriculum|vitae|profile|summary|objective|experience|education|skills?|contact|phone|email|address|linkedin|github|portfolio|references|www\.|https?:/i;

function extractCandidate(text) {
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
  const phone = (text.match(/(\+?\d{1,2}[\s.\-–]?)?\(?\d{3}\)?[\s.\-–]?\d{3}[\s.\-–]?\d{4}/) || [''])[0]
    .trim();

  // Name: the first early line that looks like "First Last" (2–4 capitalizable
  // words, no digits/@, not a section header).
  let name = '';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20);
  for (const line of lines) {
    if (NON_NAME_LINE.test(line)) continue;
    if (/[@\d]/.test(line)) continue;
    const words = line.split(' ');
    if (
      words.length >= 2 &&
      words.length <= 4 &&
      line.length <= 40 &&
      words.every((w) => /^[A-Za-z][A-Za-z'’.\-]*$/.test(w))
    ) {
      name = line;
      break;
    }
  }

  // Fallback: derive a name from the email's local part (jane.doe → Jane Doe).
  if (!name && email) {
    const local = email.split('@')[0].replace(/\d+/g, '');
    const parts = local.split(/[._\-]+/).filter(Boolean);
    if (parts.length >= 1) {
      name = parts
        .slice(0, 3)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    }
  }

  // Normalize SHOUTING-CAPS resume headers to title case.
  if (name && name === name.toUpperCase()) {
    name = name
      .split(' ')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }

  const nameWords = name.split(' ').filter(Boolean);
  return {
    firstName: nameWords[0] || '',
    lastName: nameWords.slice(1).join(' ') || '',
    email,
    phone,
  };
}

module.exports = { extractResumeText, extractCandidate };
