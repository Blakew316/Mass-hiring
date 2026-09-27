/* Onboarding docs — WPI Hire's page script (its public/app.js), as a page of
   this site. The code below is WPI Hire's own, section for section; what is
   different is only what had to be:

   - its routes live under /api/onboarding/ here, and are signed in to the way
     every page of this site is (the session cookie), so there is no password
     prompt; a lapsed session goes to this site's sign-in screen
   - its ids and the class names this site already used are wh-* (see the
     top of public/onboarding.css)
   - everything it cached in this browser is cached per team
   - its four sections are tabs within the page, remembered in the address
     bar (#onboarding?tab=hire), with an iOS segmented control on a phone
   - it starts when the page is first opened, looks again every 30 seconds
     while it is open, and forgets everything when the team changes
   - the site's header, offline marker and service worker do what WPI Hire's
     own did
   - new: the Signed paperwork list (the signing record and the signed copies
     of every completed packet), its settings card in Settings, and "Send
     onboarding docs" from the Candidates page. */
(() => {
const state = {
  statuses: [],
  candidates: [],
  localCandidates: [],
  overrides: {},
  storage: null,
  documents: [],
  hiredStatusId: null,
  hiredThisSession: new Set(),
  sends: {},
  completedHires: [],
  synced: false,
  // As a page of this site: whose data this is, whether the page is open,
  // and which of its four sections is showing.
  teamId: '',
  active: false,
  booted: false,
  tab: 'pipeline',
  // Moved on by a change of team: an answer asked for before it is dropped.
  generation: 0,
  // The completed hire whose record is open in Signed paperwork.
  openSigned: '',
};

const $ = (sel) => document.querySelector(sel);

const ICONS = {
  mail: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m22 7-10 6L2 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 2v4M8 2v4M3 10h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flask: '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 8h.01M12 12v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ── Saved records ────────────────────────────────────────────────────────────
// Uploaded candidates and manual corrections are stored on the server so they
// persist across sessions and devices. The browser keeps a copy purely as an
// offline cache, so the pipeline still renders if a request fails.

const LOCAL_CANDIDATES_KEY = 'hhqLocalCandidates';
const OVERRIDES_KEY = 'hhqCandidateOverrides';

// One browser can be signed in to one team and then another, and the second
// must never be shown the first one's pipeline: the records are kept per
// team. Whether the install hint was dismissed is about the device.
const DEVICE_KEYS = new Set(['hhqInstallHintDismissed']);
const cacheKey = (key) => (DEVICE_KEYS.has(key) ? key : state.teamId ? `${key}:${state.teamId}` : '');

function cacheGet(key, fallback) {
  const k = cacheKey(key);
  if (!k) return fallback;
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function cacheSet(key, value) {
  const k = cacheKey(key);
  if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(value)); } catch { /* private mode */ }
}

function loadLocalCandidates() {
  return cacheGet(LOCAL_CANDIDATES_KEY, []) || [];
}
function saveLocalCandidates() {
  cacheSet(LOCAL_CANDIDATES_KEY, state.localCandidates);
}
// A record the server refused is taken back off the board and the cache.
function forgetLocal(id) {
  state.localCandidates = state.localCandidates.filter((x) => String(x.id) !== String(id));
  saveLocalCandidates();
  renderStats();
  renderBoard();
}
function allCandidates() {
  return [...state.localCandidates, ...state.candidates];
}

// Pulls the saved records from the server; the cache covers a failed request.
async function loadSaved() {
  const gen = state.generation;
  try {
    const res = await api('/api/saved');
    if (gen !== state.generation) return;
    state.localCandidates = Array.isArray(res.candidates) ? res.candidates : [];
    state.overrides = {};
    for (const o of res.overrides || []) {
      const { id, savedAt, ...details } = o;
      void savedAt;
      state.overrides[String(id)] = details;
    }
    state.sends = {};
    for (const send of res.sends || []) {
      const key = emailKey(send.email || send.id);
      if (key) state.sends[key] = send;
    }
    state.completedHires = Array.isArray(res.hires) ? res.hires : [];
    state.storage = res.storage || null;
    saveLocalCandidates();
    cacheSet(OVERRIDES_KEY, state.overrides);
  } catch (err) {
    if (gen !== state.generation) return;
    state.localCandidates = loadLocalCandidates();
    state.overrides = cacheGet(OVERRIDES_KEY, {}) || {};
    console.warn('Using cached records:', err.message);
  }
}

// Packets are addressed by email, so that is the key that ties a candidate to
// the packet they were sent and the paperwork they signed.
function emailKey(value) {
  return String(value || '').trim().toLowerCase();
}

function shortDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Where each candidate has got to: sent a packet, signed it, or neither.
function progressOf(c) {
  const key = emailKey(applicantOf(c).email);
  if (!key) return {};
  const signed = state.completedHires.find((h) => emailKey(h.email) === key);
  return { sentAt: state.sends[key]?.sentAt, signedAt: signed?.signedAt };
}

// Records the send locally the moment it succeeds, so the tiles and cards move
// without waiting for the next round-trip. The server stores it durably too.
function noteSend(email) {
  const key = emailKey(email);
  if (!key) return;
  state.sends[key] = { ...(state.sends[key] || {}), email, sentAt: new Date().toISOString() };
  renderStats();
  renderBoard();
  // The Candidates page shows who was sent their packet: it looks again.
  host.changed();
}

function loadOverrides() {
  return state.overrides || {};
}

async function saveOverride(id, data) {
  if (data) state.overrides[String(id)] = data;
  else delete state.overrides[String(id)];
  cacheSet(OVERRIDES_KEY, state.overrides);
  try {
    await api('/api/saved/overrides', { method: 'POST', body: { id: String(id), details: data || null } });
  } catch (err) {
    if (err.refused) {
      delete state.overrides[String(id)];
      cacheSet(OVERRIDES_KEY, state.overrides);
      renderBoard();
      toast(err.message, true);
      return;
    }
    toast(`Saved on this device only — ${err.message}`, true);
  }
}

function hasOverride(id) {
  return Boolean(loadOverrides()[String(id)]);
}

// The candidate's contact details with any manual edits applied.
function applicantOf(c) {
  const a = c.applicant || {};
  const o = loadOverrides()[String(c.id)];
  return o ? { ...a, ...o } : a;
}

// WPI Hire's routes, at their place in this app: /api/onboarding/… (the site
// already has an /api/candidates of its own). They are behind the team
// sign-in like every other page — the session cookie goes with each call — so
// where WPI Hire prompted for its password, a refusal here is a lapsed
// session, and the site's own sign-in screen takes over.
const route = (path) => (path.startsWith('/api/onboarding/') ? path : path.replace(/^\/api\//, '/api/onboarding/'));

// Set by the site (public/app.js): its sign-in screen, and its pages.
const host = { signedOut() {}, show() {}, changed() {} };

async function rawFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(route(path), {
      ...opts,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  } catch {
    // A dropped connection reads as "Failed to fetch", which tells nobody
    // anything. Say what actually happened.
    throw new Error(
      navigator.onLine
        ? 'Could not reach the server — try again in a moment'
        : "You're offline — reconnect to load the latest"
    );
  }
  if (res.status === 401) host.signedOut();
  return res;
}

const api = async (path, opts = {}) => {
  const res = await rawFetch(path, {
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.auth ? 'Please sign in to the dashboard.' : data.error || `Request failed (${res.status})`);
    // A 400 is the server refusing on purpose — someone at Wholesale Payments,
    // an address that is not one. Keeping it "on this device only" would keep
    // exactly what was refused, so those are undone rather than cached.
    err.refused = res.status === 400;
    throw err;
  }
  return data;
};

// Nobody at Wholesale Payments is added or sent a packet as a new hire: the
// packet goes to the person's own address, before they have a company inbox.
// The server holds the line; this says so before anything is added.
const OWN_COMPANY = /@(?:[a-z0-9-]+\.)*wholesalepayments\.com$/i;
function refuseOwnCompany(email) {
  if (!OWN_COMPANY.test(String(email || '').trim())) return false;
  toast('That is a Wholesale Payments address. Onboarding packets go to the new hire’s own email — use their personal address.', true);
  return true;
}

function toast(msg, isError = false) {
  const el = $('#wh-toast');
  el.textContent = msg;
  el.className = `wh-toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 4200);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}
// For use inside double-quoted HTML attributes (input values).
function escAttr(s) {
  return esc(s).replaceAll('"', '&quot;');
}

const AVATAR_COLORS = ['#0b1b5e', '#0a8fe0', '#0aa065', '#0f7691', '#4a5d94', '#6437a8', '#5b6673'];
function avatar(name, cls = 'wh-avatar') {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  return `<span class="${cls}" style="background:${color}">${esc(initials)}</span>`;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = ['pipeline', 'hire', 'onboarding', 'directory'];
const wph = $('#wph');

// The page scrolls in this site's page area on a phone, and in the window on
// a wide screen: back to the top of whichever it is.
function scrollToTop() {
  window.scrollTo({ top: 0 });
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

function showTab(name, { scroll = true } = {}) {
  if (!TABS.includes(name)) name = 'pipeline';
  state.tab = name;
  wph.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('wh-active', t.dataset.tab === name));
  wph.querySelectorAll('.panel').forEach((p) => p.classList.toggle('wh-active', p.id === `wh-tab-${name}`));
  document.querySelectorAll('#view-onboarding .wh-seg-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  // Which section is open is in the address bar, so a reload or a link lands
  // on it. Replaced, not pushed: Back leaves the page, as it does elsewhere.
  if (state.active) {
    const want = name === 'pipeline' ? '#onboarding' : `#onboarding?tab=${name}`;
    if (location.hash !== want) history.replaceState(history.state, '', want);
  }
  if (scroll) scrollToTop();
}
document.querySelectorAll('#wph .nav-tab, #view-onboarding .wh-seg-btn').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab))
);

