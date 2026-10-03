/* New-hire paperwork portal — step flow, signature capture, submission. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  token: new URLSearchParams(location.search).get('t') || '',
  hire: null,
  company: null,
  step: 1,
  maxStep: 6,
  pads: {},
  opened: new Set(),
};

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 4600);
}

const esc = (s) => {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
};

// ── Signature pad ────────────────────────────────────────────────────────────
// Draw with finger/mouse, or switch to typing. Exposes value() → PNG data URL
// (drawn) or plain string (typed).

class SignaturePad {
  constructor(host, { kind = 'signature', label = 'Signature', perjury = '' } = {}) {
    this.host = host;
    this.kind = kind;
    this.mode = 'draw';
    this.strokes = [];
    this.typed = '';

    host.innerHTML = `
      ${perjury ? `<div class="pw-sig-perjury">${esc(perjury)}</div>` : ''}
      <div class="pw-sig-label">
        <span>${esc(label)}</span>
        <button type="button" class="pw-sig-toggle">Type instead</button>
      </div>
      <div class="pw-sig-canvas-wrap">
        <canvas class="pw-sig-canvas"></canvas>
        <div class="pw-sig-baseline"></div>
        <div class="pw-sig-placeholder">${kind === 'initials' ? 'Initial here' : 'Sign here with your finger or mouse'}</div>
      </div>
      <input class="pw-sig-typed field" type="text" placeholder="Type your ${kind === 'initials' ? 'initials' : 'full name'}" hidden />
      <div class="pw-sig-foot">
        <button type="button" class="pw-sig-clear">Clear</button>
      </div>`;

    this.wrap = $('.pw-sig-canvas-wrap', host);
    this.canvas = $('.pw-sig-canvas', host);
    this.typedInput = $('.pw-sig-typed', host);
    this.toggle = $('.pw-sig-toggle', host);

    this.toggle.addEventListener('click', () => this.setMode(this.mode === 'draw' ? 'type' : 'draw'));
    $('.pw-sig-clear', host).addEventListener('click', () => this.clear());
    this.typedInput.addEventListener('input', () => {
      this.typed = this.typedInput.value;
      this.wrap.classList.toggle('signed', Boolean(this.typed.trim()));
      host.dispatchEvent(new CustomEvent('sig-change', { bubbles: true }));
    });

    this.setupCanvas();
  }

  setupCanvas() {
    const c = this.canvas;
    const resize = () => {
      const rect = c.getBoundingClientRect();
      // A hidden step reports 0×0 — keep the last known size so a signature
      // captured earlier can still be exported later.
      if (!rect.width) return;
      const dpr = window.devicePixelRatio || 1;
      // Rotating the phone changes the pad's width; rescale existing strokes
      // so a signature drawn in portrait isn't clipped in landscape.
      if (this.cssWidth && rect.width && this.strokes.length) {
        const sx = rect.width / this.cssWidth;
        const sy = rect.height / (this.cssHeight || rect.height);
        if (sx !== 1 || sy !== 1) {
          this.strokes = this.strokes.map((st) => st.map((p) => ({ x: p.x * sx, y: p.y * sy })));
        }
      }
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
      this.dpr = dpr;
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
      const ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineWidth = this.kind === 'initials' ? 2.4 : 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0b1b5e';
      this.ctx = ctx;
      this.redraw();
    };
    this._resize = resize;
    requestAnimationFrame(resize);
    window.addEventListener('resize', () => requestAnimationFrame(resize));

    let drawing = false;
    let current = null;
    let activePointer = null;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      // A second finger (or a resting palm) must not hijack the stroke.
      if (drawing) return;
      e.preventDefault();
      drawing = true;
      activePointer = e.pointerId;
      c.setPointerCapture(e.pointerId);
      current = [pos(e)];
      this.strokes.push(current);
      this.wrap.classList.add('signed');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drawing || e.pointerId !== activePointer) return;
      e.preventDefault();
      const p = pos(e);
      current.push(p);
      const ctx = this.ctx;
      const n = current.length;
      if (n >= 2) {
        ctx.beginPath();
        ctx.moveTo(current[n - 2].x, current[n - 2].y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    });
    const end = (e) => {
      if (!drawing || (e && e.pointerId !== activePointer)) return;
      drawing = false;
      activePointer = null;
      current = null;
      this.host.dispatchEvent(new CustomEvent('sig-change', { bubbles: true }));
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', end);
  }

  redraw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.cssWidth || this.canvas.width, this.cssHeight || this.canvas.height);
    for (const stroke of this.strokes) {
      this.ctx.beginPath();
      stroke.forEach((p, i) => (i ? this.ctx.lineTo(p.x, p.y) : this.ctx.moveTo(p.x, p.y)));
      this.ctx.stroke();
    }
  }

  setMode(mode) {
    this.mode = mode;
    const drawing = mode === 'draw';
    this.wrap.hidden = !drawing;
    this.typedInput.hidden = drawing;
    this.toggle.textContent = drawing ? 'Type instead' : 'Draw instead';
    this.wrap.classList.toggle('signed', drawing ? this.strokes.length > 0 : Boolean(this.typed.trim()));
    if (drawing) requestAnimationFrame(this._resize);
    else this.typedInput.focus();
  }

  clear() {
    this.strokes = [];
    this.typed = '';
    this.typedInput.value = '';
    this.redraw();
    this.wrap.classList.remove('signed');
    this.host.dispatchEvent(new CustomEvent('sig-change', { bubbles: true }));
  }

  // Total drawn distance — a single tap or dot is not a signature.
  inkLength() {
    let total = 0;
    for (const st of this.strokes) {
      for (let i = 1; i < st.length; i++) {
        total += Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y);
      }
    }
    return total;
  }

  isEmpty() {
    if (this.mode === 'type') return !this.typed.trim();
    return this.strokes.length === 0 || this.inkLength() < 24;
  }

  // Trimmed PNG (drawn) or the typed string. Rendered from the stored stroke
  // data at the last known canvas size, so it still works when the step is
  // hidden (reading the live element would give a 0x0 box and a blank image).
  value() {
    if (this.mode === 'type') return this.typed.trim();
    if (!this.strokes.length) return '';
    const width = this.cssWidth || 300;
    const height = this.cssHeight || 120;
    const dpr = this.dpr || window.devicePixelRatio || 1;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const st of this.strokes) {
      for (const p of st) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    if (!isFinite(minX)) return '';
    const pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width, maxX + pad); maxY = Math.min(height, maxY + pad);
    const w = Math.max(8, Math.round(maxX - minX));
    const h = Math.max(8, Math.round(maxY - minY));

    const out = document.createElement('canvas');
    out.width = Math.round(w * dpr);
    out.height = Math.round(h * dpr);
    const ctx = out.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.translate(-minX, -minY);
    ctx.lineWidth = this.kind === 'initials' ? 2.4 : 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b1b5e';
    for (const st of this.strokes) {
      ctx.beginPath();
      st.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    return out.toDataURL('image/png');
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  if (!state.token) return showGateError('This link is missing its access code.', 'Please use the link from your welcome email, or ask your hiring contact to resend it.');
  try {
    const res = await fetch('/api/paperwork/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token }),
    });
    const data = await res.json().catch(() => ({}));
    // Refused: the link itself is wrong or has expired. Anything else is the
    // server having trouble, and the link is fine — saying it isn't would
    // only have the hire ask for a new one.
    if (res.status === 400 || res.status === 401) {
      return showGateError('This link isn\'t valid.', data.error || 'Ask your hiring contact to send a fresh link.');
    }
    if (!res.ok || !data.ok) {
      return showGateError('We couldn\'t load your paperwork.', 'Something went wrong on our side. Please refresh the page in a moment.');
    }
    state.hire = data.hire;
    state.company = data.company;
    state.documents = data.documents || [];
    // Signed through this link already: like an envelope, once is final.
    if (data.completed) return showCompleted(data.completed);
    render();
  } catch (err) {
    showGateError('We couldn\'t load your paperwork.', 'Please check your connection and refresh the page.');
  }
}

function showCompleted(done) {
  $('#gate').hidden = true;
  $('#pw-form').hidden = true;
  $('#done').hidden = false;
  $('#footer-company').textContent = state.company.name;
  const when = done.signedAt
    ? new Date(done.signedAt).toLocaleString(undefined, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : done.signedDate || '';
  $('#done h1').textContent = 'Already submitted';
  $('#done-msg').textContent =
    `You signed and submitted this paperwork${when ? ` on ${when}` : ''} (reference ${done.reference}). ` +
    (done.emailed ? `Completed copies were emailed to ${done.email}.` : 'Your completed documents are with our team.') +
    ' If something needs to change, ask your hiring contact for a new link.';
  $('#done-list').innerHTML =
    '<h2 class="pw-card-title">Completed documents</h2><ul class="pw-doc-list">' +
    (done.documents || [])
      .map((d, i) => `<li><span class="pw-doc-num">${i + 1}</span><span><strong>${esc(d.title)}</strong></span></li>`)
      .join('') +
    '</ul>';
  clearDraft();
}

function showGateError(title, body) {
  $('#gate').innerHTML = `<div class="pw-gate-error"><h1>${esc(title)}</h1><p class="pw-lede">${esc(body)}</p></div>`;
}

function render() {
  const { hire, company } = state;
  $('#gate').hidden = true;
  $('#pw-form').hidden = false;
  $('#greet-name').textContent = hire.firstName || 'there';
  $('#greet-company').textContent = company.name;
  $('#footer-company').textContent = company.name;

  const f = $('#pw-form');
  f.legalFirstName.value = hire.firstName || '';
  f.legalLastName.value = hire.lastName || '';
  f.email.value = hire.email || '';
  f.phone.value = hire.phone || '';

  $('#doc-summary-list').innerHTML = state.documents
    .map(
      (d, i) => `<li><span class="pw-doc-num">${i + 1}</span><span><strong>${esc(d.title)}</strong><small>${esc(d.summary || '')}</small></span></li>`
    )
    .join('');

  // Signature pads
  const PERJURY =
    'Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.';
  $$('[data-sig]').forEach((host) => {
    const id = host.dataset.sig;
    const kind = host.dataset.kind || 'signature';
    state.pads[id] = new SignaturePad(host, {
      kind,
      label: host.dataset.label || (kind === 'initials' ? 'Initials' : 'Signature'),
      perjury: id === 'w4Signature' ? PERJURY : '',
    });
  });

  $$('.pw-doc-open').forEach((a) =>
    a.addEventListener('click', () => state.opened.add(a.dataset.opens))
  );

  // W-4 dependent math
  const calc = () => {
    const kids = Number(f.w4ChildCount.value || 0);
    const others = Number(f.w4OtherCount.value || 0);
    const total = kids * 2200 + others * 500;
    const el = $('#w4-calc');
    if (kids || others) {
      el.hidden = false;
      el.textContent = `Step 3 total: $${total.toLocaleString()} (${kids} × $2,200 + ${others} × $500)`;
    } else {
      el.hidden = true;
    }
  };
  f.w4ChildCount.addEventListener('input', calc);
  f.w4OtherCount.addEventListener('input', calc);

  // SSN formatting
  f.ssn.addEventListener('input', () => {
    const d = f.ssn.value.replace(/\D/g, '').slice(0, 9);
    f.ssn.value = d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`
      : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
  });
  ['state', 'licenseState', 'businessState'].forEach((n) => {
    if (f[n]) f[n].addEventListener('input', () => { f[n].value = f[n].value.toUpperCase(); });
  });

  // Enter in a text field must advance the step, never submit the whole form
  // from step 2 and skip everything after it.
  f.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || e.target.type === 'submit') return;
    e.preventDefault();
    if (state.step < state.maxStep) next();
  });

  restoreDraft();
  f.addEventListener('input', saveDraftSoon);
  f.addEventListener('change', saveDraftSoon);

  $('#next-btn').addEventListener('click', next);
  $('#back-btn').addEventListener('click', back);
  f.addEventListener('submit', submit);
  showStep(1);
}

// ── Draft persistence ────────────────────────────────────────────────────────
// Typing 40 fields on a phone is a big investment; a refresh or a backgrounded
// tab must not throw it away. Signatures are deliberately not stored, and nor
// is the Social Security number: it is never written to the device, only sent.

// Keyed by the link's signature, which no two links share.
const draftKey = () => `hhqPaperworkDraft:${state.token.slice(-24)}`;
const NEVER_SAVED = new Set(['ssn']);
let draftTimer = null;

function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
  try {
    const f = $('#pw-form');
    const data = {};
    for (const el of $$('input, select', f)) {
      if (!el.name || el.classList.contains('pw-sig-typed') || NEVER_SAVED.has(el.name)) continue;
      if (el.type === 'checkbox') data[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
      else data[el.name] = el.value;
    }
    localStorage.setItem(draftKey(), JSON.stringify({ data, step: state.step, at: Date.now() }));
  } catch { /* private mode / quota — the form still works */ }
}

