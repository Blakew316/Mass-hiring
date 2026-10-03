// The company's real onboarding documents — the PDFs a new hire reads, fills
// in and signs through the paperwork portal (public/paperwork/). They are
// published beside the portal so a hire can open each one in full before
// signing, and read here to build the signed copies.
//
// In the deployed function esbuild inlines each file (binary loader, see
// scripts/build-function.mjs), because a bundled function has no public/
// folder to read from — each in a chunk of its own, loaded the first time
// that document is needed rather than with the app. Running locally the
// import fails and the file is read from disk instead.
const fs = require('fs');
const path = require('path');

const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'paperwork', 'documents');

const COMPANY_DOCUMENTS = [
  {
    key: 'agent-agreement',
    title: 'Agent Agreement 2026',
    file: 'Agent-Agreement-2026.pdf',
    // Requires completion in the portal (initials, signatures, profile data).
    completable: true,
    summary: 'Your contract with Wholesale Payments, including Schedule A (commission and residual schedule).',
  },
  {
    key: 'w4',
    title: 'Form W-4 (Federal Withholding)',
    file: 'W-4.pdf',
    completable: true,
    summary: 'Sets how much federal income tax is withheld from your pay.',
  },
  {
    key: 'email-policy',
    title: 'Corporate Email Usage Policy',
    file: 'Email-Policy.pdf',
    completable: true,
    summary: 'How your Wholesale Payments email account may be used.',
  },
  {
    key: 'health-sharing',
    title: 'Impact Health Sharing — Program Overview',
    file: 'Impact-Health-Sharing.pdf',
    completable: true,
    summary: 'An optional healthcare cost-sharing program you may enroll in directly.',
  },
];

// Literal imports, one per file, so the bundler can see and inline each.
async function bundled(key) {
  try {
    let m = null;
    if (key === 'agent-agreement') m = await import('../public/paperwork/documents/Agent-Agreement-2026.pdf');
    else if (key === 'w4') m = await import('../public/paperwork/documents/W-4.pdf');
    else if (key === 'email-policy') m = await import('../public/paperwork/documents/Email-Policy.pdf');
    else if (key === 'health-sharing') m = await import('../public/paperwork/documents/Impact-Health-Sharing.pdf');
    const b = m && m.default ? m.default : m;
    return b && b.length ? Buffer.from(b) : null;
  } catch {
    return null;
  }
}

const cache = new Map();

async function readDocument(key) {
  if (cache.has(key)) return cache.get(key);
  const doc = COMPANY_DOCUMENTS.find((d) => d.key === key);
  if (!doc) return null;
  let bytes = await bundled(key);
  if (!bytes) {
    try { bytes = fs.readFileSync(path.join(DOCUMENT_DIR, doc.file)); } catch { bytes = null; }
  }
  if (bytes) cache.set(key, bytes);
  return bytes;
}

// Where the portal links to each document for reading.
function publicPath(key) {
  const doc = COMPANY_DOCUMENTS.find((d) => d.key === key);
  return doc ? `/paperwork/documents/${doc.file}` : null;
}

// The company logo carried inline in the packet and completion emails.
let logo;
function logoBytes() {
  if (logo !== undefined) return logo;
  logo = null;
  try {
    const m = require('../assets/onboarding/logo.png');
    const b = m && m.default ? m.default : m;
    if (b && b.length) logo = Buffer.from(b);
  } catch {}
  if (!logo) { try { logo = fs.readFileSync(path.join(__dirname, '..', 'assets', 'onboarding', 'logo.png')); } catch {} }
  return logo;
}

module.exports = { COMPANY_DOCUMENTS, readDocument, publicPath, logoBytes };