// ── Status / header ──────────────────────────────────────────────────────────

async function loadStatus() {
  const gen = state.generation;
  const s = await api('/api/status');
  if (gen !== state.generation) return;
  state.status = s;
  // Surface a badge only when something needs attention.
  const badge = $('#wh-email-badge');
  const warning =
    s.storage && !s.storage.persistent
      ? 'Records not saving'
      : s.storage && !s.storage.sharedAcrossDevices
        ? 'Records: this device only'
        : s.mode !== 'live'
          ? 'Demo data'
          : !s.emailConfigured
            ? 'Email simulated'
            : '';
  // A setting can change while the page is open (Settings → Onboarding docs),
  // so the badge can go as well as come.
  badge.textContent = warning || '\u00a0';
  badge.hidden = !warning;
}
// Each of those is put right in Settings.
$('#wh-email-badge').addEventListener('click', () => openSettings());

function openSettings() {
  host.show('settings');
  setTimeout(() => {
    const card = $('#onbSettingsCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

function chipClass(label) {
  const l = (label || '').toLowerCase();
  if (/(not a fit|reject|decline|disqualif)/.test(l)) return 'chip-red';
  if (/hire/.test(l)) return 'chip-green';
  if (/offer/.test(l)) return 'chip-violet';
  if (/interview/.test(l)) return 'chip-amber';
  if (/(phone|screen)/.test(l)) return 'chip-teal';
  if (/review/.test(l)) return 'chip-blue';
  return 'chip-gray';
}

// The BambooHR hiring stages, used to group the board and fill the per-card
// status dropdowns. Candidates themselves are only pulled on Sync.
async function loadStages() {
  const res = await api('/api/statuses');
  state.statuses = res.statuses.map((x) => ({ id: x.id, label: x.label || x.name }));
  const hired = state.statuses.find((x) => /hire/i.test(x.label));
  state.hiredStatusId = hired ? hired.id : null;
}

async function loadCandidates() {
  const res = await api('/api/candidates');
  state.candidates = res.applications || [];
  state.synced = true;
  renderStats();
  renderBoard();
  return state.candidates.length;
}

// The tiles read from the records this app owns — candidates on the board,
// packets it has sent, and paperwork that has come back signed. Nothing here
// needs a BambooHR round-trip, so the numbers move the moment anything changes.
function renderStats() {
  const el = $('#wh-pipeline-stats');
  const all = allCandidates();

  const signed = new Set(state.completedHires.map((h) => emailKey(h.email)).filter(Boolean));
  const sent = new Set(signed); // signing proves a packet went out
  for (const key of Object.keys(state.sends)) if (key) sent.add(key);

  // Phones get the short label so four tiles fit one row and the candidate
  // cards stay above the fold; CSS picks which of the two to show.
  const stats = [
    { value: all.length, label: 'Candidates', short: 'Hires' },
    { value: sent.size, label: 'Packets sent', short: 'Sent' },
    { value: Math.max(0, sent.size - signed.size), label: 'Awaiting signature', short: 'Awaiting' },
    { value: signed.size, label: 'Signed & complete', short: 'Signed' },
  ];
  el.innerHTML = stats
    .map(
      (s) =>
        `<div class="stat"><div class="wh-stat-value">${s.value}</div>` +
        `<div class="wh-stat-label"><span class="label-full">${esc(s.label)}</span>` +
        `<span class="label-short">${esc(s.short)}</span></div></div>`
    )
    .join('');
  el.hidden = false;
}

function candidateCard(c) {
  const a = applicantOf(c);
  const name = `${a.firstName || ''} ${a.lastName || ''}`.trim() || 'Unknown';
  const role = c.job?.title?.label || c.job?.title || '';
  const statusLabel = c.status?.label || c.status?.name || '—';
  const edited = hasOverride(c.id);
  const statusOptions = state.statuses
    .map((s) => `<option value="${s.id}" ${String(s.id) === String(c.status?.id) ? 'selected' : ''}>${esc(s.label)}</option>`)
    .join('');
  const { sentAt, signedAt } = progressOf(c);
  const meta = [
    a.email && `<div class="meta-line">${ICONS.mail}<span>${esc(a.email)}</span></div>`,
    a.phoneNumber && `<div class="meta-line">${ICONS.phone}<span>${esc(a.phoneNumber)}</span></div>`,
    c.resumeName && `<div class="meta-line">${ICONS.file}<span>${esc(c.resumeName)}</span></div>`,
    c.startDate && `<div class="meta-line">${ICONS.calendar}<span>Starts ${esc(c.startDate)}</span></div>`,
    c.appliedDate && `<div class="meta-line">${ICONS.calendar}<span>Added ${esc(c.appliedDate)}</span></div>`,
    signedAt
      ? `<div class="meta-line meta-good"><button type="button" class="meta-link open-signed" data-email="${escAttr(emailKey(a.email))}" title="The signing record and the signed copies">${ICONS.check}<span>Paperwork signed ${esc(shortDate(signedAt))}</span></button></div>`
      : sentAt && `<div class="meta-line meta-pending">${ICONS.mail}<span>Packet sent ${esc(shortDate(sentAt))} — awaiting signature</span></div>`,
  ].filter(Boolean).join('');

  return `
  <div class="candidate-card" data-id="${c.id}">
    <div class="candidate-head">
      ${avatar(name)}
      <div class="candidate-id">
        <div class="candidate-name">${esc(name)}${edited ? '<span class="tag-edited">Edited</span>' : ''}</div>
        <div class="candidate-role">${esc(role)}</div>
      </div>
      <span class="wh-chip ${c.local ? 'chip-blue' : chipClass(statusLabel)}">${esc(statusLabel)}</span>
      <button class="wh-icon-btn edit-btn" type="button" aria-label="Edit contact details" title="Edit contact details">${ICONS.pencil}</button>
    </div>
    <form class="edit-form" hidden>
      <div class="edit-grid">
        <label class="field">First name<input name="firstName" value="${escAttr(a.firstName || '')}" required /></label>
        <label class="field">Last name<input name="lastName" value="${escAttr(a.lastName || '')}" required /></label>
        <label class="field span-2">Email<input name="email" type="email" value="${escAttr(a.email || '')}" /></label>
        <label class="field span-2">Phone<input name="phoneNumber" type="tel" value="${escAttr(a.phoneNumber || '')}" /></label>
      </div>
      <div class="edit-actions">
        <button type="submit" class="wh-btn wh-btn-primary wh-btn-sm">Save</button>
        <button type="button" class="wh-btn wh-btn-ghost wh-btn-sm cancel-edit">Cancel</button>
        ${edited ? '<button type="button" class="wh-btn wh-btn-ghost wh-btn-sm reset-edit">Reset to BambooHR</button>' : ''}
      </div>
    </form>
    ${meta ? `<div class="candidate-meta">${meta}</div>` : ''}
    <div class="candidate-actions">
      ${c.local
        ? `<button class="wh-btn wh-btn-primary wh-btn-sm hire-btn" style="flex:1">Hire</button>
           <button class="wh-btn wh-btn-ghost wh-btn-sm remove-local">Remove</button>`
        : `<select class="wh-select wh-status-select" aria-label="Move to stage">${statusOptions}</select>
           <button class="wh-btn wh-btn-primary wh-btn-sm hire-btn">Hire</button>`}
      <button class="wh-btn wh-btn-ghost wh-btn-sm send-packet-quick" ${a.email ? '' : 'disabled title="No email on file"'}>
        <svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Send onboarding packet
      </button>
    </div>
  </div>`;
}

// One-tap send from a candidate card: the packet is personalized with the
// candidate's name, email, phone, and role, and emailed immediately.
async function quickSendPacket(c, btn) {
  const a = applicantOf(c);
  if (!a.email) return toast('This candidate has no email on file', true);
  const name = `${a.firstName || ''} ${a.lastName || ''}`.trim();

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = 'Sending…';
  try {
    const hire = {
      firstName: a.firstName || '',
      lastName: a.lastName || '',
      email: a.email,
      phone: a.phoneNumber || '',
      jobTitle: 'Account Executive',
      startDate: c.startDate || '',
    };
    const res = await api('/api/onboarding/send', {
      method: 'POST',
      body: { hire, options: { sendEmail: true, ccHr: true, uploadToBamboo: true } },
    });

    // Mirror the send in the Onboarding tab so the details and results are there.
    const p = $('#wh-packet-form');
    p.firstName.value = hire.firstName;
    p.lastName.value = hire.lastName;
    p.email.value = hire.email;
    p.phone.value = hire.phone;
    p.jobTitle.value = hire.jobTitle;
    if (hire.startDate) p.startDate.value = hire.startDate;
    renderPacketResult(res);
    noteSend(hire.email);

    toast(res.ok ? `Onboarding packet sent to ${name || hire.email}` : 'Sent, but check the Onboarding tab', !res.ok);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function renderBoard() {
  const board = $('#wh-pipeline-board');
  const all = allCandidates();
  if (!all.length) {
    board.innerHTML = state.synced
      ? '<div class="wh-empty-state">No candidates in BambooHR yet.</div>'
      : '<div class="wh-empty-state">No candidates yet — press Sync to pull them from BambooHR.</div>';
    return;
  }

  // Group candidates by stage: uploaded resumes first, then pipeline order.
  const order = state.statuses.map((s) => s.label);
  const OWN_STAGES = ['Added', 'Uploaded'];
  const rank = (label) => (OWN_STAGES.includes(label) ? OWN_STAGES.indexOf(label) - 2 : order.indexOf(label) + 1 || 99);
  const groups = new Map();
  for (const c of all) {
    const label = c.status?.label || 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  }
  const sorted = [...groups.entries()].sort((x, y) => rank(x[0]) - rank(y[0]));

  board.innerHTML = sorted
    .map(
      ([label, cands]) => `
      <section class="stage">
        <div class="stage-head">
          <span class="stage-name">${esc(label)}</span>
          <span class="stage-count">${cands.length}</span>
          <span class="stage-rule"></span>
        </div>
        <div class="candidate-grid">${cands.map(candidateCard).join('')}</div>
      </section>`
    )
    .join('');

  board.querySelectorAll('.wh-status-select').forEach((sel) =>
    sel.addEventListener('change', async (e) => {
      const card = e.target.closest('.candidate-card');
      try {
        await api(`/api/candidates/${card.dataset.id}/status`, {
          method: 'POST',
          body: { statusId: Number(e.target.value) },
        });
        const label = state.statuses.find((s) => String(s.id) === e.target.value)?.label;
        const c = state.candidates.find((x) => String(x.id) === String(card.dataset.id));
        if (c) c.status = { id: Number(e.target.value), label };
        toast(`Moved to ${label}`);
        renderStats();
        renderBoard();
      } catch (err) {
        toast(err.message, true);
      }
    })
  );

  const findCandidate = (id) => allCandidates().find((x) => String(x.id) === String(id));

  board.querySelectorAll('.hire-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const c = findCandidate(e.target.closest('.candidate-card').dataset.id);
      prefillHireForm(c);
      showTab('hire');
    })
  );

  board.querySelectorAll('.open-signed').forEach((btn) =>
    btn.addEventListener('click', () => openSignedFor(btn.dataset.email))
  );

  board.querySelectorAll('.send-packet-quick').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const c = findCandidate(e.target.closest('.candidate-card').dataset.id);
      quickSendPacket(c, btn);
    })
  );

  board.querySelectorAll('.remove-local').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.candidate-card').dataset.id;
      const c = findCandidate(id);
      const a = applicantOf(c);
      if (!confirm(`Remove ${a.firstName} ${a.lastName} from the pipeline?`)) return;
      state.localCandidates = state.localCandidates.filter((x) => String(x.id) !== String(id));
      saveLocalCandidates();
      delete state.overrides[String(id)];
      cacheSet(OVERRIDES_KEY, state.overrides);
      api(`/api/saved/candidates/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      renderStats();
      renderBoard();
      toast('Candidate removed');
    })
  );

  board.querySelectorAll('.edit-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const form = e.target.closest('.candidate-card').querySelector('.edit-form');
      form.hidden = !form.hidden;
    })
  );

  board.querySelectorAll('.cancel-edit').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.target.closest('.edit-form').hidden = true;
    })
  );

  board.querySelectorAll('.reset-edit').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.candidate-card');
      saveOverride(card.dataset.id, null);
      renderBoard();
      toast('Restored details from BambooHR');
    })
  );

  board.querySelectorAll('.edit-form').forEach((form) =>
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const card = e.target.closest('.candidate-card');
      const f = e.target;
      const details = {
        firstName: f.firstName.value.trim(),
        lastName: f.lastName.value.trim(),
        email: f.email.value.trim(),
        phoneNumber: f.phoneNumber.value.trim(),
      };
      if (refuseOwnCompany(details.email)) return;
      const c = findCandidate(card.dataset.id);
      if (c?.local) {
        // Uploaded candidates are stored as records, so update in place.
        const before = c.applicant;
        c.applicant = { ...c.applicant, ...details };
        saveLocalCandidates();
        api('/api/saved/candidates', { method: 'POST', body: { candidate: c } }).catch((err) => {
          if (!err.refused) return toast(`Saved on this device only — ${err.message}`, true);
          c.applicant = before;
          saveLocalCandidates();
          renderBoard();
          toast(err.message, true);
        });
      } else {
        saveOverride(card.dataset.id, details);
      }
      renderBoard();
      toast('Details saved — packets will use the updated info');
    })
  );
}

// ── Add a hire by hand ───────────────────────────────────────────────────────
// The same record shape the resume upload produces, so an added hire behaves
// exactly like an uploaded one: it persists, it can be edited, and its packet
// can be sent straight from the card.

const addHirePanel = $('#wh-add-hire-panel');
const addHireForm = $('#wh-add-hire-form');

function toggleAddHire(show) {
  addHirePanel.hidden = show === undefined ? !addHirePanel.hidden : !show;
  if (!addHirePanel.hidden) {
    $('#wh-upload-panel').hidden = true;
    addHirePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    addHireForm.firstName.focus();
  }
}

$('#wh-add-hire-btn').addEventListener('click', () => toggleAddHire());
$('#wh-add-hire-cancel').addEventListener('click', () => {
  addHireForm.reset();
  toggleAddHire(false);
});

addHireForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();

  // One record per person: adding someone already on the board would leave two
  // cards fighting over the same packet.
  if (refuseOwnCompany(email)) return;
  const existing = allCandidates().find((c) => emailKey(applicantOf(c).email) === emailKey(email));
  if (existing) {
    const a = applicantOf(existing);
    return toast(`${a.firstName || ''} ${a.lastName || ''}`.trim() + ` is already in the pipeline with that email`, true);
  }

  const candidate = {
    id: `hire-${Date.now()}`,
    local: true,
    appliedDate: new Date().toISOString().slice(0, 10),
    startDate: f.startDate.value || '',
    applicant: {
      firstName: f.firstName.value.trim(),
      lastName: f.lastName.value.trim(),
      email,
      phoneNumber: f.phone.value.trim(),
    },
    job: { title: { label: f.jobTitle.value.trim() || 'Account Executive' } },
    status: { id: 'local', label: 'Added' },
  };

  state.localCandidates.unshift(candidate);
  saveLocalCandidates();
  api('/api/saved/candidates', { method: 'POST', body: { candidate } }).catch((err) => {
    if (!err.refused) return toast(`Saved on this device only — ${err.message}`, true);
    forgetLocal(candidate.id);
    toast(err.message, true);
  });

  f.reset();
  f.jobTitle.value = 'Account Executive';
  toggleAddHire(false);
  renderStats();
  renderBoard();
  toast(`${candidate.applicant.firstName} ${candidate.applicant.lastName} added — ready to send their packet`);
  document.querySelector(`.candidate-card[data-id="${candidate.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Resume upload ────────────────────────────────────────────────────────────

const uploadPanel = $('#wh-upload-panel');
const dropzone = $('#wh-dropzone');
const resumeFile = $('#wh-resume-file');
const uploadReview = $('#wh-upload-review');
const uploadStatus = $('#wh-upload-status');
let pendingResumeName = '';

$('#wh-upload-resume-btn').addEventListener('click', () => {
  uploadPanel.hidden = !uploadPanel.hidden;
  if (!uploadPanel.hidden) {
    addHirePanel.hidden = true;
    uploadPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

$('#wh-upload-cancel').addEventListener('click', () => {
  uploadReview.hidden = true;
  uploadPanel.hidden = true;
});

dropzone.addEventListener('click', () => resumeFile.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('wh-drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('wh-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('wh-drag');
  const file = e.dataTransfer.files?.[0];
  if (file) handleResumeFile(file);
});
resumeFile.addEventListener('change', () => {
  if (resumeFile.files?.[0]) handleResumeFile(resumeFile.files[0]);
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

async function handleResumeFile(file) {
  if (file.size > 4 * 1024 * 1024) return toast("Resume is too large (4 MB max)", true);
  pendingResumeName = file.name;
  uploadStatus.hidden = false;
  uploadStatus.textContent = `Reading ${file.name}…`;
  uploadReview.hidden = true;
  const f = uploadReview;
  try {
    const contentBase64 = await fileToBase64(file);
    const res = await api('/api/resume/parse', {
      method: 'POST',
      body: { filename: file.name, contentBase64 },
    });
    f.firstName.value = res.candidate.firstName || '';
    f.lastName.value = res.candidate.lastName || '';
    f.email.value = res.candidate.email || '';
    f.phone.value = res.candidate.phone || '';
    $('#wh-upload-note').textContent = res.note || '';
  } catch (err) {
    // Never dead-end the upload: open the form empty so the details can be
    // typed in even when parsing is unavailable.
    f.firstName.value = '';
    f.lastName.value = '';
    f.email.value = '';
    f.phone.value = '';
    $('#wh-upload-note').textContent = `Couldn't read the resume automatically (${err.message}) — enter the details below and the candidate will still be added.`;
    toast(err.message, true);
  } finally {
    uploadStatus.hidden = true;
    uploadReview.hidden = false;
    resumeFile.value = '';
  }
}

uploadReview.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (refuseOwnCompany(f.email.value)) return;
  const candidate = {
    id: `local-${Date.now()}`,
    local: true,
    resumeName: pendingResumeName,
    appliedDate: new Date().toISOString().slice(0, 10),
    applicant: {
      firstName: f.firstName.value.trim(),
      lastName: f.lastName.value.trim(),
      email: f.email.value.trim(),
      phoneNumber: f.phone.value.trim(),
    },
    job: { title: { label: f.jobTitle.value.trim() || 'Uploaded resume' } },
    status: { id: 'local', label: 'Uploaded' },
  };
  state.localCandidates.unshift(candidate);
  saveLocalCandidates();
  api('/api/saved/candidates', { method: 'POST', body: { candidate } }).catch((err) => {
    if (!err.refused) return toast(`Saved on this device only — ${err.message}`, true);
    forgetLocal(candidate.id);
    toast(err.message, true);
  });
  f.reset();
  uploadReview.hidden = true;
  uploadPanel.hidden = true;
  renderStats();
  renderBoard();
  toast(`${candidate.applicant.firstName} ${candidate.applicant.lastName} added — ready to send their packet`);
  document.querySelector('.candidate-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Hire ─────────────────────────────────────────────────────────────────────

function prefillHireForm(c) {
  const f = $('#wh-hire-form');
  const a = applicantOf(c);
  f.firstName.value = a.firstName || '';
  f.lastName.value = a.lastName || '';
  f.workEmail.value = a.email || '';
  f.mobilePhone.value = a.phoneNumber || '';
  f.jobTitle.value = c.job?.title?.label || c.job?.title || '';
  if (c.startDate) f.hireDate.value = c.startDate;
  f.department.value = '';
  f.applicationId.value = c.local ? '' : c.id;
  const banner = $('#wh-hire-context');
  banner.innerHTML = `${avatar(`${a.firstName || ''} ${a.lastName || ''}`.trim(), 'wh-avatar')}<span>Hiring <strong>${esc(a.firstName)} ${esc(a.lastName)}</strong> from the pipeline — their application will be marked Hired.</span>`;
  banner.hidden = false;
}

$('#wh-hire-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await api('/api/hire', {
      method: 'POST',
      body: {
        employee: {
          firstName: f.firstName.value.trim(),
          lastName: f.lastName.value.trim(),
          workEmail: f.workEmail.value.trim(),
          mobilePhone: f.mobilePhone.value.trim(),
          jobTitle: f.jobTitle.value.trim(),
          department: f.department.value.trim(),
          hireDate: f.hireDate.value,
          location: f.location.value.trim(),
        },
        applicationId: f.applicationId.value || undefined,
        hiredStatusId: state.hiredStatusId || undefined,
      },
    });
    toast(`Employee #${res.employeeId} created${res.statusUpdated ? ' — application marked Hired' : ''}`);
    state.hiredThisSession.add(String(res.employeeId));

    // Hand off to onboarding, prefilled.
    const p = $('#wh-packet-form');
    p.firstName.value = f.firstName.value;
    p.lastName.value = f.lastName.value;
    p.email.value = f.workEmail.value;
    p.phone.value = f.mobilePhone.value;
    p.jobTitle.value = 'Account Executive';
    p.department.value = f.department.value;
    p.startDate.value = f.hireDate.value;
    p.employeeId.value = res.employeeId || '';
    p.workLocation.value = f.location.value;
    $('#wh-hire-context').hidden = true;
    f.reset();
    showTab('onboarding');
    loadStages();
    loadDirectory();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Onboarding packet ────────────────────────────────────────────────────────

async function loadDocuments() {
  const gen = state.generation;
  const res = await api('/api/packet/documents');
  if (gen !== state.generation) return;
  state.documents = res.documents;
  $('#wh-doc-list').innerHTML = state.documents
    .map(
      (d) => `
      <label class="doc-item">
        <input type="checkbox" value="${d.key}" ${d.default ? 'checked' : ''} />
        <span class="doc-check"></span>
        <span class="doc-title">${esc(d.title)}</span>
        <a href="${escAttr(d.href || '#')}" ${d.href ? 'target="_blank" rel="noopener"' : ''} class="doc-preview" data-key="${d.key}">Preview</a>
      </label>`
    )
    .join('');

  $('#wh-doc-list').querySelectorAll('.doc-preview').forEach((a) =>
    a.addEventListener('click', async (e) => {
      // A company document is published beside the paperwork portal: the link
      // opens the PDF itself, which works everywhere — the installed app on an
      // iPhone included, where a window opened after a network request is
      // blocked as a pop-up.
      const doc = state.documents.find((d) => d.key === a.dataset.key);
      if (doc && doc.href) return;
      e.preventDefault();
      const win = window.open('', '_blank');
      try {
        const res = await rawFetch('/api/packet/preview', {
          method: 'POST',
          body: JSON.stringify({ docKey: a.dataset.key, hire: readHireForm() }),
        });
        if (!res.ok) throw new Error('Preview failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (win) win.location = url;
        else window.open(url, '_blank');
      } catch (err) {
        if (win) win.close();
        toast(err.message, true);
      }
    })
  );
}

function readHireForm() {
  const f = $('#wh-packet-form');
  return {
    firstName: f.firstName.value.trim(),
    lastName: f.lastName.value.trim(),
    email: f.email.value.trim(),
    phone: f.phone.value.trim(),
    jobTitle: f.jobTitle.value.trim(),
    department: f.department.value.trim(),
    startDate: f.startDate.value,
    manager: f.manager.value.trim(),
    salary: f.salary.value.trim(),
    employmentType: f.employmentType.value,
    workLocation: f.workLocation.value.trim(),
    employeeId: f.employeeId.value.trim() || undefined,
  };
}

const STEP_STYLE = {
  done: { cls: 'tl-done', icon: ICONS.check },
  simulated: { cls: 'tl-sim', icon: ICONS.flask },
  skipped: { cls: 'tl-skip', icon: ICONS.skip },
  error: { cls: 'tl-err', icon: ICONS.x },
};

function renderPacketResult(res) {
  const card = $('#wh-packet-result');
  card.hidden = false;
  card.innerHTML =
    `<h2 class="result-title">${res.ok ? 'Packet sent' : 'Sent with issues'}</h2>` +
    `<div class="timeline">` +
    res.steps
      .map((s) => {
        const st = STEP_STYLE[s.status] || { cls: 'tl-skip', icon: ICONS.info };
        return `
        <div class="tl-step">
          <span class="tl-dot ${st.cls}">${st.icon}</span>
          <div class="tl-body">
            <div class="tl-name">${esc(s.step)}</div>
            <div class="tl-detail">${esc(s.detail)}</div>
          </div>
        </div>`;
      })
      .join('') +
    `</div>`;
}

$('#wh-packet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#wh-send-packet-btn');
  const selectedDocs = [...f.querySelectorAll('.doc-item input:checked')].map((i) => i.value);
  if (!selectedDocs.length) return toast('Select at least one document for the packet', true);

  btn.disabled = true;
  $('#wh-send-packet-label').textContent = 'Sending…';
  try {
    const res = await api('/api/onboarding/send', {
      method: 'POST',
      body: {
        hire: readHireForm(),
        documents: selectedDocs,
        options: {
          sendEmail: f.sendEmail.checked,
          ccHr: f.ccHr.checked,
          uploadToBamboo: f.uploadToBamboo.checked,
        },
      },
    });
    renderPacketResult(res);
    if (f.sendEmail.checked) noteSend(f.email.value);
    $('#wh-packet-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(res.ok ? 'Onboarding packet on its way' : 'Sent, but check the results panel', !res.ok);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    $('#wh-send-packet-label').textContent = 'Send onboarding packet';
  }
});

// Tests the deployed SMTP login and reports which account it authenticates as.
$('#wh-test-email-btn').addEventListener('click', async () => {
  const btn = $('#wh-test-email-btn');
  const out = $('#wh-email-test-result');
  btn.disabled = true;
  out.textContent = 'Testing…';
  try {
    const res = await api('/api/email/test', { method: 'POST', body: {} });
    out.textContent = res.ok
      ? `✓ Login OK — sending as ${res.user} via ${res.host}`
      : `✗ ${res.host} rejected login as ${res.user}: ${res.error}`;
    toast(res.ok ? 'Email login works' : 'Email login failed — details shown below the button', !res.ok);
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Directory ────────────────────────────────────────────────────────────────

function dirValue(v) {
  return v?.label || (typeof v === 'string' ? v : '') || '—';
}

async function loadDirectory() {
  const el = $('#wh-directory-list');
  const gen = state.generation;
  try {
    const res = await api('/api/employees');
    if (gen !== state.generation) return;
    if (!res.employees.length) {
      el.innerHTML = '<div class="wh-empty-state">No employees yet.</div>';
      return;
    }
    const rows = res.employees.map((emp) => {
      const name = emp.displayName || `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
      const isNew = state.hiredThisSession.has(String(emp.id));
      return { emp, name, isNew };
    });

    el.innerHTML = `
      <table class="dir-table">
        <thead><tr><th>Name</th><th>Title</th><th>Department</th><th>Email</th><th>Location</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ({ emp, name, isNew }) => `
              <tr>
                <td><span class="dir-person">${avatar(name)}<span class="dir-name">${esc(name)}</span>${isNew ? '<span class="tag-new">New</span>' : ''}</span></td>
                <td>${esc(dirValue(emp.jobTitle))}</td>
                <td>${esc(dirValue(emp.department))}</td>
                <td>${esc(emp.workEmail || '—')}</td>
                <td>${esc(dirValue(emp.location))}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div class="dir-cards">
        ${rows
          .map(
            ({ emp, name, isNew }) => `
            <div class="dir-card">
              ${avatar(name)}
              <div class="dir-card-body">
                <div class="dir-card-name">${esc(name)}${isNew ? '<span class="tag-new">New</span>' : ''}</div>
                <div class="dir-card-sub">${esc([dirValue(emp.jobTitle), dirValue(emp.department)].filter((x) => x !== '—').join(' · ') || dirValue(emp.workEmail))}</div>
              </div>
            </div>`
          )
          .join('')}
      </div>`;
  } catch (err) {
    if (gen !== state.generation) return;
    el.innerHTML = `<div class="wh-empty-state">Could not load directory: ${esc(err.message)}</div>`;
  }
}

$('#wh-refresh-directory').addEventListener('click', loadDirectory);

// ── Sync ─────────────────────────────────────────────────────────────────────
// Pulls candidates and the employee directory from BambooHR, only when asked.

$('#wh-sync-btn').addEventListener('click', async () => {
  const btn = $('#wh-sync-btn');
  const label = btn.querySelector('.sync-label');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.remove('is-done');
  btn.classList.add('is-syncing');
  label.textContent = 'Syncing';
  try {
    await loadSaved();
    await loadStages();
    const pulled = await loadCandidates();
    await loadDirectory();
    btn.classList.remove('is-syncing');
    btn.classList.add('is-done');
    label.textContent = 'Synced';
    toast(pulled === 1 ? '1 candidate synced from BambooHR' : `${pulled} candidates synced from BambooHR`);
    setTimeout(() => {
      btn.classList.remove('is-done');
      label.textContent = 'Sync';
    }, 2200);
  } catch (err) {
    btn.classList.remove('is-syncing');
    label.textContent = 'Sync';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// WPI Hire's Offline badge: this site's header says so on every page, this
// one included, and every button that would fail is dimmed while it does.

// ── Installed app ────────────────────────────────────────────────────────────

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// The service worker is this site's (public/sw.js), registered by the site.

// Reopening the app should show current numbers. Only the app's own saved
// records are re-read — BambooHR is still only ever pulled by pressing Sync.
// And while the page is open, every 30 seconds, as the rest of the site does:
// a hire who signs while you watch appears without a reload.
async function lookAgain() {
  if (document.hidden || !state.active) return;
  await loadSaved();
  renderStats();
  renderBoard();
  renderSigned();
}
document.addEventListener('visibilitychange', lookAgain);
let pollTimer = null;

// iOS Safari has no install prompt API, so the steps are spelled out instead.
const INSTALL_DISMISSED_KEY = 'hhqInstallHintDismissed';

$('#wh-install-dismiss').addEventListener('click', () => {
  $('#wh-install-hint').hidden = true;
  cacheSet(INSTALL_DISMISSED_KEY, true);
});

function maybeOfferInstall() {
  if (isStandalone || cacheGet(INSTALL_DISMISSED_KEY, false)) return;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(ua);
  if (!iOS || !safari) return;
  setTimeout(() => { $('#wh-install-hint').hidden = false; }, 1400);
}

// ── Signed paperwork ─────────────────────────────────────────────────────────
// Every completed packet, newest first: who signed, when, from where, and the
// signed copies themselves — kept encrypted on the server, each with the
// SHA-256 fingerprint it had the moment it was signed, so a copy can always
// be checked against the record.

const DOC_ICON = ICONS.file;
const HEALTH = { interested: 'Interested — send details', declined: 'Declined' };

function signedItem(h) {
  const name = `${h.firstName || ''} ${h.lastName || ''}`.trim() || h.email || 'New hire';
  const open = state.openSigned === h.reference;
  const when = h.signedAt ? new Date(h.signedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : h.signedDate || '';
  const audit = h.audit || {};
  const files = Array.isArray(h.files) ? h.files : [];
  const docs = files.length
    ? files.map((f) => {
        const url = `/api/onboarding/hires/${encodeURIComponent(h.reference)}/files/${encodeURIComponent(f.key)}`;
        return `
          <div class="signed-doc">
            <div class="signed-doc-top">
              <span class="signed-doc-title">${esc(f.title)}</span>
              <span class="signed-doc-actions">${f.stored === false ? '<span class="signed-missing">Emailed only</span>' : `<a href="${url}" target="_blank" rel="noopener">Open</a><a href="${url}?download=1" download="${escAttr(f.filename)}">Download</a>`}</span>
            </div>
            <div class="signed-hash" title="SHA-256 of the signed file">SHA-256 ${esc(f.sha256 || '')}</div>
          </div>`;
      }).join('')
    : (h.documents || []).map((t) => `<div class="signed-doc"><div class="signed-doc-top"><span class="signed-doc-title">${esc(t)}</span><span class="signed-missing">Emailed</span></div></div>`).join('');
  const rows = [
    ['Reference', h.reference],
    ['Signed', `${h.signedDate || ''}${audit.time ? ` at ${audit.time}` : ''}`.trim()],
    ['IP address', audit.ip],
    ['Location', audit.location],
    ['Device', audit.userAgent],
    ['Consent', audit.consent ? 'Agreed to sign electronically (ESIGN / UETA)' : ''],
    ['Email', h.email],
    ['Phone', h.phone],
    ['Health Sharing', HEALTH[h.healthElection] || ''],
    ['Delivered to', h.delivered ? h.deliveredTo || 'your inbox' : 'Not emailed — email was not set up'],
  ].filter(([, v]) => v);
  return `
    <div class="signed-item${open ? ' open' : ''}" data-ref="${escAttr(h.reference)}">
      <button type="button" class="signed-head" aria-expanded="${open}">
        ${avatar(name)}
        <span class="signed-who">
          <span class="signed-name">${esc(name)}</span>
          <span class="signed-sub">${esc([when, h.reference].filter(Boolean).join(' · '))}</span>
        </span>
        <svg class="signed-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${open ? `
      <div class="signed-body">
        <p class="signed-group">Signed documents</p>
        <div class="signed-docs">${docs}</div>
        <p class="signed-group">Signing record</p>
        <dl class="audit-list">${rows.map(([k, v]) => `<div class="audit-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="signed-foot"><button type="button" class="wh-btn wh-btn-ghost wh-btn-sm signed-remove">Remove from list</button></div>
      </div>` : ''}
    </div>`;
}
void DOC_ICON;

function renderSigned() {
  const el = $('#wh-signed-list');
  const list = state.completedHires || [];
  if (!list.length) {
    el.innerHTML = '<p class="signed-empty">Nobody has signed yet. Completed packets appear here the moment they come back.</p>';
    return;
  }
  el.innerHTML = list.slice(0, 50).map(signedItem).join('');
}

$('#wh-signed-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.signed-item');
  if (!item) return;
  if (e.target.closest('.signed-head')) {
    state.openSigned = state.openSigned === item.dataset.ref ? '' : item.dataset.ref;
    renderSigned();
    return;
  }
  if (e.target.closest('.signed-remove')) {
    const h = state.completedHires.find((x) => x.reference === item.dataset.ref);
    if (!h) return;
    const name = `${h.firstName || ''} ${h.lastName || ''}`.trim() || h.email;
    if (!confirm(`Remove ${name}'s signed paperwork (${h.reference}) from this list? The stored copies are deleted too. Copies already emailed, or filed in BambooHR, are not affected.`)) return;
    try {
      await api(`/api/hires/${encodeURIComponent(h.reference)}`, { method: 'DELETE' });
      state.completedHires = state.completedHires.filter((x) => x.reference !== h.reference);
      state.openSigned = '';
      renderSigned();
      renderStats();
      renderBoard();
      host.changed();
      toast('Removed from Signed paperwork');
    } catch (err) {
      toast(err.message, true);
    }
  }
});

// From a candidate card's "Paperwork signed" line: to their record.
function openSignedFor(email) {
  const key = emailKey(email);
  const h = state.completedHires
    .filter((x) => emailKey(x.email) === key)
    .sort((a, b) => String(b.signedAt || '').localeCompare(String(a.signedAt || '')))[0];
  if (!h) return;
  state.openSigned = h.reference;
  showTab('onboarding', { scroll: false });
  renderSigned();
  requestAnimationFrame(() => {
    const el = $('#wh-signed-list').querySelector(`.signed-item[data-ref="${CSS.escape(h.reference)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// ── Settings → Onboarding docs ───────────────────────────────────────────────
// What WPI Hire read from its environment, set on the site's Settings page and
// kept for the team. Saved by that page's Save settings button, with the rest.

const SETTING_INPUTS = {
  bambooSubdomain: '#onbBambooSubdomain',
  companyName: '#onbCompanyName',
  companyAddress: '#onbCompanyAddress',
  companyEin: '#onbCompanyEin',
  hrName: '#onbHrName',
  hrEmail: '#onbHrEmail',
  paperworkInbox: '#onbPaperworkInbox',
  ccEmail: '#onbCcEmail',
  timezone: '#onbTimezone',
};
let settingsDirty = false;
let clearApiKey = false;
let settingsFor = null;
const keyInput = $('#onbBambooApiKey');

[...Object.values(SETTING_INPUTS), '#onbBambooApiKey'].forEach((sel) =>
  $(sel).addEventListener('input', () => { settingsDirty = true; })
);
$('#onbBambooClear').addEventListener('click', () => {
  clearApiKey = true;
  keyInput.value = '';
  keyInput.placeholder = 'Removed when you save';
  $('#onbBambooClear').hidden = true;
  settingsDirty = true;
  // The page's Save settings button marks itself as having something to save.
  keyInput.dispatchEvent(new Event('input', { bubbles: true }));
});

function renderSettingsCard(s) {
  const set = s.settings || {};
  const eff = set.effective || {};
  for (const [k, sel] of Object.entries(SETTING_INPUTS)) {
    const el = $(sel);
    if (!settingsDirty && document.activeElement !== el) el.value = set[k] || '';
    // What applies when the field is left empty.
    if (eff[k] && !set[k]) el.placeholder = eff[k];
  }
  if (!eff.paperworkInbox) $('#onbPaperworkInbox').placeholder = s.email && s.email.from ? `${s.email.from} (your sending account)` : 'your sending account';
  if (!eff.ccEmail && !eff.hrEmail) $('#onbCcEmail').placeholder = 'the HR email, if set';
  if (!settingsDirty) {
    keyInput.value = '';
    clearApiKey = false;
    keyInput.placeholder = set.bambooApiKeySet
      ? `Saved (${set.bambooApiKeyHint})${set.bambooFromEnv ? ' from the server’s settings' : ''} — type a new one to replace it`
      : 'BambooHR → your avatar → API Keys';
    $('#onbBambooClear').hidden = !set.bambooApiKeySet || set.bambooFromEnv;
  }
  const badge = $('#onbModeBadge');
  badge.textContent = s.mode === 'live' ? `BambooHR: ${s.subdomain}` : 'Sample data';
  badge.className = `badge ${s.mode === 'live' ? 'tint-green' : 'tint-navy'}`;
  $('#onbBambooHint').textContent = s.mode === 'live'
    ? `Connected to ${s.subdomain}.bamboohr.com. Sync pulls candidates and the directory from it; hires and signed paperwork are filed on the employee's record.`
    : 'Without BambooHR the page runs on sample data, as WPI Hire did — adding hires, sending packets and signing all still work.';
}

async function loadSettingsCard() {
  const teamAtStart = state.teamId;
  try {
    const s = await api('/api/status');
    if (teamAtStart !== state.teamId) return;
    settingsFor = teamAtStart;
    renderSettingsCard(s);
  } catch {
    $('#onbModeBadge').textContent = 'unavailable';
  }
}

async function saveSettings() {
  if (!settingsDirty) return null;
  const body = {};
  for (const [k, sel] of Object.entries(SETTING_INPUTS)) body[k] = $(sel).value.trim();
  if (keyInput.value.trim()) body.bambooApiKey = keyInput.value.trim();
  else if (clearApiKey) body.clearBambooApiKey = true;
  const r = await api('/api/settings', { method: 'PUT', body });
  settingsDirty = false;
  clearApiKey = false;
  await loadSettingsCard();
  if (state.booted) loadStatus().catch(() => {});
  return r;
}

// ── For the rest of the site ─────────────────────────────────────────────────

// From the Candidates page: someone onto the pipeline (once — by email), and
// the page opened on their card, ready to send their packet.
async function addFromCrm(c) {
  const r = await api('/api/from-crm', { method: 'POST', body: { id: c.id } });
  host.show('onboarding');
  showTab('pipeline', { scroll: false });
  await loadSaved();
  renderStats();
  renderBoard();
  requestAnimationFrame(() => {
    const card = document.querySelector(`.candidate-card[data-id="${CSS.escape(String(r.id))}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('wh-flash');
    void card.offsetWidth;
    card.classList.add('wh-flash');
  });
  return r;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

// Show cached records immediately, then reconcile with the server. Run the
// first time the page is opened, and again after a change of team.
async function boot() {
  state.booted = true;
  state.localCandidates = loadLocalCandidates();
  state.overrides = cacheGet(OVERRIDES_KEY, {}) || {};
  renderStats();
  renderBoard();
  renderSigned();
  const gen = state.generation;
  await loadSaved();
  if (gen !== state.generation) return;
  loadStatus().catch((e) => toast(e.message, true));
  // Stage metadata only — candidates and the directory are pulled from
  // BambooHR when Sync is pressed, never on their own.
  loadStages().then(renderBoard).catch(() => {});
  loadDocuments().catch((e) => toast(e.message, true));
  renderStats();
  renderBoard();
  renderSigned();
}

const POLL_MS = 30 * 1000;

function tabFromAddress() {
  const m = location.hash.match(/[?&]tab=([a-z]+)/);
  return m && TABS.includes(m[1]) ? m[1] : '';
}

function activate() {
  if (state.active) return;
  state.active = true;
  showTab(tabFromAddress() || state.tab, { scroll: false });
  if (!state.booted) boot().catch((e) => toast(e.message, true));
  else lookAgain().catch(() => {});
  clearInterval(pollTimer);
  pollTimer = setInterval(() => lookAgain().catch(() => {}), POLL_MS);
}

function deactivate() {
  state.active = false;
  clearInterval(pollTimer);
  pollTimer = null;
}

// Is something half-done here that a reload would throw away?
function busy() {
  const open = (sel) => { const el = $(sel); return el && !el.hidden; };
  return open('#wh-add-hire-panel') || open('#wh-upload-review')
    || [...document.querySelectorAll('#wph .edit-form')].some((f) => !f.hidden)
    || Boolean($('#wh-send-packet-btn').disabled);
}

// Signed in to another team, or signed out: nothing of the last team's stays
// on screen — records, forms, results, the directory — and an answer still on
// its way for it is dropped. `signedIn` says whether there is a team to look
// again for.
function reset(signedIn, teamId) {
  const wasActive = state.active;
  deactivate();
  state.generation++;
  state.teamId = teamId || '';
  Object.assign(state, {
    statuses: [], candidates: [], localCandidates: [], overrides: {}, storage: null, documents: [],
    hiredStatusId: null, sends: {}, completedHires: [], synced: false, booted: false, openSigned: '', status: null,
  });
  state.hiredThisSession = new Set();
  ['#wh-add-hire-form', '#wh-upload-review', '#wh-hire-form', '#wh-packet-form'].forEach((sel) => $(sel).reset());
  ['#wh-add-hire-panel', '#wh-upload-panel', '#wh-upload-review', '#wh-hire-context', '#wh-packet-result'].forEach((sel) => { $(sel).hidden = true; });
  $('#wh-doc-list').innerHTML = '';
  $('#wh-email-test-result').textContent = '';
  $('#wh-email-badge').hidden = true;
  $('#wh-directory-list').innerHTML = '<div class="wh-empty-state">Press Refresh to load the directory from BambooHR.</div>';
  $('#wh-pipeline-stats').hidden = true;
  $('#wh-pipeline-board').innerHTML = '<div class="wh-empty-state" id="wh-pipeline-loading">Loading candidates…</div>';
  $('#wh-signed-list').innerHTML = '<p class="signed-empty">Loading…</p>';
  // The settings card is this team's too.
  settingsDirty = false;
  clearApiKey = false;
  settingsFor = null;
  Object.values(SETTING_INPUTS).forEach((sel) => { $(sel).value = ''; });
  keyInput.value = '';
  if (wasActive && signedIn) activate();
}

// From the Candidates page, for someone who has signed: their record.
async function openSigned(email) {
  host.show('onboarding');
  await loadSaved();
  renderStats();
  renderBoard();
  openSignedFor(email);
}

window.Onboarding = {
  activate, deactivate, reset, busy, addFromCrm, openSigned,
  loadSettingsCard, saveSettings,
  settingsDirty: () => settingsDirty,
  settingsFor: () => settingsFor,
  connect(hooks) { Object.assign(host, hooks); },
};

maybeOfferInstall();
})();