function restoreDraft() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(draftKey()) || 'null');
  } catch { return; }
  if (!saved || !saved.data) return;
  const f = $('#pw-form');
  let restored = 0;
  for (const [name, value] of Object.entries(saved.data)) {
    if (NEVER_SAVED.has(name)) continue;
    const els = $$(`[name="${CSS.escape(name)}"]`, f);
    if (!els.length) continue;
    if (els[0].type === 'radio') {
      const hit = els.find((el) => el.value === value);
      if (hit) { hit.checked = true; restored++; }
    } else if (els[0].type === 'checkbox') {
      els[0].checked = Boolean(value);
      if (value) restored++;
    } else if (value) {
      els[0].value = value;
      restored++;
    }
  }
  if (restored > 3) toast('We restored what you had already filled in.');
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
}

// ── Steps ────────────────────────────────────────────────────────────────────

function showStep(n) {
  state.step = n;
  $$('.pw-step').forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
  $('#back-btn').hidden = n === 1;
  $('#next-btn').hidden = n === state.maxStep;
  $('#submit-btn').hidden = n !== state.maxStep;
  $('#step-count').textContent = `Step ${n} of ${state.maxStep}`;
  $('#progress-bar').style.width = `${(n / state.maxStep) * 100}%`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  Object.values(state.pads).forEach((p) => p.mode === 'draw' && requestAnimationFrame(p._resize));
  if (n === state.maxStep) renderReview();
}

function currentStepEl() {
  return $(`.pw-step[data-step="${state.step}"]`);
}

// Signature requirements per step
const STEP_SIGS = {
  3: [['w4Signature', 'your signature on the W-4']],
  4: [
    ['exclusivityInitials', 'initials for §1.7(B) Exclusive Services'],
    ['nonSolicitInitials', 'initials for Section V Non-Solicitation'],
    ['agentAgreementSignature', 'your signature on the Agent Agreement'],
    ['scheduleASignature', 'your signature on Schedule A'],
  ],
  5: [
    ['emailPolicySignature', 'your signature on the Email Policy'],
    ['healthSharingSignature', 'your signature on the Health Sharing acknowledgment'],
  ],
};

function validateStep() {
  const el = currentStepEl();
  const fields = $$('input, select, textarea', el).filter((i) => !i.disabled && i.offsetParent !== null);
  for (const field of fields) {
    if (!field.checkValidity()) {
      field.reportValidity();
      field.focus();
      return false;
    }
  }
  for (const [id, label] of STEP_SIGS[state.step] || []) {
    const pad = state.pads[id];
    if (pad && pad.isEmpty()) {
      toast(`Please add ${label}.`, true);
      pad.host.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
  }
  return true;
}

function next() {
  if (!validateStep()) return;
  if (state.step < state.maxStep) showStep(state.step + 1);
}
function back() {
  if (state.step > 1) showStep(state.step - 1);
}

// ── Review ───────────────────────────────────────────────────────────────────

function collect() {
  const f = $('#pw-form');
  const v = (n) => (f[n] ? String(f[n].value || '').trim() : '');
  const kids = Number(v('w4ChildCount') || 0);
  const others = Number(v('w4OtherCount') || 0);
  const money = (x) => (x ? x.replace(/[^0-9.]/g, '') : '');

  // Each document is signed with its own signature — the W-4 in particular
  // carries a penalties-of-perjury declaration shown at the moment of signing.
  const signatures = {};
  for (const [id, pad] of Object.entries(state.pads)) {
    const val = pad.value();
    if (val) signatures[id] = val;
  }

  return {
    legalFirstName: v('legalFirstName'),
    middleInitial: v('middleInitial'),
    legalLastName: v('legalLastName'),
    email: v('email'),
    phone: v('phone'),
    address: v('address'),
    city: v('city'),
    state: v('state'),
    zip: v('zip'),
    ssn: v('ssn'),
    driversLicense: v('driversLicense'),
    licenseState: v('licenseState'),
    businessName: v('businessName'),
    businessAddress: v('businessAddress'),
    businessCity: v('businessCity'),
    businessState: v('businessState'),
    businessZip: v('businessZip'),
    w4FilingStatus: (f.querySelector('input[name=w4FilingStatus]:checked') || {}).value || '',
    w4MultipleJobs: f.w4MultipleJobs.checked,
    w4QualifyingChildren: kids ? String(kids * 2200) : '',
    w4OtherDependents: others ? String(others * 500) : '',
    w4DependentTotal: kids || others ? String(kids * 2200 + others * 500) : '',
    w4OtherIncome: money(v('w4OtherIncome')),
    w4Deductions: money(v('w4Deductions')),
    w4ExtraWithholding: money(v('w4ExtraWithholding')),
    signerTitle: v('signerTitle'),
    juryWaiverAck: f.juryWaiverAck.checked,
    healthElection: (f.querySelector('input[name=healthElection]:checked') || {}).value || '',
    esignConsent: f.esignConsent.checked,
    signatures,
  };
}

function renderReview() {
  const d = collect();
  const name = [d.legalFirstName, d.middleInitial, d.legalLastName].filter(Boolean).join(' ');
  const statusLabel = { single: 'Single / married filing separately', married: 'Married filing jointly', head: 'Head of household' }[d.w4FilingStatus] || '—';
  const maskedSsn = d.ssn ? `•••-••-${d.ssn.slice(-4)}` : '—';

  const rows = (title, items) =>
    `<p class="pw-review-group">${title}</p>` +
    items
      .filter(([, v]) => v)
      .map(([k, v]) => `<dl class="pw-review-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></dl>`)
      .join('');

  $('#review-card').innerHTML =
    rows('You', [
      ['Legal name', name],
      ['Email', d.email],
      ['Phone', d.phone],
      ['Address', [d.address, d.city, `${d.state} ${d.zip}`].filter(Boolean).join(', ')],
      ['Social Security number', maskedSsn],
      ["Driver's license", d.driversLicense ? `${d.driversLicense} (${d.licenseState})` : ''],
      ['Business', d.businessName],
    ]) +
    rows('Tax withholding (W-4)', [
      ['Filing status', statusLabel],
      ['Dependent credit', d.w4DependentTotal ? `$${Number(d.w4DependentTotal).toLocaleString()}` : 'None'],
      ['Extra withholding', d.w4ExtraWithholding ? `$${d.w4ExtraWithholding}` : 'None'],
      ['Multiple jobs (Step 2c)', d.w4MultipleJobs ? 'Yes' : 'No'],
    ]) +
    rows('Agreements', [
      ['Agent Agreement', d.signatures.agentAgreementSignature ? 'Signed' : 'Not signed'],
      ['Your title', d.signerTitle],
      ['Clause initials', d.signatures.exclusivityInitials && d.signatures.nonSolicitInitials ? 'Both provided' : 'Incomplete'],
      ['Schedule A', d.signatures.scheduleASignature ? 'Signed' : 'Not signed'],
      ['Email Policy', d.signatures.emailPolicySignature ? 'Signed' : 'Not signed'],
      ['Health Sharing', d.healthElection === 'interested' ? 'Interested — send details' : d.healthElection === 'declined' ? 'Declined' : '—'],
    ]);

  const missing = [];
  if (!d.esignConsent) missing.push('Consent to sign electronically (step 1)');
  if (!d.legalFirstName || !d.legalLastName) missing.push('Your legal name (step 2)');
  if (!d.address || !d.city || !d.state || !d.zip) missing.push('Your home address (step 2)');
  if (!d.ssn) missing.push('Your Social Security number (step 2)');
  if (!d.w4FilingStatus) missing.push('W-4 filing status (step 3)');
  if (!d.juryWaiverAck) missing.push('Acknowledgment of the jury trial waiver (step 4)');
  if (!d.signerTitle) missing.push('Your title (step 4)');
  if (!d.healthElection) missing.push('Health Sharing choice (step 5)');
  for (const [id, label] of [...STEP_SIGS[3], ...STEP_SIGS[4], ...STEP_SIGS[5]]) {
    if (!d.signatures[id]) missing.push(`Missing ${label}`);
  }
  const box = $('#review-missing');
  if (missing.length) {
    box.hidden = false;
    box.innerHTML = `<strong>Still needed before you can submit:</strong><ul>${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`;
    $('#submit-btn').disabled = true;
  } else {
    box.hidden = true;
    $('#submit-btn').disabled = false;
  }
}

// ── Submit ───────────────────────────────────────────────────────────────────

async function submit(e) {
  e.preventDefault();
  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const res = await fetch('/api/paperwork/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, submission: collect() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(
        data.error ||
          (res.status >= 500
            ? "Something went wrong on our side and nothing was submitted. Please try again in a moment."
            : `Submission failed (${res.status})`)
      );
    }

    clearDraft();
    $('#pw-form').hidden = true;
    $('#done').hidden = false;
    $('#done-msg').textContent = data.emailed
      ? `We've emailed completed copies to ${state.hire.email}.`
      : 'Your completed documents have been sent to our team.';
    $('#done-list').innerHTML =
      '<h2 class="pw-card-title">Completed documents</h2><ul class="pw-doc-list">' +
      (data.documents || [])
        .map((d, i) => `<li><span class="pw-doc-num">${i + 1}</span><span><strong>${esc(d.title)}</strong></span></li>`)
        .join('') +
      '</ul>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Submit my paperwork';
  }
}

boot();
