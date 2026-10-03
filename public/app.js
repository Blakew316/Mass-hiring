/* Wholesale Payments · Hiring CRM — frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let state = null;            // last /api/state payload
  // The team this browser is signed into. Declared up here because the very
  // first thing this file does is read a per-team preference back out of
  // localStorage, and teamKey() needs somewhere to look.
  let currentTeam = null;      // { id, name, usesAppPassword }
  let selected = new Set();    // selected candidate ids
  let filter = 'all';
  let search = '';
  let roleFilter = '';          // exact current role someone holds, '' = every role
  let sortBy = 'default';       // 'texting' = the order to work down at 60/day
  let industryFilter = '';
  let addedFilter = '';
  let textedFilter = '';
  let rankFilter = '';
  let iqFilter = '';            // where they are with Sales IQ (see IQ_FILTERS)
  let onbFilter = '';           // and with Onboarding docs (ONB_FILTERS)
  let feedChannel = readFeedChannel();  // 'all' | 'email' | 'text'
  // 3,500 rows rendered at once is a 400,000-pixel page and the reason the
  // list felt like everything at once. A page at a time, like any CRM.
  const PAGE_SIZE = 50;
  let page = 0;
  let lastFilterSig = '';
  let pageRows = [];           // what is actually on screen right now
  let pendingImport = null;    // {headers, rows, mapping, source}
  let composeIds = [];

  // At 33,000 people every list and count drawn from the candidates is worth
  // keeping rather than working out again on every render, and a kept answer
  // is only as good as what it is keyed on. The rule: listVersion goes up
  // whenever anything in state.candidates may have changed — a new state, a
  // conversation read here, a status picked here and its revert, signing out
  // or changing team — and stateVersion goes up with every new state and on
  // signing out or changing team. Whatever is kept keys on the version it
  // reads, plus the identity of any other part of the state it reads
  // (state.salesiq, state.onboarding, state.texting.priority). A bump too
  // many only costs a rebuild; a missing one shows a list that is out of
  // date, so anything that changes a candidate in place bumps.
  let listVersion = 0;
  let stateVersion = 0;
  const bumpList = () => { listVersion += 1; };

  // Whatever is kept holds on to the copy of the list it was made from (its
  // keys name it, and its rows are that copy's people), and one copy of
  // 33,000 people is tens of megabytes. Kept until next asked for, the
  // answers of a page last drawn an hour ago kept that hour-old copy alive
  // beside the current one — a copy for each page visited between polls,
  // five times the memory a phone needed before, and every collection of it
  // slower. A new state puts every kept answer out of date anyway (both
  // versions move), so each new state, and signing out, lets go of them all:
  // forgetKept(). Anything kept outside kept() registers here how to let go.
  const forgetters = [];
  const forgetWithState = (fn) => { forgetters.push(fn); };
  function forgetKept() { for (const fn of forgetters) fn(); }

  // A value worked out from the state, kept until one of its keys changes.
  // `keysOf` names what it depends on (versions, side objects, a query); the
  // keys are compared one by one, by identity.
  function kept(keysOf, build) {
    let keys = null;
    let value;
    forgetWithState(() => { keys = null; value = undefined; });
    return () => {
      const now = keysOf();
      if (!keys || now.length !== keys.length || now.some((k, i) => k !== keys[i])) {
        value = build();
        keys = now;
      }
      return value;
    };
  }

  // Date.prototype.toLocale*String builds a new Intl.DateTimeFormat on every
  // call, which is nearly all it costs; the minute tick, a page of rows and a
  // conversation each ask for dozens. One formatter per set of options
  // instead, made the first time it is used, giving the same answer for a
  // date that is not one ("Invalid Date") as toLocaleString does.
  function dateFormat(locales, options) {
    let f = null;
    return (when) => {
      const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
      if (!Number.isFinite(t)) return 'Invalid Date';
      if (!f) f = new Intl.DateTimeFormat(locales, options);
      return f.format(t);
    };
  }
  const clockTime = dateFormat([], { hour: 'numeric', minute: '2-digit' });
  const weekdayShort = dateFormat([], { weekday: 'short' });
  const monthDay = dateFormat([], { month: 'short', day: 'numeric' });
  // What toLocaleString() with no options writes: the date and the time.
  const fullStamp = dateFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });

  const STATUS = {
    new:      { label: 'Not contacted', cls: 'tint-navy' },
    emailed:  { label: 'Emailed',       cls: 'tint-blue' },
    replied:  { label: 'Replied',       cls: 'tint-mint' },
    booked:   { label: 'Booked',        cls: 'tint-green' },
    declined: { label: 'Not interested',cls: 'tint-red' },
    bounced:  { label: 'Bounced',       cls: 'tint-amber' },
  };
  const AVATAR_TINTS = ['tint-blue', 'tint-green', 'tint-mint', 'tint-navy'];
  // A candidate's status: a real <select>, so the phone shows its own picker.
  // On a phone the select is laid invisibly over a compact pill (.status-face)
  // — a select has to be 16px there or iOS zooms the page, and at 16px it was
  // the widest thing on the card, squeezing the name down to one letter.
  function statusControl(c, extra = '') {
    const st = STATUS[c.status] || STATUS.new;
    return `<span class="status-ctl"><span class="status-face m-only ${st.cls}" aria-hidden="true">${st.label}</span>`
      + `<select class="status-select ${st.cls}${extra ? ` ${extra}` : ''}" data-id="${c.id}" title="Change status" aria-label="Status of ${esc(c.name || c.email || 'this candidate')}">`
      + Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v.label}</option>`).join('')
      + '</select></span>';
  }
  // The pill says what was picked straight away, before the save comes back.
  document.addEventListener('change', (e) => {
    const sel = e.target;
    if (!sel.classList || !sel.classList.contains('status-select')) return;
    const face = sel.parentElement && sel.parentElement.querySelector('.status-face');
    const st = STATUS[sel.value];
    if (face && st) { face.textContent = st.label; face.className = `status-face m-only ${st.cls}`; }
  }, true);
  // Where someone stands in the TEXT funnel, which runs alongside the email one.
  // "Delivered" and "Read" are receipts from iMessage itself — email has no
  // equivalent, so these are the one place texting tells you more than email.
  const TEXT_STATUS = {
    sent:           { label: 'Sent',          cls: 'is-sent' },
    delivered:      { label: 'Delivered',     cls: 'is-delivered' },
    read:           { label: 'Read',          cls: 'is-read' },
    replied:        { label: 'Replied',       cls: 'is-replied' },
    failed:         { label: 'Failed',        cls: 'is-failed' },
    'not-imessage': { label: 'No iMessage',   cls: 'is-none' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Where this browser files something of its own for the team it is signed
  // into. Not a security boundary — the server decides what you may see — but
  // it keeps one team's remembered filters and paid-for Apollo ids from
  // turning up in another team's session on a shared device.
  function teamKey(name) {
    return `${name}::${currentTeam ? currentTeam.id : ''}`;
  }

  // ---------------- API ----------------
  // Errors carry whatever extra fields the server sent, so a caller can tell
  // "your plan blocks this" apart from "that went wrong".
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.auth) {
      showLogin();
      throw new Error('Please sign in.');
    }
    if (res.status === 403 && data.setupRequired) {
      $('#setupScreen').hidden = false;
      throw new Error('Set APP_PASSWORD first.');
    }
    if (!res.ok) {
      // Keep whatever else the server said on the error, so a caller can tell
      // a blocked plan apart from something having gone wrong.
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      for (const [k, v] of Object.entries(data)) if (k !== 'error' && k !== 'message') err[k] = v;
      throw err;
    }
    return data;
  }

  // ---------------- Teams and signing in ----------------
  // Everything the server sends back belongs to one team. The few things this
  // browser remembers by itself are filed under that team too, so a device
  // that signs out of one and into another is not left looking at the first
  // one's leftovers.
  let knownTeams = [];         // [{ id, name }] — what the picker offers
  // Whether every team signs in with a four-digit PIN. False while any of them
  // still signs in with the admin password, which is not four digits — capping
  // the field then would lock that team's own owner out. It says nothing about
  // WHICH team, only about the list as a whole.
  let numericPins = false;
  // The timers outlive a sign-out, so they ask before doing anything: a phone
  // left on the sign-in screen overnight must not spend the night polling as
  // a signed-out user.
  let signedIn = false;
  // Whether there is a sign-in to be signed out OF. Without a password there
  // is exactly one team and no way to reach another, so the switch-team
  // control would only ever put up a screen you cannot get past.
  let authRequired = false;
  let pickedTeamId = '';       // the chip currently chosen on the sign-in screen

  const LAST_TEAM_KEY = 'lastTeam';
  // Whether this browser was signed in when it last looked. index.html asks
  // for the state and the list before anything else only when it was: a
  // signed-out page would be told 401 twice for nothing, and the list can be
  // megabytes. Only a hint — the server decides, and a stale one costs two
  // refusals, once.
  const SIGNED_IN_KEY = 'wp-signed-in';
  function signedInHint(on) {
    try { if (on) localStorage.setItem(SIGNED_IN_KEY, '1'); else localStorage.removeItem(SIGNED_IN_KEY); } catch { /* no storage: no early asking */ }
  }
  // Another admin may have made or renamed a team since this page loaded, and
  // the delete list has to mean something. Refreshed when Settings is looked
  // at, not on the 30-second poll, which must stay one request.
  let teamsRefreshedAt = 0;
  const lastTeam = () => { try { return localStorage.getItem(LAST_TEAM_KEY) || ''; } catch { return ''; } };

  function setTeam(team) {
    const previous = currentTeam && currentTeam.id;
    const changed = previous !== (team && team.id);
    currentTeam = team || null;
    signedInHint(Boolean(currentTeam));
    // Nothing kept from one team's list may answer for another's.
    if (changed) { listVersion += 1; stateVersion += 1; }
    if (currentTeam) { try { localStorage.setItem(LAST_TEAM_KEY, currentTeam.id); } catch {} }
    // Anything kept per team has to be re-read when the team changes, or the
    // new team inherits the old one's view of things.
    if (changed) feedChannel = readFeedChannel();
    // What the bell has rung for and what was read here are the old team's:
    // the new team's unread is new to this screen, not news to ring about.
    if (changed) { try { resetUnreadMemory(); } catch { /* not declared yet: nothing kept */ } }
    // The Sales IQ card holds a live secret and a Disconnect button. A session
    // that lapses and signs in to another team never goes through signedOut(),
    // and until the new team's answer arrives — or for good, if it fails — the
    // card would offer the last team's code to copy and send Disconnect under
    // this team's session.
    if (changed) { try { clearSalesiq(); } catch { /* not declared yet: nothing shown */ } }
    // And the Sales IQ page, whose list is this team's and nobody else's —
    // once there was a team before this one: the first sign-in has nothing
    // to clear away, and a report link it was opened with must survive it.
    if (changed && previous && window.SalesIQ) window.SalesIQ.reset(Boolean(currentTeam));
    // The Onboarding docs page likewise — and it is told which team it now
    // belongs to even the first time, since it keeps a copy of its records in
    // this browser under the team's name.
    if (changed && window.Onboarding) window.Onboarding.reset(Boolean(currentTeam), currentTeam ? currentTeam.id : '');
    renderTeamChip();
  }

  function renderTeamChip() {
    const chip = $('#teamChip');
    if (chip) {
      chip.hidden = !currentTeam;
      if (currentTeam) $('#teamChipName').textContent = currentTeam.name;
    }
    // On a phone the sidebar is a tab bar and its foot is not on screen, so
    // the chip above would only ever be visible on Settings. The one question
    // this app must never leave unanswered is which team's 3,514 people you
    // are about to email, so the answer rides in the header of every page,
    // beside the bell and the theme switch — and is itself the way out.
    $$('.head-team').forEach((b) => {
      b.hidden = !(currentTeam && authRequired);
      if (!currentTeam) return;
      // In a page header, beside a title, what distinguishes one team from
      // another is the name — "Maverick", "Ranger" — not the word "Team" they
      // all share. Dropping it is what lets the whole answer fit on a phone
      // instead of being cut to "Team M…", which answers nothing.
      b.querySelector('.head-team-name').textContent = currentTeam.name.replace(/^team\s+/i, '') || currentTeam.name;
      b.title = `${currentTeam.name} — tap to switch team`;
    });
  }

  function mountTeam() {
    // Under the page title, not in the row of controls beside it. A large iOS
    // title and three controls do not both fit across a phone, and what gave
    // way was the title — "Dashboa" is not a heading. A caption under the
    // heading is the shape this belongs in anyway: it says where you are,
    // right where the page says what you are looking at.
    $$('.page-head > div:first-child').forEach((row) => {
      if (row.querySelector('.head-team')) return;
      const b = document.createElement('button');
      b.className = 'head-team';
      b.type = 'button';
      b.hidden = true;
      b.title = 'Switch team';
      b.innerHTML = `${icon('users', 14)}<span class="head-team-name"></span>`;
      b.addEventListener('click', async () => {
        if (!confirm(`Leave ${currentTeam ? currentTeam.name : 'this team'} and sign in to another?`)) return;
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        signedOut();
      });
      row.appendChild(b);
    });
  }

  async function loadTeams() {
    const r = await api('/api/teams');
    knownTeams = r.teams || [];
    numericPins = Boolean(r.numericPins);
    renderTeamPicker();
    return knownTeams;
  }

  // A number pad instead of a keyboard, and no room for a fifth digit — but
  // only once there is nothing left to sign in with except four digits.
  function applyPinField() {
    const el = $('#loginPassword');
    if (numericPins) {
      el.setAttribute('inputmode', 'numeric');
      el.setAttribute('pattern', '[0-9]*');
      el.setAttribute('maxlength', '4');
      el.classList.add('pin-field');
    } else {
      el.removeAttribute('inputmode');
      el.removeAttribute('pattern');
      el.removeAttribute('maxlength');
      el.classList.remove('pin-field');
    }
  }

  function renderTeamPicker() {
    const wrap = $('#teamPicker');
    if (!wrap) return;
    if (!knownTeams.length) {
      wrap.hidden = true;
      $('#loginIntro').textContent = 'No teams yet — start the first one below.';
      return;
    }
    if (!knownTeams.some((t) => t.id === pickedTeamId)) {
      const remembered = lastTeam();
      pickedTeamId = knownTeams.some((t) => t.id === remembered) ? remembered : knownTeams[0].id;
    }
    // One team is not a choice, so it is not offered as one — the screen stays
    // exactly as simple as it was before teams existed.
    const many = knownTeams.length > 1;
    wrap.hidden = !many;
    applyPinField();
    $('#loginIntro').textContent = many
      ? 'Choose your team, then enter its PIN.'
      : `Enter the PIN for ${knownTeams[0].name}.`;
    if (many) {
      wrap.innerHTML = knownTeams.map((t) =>
        `<button type="button" class="team-option" role="radio" data-team="${esc(t.id)}" aria-checked="${t.id === pickedTeamId}">${esc(t.name)}</button>`).join('');
    }
  }

  function showLogin() {
    stateTag = '';
    dropEarly();
    signedInHint(false);
    // The Sales IQ page stops looking, and puts away any sheet it had open:
    // its sheets sit above everything, the sign-in screen included.
    if (window.SalesIQ) window.SalesIQ.deactivate();
    if (window.Onboarding) window.Onboarding.deactivate();
    $('#loginScreen').hidden = false;
    $('#newTeamForm').hidden = true;
    $('#loginForm').hidden = false;
    loadTeams().catch(() => renderTeamPicker());
    setTimeout(() => $('#loginPassword').focus(), 50);
  }

  async function enterApp(team) {
    setTeam(team);
    stateTag = '';
    signedIn = true;
    $('#loginScreen').hidden = true;
    await refresh();
    start();
    takeUpdate('launch');
  }

  $('#teamPicker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    pickedTeamId = b.dataset.team;
    renderTeamPicker();
    $('#loginPassword').focus();
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { team: pickedTeamId, pin: $('#loginPassword').value } });
      $('#loginPassword').value = '';
      await enterApp(r.team);
    } catch (err) {
      $('#loginError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#newTeamLink').addEventListener('click', () => {
    $('#loginForm').hidden = true;
    $('#newTeamForm').hidden = false;
    $('#newTeamError').textContent = '';
    setTimeout(() => $('#newTeamName').focus(), 50);
  });

  $('#backToLogin').addEventListener('click', () => {
    $('#newTeamForm').hidden = true;
    $('#loginForm').hidden = false;
    setTimeout(() => $('#loginPassword').focus(), 50);
  });

  $('#newTeamForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#newTeamError');
    err.textContent = '';
    if ($('#newTeamPin').value !== $('#newTeamPin2').value) {
      err.textContent = 'Those two PINs are not the same.';
      return;
    }
    const btn = $('#newTeamBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/teams/create', {
        method: 'POST',
        body: { name: $('#newTeamName').value, pin: $('#newTeamPin').value, adminPassword: $('#newTeamAdmin').value },
      });
      ['#newTeamName', '#newTeamPin', '#newTeamPin2', '#newTeamAdmin'].forEach((sel) => { $(sel).value = ''; });
      await loadTeams().catch(() => {});
      if (r.signedIn) { await enterApp(r.team); return; }
      pickedTeamId = r.team.id;
      renderTeamPicker();
      $('#newTeamForm').hidden = true;
      $('#loginForm').hidden = false;
      $('#loginError').textContent = `${r.team.name} is ready — sign in with its PIN.`;
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
    }
  });

  // Everything the page is holding about the team you were in. A candidate id
  // is only meaningful inside one team, and renderAll() replays the open
  // thread — so without this the first thing a new team sees is an error about
  // somebody else's candidate.
  function resetClientState() {
    state = null;
    stateTag = '';
    listVersion += 1;
    stateVersion += 1;
    forgetKept();
    appliedAskedAt = 0;
    // The kept copy of the list, and what this page laid over it, are the
    // team's being left.
    dropList();
    overlays.clear();
    wantOrder = false;
    verifyWait = VERIFY_MS;
    selected = new Set();
    filter = 'all';
    search = '';
    roleFilter = '';
    sortBy = 'default';
    industryFilter = '';
    addedFilter = '';
    textedFilter = '';
    rankFilter = '';
    iqFilter = '';
    onbFilter = '';
    page = 0;
    pageRows = [];
    lastFilterSig = '';
    pendingImport = null;
    composeIds = [];
    openThreadId = null;
    openMailId = null;
    threadLoading = false;
    mailLoading = false;
    thread = null;
    mail = null;
    mailShownSig = '';
    // On a laptop each conversation column shows beside its list the whole
    // time, so the last conversation opened — its messages, the name over
    // them and a reply box addressed to that person — stayed on screen into
    // the next team's session. Put them away with everything else.
    $('#threadLive').hidden = true;
    $('#threadEmpty').hidden = false;
    $('#mailLive').hidden = true;
    $('#mailEmpty').hidden = false;
    for (const sel of ['#threadBody', '#threadName', '#threadSub', '#threadAvatar', '#threadNative', '#threadNote',
      '#mailBody', '#mailName', '#mailSub', '#mailAvatar', '#mailNative', '#mailNote']) {
      const el = $(sel);
      if (el) el.innerHTML = '';
    }
    $('#threadInput').value = '';
    $('#mailInput').value = '';
    $('#mailGmail').hidden = true;
    try { syncThreadStack(false); } catch { /* not declared yet: nothing open */ }
    try { resetUnreadMemory(); } catch { /* not declared yet: nothing kept */ }
    // Status changes still waiting on the server belong to the old team, and
    // so does a refresh that was about to go out for them.
    try { pendingStatus.clear(); clearTimeout(soonTimer); soonTimer = 0; } catch { /* not declared yet: nothing waiting */ }
    for (const k of Object.keys(thumbs)) delete thumbs[k];
    for (const k of Object.keys(scrollMemory)) delete scrollMemory[k];
    // Unsaved edits and the template shown belong to the team they were made
    // in: carried into the next team, pressing Save would write them there.
    try {
      presetShown.email = ''; presetShown.text = '';
      presetDraft.email = null; presetDraft.text = null;
      setTemplateDirty(false); setFollowUpDirty(false); setPresetDirty('text', false); setSettingsDirty(false);
      clearSalesiq();
    } catch { /* not declared yet: nothing to reset */ }
  }

  function signedOut() {
    signedIn = false;
    resetClientState();
    // Nothing unread belongs on the icon of an app nobody is signed in to.
    try { renderAppBadge(); } catch { /* not declared yet: nothing shown */ }
    setTeam(null);
    showLogin();
  }

  $('#signOutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    signedOut();
  });

  // Persistence / security warnings that must not be missable.
  function renderNotices() {
    const n = [];
    // Put away with its ×, it stays away for this version: the app still
    // moves to it by itself the next time you come back to it.
    if (updateReady && updateDismissed !== updateReady) {
      n.push(`<div class="notice ok"><span class="notice-ico">${icon('download', 16)}</span><div><strong>A new version is ready.</strong> It installs by itself the next time you open the app, or reload now.</div><button class="btn btn-sm notice-action" id="reloadForUpdate">Reload</button><button type="button" class="notice-x" id="dismissUpdate" aria-label="Not now" title="Not now">${icon('x', 14)}</button></div>`);
    }
    if (state.storage && !state.storage.persistent) {
      n.push(`<div class="notice danger"><span class="notice-ico">${icon('alert', 16)}</span><div><strong>Your data is not being saved permanently.</strong> Netlify Blobs is unavailable${state.storage.error ? ` (${esc(state.storage.error)})` : ''}, so settings and candidates will be lost on the next deploy or restart. Check that Blobs is enabled for this site in Netlify, then redeploy.</div></div>`);
    }
    if (state.storage && state.storage.deployed && state.auth && !state.auth.required) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('lock', 16)}</span><div><strong>This dashboard is public.</strong> Anyone with the URL could send email from your account. Add an environment variable named <code>APP_PASSWORD</code> in Netlify (Project configuration → Environment variables), then redeploy. That is the admin password — it locks the dashboard and is what lets you create and delete teams.</div></div>`);
    }
    // A problem is said once. Put away, it stays away until a different one
    // comes along — it used to sit on every page for a day.
    if (state.lastError && !(state.lastErrorId && dismissedErrorIds().includes(state.lastErrorId))) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('alert', 16)}</span><div>${esc(state.lastError)}</div>${state.lastErrorId ? `<button type="button" class="notice-x" data-dismiss-error="${esc(state.lastErrorId)}" aria-label="Dismiss" title="Dismiss">${icon('x', 14)}</button>` : ''}</div>`);
    }
    $('#notices').innerHTML = n.join('');
    $('#signOutBtn').hidden = !(state.auth && state.auth.required);
  }

  // The last few put away, so clearing a newer one cannot bring back an
  // older one that was dismissed already.
  const dismissedErrorIds = () => {
    try { const v = JSON.parse(localStorage.getItem(teamKey('errorsDismissed')) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  document.addEventListener('click', (e) => {
    const err = e.target.closest('[data-dismiss-error]');
    if (err) {
      const id = err.dataset.dismissError;
      try { localStorage.setItem(teamKey('errorsDismissed'), JSON.stringify([id, ...dismissedErrorIds().filter((x) => x !== id)].slice(0, 20))); } catch {}
      if (state) renderNotices();
      return;
    }
    if (e.target.closest('#dismissUpdate')) {
      updateDismissed = updateReady;
      if (state) renderNotices();
    }
  });

  // The 30-second poll. The server tags the state, so an unchanged poll comes
  // back 304 with no body — nothing to parse, and nothing to re-render, which
  // is the whole point: most polls change nothing and should cost nothing.
  //
  // The state comes without the list (/api/state?v=2). The page keeps its
  // own copy of the list (public/wire.js) and, when the state says the list
  // has moved on, asks only for the part of it that changed; the list, the
  // texting order and who is due a follow-up are then put back into the
  // state exactly as the server used to send them, so nothing else on the
  // page knows the difference. A server too old to know any of this sends the
  // state with the list in it, as it always did, and that is used as it is.
  let stateTag = '';
  // When the newest state on screen was asked for. An answer to a request
  // that set off before it is older than what is shown, and is dropped.
  // Timed on the page's own clock, which only goes forward: Date.now() is the
  // device's clock, and a phone putting its clock back (by hand, or a network
  // time correction) would have had every answer after it dropped as older,
  // the page frozen until the clock caught up again.
  let appliedAskedAt = 0;
  const pageClock = () => performance.now();
  const teamIdNow = () => (currentTeam ? currentTeam.id : '');

  // ---- asking, with a deadline ----
  // A request that never answers (a phone between networks, a proxy holding
  // the line) must not hold up everything queued behind it, so each has a
  // deadline that covers reading the body too: generous for the state and the
  // whole list, which can be megabytes on a slow line, shorter for a sync,
  // which is a few kilobytes.
  const STATE_MS = 90000;
  const FULL_MS = 90000;
  const SYNC_MS = 20000;
  const authFailed = () => { showLogin(); const e = new Error('Please sign in.'); e.authFailed = true; return e; };
  // { status, tag, body } — body only for a 200. `early` is one of the
  // requests index.html started while the page loaded, used in place of
  // asking again.
  async function fetchJson(url, { method = 'GET', headers = {}, body, ms }, early = null) {
    const ctl = early ? early.ctl : new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await (early ? early.res : fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      }));
      return { status: res.status, tag: res.headers.get('ETag') || '', body: res.status === 200 ? await res.json() : null };
    } catch (err) {
      const e = new Error(ctl.signal.aborted ? 'The server took too long to answer.' : 'Cannot reach the server.');
      e.network = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- what index.html asked for while the page loaded ----
  // The session, the state and the whole list, all at once and before the
  // scripts had even arrived. Each is used at most once, by the first thing
  // that would have asked for it, and only for the team it turns out to be
  // for; anything else about it (signed out, a failure, another team) and it
  // is simply asked for again.
  const early = window.__early || {};
  window.__early = null;
  function takeEarly(name) {
    const e = early[name];
    early[name] = null;
    return e || null;
  }
  // Signed out, the answers are of no use, and the list may be megabytes.
  function dropEarly() {
    for (const name of Object.keys(early)) { const e = takeEarly(name); if (e) e.ctl.abort(); }
  }

  // The state, as a 304, or a 200 with its tag and body, and when it was
  // asked for (on pageClock).
  async function readState(tag, team) {
    const e = !tag && takeEarly('state');
    if (e) {
      try {
        const r = await fetchJson(null, { ms: STATE_MS }, e);
        if (r.status === 200 && r.body && r.body.team && r.body.team.id === team) return { ...r, askedAt: e.at };
      } catch { /* asked again below */ }
    }
    const askedAt = pageClock();
    const r = await fetchJson('/api/state?v=2', { headers: tag ? { 'If-None-Match': tag } : {}, ms: STATE_MS });
    return { ...r, askedAt };
  }

  // The order below matters, and each step is where it is for a reason.
  async function refresh() {
    // Who asked, and when, before anything can change under the request:
    // a status picked while it is out is laid over its answer (the answer
    // may predate it), and an answer for a team this page has since left is
    // not this page's to show.
    const askedTeam = teamIdNow();
    const got = await readState(stateTag, askedTeam);
    // Answered, therefore in touch: a 304 is as current as a 200, it just has
    // nothing new to say.
    if (got.status === 304) { lastSyncAt = Date.now(); return false; }
    if (got.status === 401) throw authFailed();
    if (got.status !== 200) throw new Error(`Request failed (${got.status})`);
    lastSyncAt = Date.now();
    // The tag is remembered only once this version is actually on screen. Saved
    // first, a body cut off in transit or a drawing error left the page asking
    // "anything newer than this?", being told no, and showing the old list —
    // an import that never appeared — until something else changed.
    const had = stateTag;
    stateTag = '';
    let fresh = got.body;
    let tag = got.tag;
    let askedAt = got.askedAt;
    let copy = null;
    let agreed = true;
    if (fresh && fresh.cands) {
      // Bring the copy of the list up to the version this state is for. If
      // the list has moved on again in between (somebody saved a moment
      // later), the state is asked for again, so the two on screen agree; a
      // few tries, then the newest of each, and the next poll asks again.
      // The list is the team the state is for: the session's, which can
      // differ from the team on screen (signed in as another team in
      // another tab), and the page then moves to it, as it always did.
      for (let tries = 0; ; tries++) {
        copy = await syncList(fresh.cands);
        if (copy.v === fresh.cands.v && copy.t === fresh.cands.t) break;
        if (tries >= 3) { agreed = false; break; }
        const again = await readState('', askedTeam);
        if (again.status === 401) throw authFailed();
        if (again.status !== 200 || !again.body || !again.body.cands) { agreed = false; break; }
        fresh = again.body; tag = again.tag; askedAt = again.askedAt;
      }
    }
    // Reading a list this size holds the page for a moment; let a tap or a
    // keystroke that came in meanwhile through before it is drawn.
    await new Promise((r) => setTimeout(r, 0));
    // Signed out, or into another team, while it was on its way: not ours.
    // Nor is a list that is not the state's own team's.
    if (!signedIn || teamIdNow() !== askedTeam || (copy && copy.t !== fresh.cands.t)) return false;
    // Older than what is already on screen (a slow answer overtaken by a
    // later one): what is shown stands, and so does the tag it came with.
    if (askedAt < appliedAskedAt) { if (!stateTag) stateTag = had; return false; }
    appliedAskedAt = askedAt;
    // What this page laid over the last state comes off before the next one
    // lands, and goes back on below only where it still holds.
    liftOverlays();
    if (copy) {
      fresh.candidates = copy.cands;
      const side = sideLists(copy);
      fresh.texting.priority = side.priority;
      fresh.followUp.dueIds = side.dueIds;
    } else {
      // A server that sends the list itself: no copy is kept beside it.
      dropList();
    }
    state = fresh;
    listVersion += 1;
    stateVersion += 1;
    // Nothing kept from the last state answers for this one, and keeping it
    // would keep the last copy of the list alive too.
    forgetKept();
    authRequired = Boolean(state.auth && state.auth.required);
    setTeam(state.team);
    // A conversation read on this screen stays read, whatever an answer that
    // set off before the tap (or a "seen" call lost on a bad connection) says.
    applyLocallyRead();
    // And a status picked here stays picked until the server has said so.
    applyPendingStatus(askedAt);
    // Someone removed on another device cannot stay selected: a selection
    // counts people, and acts on them.
    pruneSelection();
    renderAll();
    refreshProfile();
    // Back from a sign-in with Sales IQ on screen: it looks again.
    if (currentView === 'salesiq' && window.SalesIQ) window.SalesIQ.activate();
    if (currentView === 'onboarding' && window.Onboarding) window.Onboarding.activate();
    stateTag = agreed ? tag : '';
    return true;
  }

  // ---------------- The kept copy of the list ----------------
  // One team's list as of one version (see public/wire.js), never changed in
  // place: a sync makes a new copy, and one that fails any check against the
  // server's digests is never kept — the whole list is fetched instead. One
  // sync at a time, in the order asked.
  let list = null;
  let listEpoch = 0;                 // moves on sign-out: a sync on its way then is not kept
  let listQueue = Promise.resolve();
  // Buckets whose copy this page no longer trusts (a save it showed before
  // the server took it, and the server refused): the next sync asks for them
  // whatever their digests say.
  const distrust = new Set();
  // Set when the texting order put together here did not come out as the
  // server's: from then on it is asked for outright.
  let wantOrder = false;

  function dropList() {
    list = null;
    listEpoch += 1;
    distrust.clear();
    sideMemo = null;
    clearTimeout(verifyTimer);
    verifyTimer = 0;
  }

  function syncList(cands) {
    const run = listQueue.then(() => bringListUp(cands));
    listQueue = run.catch(() => {});
    return run;
  }

  // The copy brought up to `cands` (the state's word on the list). Whatever
  // the server answers is the session's own team's list, and is what is
  // kept; refresh() draws it only under a state of the same team.
  async function bringListUp(cands) {
    const team = cands.t;
    const epoch = listEpoch;
    // Signed out (or into another team) while it was on its way: handed
    // back for refresh() to drop, never kept.
    const keep = (copy) => {
      if (epoch === listEpoch) list = copy;
      return copy;
    };
    if (list && list.t !== team) dropList();
    if (list && !distrust.size && !(wantOrder && !list.ro)) {
      if (list.v === cands.v) return list;
      // A new version with the same people, order and digests (a ten-minute
      // window that moved nobody): nothing to ask for.
      if (Wire.sameAs(list, cands)) return keep(Wire.adopt(list, cands));
    }
    if (!list || list.dup || !Wire.canDigest()) return wholeList(team, keep);
    const asked = new Set(distrust);
    // A network error or a timeout is said as one — the next poll tries
    // again — rather than fetching the whole list over a connection that has
    // just failed to carry a few kilobytes.
    const r = await fetchJson('/api/candidates/sync?v=2', { method: 'POST', body: { ...Wire.syncBody(list, distrust), ...(wantOrder ? { ro: 1 } : {}) }, ms: SYNC_MS });
    if (r.status === 401) throw authFailed();
    if (r.status !== 200 || !r.body) throw new Error(`Request failed (${r.status})`);
    const msg = r.body;
    let next;
    try {
      if (msg.same) {
        if (!Wire.sameAs(list, msg)) { const e = new Error('The list update was refused: it says nothing changed, but this copy is not the server\'s.'); e.refused = true; throw e; }
        next = Wire.adopt(list, msg);
      } else if (msg.ch) next = await Wire.applyDelta(list, msg);
      else next = await Wire.fromFull(msg);
    } catch (err) {
      if (!err.refused) throw err;
      return wholeList(team, keep);
    }
    for (const b of asked) distrust.delete(b);
    keep(next);
    if (!msg.same) scheduleVerify();
    return next;
  }

  async function wholeList(team, keep) {
    const e = takeEarly('list');
    let r = null;
    if (e && !wantOrder) {
      try {
        r = await fetchJson(null, { ms: FULL_MS }, e);
        if (r.status !== 200 || !r.body || r.body.t !== team) r = null;
      } catch { r = null; }
    }
    if (!r) r = await fetchJson(`/api/candidates?v=2${wantOrder ? '&ro=1' : ''}`, { ms: FULL_MS });
    if (r.status === 401) throw authFailed();
    if (r.status !== 200 || !r.body) throw new Error(`Request failed (${r.status})`);
    const copy = await Wire.fromFull(r.body);
    distrust.clear();
    keep(copy);
    scheduleVerify(true);
    return copy;
  }

  // The texting order and the follow-up list for a copy, put together the
  // way the server used to send them, and kept while the copy's rows are the
  // same ones (a new version of the same rows gives the same answer).
  let sideMemo = null;
  function sideLists(copy) {
    if (sideMemo && sideMemo.sides === copy.sides && sideMemo.ids === copy.ids && sideMemo.ro === copy.ro) return sideMemo;
    const ranked = Wire.rankOf(copy);
    sideMemo = { sides: copy.sides, ids: copy.ids, ro: copy.ro, priority: Wire.priorityOf(copy, ranked), dueIds: Wire.dueIdsOf(copy) };
    // Ties in the order are broken here as the server breaks them. Should one
    // ever come out differently (the server says so when it knows: ro), the
    // order is asked for outright from then on.
    if (!copy.ro && Wire.canDigest()) {
      Wire.rankDigest(copy, ranked).then((d) => {
        if (d === copy.rn || wantOrder || copy !== list) return;
        wantOrder = true;
        stateTag = '';
        refreshSoon();
      }).catch(() => {});
    }
    return sideMemo;
  }

  // ---- the whole copy, checked when there is time ----
  // A sync checks the buckets it changes; the rest of the copy is checked
  // against the server's digests now and then, in moments the page has
  // nothing else to do: first which rows are in which bucket, then — in
  // later moments, as many buckets at a time as fit — their text and digest.
  // A bucket that does not come out as the server has it is asked for again
  // (distrust), and the next check waits twice as long, so a fault that keeps
  // coming back costs a little more time between tries rather than a loop.
  const VERIFY_MS = 5 * 60000;
  const VERIFY_MAX = 60 * 60000;
  let verifyWait = VERIFY_MS;
  let verifyTimer = 0;
  const idle = (fn) => (window.requestIdleCallback
    ? requestIdleCallback(fn, { timeout: 10000 })
    : setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 50));
  function scheduleVerify(soon = false) {
    if (verifyTimer || !Wire.canDigest()) return;
    verifyTimer = setTimeout(() => idle(() => checkIndex(list)), soon ? 10000 : verifyWait);
  }
  function checkIndex(copy) {
    if (!copy || copy !== list || document.hidden) { verifyTimer = 0; if (list) scheduleVerify(); return; }
    const groups = Array.from({ length: copy.nb }, () => []);
    for (let i = 0; i < copy.n; i++) groups[copy.bk[i]].push(i);
    idle((deadline) => checkBuckets(copy, groups, 0, [], deadline));
  }
  async function checkBuckets(copy, groups, from, bad, deadline) {
    if (copy !== list) { verifyTimer = 0; scheduleVerify(); return; }
    const texts = [];
    let b = from;
    // The page's own edits come off for the reading, and go straight back on.
    withOverlaysLifted(() => {
      while (b < copy.nb && (!texts.length || deadline.timeRemaining() > 2)) {
        texts.push([b, groups[b].map((i) => Wire.rowText(copy.f, copy.k, copy.cands[i], copy.sides[i])).join('')]);
        b += 1;
      }
    });
    try {
      for (const [at, text] of texts) if (await Wire.digest(text, Wire.DIGEST) !== copy.d[at]) bad.push(at);
    } catch { verifyTimer = 0; return; }
    if (b < copy.nb) { idle((d) => checkBuckets(copy, groups, b, bad, d)); return; }
    verifyTimer = 0;
    if (copy !== list) { scheduleVerify(); return; }
    if (!bad.length) { verifyWait = VERIFY_MS; return; }
    for (const at of bad) distrust.add(at);
    verifyWait = Math.min(verifyWait * 2, VERIFY_MAX);
    stateTag = '';
    refreshSoon();
    scheduleVerify();
  }

  // ---- this page's edits, laid over the list ----
  // A status picked here, a conversation read here: shown at once, on the
  // very objects the list is drawn from, before the server has them. They are
  // lifted off before each new state lands and laid back on (applyLocallyRead,
  // applyPendingStatus) only where they still hold. Left on, a copy patched
  // bucket by bucket would keep them on everyone whose bucket did not change:
  // a conversation shown read here would stay read even while the server
  // still has it unread — the "seen" call lost on a bad connection — and the
  // page would never tell it again.
  const overlays = new Map();        // person -> Map(field -> [had it, value before])
  function overlay(c, field, value) {
    let m = overlays.get(c);
    if (!m) { m = new Map(); overlays.set(c, m); }
    if (!m.has(field)) m.set(field, [Object.prototype.hasOwnProperty.call(c, field), c[field]]);
    c[field] = value;
  }
  function liftOverlays() {
    for (const [c, m] of overlays) {
      for (const [field, [had, was]] of m) { if (had) c[field] = was; else delete c[field]; }
    }
    overlays.clear();
  }
  function withOverlaysLifted(fn) {
    const now = [];
    for (const [c, m] of overlays) for (const [field, [had, was]] of m) { now.push([c, field, c[field]]); if (had) c[field] = was; else delete c[field]; }
    try { return fn(); } finally { for (const [c, field, v] of now) c[field] = v; }
  }

  // ---------------- Connection ----------------
  // A failed poll used to fail in complete silence: the numbers on screen
  // simply stopped moving, which looks exactly like a quiet afternoon. While a
  // send is running that is the worst lie the page can tell. Two failures in a
  // row now say so in the header, and we try again sooner than the next
  // half-minute instead of waiting it out.
  let pollFails = 0;
  let lastSyncAt = 0;
  let retryTimer = null;

  async function poll() {
    if (!signedIn) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    try {
      await refresh();
      if (pollFails) { pollFails = 0; renderConnection(); }
      takeUpdate('launch');
    } catch (err) {
      // Signed out is not offline — the login panel is already up, and
      // hammering the server would not help.
      if (err && err.authFailed) { pollFails = 0; renderConnection(); return; }
      pollFails += 1;
      renderConnection();
      retryTimer = setTimeout(poll, Math.min(5000 * pollFails, 30000));
    }
  }

  function mountConnection() {
    $$('.head-chrome').forEach((row) => {
      if (row.querySelector('.conn-lost')) return;
      const el = document.createElement('button');
      el.className = 'conn-lost';
      el.type = 'button';
      el.hidden = true;
      el.innerHTML = '<span class="conn-dot"></span><span class="conn-text">Offline</span>';
      el.addEventListener('click', () => poll());
      // leftmost of the three, so it never shifts the bell and the switch
      row.prepend(el);
    });
  }

  function renderConnection() {
    const lost = pollFails >= 2;
    // Not just the marker in the header: with no connection every control that
    // sends something is going to fail, and a button that looks ready is a
    // button somebody presses three times.
    document.documentElement.classList.toggle('is-offline', lost);
    const when = lastSyncAt
      ? clockTime(lastSyncAt)
      : '';
    $$('.conn-lost').forEach((el) => {
      el.hidden = !lost;
      // Only while it is up: a tooltip on a hidden button helps nobody, and a
      // clock baked into an always-present attribute makes two pages showing
      // the same thing differ.
      if (!lost) el.removeAttribute('title');
      else el.title = when
        ? `Cannot reach the server. Everything on screen is as it was at ${when}. Click to try again.`
        : 'Cannot reach the server. Click to try again.';
    });
  }

  // ---------------- Toasts ----------------
  function toast(msg, isErr = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), isErr ? 6000 : 3500);
  }
  const oops = (err) => toast(err.message || String(err), true);

  // ---------------- Navigation ----------------
  // The one thing that scrolls. Declared here rather than beside the rest of
  // the phone code because show() reads it, and show() is defined above that.
  const mainEl = $('.main');

  // The page you are on lives in the address bar. Back used to leave the site
  // entirely, a reload always dumped you on the Dashboard however deep into
  // Texting you were, and there was no way to send somebody a link to a page.
  let currentView = 'dashboard';
  let offlineBoot = false;      // the first load could not reach the server
  // Set now as well as in show(), so the first paint is already the right
  // width rather than reflowing the moment you navigate.
  if (mainEl) mainEl.dataset.view = currentView;
  const scrollMemory = Object.create(null);

  // The phone's tab bar has five tabs: Home, People, Inbox, Hiring and More.
  // Inbox is Email and Texting, Hiring is Sales IQ and Onboarding docs; each
  // pair is switched from the top of its own page, and the tab goes back to
  // whichever of the two you were on last. The sidebar still lists all four.
  const GROUPS = {
    inbox: { label: 'Inbox', views: [['template', 'Email', 'mail'], ['texting', 'Texts', 'bubble']] },
    hiring: { label: 'Hiring', views: [['salesiq', 'Sales IQ', 'clipboard'], ['onboarding', 'Onboarding docs', 'signdoc']] },
  };
  const groupOf = (view) => Object.keys(GROUPS).find((g) => GROUPS[g].views.some(([v]) => v === view)) || '';
  const lastInGroup = (() => {
    try { return JSON.parse(localStorage.getItem('wp-tab-last')) || {}; } catch { return {}; }
  })();
  function rememberInGroup(view) {
    const g = groupOf(view);
    if (!g || lastInGroup[g] === view) return;
    lastInGroup[g] = view;
    try { localStorage.setItem('wp-tab-last', JSON.stringify(lastInGroup)); } catch {}
  }
  // The highlight behind the current tab slides from one tab to the next.
  // Measured from the tabs actually on screen, so it follows whatever the
  // stylesheet shows at this width; with none of them current it fades out.
  function placeTabHighlight() {
    const nav = $('.nav');
    if (!nav) return;
    const tabs = $$('.nav > .nav-item').filter((t) => t.getClientRects().length > 0);
    const i = tabs.findIndex((t) => t.classList.contains('active'));
    nav.style.setProperty('--tab-n', String(tabs.length || 1));
    nav.style.setProperty('--tab-i', String(Math.max(0, i)));
    nav.classList.toggle('has-current', i >= 0);
    // It slides between tabs, but on the first paint it is simply there.
    if (!nav.classList.contains('tabs-ready')) requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.add('tabs-ready')));
  }

  function show(view, { record = true } = {}) {
    if (!$(`#view-${view}`)) return;
    if (currentView !== view) scrollMemory[currentView] = mainEl ? mainEl.scrollTop : 0;
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    // Which page this is, for the stylesheet: Candidates is a table and wants
    // the window, everything else is capped for reading.
    if (mainEl) mainEl.dataset.view = view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    // A page that lives in More on a phone lights up More, and one of a
    // pair lights up the tab the pair shares.
    $('#navMore').classList.toggle('active', Boolean($(`.nav-item[data-overflow][data-view="${view}"]`)));
    const group = groupOf(view);
    $$('.nav-group').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
    rememberInGroup(view);
    placeTabHighlight();
    // Settings asks for its Sales IQ card on every visit (the code starts
    // covered each time); asked before Settings is drawn, so that drawing it
    // does not ask a second time for a team it has no answer for yet.
    if (view === 'settings') loadSalesiq();
    // Anything that fell behind while you were on another page is drawn now,
    // rather than on every poll for six pages at once; and the "5m ago"s on a
    // page that was not, which the minute tick only keeps moving on screen.
    if (staleViews.has(view)) renderView(view);
    else tickAgo($(`#view-${view}`));
    // Sales IQ keeps its own list (public/salesiq.js), and looks for changes
    // only while it is the page on screen.
    if (window.SalesIQ) { if (view === 'salesiq') window.SalesIQ.activate(); else window.SalesIQ.deactivate(); }
    // So does Onboarding docs (public/onboarding.js), once there is a team:
    // before the first answer names one, it would be looking as nobody.
    if (window.Onboarding) { if (view === 'onboarding' && currentTeam) window.Onboarding.activate(); else window.Onboarding.deactivate(); }
    // Opened with no connection (the Home Screen app starts at the Dashboard):
    // what this device kept for the team it was last signed in to.
    if (view === 'onboarding' && !currentTeam && offlineBoot && window.Onboarding && lastTeam()) window.Onboarding.showCached(lastTeam());
    // The editors moved to Settings; Email and Texting are conversations only.
    if (view === 'settings') {
      renderTemplatePreview(); loadRelayToken(); placeAccountControls();
    }
    // Back on a page whose thread column shows the whole time (anything wider
    // than a phone): the conversation it holds may have moved on meanwhile.
    if (state && !phoneQuery.matches) {
      const c = candById;
      if (view === 'texting' && openThreadId && !threadLoading) openThread(openThreadId, { quiet: true });
      if (view === 'template' && openMailId && !mailLoading && c(openMailId) && mailSig(c(openMailId)) !== mailShownSig) openMail(openMailId, { quiet: true });
    }
    // Arriving at a page is arriving at its list, never at whatever thread was
    // open the last time you were here.
    if (record) syncThreadStack(false);
    // Every page shares one scroller, so without this, leaving Candidates
    // halfway down and tapping Settings opened Settings halfway down too.
    // The frame's delay is needed: the new page has no height until the class
    // swap above has been painted.
    lastRouted = `${view}|`;
    const back = scrollMemory[view] || 0;
    requestAnimationFrame(() => {
      mainEl.scrollTop = back;
      mainEl.classList.toggle('scrolled', back > 14);
    });
    if (record && location.hash !== addressFor(view)) history.pushState({ view }, '', addressFor(view));
  }
  // A page's place in the address bar. Onboarding docs adds the section that
  // is open (#onboarding?tab=hire), so a reload or a shared link lands on it.
  function addressFor(view) {
    return view === 'onboarding' && window.Onboarding ? window.Onboarding.address() : `#${view}`;
  }
  const viewInAddressBar = () => {
    const want = location.hash.replace('#', '').split('?')[0];
    return want && $(`#view-${want}`) ? want : 'dashboard';
  };
  // Going back between two entries whose URLs differ only in the fragment
  // fires popstate AND hashchange, and there is a handler on each. Without
  // this the whole transition ran twice, which on a phone means the thread
  // slides out and straight back in.
  let lastRouted = '';
  function route(view, thread) {
    const key = `${view}|${thread ? 't' : ''}`;
    if (key === lastRouted) return;
    show(view, { record: false });
    // On a phone a thread is its own entry in the history, so going back out
    // of one is the same gesture as going back out of a page. Only one that
    // is still loaded is put back: after a reload there is nothing to show.
    syncThreadStack(thread && Boolean(view === 'template' ? openMailId : openThreadId));
    // Set after show(), which records the page alone: set before, the guard
    // said "no thread" while one was open, and the next Back was skipped.
    lastRouted = key;
  }
  window.addEventListener('popstate', (e) => {
    route((e.state && e.state.view) || viewInAddressBar(), Boolean(e.state && e.state.thread));
  });
  // Typing a page into the address bar, or following a link to #texting from
  // outside, changes the hash without reloading and without a popstate.
  window.addEventListener('hashchange', () => route(viewInAddressBar(), false));
  // Tapping the tab you are already on is how iOS takes you back to the top
  // of it: out of an open conversation first, then up to the top of the page.
  function tabAgain() {
    if (threadIsOpen()) { backFromThread(); return; }
    if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
    // A conversation list scrolls inside its page; it goes to the top too.
    $$('.view.active .conv-list').forEach((l) => l.scrollTo({ top: 0, behavior: 'smooth' }));
  }
  $$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === currentView) { tabAgain(); return; }
    show(b.dataset.view);
  }));
  $$('.nav-group').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.group;
    if (groupOf(currentView) === g) { tabAgain(); return; }
    show(lastInGroup[g] || GROUPS[g].views[0][0]);
  }));
  // The top of each grouped page on a phone: the tab's own name as the title
  // (Inbox, Hiring), and under it the switch between its two pages — Email |
  // Texts, Sales IQ | Onboarding docs. Built from GROUPS so the tab bar and
  // the switch cannot disagree. Phone only: the sidebar lists every page, and
  // each page keeps its own title there.
  function buildGroupSwitches() {
    for (const def of Object.values(GROUPS)) {
      for (const [view] of def.views) {
        const head = $(`#view-${view} .page-head`);
        if (!head || head.querySelector('.group-tabs')) continue;
        const title = document.createElement('div');
        title.className = 'group-title';
        title.setAttribute('role', 'heading');
        title.setAttribute('aria-level', '1');
        title.textContent = def.label;
        head.firstElementChild.prepend(title);
        const nav = document.createElement('nav');
        nav.className = 'group-tabs';
        nav.setAttribute('aria-label', def.label);
        nav.innerHTML = def.views.map(([v, label, ico]) => `<button type="button" class="group-tab${v === view ? ' is-on' : ''}" ${v === view ? 'aria-current="page"' : `data-goto="${v}"`}>${icon(ico, 15)}<span>${esc(label)}</span><span class="group-count" data-count-for="${v}"></span></button>`).join('');
        head.classList.add('has-group');
        head.firstElementChild.after(nav);
      }
    }
  }
  buildGroupSwitches();

  // ---- compose, on the phone's Inbox ----
  // A wider screen has the page's own buttons in its header (Email all, Follow
  // up, Import; Text everyone, Stop texting). On a phone those made the Inbox
  // mostly buttons, so they are one compose button in the navigation bar, the
  // way Mail and Messages do it, opening a sheet of the same actions. The
  // sheet is read from the real buttons every time it opens — their labels,
  // counts and whether they can be pressed — and pressing one presses them.
  const INBOX_ACT_ICON = { emailAllBtn: 'mail', emailFollowUpBtn: 'reply', textSendAllBtn: 'bubble', textStopBtn: 'xcircle' };
  let inboxSheetSource = [];
  function mountCompose() {
    for (const [view] of GROUPS.inbox.views) {
      const head = $(`#view-${view} .page-head`);
      if (!head || head.querySelector('.head-compose')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'head-compose';
      b.setAttribute('aria-label', view === 'template' ? 'New email' : 'New text');
      b.title = b.getAttribute('aria-label');
      b.innerHTML = icon('compose', 24);
      b.addEventListener('click', () => openInboxSheet(view));
      head.appendChild(b);
    }
  }
  function openInboxSheet(view) {
    // The page's main action first, the way an action sheet leads with it.
    const btns = $$(`#view-${view} .head-actions > .btn`).filter((x) => !x.hidden)
      .sort((a, b) => Number(b.classList.contains('btn-primary')) - Number(a.classList.contains('btn-primary')));
    inboxSheetSource = btns;
    $('#inboxSheetTitle').textContent = view === 'template' ? 'Email' : 'Texts';
    $('#inboxSheetButtons').innerHTML = btns.map((b, i) => {
      const ico = INBOX_ACT_ICON[b.id] || (b.dataset.goto === 'import' ? 'upload' : 'plus');
      const label = b.textContent.replace(/\s+/g, ' ').trim();
      return `<button type="button" class="sheet-btn more-row${b.id === 'textStopBtn' ? ' is-danger' : ''}" data-inbox-act="${i}"${b.disabled ? ' disabled' : ''}>
        <span class="more-ico">${icon(ico, 18)}</span><span class="more-label">${esc(label)}</span></button>`;
    }).join('');
    openModal('#inboxSheet');
  }
  $('#inboxSheetButtons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-inbox-act]');
    if (!b || b.disabled) return;
    const src = inboxSheetSource[Number(b.dataset.inboxAct)];
    closeModal($('#inboxSheet'));
    if (src && !src.disabled) src.click();
  });
  mountCompose();

  // A list that has scrolled under the header gets the hairline a navigation
  // bar draws once content passes beneath it, and the compact title.
  $$('#view-template .conv-list, #view-texting .conv-list').forEach((l) => l.addEventListener('scroll', () => {
    l.closest('.view').classList.toggle('list-scrolled', l.scrollTop > 8);
  }, { passive: true }));
  // More: the pages the phone's tab bar has no room for, as a list. Built
  // from the tab bar itself each time, so the two can never disagree.
  $('#navMore').addEventListener('click', () => {
    $('#moreSheetButtons').innerHTML = $$('.nav-item[data-overflow]').map((b) => {
      const here = b.dataset.view === currentView;
      return `<button type="button" class="sheet-btn more-row${here ? ' is-current' : ''}" data-more="${esc(b.dataset.view)}"${here ? ' aria-current="page"' : ''}>
        <span class="more-ico">${icon(b.querySelector('.nav-ico').dataset.icon, 18)}</span>
        <span class="more-label">${esc(b.querySelector('.nav-label').textContent)}</span>
        <span class="more-chev">${icon('chevron', 14)}</span>
      </button>`;
    }).join('');
    openModal('#moreSheet');
  });
  $('#moreSheetButtons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    closeModal($('#moreSheet'));
    show(b.dataset.more);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) show(go.dataset.goto);
    const chip = e.target.closest('[data-feed]');
    if (chip) {
      feedChannel = chip.dataset.feed;
      try { localStorage.setItem(teamKey('feedChannel'), feedChannel); } catch {}
      renderFeed();
    }
  });

  // Onboarding docs (public/onboarding.js) reaches the rest of the site through
  // these: a lapsed session goes to the sign-in screen, its links go to pages
  // here, and a packet sent or signed there redraws the badges on Candidates.
  if (window.Onboarding) {
    window.Onboarding.connect({
      signedOut: () => { if ($('#loginScreen').hidden) showLogin(); },
      show: (view) => show(view),
      changed: () => { refresh().catch(() => {}); },
    });
  }

  // ---------------- Dashboard ----------------
  // Every number the Dashboard counts from the list, in one pass over it (it
  // was thirteen), kept until the list changes.
  //
  // "Sent" is everyone we tried to text, which has to include the numbers that
  // turned out to have no iMessage account — we sent to them, it failed. Left
  // out of the total, "No iMessage" was a percentage of something it was not
  // part of, and could read over 100%; and "Delivered 100%" quietly hid every
  // failure.
  //
  // The email funnel is counted the way the texting one already was: how many
  // people ever reached each stage, so every row is a subset of the one above
  // it. Counting the *current status* instead mixed two different questions —
  // somebody who opened and then replied has status "replied", so they landed
  // in Opened but not in Sent, and the funnel read 200%.
  const TEXT_SENT = new Set(['sent', 'delivered', 'read', 'replied', 'not-imessage']);
  const TEXT_DELIVERED = new Set(['delivered', 'read', 'replied']);
  const dashboardCounts = kept(() => [listVersion, state && state.candidates], () => {
    const t = { sent: 0, delivered: 0, read: 0, replied: 0, dead: 0 };
    const e = { sent: 0, opened: 0, replied: 0, booked: 0, bounced: 0 };
    let contacted = 0;
    let repliedEither = 0;
    for (const c of state.candidates) {
      const ts = c.textStatus;
      if (TEXT_SENT.has(ts)) t.sent += 1;
      if (TEXT_DELIVERED.has(ts)) t.delivered += 1;
      if (ts === 'read' || ts === 'replied') t.read += 1;
      if (ts === 'replied') t.replied += 1;
      if (ts === 'not-imessage') t.dead += 1;
      // status is included as well as the timestamp: an older or imported
      // record can carry the stage without the date, and leaving those out
      // would make Sent smaller than the rows beneath it.
      if (c.lastEmailedAt || c.emailBounced || c.status === 'bounced' || c.status === 'emailed') e.sent += 1;
      if (c.openedAt) e.opened += 1;
      const emailReplied = c.emailReplies > 0 || Boolean(c.lastReplyAt);
      if (emailReplied) e.replied += 1;
      // Scoped to people who were emailed: a booking that came from a text
      // belongs in the texting story, not this one.
      if (c.bookedAt && c.lastEmailedAt) e.booked += 1;
      if (c.emailBounced || c.status === 'bounced') e.bounced += 1;
      if (c.lastEmailedAt || c.lastTextedAt) contacted += 1;
      // Everyone who ever answered, on either channel. The status-only count
      // dropped anyone who replied and then booked, while the split beside it
      // still counted them — so the smaller half could exceed the whole.
      if (emailReplied || ts === 'replied' || c.textRepliedAt || c.status === 'replied') repliedEither += 1;
    }
    return { t, e, contacted, repliedEither };
  });

  function renderDashboard() {
    const s = state.stats;
    const { t, e, contacted, repliedEither } = dashboardCounts();

    // Three and a half thousand candidates reads as 3514 without this, which
    // is a number you have to count the digits of.
    $('#statTotal').textContent = s.total.toLocaleString();
    $('#statEmailed').textContent = contacted.toLocaleString();
    $('#statReplied').textContent = repliedEither.toLocaleString();
    // Both tiles used to be email-only, which made texting invisible on the
    // page people actually look at.
    $('#statContactedSplit').textContent = `${e.sent.toLocaleString()} emailed · ${t.sent.toLocaleString()} texted`;
    $('#statRepliedSplit').textContent = `${t.replied.toLocaleString()} by text`;
    // The tile and the pipeline both say "Booked" and mean different things:
    // this one is what is still to come, the pipeline is everyone who ever
    // booked. With no Calendly sync there is no "upcoming" to know, so it
    // falls back to the total — and says so either way.
    const upcoming = state.calendly && state.calendly.syncEnabled;
    $('#statBooked').textContent = (upcoming ? upcomingInterviews().length : s.booked).toLocaleString();
    $('#statBookedSplit').textContent = upcoming
      ? (s.booked ? `${s.booked.toLocaleString()} booked in all` : 'still to come')
      : '';
    renderSendingCard();

    // Pipeline bars
    const steps = [
      ['Not contacted', s.new, 'var(--navy-soft)'],
      ['Emailed', s.emailed, 'var(--blue)'],
      ['Replied', s.replied, 'var(--mint)'],
      ['Booked', s.booked, 'var(--green)'],
      ['Not interested', s.declined, '#cfd4e0'],
      ['Bounced', s.bounced || 0, 'var(--amber)'],
    ];
    const max = Math.max(1, ...steps.map(([, n]) => n));
    $('#pipeline').innerHTML = steps.map(([label, n, color]) => `
      <div class="pipe-row">
        <div class="pipe-label">${label}</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${(n / max) * 100}%;background:${color};opacity:.75"></div></div>
        <div class="pipe-count">${n.toLocaleString()}</div>
      </div>`).join('');

    renderChannels(t, e);
    renderTextToday(t);
    renderTrackers();

    renderFeed();

    // Setup checklist
    const st = state.settings;
    const items = [
      ['Import your candidates from Google Sheets or CSV', state.stats.total > 0, 'import'],
      ['Set up sending from your work email', state.sending.ready, 'settings'],
      ['Add your Calendly booking link', Boolean(st.calendlyUrl), 'settings'],
      ['Turn on phone notifications for bookings', Boolean(st.ntfyTopic), 'settings'],
      ['Add your Apollo key to find new candidates', Boolean(state.apollo && state.apollo.configured), 'import'],
      ['Personalize your default email template', state.templateEdited !== false, 'template'],
    ];
    const allDone = items.every(([, d]) => d);
    $('#setupCard').hidden = allDone;
    $('#setupList').innerHTML = items.map(([label, done, goto]) => `
      <li><span class="setup-check ${done ? 'done' : 'todo'}">${done ? icon('check', 11) : ''}</span>
        <span>${label}</span>
        ${done ? '' : `<button class="btn link" data-goto="${goto}">Set up ${icon('chevron', 13)}</button>`}
      </li>`).join('');
  }

  // ---------------- Dashboard: Sales IQ and Onboarding docs ----------------
  // Everyone on each list, and where they have got to. The numbers are the
  // Sales IQ and Onboarding docs pages' own; each opens the Candidates list
  // filtered to those people, with the same filters as the menus there.
  const IQ_TIERS = [['elite', 'Elite', 'var(--green)'], ['strong', 'Strong', 'var(--blue)'], ['develop', 'Developing', 'var(--amber)'], ['notready', 'Not ready', 'var(--red)']];
  function trackerCell(n, label, patch, title) {
    return `<button type="button" class="today-cell tracker-cell" data-seg='${esc(JSON.stringify(patch))}' title="${esc(title)}">
      <div class="today-n">${n.toLocaleString()}</div><div class="today-label">${esc(label)}</div></button>`;
  }
  // Each list counted in one pass, and only when the state brings a new one.
  const trackerCounts = kept(() => [stateVersion, state && state.salesiq, state && state.onboarding], () => {
    const iq = { all: 0, added: 0, invited: 0, completed: 0, tiers: {} };
    for (const x of Object.values((state.salesiq && state.salesiq.byEmail) || {})) {
      iq.all += 1;
      if (x.status === 'added' || x.status === 'invited' || x.status === 'completed') iq[x.status] += 1;
      if (x.status === 'completed') iq.tiers[x.tierKey] = (iq.tiers[x.tierKey] || 0) + 1;
    }
    const onb = { onPipeline: 0, pipeline: 0, sent: 0, signed: 0 };
    for (const o of Object.values((state.onboarding && state.onboarding.byEmail) || {})) {
      if (o.onPipeline) onb.onPipeline += 1;
      const stage = onbStage(o);
      if (stage) onb[stage] += 1;
    }
    return { iq, onb };
  });
  function renderTrackers() {
    const { iq, onb } = trackerCounts();
    $('#iqTrackerGrid').innerHTML = [
      trackerCell(iq.all, 'On Sales IQ', { iq: 'any' }, 'Everyone on the Sales IQ list — show them on Candidates'),
      trackerCell(iq.added, 'Not sent', { iq: 'added' }, 'On the list, questionnaire not sent yet'),
      trackerCell(iq.invited, 'Awaiting results', { iq: 'invited' }, 'Sent the questionnaire — waiting on their answers'),
      trackerCell(iq.completed, 'Completed', { iq: 'completed' }, 'Finished the questionnaire'),
    ].join('');
    $('#iqTrackerTiers').innerHTML = IQ_TIERS.map(([key, label, color]) => {
      const n = iq.tiers[key] || 0;
      return n ? `<button type="button" class="tier-pill" data-seg='${esc(JSON.stringify({ iq: key }))}'><span class="tier-dot" style="background:${color}"></span>${esc(label)} <b>${n.toLocaleString()}</b></button>` : '';
    }).join('');
    $('#onbTrackerGrid').innerHTML = [
      trackerCell(onb.onPipeline, 'On the pipeline', { onb: 'any' }, 'Everyone added to Onboarding docs — show them on Candidates'),
      trackerCell(onb.pipeline, 'Packet not sent', { onb: 'pipeline' }, 'On the pipeline, packet not sent yet'),
      trackerCell(onb.sent, 'Awaiting signature', { onb: 'sent' }, 'Packet sent — waiting on their signature'),
      trackerCell(onb.signed, 'Signed', { onb: 'signed' }, 'Signed and returned their paperwork'),
    ].join('');
  }
  $('#trackerRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (!b) return;
    openSegment(JSON.parse(b.dataset.seg));
    show('candidates');
  });

  function upcomingInterviews() {
    const since = Date.now() - 3600 * 1000;
    return (state.interviews || []).filter((i) => i.status === 'active' && new Date(i.start).getTime() >= since);
  }

  // ---------------- Sales IQ, beside a candidate ----------------
  // Where someone stands with the Sales IQ questionnaire, by their address.
  // It comes with the state as a small map, the way texting priority does,
  // so the candidate list stays the shape it has always been.
  // Also by their id here, for someone whose address there is not this one.
  function iqOf(c) {
    return sideRecord(state && state.salesiq, c);
  }
  // The two small maps (Sales IQ's and Onboarding docs'), as Maps: an object
  // looked up with a freshly lowercased string for each of 33,000 people was
  // most of what a count of them cost. Made once per map the state brings.
  const sideMapsMade = new WeakMap();
  function sideMaps(x) {
    if (!x) return null;
    let m = sideMapsMade.get(x);
    if (!m) {
      m = { byEmail: new Map(Object.entries(x.byEmail || {})), byCrm: new Map(Object.entries(x.byCrm || {})) };
      sideMapsMade.set(x, m);
    }
    return m;
  }
  function sideRecord(x, c) {
    const m = sideMaps(x);
    if (!m) return null;
    return m.byEmail.get(String((c && c.email) || '').trim().toLowerCase()) || m.byEmail.get(m.byCrm.get(c && c.id)) || null;
  }
  // Nobody at Wholesale Payments goes to Sales IQ or Onboarding docs.
  const OWN_COMPANY_EMAIL = /@(?:[a-z0-9-]+\.)*wholesalepayments\.com$/i;
  const canPipe = (c) => Boolean(c && c.email) && !OWN_COMPANY_EMAIL.test(String(c.email).trim());
  const IQ_TINT = { elite: 'tint-green', strong: 'tint-blue', develop: 'tint-amber', notready: 'tint-red' };
  function iqBadge(s) {
    if (!s) return '';
    if (s.status === 'completed') {
      return `<span class="badge iq-badge ${IQ_TINT[s.tierKey] || 'tint-blue'}" title="Sales IQ questionnaire: ${esc(s.tier || 'completed')}">Sales IQ ${typeof s.score === 'number' ? `${s.score}/100` : 'done'}</span>`;
    }
    if (s.status === 'invited') return '<span class="badge iq-badge tint-navy" title="Sent the Sales IQ questionnaire — waiting on their answers">Questionnaire sent</span>';
    return '<span class="badge iq-badge" title="On the Sales IQ list — questionnaire not sent yet">Sales IQ · not sent</span>';
  }
  const iqLine = (c) => { const b = [iqBadge(iqOf(c)), onbBadge(onbOf(c))].filter(Boolean).join(' '); return b ? `<div class="cand-iq">${b}</div>` : ''; };
  function iqActionLabel(c) {
    const s = iqOf(c);
    if (s && s.status === 'completed') return 'See their Sales IQ result';
    if (s && s.status === 'invited') return 'Send Sales IQ questionnaire again';
    return 'Send Sales IQ questionnaire';
  }
  // An interview's line in Interviews booked: where the booker stands, or
  // the button that sends them the questionnaire.
  function iqTile(email) {
    const s = iqOf({ email });
    if (!s) return '';
    if (s.status === 'added') return `<button class="tile-link iq-send" data-iq="${esc(s.id)}">${icon('clipboard', 13)} Send questionnaire</button>`;
    return iqBadge(s);
  }
  function iqNeedsResults(err) {
    if (!err || !err.needsResults) return false;
    toast(err.message, true);
    closeModal($('#tileModal'));
    show('salesiq');
    setTimeout(() => { const el = $('#siq-team-select'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); } }, 120);
    return true;
  }
  async function sendIq(c) {
    const name = c.name || c.email;
    const s = iqOf(c);
    if (s && s.status === 'completed') {
      show('salesiq');
      if (window.SalesIQ) window.SalesIQ.openCandidate(s.id);
      return;
    }
    if (!c.email) { toast(`${name} has no email address to send the questionnaire to.`, true); return; }
    if (s && s.status === 'invited' && !confirm(`${name} has already been sent the Sales IQ questionnaire. Send it again?`)) return;
    try {
      const r = await window.SalesIQ.sendFromPipeline(c);
      if (r.already) toast(`${name} has already completed the Sales IQ questionnaire.`);
      else if (r.needsMail) toast(`Your mail app has opened with ${String(name).split(' ')[0]}'s questionnaire invite — just hit send.`);
      else toast(`Sales IQ questionnaire emailed to ${c.email}.`);
      await refresh();
    } catch (err) {
      if (!iqNeedsResults(err)) oops(err);
    }
  }

  // ---------------- Onboarding docs, beside a candidate ----------------
  // Whether someone has been sent their onboarding packet, and whether it has
  // come back signed — by address, from the state, as with Sales IQ.
  function onbOf(c) {
    return sideRecord(state && state.onboarding, c);
  }
  // How far along: '' (not there), on the pipeline, packet sent, signed.
  const onbStage = (o) => (!o ? '' : o.signedAt ? 'signed' : o.sentAt ? 'sent' : o.onPipeline ? 'pipeline' : '');
  function onbBadge(o) {
    const stage = onbStage(o);
    if (stage === 'signed') return '<span class="badge iq-badge tint-green" title="Signed and returned their onboarding paperwork">Docs signed</span>';
    if (stage === 'sent') return '<span class="badge iq-badge tint-navy" title="Sent their onboarding packet — waiting on their signature">Docs sent</span>';
    if (stage === 'pipeline') return '<span class="badge iq-badge" title="On the Onboarding docs pipeline — packet not sent yet">Docs · not sent</span>';
    return '';
  }
  function onbActionLabel(c) {
    const stage = onbStage(onbOf(c));
    if (stage === 'signed') return 'See their signed paperwork';
    if (stage) return 'Open their onboarding card';
    return 'Send onboarding docs';
  }
  // Onto the Onboarding docs pipeline (once), and there, on their card —
  // where one tap sends the packet.
  async function sendOnb(c) {
    const name = c.name || c.email;
    if (!c.email) { toast(`${name} has no email address to send the onboarding packet to.`, true); return; }
    const o = onbOf(c);
    if (o && o.signedAt) { window.Onboarding.openSigned(c.email).catch(oops); return; }
    try {
      const r = await window.Onboarding.addFromCrm(c);
      if (!r.already) toast(`${String(name).split(' ')[0]} is on the Onboarding docs pipeline — send their packet from their card.`);
    } catch (err) {
      oops(err);
    }
  }

  // ---------------- Stat tiles → detail views ----------------
  const fmtWhen = dateFormat([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function candRow(c, metaHtml, sideHtml = '', extraHtml = '') {
    const name = c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;
    const detail = [c.role, c.company].filter(Boolean).join(' @ ');
    return `<li class="tile-row">
      <span class="avatar tint-blue">${esc(initials(c))}</span>
      <div class="tile-main">
        <div class="tile-name">${esc(name)}</div>
        <div class="tile-email">${esc(c.email)}${detail ? ` · ${esc(detail)}` : ''}</div>
        <div class="tile-meta">${metaHtml}</div>
        ${extraHtml}
      </div>
      ${nativeActs({ phone: c.phone, email: c.email, name }, { size: 32, cls: 'tile-native m-only' })}
      <div class="tile-side">${sideHtml}</div>
    </li>`;
  }
  // An interview about to start, or one that started a few minutes ago, is
  // the moment somebody is not there yet — say so, beside Call and Message.
  function startsSoon(startIso) {
    const mins = Math.round((new Date(startIso).getTime() - Date.now()) / 60000);
    if (mins > 60 || mins < -45) return '';
    const text = mins > 0 ? `Starts in ${mins} min` : mins === 0 ? 'Starting now' : `Started ${-mins} min ago`;
    return `<span class="soon-tag${mins <= 0 ? ' is-now' : ''}">${text}</span>`;
  }
  const statusSelect = (c) => statusControl(c, 'tile-status');
  const gmailLink = (c) => c.gmailThreadId ? `<a class="tile-link" target="_blank" rel="noopener" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(c.gmailThreadId)}">${icon('mail', 13)} Open in Gmail</a>` : '';

  function openTile(kind) {
    if (kind === 'all') {
      filter = 'all';
      $('#stageFilter').value = 'all';
      renderCandidates();
      show('candidates');
      return;
    }
    const list = $('#tileList');
    const actions = $('#tileActions');
    actions.innerHTML = '';
    let rows = [];
    if (kind === 'emailed') {
      const cs = state.candidates.filter((c) => c.status === 'emailed').sort((a, b) => String(b.lastEmailedAt || '').localeCompare(String(a.lastEmailedAt || '')));
      $('#tileTitle').textContent = `Emailed · awaiting a reply (${cs.length})`;
      $('#tileSub').textContent = 'Everyone who has been emailed and has not replied or booked yet.';
      const due = new Set(followUpDueIds());
      if (due.size) actions.innerHTML = `<button class="btn follow-up-btn" id="tileFollowUpBtn">${icon('reply', 14)} Follow up with ${due.size}</button><span class="muted small">Replies in the same conversation to everyone who is due.</span>`;
      rows = cs.map((c) => candRow(c,
        `Sent ${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : ''}${c.followUpCount ? ` · followed up ${c.followUpCount}×` : ''} · ${c.openedAt ? `${icon('eye', 12)} opened ${timeAgo(c.openedAt)}` : 'not opened yet'}${c.pastRoles ? ` · previously ${String(c.pastRoles).split('|').map((x) => x.trim()).filter(Boolean).slice(0, 2).join('; ')}` : ''}${due.has(c.id) ? ' · <span class="due-tag">due a follow-up</span>' : ''}`,
        `<button class="tile-link tile-followup" data-id="${esc(c.id)}">${icon('reply', 13)} Follow up</button>${statusSelect(c)}${gmailLink(c)}`));
    } else if (kind === 'replied') {
      const cs = state.candidates.filter((c) => c.status === 'replied').sort((a, b) => String(b.lastReplyAt || b.repliedAt || '').localeCompare(String(a.lastReplyAt || a.repliedAt || '')));
      $('#tileTitle').textContent = `Replied (${cs.length})`;
      $('#tileSub').textContent = 'Real replies only — bounces and automatic replies are filtered out. Change a status here once you have followed up.';
      rows = cs.map((c) => {
        const reps = c.emailReplies || 0;
        const text = (c.emailLast && c.emailLast.text) || '';
        const quote = text
          ? `<blockquote class="reply-quote">${esc(text)}</blockquote>`
          : `<blockquote class="reply-quote muted-quote">${replyTextLimited
              ? 'Reply text can’t be read with the current Google permissions — Settings → Google → Reconnect and tick every box.'
              : 'Reply text hasn’t been captured yet — it fills in automatically within a minute or two. Use “Open in Gmail” to read it now.'}</blockquote>`;
        const when = c.lastReplyAt || c.repliedAt;
        return candRow(c, `Replied ${when ? timeAgo(when) : ''}${reps > 1 ? ` · ${reps} messages` : ''}`,
          `${statusSelect(c)}${gmailLink(c)}`, quote);
      });
    } else if (kind === 'booked') {
      const sync = state.calendly || {};
      const items = sync.syncEnabled ? upcomingInterviews() : [];
      const bookedCands = state.candidates.filter((c) => c.status === 'booked');
      $('#tileTitle').textContent = `Interviews booked (${sync.syncEnabled ? items.length : bookedCands.length})`;
      $('#tileSub').textContent = sync.syncEnabled ? 'Upcoming interviews from your Calendly, matched to your candidates.' : 'Candidates marked Booked. Add your Calendly token in Settings to sync every scheduled interview here.';
      if (sync.syncEnabled) {
        actions.innerHTML = `<button class="btn" id="syncNowBtn">${icon('calendar', 14)} Sync now</button><span>${sync.lastSyncAt ? `Last synced ${timeAgo(sync.lastSyncAt)}` : 'Not synced yet'}${sync.error ? ` · <span style="color:var(--red)">${esc(sync.error)}</span>` : ''}</span>`;
        rows = items.map((i) => {
          const c = i.candidateId ? candById(i.candidateId) : null;
          const who = c ? (c.name || c.email) : (i.inviteeName || i.inviteeEmail || 'Unknown invitee');
          const detail = c ? [c.role, c.company].filter(Boolean).join(' @ ') : 'not in your candidate list';
          return `<li class="tile-row">
            <span class="avatar tint-green">${esc(initials(c || { name: who, email: i.inviteeEmail }))}</span>
            <div class="tile-main">
              <div class="tile-when">${esc(fmtWhen(i.start))}${i.end ? ` – ${clockTime(i.end)}` : ''}${startsSoon(i.start)}</div>
              <div class="tile-name">${esc(who)} <span class="muted small">· ${esc(i.name)}</span></div>
              <div class="tile-email">${esc(i.inviteeEmail || (c && c.email) || '')}${detail ? ` · ${esc(detail)}` : ''}</div>
            </div>
            ${nativeActs({ phone: (c && c.phone) || i.inviteePhone, email: i.inviteeEmail || (c && c.email), name: who }, { size: 32, cls: 'tile-native m-only' })}
            <div class="tile-side">
              ${iqTile(i.inviteeEmail || (c && c.email))}
              ${i.joinUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(i.joinUrl)}">Join call</a>` : ''}
              ${i.rescheduleUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(i.rescheduleUrl)}">Reschedule</a>` : ''}
              ${c ? statusSelect(c) : `<button class="tile-link link-btn" data-uri="${esc(i.uri)}" data-email="${esc(i.inviteeEmail || '')}" data-name="${esc(i.inviteeName || '')}">${icon('users', 13)} Link to candidate</button>`}
            </div>
          </li>`;
        });
      } else {
        rows = bookedCands.map((c) => candRow(c, `Interview ${c.bookedAt ? fmtWhen(c.bookedAt) : 'time not recorded'}${c.bookedEvent ? ` · ${esc(c.bookedEvent)}` : ''}${c.bookedAt ? startsSoon(c.bookedAt) : ''}`,
          `${iqTile(c.email)}${c.bookedJoinUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(c.bookedJoinUrl)}">Join call</a>` : ''}${statusSelect(c)}`));
      }
    }
    list.innerHTML = rows.length ? rows.join('') : '<li class="tile-empty">Nothing here yet.</li>';
    openModal('#tileModal');
  }
  $$('.stat-card[data-tile]').forEach((card) => {
    card.addEventListener('click', () => openTile(card.dataset.tile));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTile(card.dataset.tile); } });
  });
  // Link an unmatched Calendly booking to a candidate: inline search, click to link.
  $('#tileActions').addEventListener('click', (e) => {
    if (e.target.closest('#tileFollowUpBtn')) { closeModal($('#tileModal')); openCompose(followUpDueIds(), null, { followUp: true }); }
  });
  $('#tileList').addEventListener('click', async (e) => {
    const iq = e.target.closest('.iq-send');
    if (iq) {
      iq.disabled = true;
      try {
        const r = await window.SalesIQ.sendInvite(iq.dataset.iq);
        const who = r.cand.name || r.cand.email;
        toast(r.already === 'completed' ? `${who} has already completed the Sales IQ questionnaire.`
          : r.already ? `${who} has already been sent the Sales IQ questionnaire.`
          : r.draft ? `Your mail app has opened with ${String(r.cand.name || '').split(' ')[0] || 'their'}'s questionnaire invite — just hit send.`
          : `Sales IQ questionnaire emailed to ${r.cand.email}.`);
        await refresh();
        openTile('booked');
      } catch (err) {
        iq.disabled = false;
        if (!iqNeedsResults(err)) oops(err);
      }
      return;
    }
    const fu = e.target.closest('.tile-followup');
    if (fu) { closeModal($('#tileModal')); openCompose([fu.dataset.id], null, { followUp: true }); return; }
    const btn = e.target.closest('.link-btn');
    if (!btn) return;
    const row = btn.closest('.tile-row');
    const existing = row.querySelector('.link-box');
    if (existing) { existing.remove(); return; }
    const box = document.createElement('div');
    box.className = 'link-box';
    box.innerHTML = `<input class="input link-input" placeholder="Type the candidate's name or email…"><ul class="link-results"></ul>`;
    row.querySelector('.tile-main').appendChild(box);
    const input = box.querySelector('.link-input');
    const ul = box.querySelector('.link-results');
    const render = () => {
      const qv = input.value.trim().toLowerCase();
      const hits = qv.length < 2 ? [] : state.candidates.filter((c) => `${c.name || ''} ${c.email || ''} ${c.company || ''}`.toLowerCase().includes(qv)).slice(0, 6);
      ul.innerHTML = hits.map((c) => `<li data-id="${c.id}"><strong>${esc(c.name || c.email)}</strong> <span class="muted small">${esc(c.email)}${c.role ? ` · ${esc(c.role)}` : ''}</span></li>`).join('')
        || (qv.length >= 2 ? '<li class="link-none muted small">No candidate matches — try part of the name or email.</li>' : '');
    };
    input.addEventListener('input', render);
    ul.addEventListener('click', async (ev) => {
      const li = ev.target.closest('li[data-id]');
      if (!li) return;
      try {
        const r = await api('/api/interviews/link', { method: 'POST', body: { uri: btn.dataset.uri, inviteeEmail: btn.dataset.email, candidateId: li.dataset.id } });
        toast(`Linked to ${r.candidate.name || r.candidate.email}.`);
        await refresh();
        openTile('booked');
      } catch (err) { oops(err); }
    });
    // Start from the name they booked with — usually enough to find them.
    input.value = (btn.dataset.name || '').split(' ')[0] || '';
    render();
    input.focus();
  });
  $('#tileList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('tile-status')) return;
    setStatus(e.target.dataset.id, e.target.value);
  });
  $('#tileActions').addEventListener('click', async (e) => {
    if (!e.target.closest('#syncNowBtn')) return;
    const b = e.target.closest('#syncNowBtn'); b.disabled = true; b.textContent = 'Syncing…';
    try { const r = await api('/api/calendly/sync', { method: 'POST' }); if (r.error) toast(r.error, true); await refresh(); openTile('booked'); }
    catch (err) { oops(err); b.disabled = false; }
  });

  // Pull interviews from Calendly on load and every 5 minutes while open.
  async function syncCalendly() {
    if (!signedIn || !state || !state.calendly || !state.calendly.syncEnabled || document.hidden) return;
    try {
      const r = await api('/api/calendly/sync', { method: 'POST' });
      if (r.newBookings > 0) { await refresh(); toast(`${r.newBookings} new interview${r.newBookings === 1 ? '' : 's'} booked.`); }
      // A sync that changed nothing has nothing to show, and looking anyway
      // fetched the whole state every five minutes for it. A server that does
      // not say (one from before it could) is looked at, as it always was.
      else if (r.ok && r.changed !== false) refresh().catch(() => {});
    } catch {}
  }

  // Everyone still at "Not contacted", kept until the list changes. (The
  // Email page's button counts them after every new state, from any page.)
  const uncontactedIds = kept(() => [listVersion, state && state.candidates],
    () => state.candidates.filter((c) => c.status === 'new').map((c) => c.id));

  // The two channels as funnels, drawn against the same scale so the shapes can
  // be compared at a glance. Texting is the one that can show delivered and
  // read at all — email has no equivalent — so the rows deliberately differ
  // rather than being forced into a shared shape that flatters neither.
  function renderChannels(t, e) {
    const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');
    const funnel = (el, rows, top) => {
      const base = Math.max(1, top);
      $(el).innerHTML = rows.map(([label, n, color, note]) => `
        <div class="funnel-row">
          <div class="funnel-label">${label}</div>
          <div class="funnel-track"><div class="funnel-fill" style="width:${Math.min(100, (n / base) * 100)}%;background:${color}"></div></div>
          <div class="funnel-n">${n.toLocaleString()}</div>
          <div class="funnel-pct">${note !== undefined ? note : pct(n, top)}</div>
        </div>`).join('');
    };

    funnel('#emailFunnel', [
      ['Sent', e.sent, 'var(--blue)', ''],
      ['Opened', e.opened, 'var(--mint)'],
      ['Replied', e.replied, 'var(--green)'],
      ['Booked', e.booked, '#23a55a'],
      ['Bounced', e.bounced, 'var(--amber)'],
    ], e.sent);

    funnel('#textFunnel', [
      ['Sent', t.sent, 'var(--blue)', ''],
      ['Delivered', t.delivered, 'var(--mint)'],
      ['Read', t.read, 'var(--green)'],
      ['Replied', t.replied, '#23a55a'],
      ['No iMessage', t.dead, 'var(--amber)'],
    ], t.sent);

    const q = (state.texting && state.texting.queue) || {};
    const relay = q.relay || {};
    const chip = $('#chTextRelay');
    chip.className = `badge ${relay.online ? 'tint-green' : 'tint-navy'}`;
    chip.textContent = relay.online ? 'Mac online' : 'Mac offline';
  }

  // What the daily allowance has been spent on today, and what is left.
  // ---------- Candidate updates ----------
  // One chronological feed carrying both channels. Email outnumbers texting by
  // orders of magnitude — a few thousand sent emails produce opens all day —
  // so without a way to ask for one channel, every text reply is buried under
  // opens within minutes of arriving. Bookings and cancellations are the
  // outcome both channels are chasing, so they show under every filter.
  const FEED_KIND = {
    opened:         { ico: 'eye',      cls: 'tint-blue',  ch: 'email', tag: 'Email' },
    replied:        { ico: 'mail',     cls: 'tint-mint',  ch: 'email', tag: 'Email' },
    'text-read':    { ico: 'eye',      cls: 'tint-mint',  ch: 'text',  tag: 'Text' },
    'text-replied': { ico: 'bubble',   cls: 'tint-green', ch: 'text',  tag: 'Text' },
    'text-optout':  { ico: 'xcircle',  cls: 'tint-red',   ch: 'text',  tag: 'Text' },
    texted:         { ico: 'send',     cls: 'tint-blue',  ch: 'text',  tag: 'Text' },
    booked:         { ico: 'calendar', cls: 'tint-green', ch: 'both',  tag: '' },
    canceled:       { ico: 'xcircle',  cls: 'tint-red',   ch: 'both',  tag: '' },
    // A finished Sales IQ questionnaire: the step after a booking, so it too
    // shows whichever channel the feed is filtered to.
    assessed:       { ico: 'clipboard', cls: 'tint-blue', ch: 'both',  tag: '', topic: 'iq' },
    // Onboarding paperwork signed and returned: the last step of all.
    signed:         { ico: 'signdoc',   cls: 'tint-green', ch: 'both', tag: '', topic: 'onb' },
  };

  function readFeedChannel() {
    try {
      const v = localStorage.getItem(teamKey('feedChannel'));
      return ['email', 'text', 'iq', 'onb'].includes(v) ? v : 'all';
    } catch { return 'all'; }
  }

  function feedEvents(channel) {
    return (state.events || []).filter((ev) => {
      const k = FEED_KIND[ev.type];
      if (!k) return false;
      // Sales IQ and Onboarding docs: just their own news.
      if (channel === 'iq' || channel === 'onb') return k.topic === channel;
      return channel === 'all' || k.ch === 'both' || k.ch === channel;
    });
  }

  function renderFeed() {
    // The chip counts each channel's own updates. Bookings show under every
    // filter but are counted only in All, so "Texting 2" never means "2, one
    // of which is a booking".
    const shown = feedEvents('all');
    const own = (ch) => shown.filter((ev) => FEED_KIND[ev.type].ch === ch).length;
    const topic = (t) => shown.filter((ev) => FEED_KIND[ev.type].topic === t).length;
    const counts = { all: shown.length, email: own('email'), text: own('text'), iq: topic('iq'), onb: topic('onb') };
    // A filter that can only ever show what "All" already shows is noise, so
    // the row appears once there is genuinely something to separate — and
    // then only the chips that have something behind them.
    const kinds = ['email', 'text', 'iq', 'onb'].filter((k) => counts[k] > 0);
    const worthFiltering = kinds.length >= 2;
    const chips = [['all', 'All'], ['email', 'Email'], ['text', 'Texting'], ['iq', 'Sales IQ'], ['onb', 'Onboarding']]
      .filter(([k]) => k === 'all' || counts[k] > 0);
    // Settled before the chips are drawn, so the one lit is the one shown.
    if (!worthFiltering || !chips.some(([k]) => k === feedChannel)) feedChannel = 'all';
    $('#feedFilters').innerHTML = worthFiltering
      ? chips.map(([k, label]) =>
          `<button class="feed-chip${feedChannel === k ? ' on' : ''}" data-feed="${k}">${label}<span class="feed-n">${counts[k]}</span></button>`).join('')
      : '';

    const list = feedRows(feedEvents(feedChannel), 15);
    const empty = feedChannel === 'iq'
      ? 'No finished questionnaires yet.'
      : feedChannel === 'onb'
        ? 'No signed paperwork yet.'
        : feedChannel === 'text'
      ? 'No texting updates yet — reads, replies and opt-outs show up here.'
      : feedChannel === 'email'
        ? 'No email updates yet — opens and replies show up here.'
        : 'No updates yet — opens, replies, texts, bookings, cancellations, finished questionnaires and signed paperwork show up here.';
    $('#activityList').innerHTML = list.length
      ? list.map((ev) => {
          const k = FEED_KIND[ev.type];
          const to = !ev.more.length && feedTarget(ev);
          const tag = to ? 'button' : 'div';
          return `<li><${tag} class="act-row${to ? ' act-open' : ''}"${to ? ` type="button" data-feed-open="${esc(ev.candidateId)}" data-feed-to="${to}"` : ''}>
            <span class="act-ico ${k.cls}">${icon(k.ico, 14)}</span>
            <span class="act-main"><span class="act-msg">${esc(feedMessage(ev))}</span>
              <span class="act-time">${k.tag ? `<span class="act-tag ch-${k.ch}">${k.tag}</span>` : ''}<span data-ago="${esc(ev.ts)}">${timeAgo(ev.ts)}</span></span></span>
            ${to ? `<span class="act-chev">${icon('chevron', 13)}</span>` : ''}</${tag}></li>`;
        }).join('')
      : `<li class="empty-line">${empty}</li>`;
  }

  // A send wave's opens arrive together, and a hundred lines of "opened your
  // email" buried the one reply that mattered — and read as the same update
  // over and over. A run of them is one line.
  const FEED_FOLDS = { opened: ' opened your email', 'text-read': ' read your text' };
  function feedRows(events, limit) {
    const out = [];
    for (const ev of events) {
      const prev = out[out.length - 1];
      if (FEED_FOLDS[ev.type] && prev && prev.type === ev.type) { prev.more.push(ev); continue; }
      if (out.length >= limit) break;
      out.push({ ...ev, more: [] });
    }
    return out;
  }
  function feedMessage(ev) {
    if (!ev.more.length) return ev.message;
    const tail = FEED_FOLDS[ev.type];
    const who = String(ev.message || '').replace(/\.$/, '').replace(tail, '');
    const n = ev.more.length;
    return `${who} and ${n.toLocaleString()} other${n === 1 ? '' : 's'}${tail}.`;
  }
  // Where tapping an update takes you: the conversation it is about, or the
  // person. Nowhere, if they have since been removed.
  function feedTarget(ev) {
    if (!ev.candidateId || !candById(ev.candidateId)) return '';
    if (ev.type === 'replied') return 'email';
    if (ev.type === 'text-replied' || ev.type === 'text-optout' || ev.type === 'text-read') return 'text';
    return 'profile';
  }
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-feed-open]');
    if (!row) return;
    const c = candById(row.dataset.feedOpen);
    if (!c) return;
    if (row.dataset.feedTo === 'email') { show('template'); openMail(c.id); }
    else if (row.dataset.feedTo === 'text') { show('texting'); openThread(c.id); }
    else openProfile(c);
  });

  // "just now" has to become "5m ago" without waiting for something else to
  // change: an unchanged poll draws nothing, so the times are kept moving here.
  // Only the ones that can be seen — the page on screen and the bell's panel
  // when it is open; a page is brought up to date as it is shown (show()).
  function tickAgo(root) {
    if (!root) return;
    root.querySelectorAll('[data-ago]').forEach((el) => {
      const t = timeAgo(el.dataset.ago);
      if (el.textContent !== t) el.textContent = t;
    });
  }
  setInterval(() => {
    if (document.hidden) return;
    tickAgo($('.view.active'));
    if (!$('#bellPanel').hidden) tickAgo($('#bellPanel'));
  }, 60000);

  function renderTextToday(t) {
    const q = (state.texting && state.texting.queue) || {};
    const used = q.sentToday || 0;
    const cap = q.dailyLimit || 0;
    $('#textTodayBadge').textContent = cap ? `${used} of ${cap} used` : 'not set up';
    const relay = q.relay || {};
    const items = [
      ['Sent today', used],
      ['Left today', Math.max(0, cap - used)],
      ['Waiting in the queue', q.pending || 0],
      ['Replied to a text', t.replied],
    ];
    $('#textToday').innerHTML = items.map(([label, n]) => `
      <div class="today-cell"><div class="today-n">${Number(n).toLocaleString()}</div><div class="today-label">${label}</div></div>`).join('');
    const note = $('#textTodayNote');
    note.title = '';
    note.textContent = !relay.online
      ? 'The Mac relay is offline, so nothing will send until it is back.'
      : q.pending
        ? `Sending about one every ${Math.round(((q.minGap || 45) + (q.maxGap || 150)) / 2)}s, ${q.startHour}:00–${q.endHour}:00 in each person's own timezone.`
        : '';
  }

  function renderSendingCard() {
    const q = state.queue || {};
    const card = $('#sendingCard');
    const show = q.active || q.failed > 0;
    card.hidden = !show;
    if (!show) return;
    const total = q.total || (q.pending + q.sent);
    const pct = total ? Math.round((q.sent / total) * 100) : 100;
    $('#sendingFill').style.width = `${pct}%`;
    $('#sendingBadge').textContent = q.active ? `${q.sent} of ${total} sent` : `finished · ${q.sent} sent`;
    const parts = [];
    const clock = (iso) => {
      const d = new Date(iso);
      const sameDay = d.toDateString() === new Date().toDateString();
      return clockTime(d) + (sameDay ? '' : ` ${weekdayShort(d)}`);
    };
    const remainingToday = Number.isFinite(q.remainingToday) ? q.remainingToday : Math.max(0, (q.dailyLimit || 0) - (q.sentToday || 0));
    if (q.active) {
      if (q.pausedUntil && q.pauseKind === 'daily') {
        // Not a Gmail throttle — the Daily send limit from Settings. Say when it frees up and how to send more today.
        parts.push(`${q.pending} still to send`);
        parts.push(`daily limit of ${q.dailyLimit} reached (${q.sentToday} sent in the last 24h) — sending resumes automatically at ${clock(q.pausedUntil)} as the 24-hour window frees up`);
        if (q.dailyMax && q.dailyLimit < q.dailyMax) parts.push(`Gmail allows up to ${q.dailyMax.toLocaleString()} a day: raise the limit in Settings → Sending pace to send more today`);
      } else if (q.pausedUntil) {
        parts.push(`${q.pending} still to send`);
        const why = q.note || (q.pauseKind === 'not-ready' ? 'Email is not set up — sending is paused.' : 'Sending is paused.');
        parts.push(why);
        // Don't repeat a time the message already gives, and don't promise a
        // resume time for a pause only reconnecting email can end.
        if (q.pauseKind !== 'not-ready' && !/\buntil\b/i.test(why)) parts.push(`it resumes at ${clock(q.pausedUntil)}`);
        parts.push(`${q.sentToday} sent in the last 24h (limit ${q.dailyLimit})`);
      } else {
        const today = Math.min(q.pending, remainingToday);
        const minutes = Math.max(1, Math.ceil(today / (q.perMinute || 1)));
        const eta = minutes >= 90 ? `about ${Math.round(minutes / 60)} h` : `about ${minutes} min`;
        parts.push(`${q.pending} still to send at up to ${q.perMinute}/min${today ? ` (${eta} for ${today === q.pending ? 'all of them' : `the ${today} that fit today`})` : ''}`);
        if (today < q.pending) {
          const from = q.windowFreesAt || q.resumeAt;
          parts.push(`the other ${q.pending - today} continue automatically once the 24-hour window frees up${from ? ` (from ${clock(from)})` : ''}`
            + (q.dailyMax && q.dailyLimit < q.dailyMax ? ` — Gmail allows up to ${q.dailyMax.toLocaleString()} a day, so raising the Daily send limit in Settings sends more today` : ' — Gmail allows no more than that per day'));
        }
        parts.push(`${q.sentToday} sent in the last 24h (limit ${q.dailyLimit})`);
        if (q.note) parts.push(q.note);
      }
    } else {
      parts.push(`${q.sentToday} sent in the last 24h (limit ${q.dailyLimit})`);
      if (q.note) parts.push(q.note);
    }
    if (q.failed) parts.push(`${q.failed} failed — ${q.failures.map((f) => `${f.email}: ${f.error}`).slice(-3).join(' · ')}`);
    const meta = parts.join(' · ');
    $('#sendingMeta').textContent = meta;
    $('#sendingMeta').title = meta;   // clamped to three lines; hover for the rest
    $('#retryFailedBtn').hidden = !q.failed;
    $('#retryFailedBtn').textContent = `Retry ${q.failed} failed`;
    $('#stopQueueBtn').hidden = !q.active;
    $('#stopQueueBtn').textContent = 'Stop sending';
  }

  $('#stopQueueBtn').addEventListener('click', async () => {
    if (!confirm('Stop sending? Emails not yet sent stay marked "Not contacted".')) return;
    try { await api('/api/queue', { method: 'DELETE' }); toast('Sending stopped.'); await refresh(); } catch (err) { oops(err); }
  });
  $('#retryFailedBtn').addEventListener('click', async () => {
    try { const r = await api('/api/queue/retry-failed', { method: 'POST' }); toast(`${r.added} emails re-queued.`); await refresh(); } catch (err) { oops(err); }
  });

  // While a queue is active, refresh faster and (locally, without Netlify's
  // scheduler) drive the queue from here.
  let queueTimer = null;
  function scheduleQueueWork() {
    const active = state && state.queue && state.queue.active;
    if (active && !queueTimer) {
      queueTimer = setInterval(async () => {
        try { await api('/api/queue/run', { method: 'POST' }); } catch {}
        refresh().catch(() => {});
      }, 60000);
    } else if (!active && queueTimer) {
      clearInterval(queueTimer);
      queueTimer = null;
    }
  }

  function renderEmailAllButtons() {
    const n = uncontactedIds().length;
    const label = n ? `Email all ${n} not contacted` : 'Everyone has been contacted';
    $$('.email-all-btn').forEach((b) => { b.textContent = label; b.disabled = n === 0; });
    const due = followUpDueIds().length;
    $$('.follow-up-btn').forEach((b) => {
      b.innerHTML = `${icon('reply', 15)} ${due ? `Follow up with ${due}` : 'No follow-ups due'}`;
      b.disabled = due === 0;
      b.title = due ? `Reply in the same conversation to the ${due} ${due === 1 ? 'person' : 'people'} who haven't answered` : `People become due ${state.followUp ? state.followUp.days : 3} days after their last email if they haven't replied`;
    });
    $('#followUpDueBadge').textContent = due ? `${due} due` : 'nobody due';
  }

  const shortDay = dateFormat('en-US', { month: 'short', day: 'numeric' });
  function timeAgo(ts) {
    const sec = (Date.now() - new Date(ts).getTime()) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return shortDay(ts);
  }

  // ---------------- Candidates ----------------
  // A role written a dozen slightly different ways is still one role to a
  // person reading the list, so compare them loosely.
  const roleKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Everyone's place in the list, by id, for the many places that start from
  // an id (the first of any two with one id, as .find() would have it).
  const candPos = kept(() => [listVersion, state && state.candidates], () => {
    const m = new Map();
    ((state && state.candidates) || []).forEach((c, i) => { if (!m.has(c.id)) m.set(c.id, i); });
    return m;
  });
  const candById = (id) => {
    if (!state || !state.candidates) return null;
    const i = candPos().get(id);
    return i === undefined ? null : state.candidates[i];
  };

  // Strings compared the way localeCompare compares them, without making a
  // new collator for every pair.
  const collator = new Intl.Collator();

  // ---- the index ----
  // What the filters, the pills and the menus ask of each person, worked out
  // once per version of the list in one pass: where they are with Sales IQ and
  // Onboarding docs, the number a text would go to, their role as compared,
  // their industry — and every count the pills and the menus show. Rendering
  // the page used to walk all 33,000 people some twenty-five times to count
  // them, on every render.
  const IQ_TIER_KEYS = new Set(['elite', 'strong', 'develop', 'notready']);
  const candIndex = kept(
    () => [listVersion, state && state.candidates, state && state.salesiq, state && state.onboarding],
    () => {
      const all = (state && state.candidates) || [];
      const n = all.length;
      const idx = {
        n, pos: candPos(), iq: new Array(n), stage: new Array(n), phone: new Array(n), role: new Array(n), industry: new Array(n),
        status: {}, roles: new Map(), noRole: 0, byIndustry: {}, noNumber: 0,
        iqN: { any: 0, none: 0, added: 0, invited: 0, completed: 0, elite: 0, strong: 0, develop: 0, notready: 0 },
        onbN: { any: 0, none: 0, pipeline: 0, sent: 0, signed: 0 },
      };
      for (let i = 0; i < n; i++) {
        const c = all[i];
        idx.status[c.status] = (idx.status[c.status] || 0) + 1;
        const key = roleKey(c.role);
        idx.role[i] = key;
        if (key) {
          const entry = idx.roles.get(key);
          if (entry) entry.n += 1;
          else idx.roles.set(key, { label: String(c.role).trim(), n: 1 });
        } else idx.noRole += 1;
        const ind = c.industry || 'other';
        idx.industry[i] = ind;
        idx.byIndustry[ind] = (idx.byIndustry[ind] || 0) + 1;
        const ph = textPhoneOf(c);
        idx.phone[i] = ph;
        if (!ph) idx.noNumber += 1;
        // Counted the way iqMatch() and onbMatch() decide them.
        const s = iqOf(c);
        idx.iq[i] = s;
        if (!s) idx.iqN.none += 1;
        else {
          idx.iqN.any += 1;
          if (s.status === 'added' || s.status === 'invited' || s.status === 'completed') idx.iqN[s.status] += 1;
          if (s.status === 'completed' && IQ_TIER_KEYS.has(s.tierKey)) idx.iqN[s.tierKey] += 1;
        }
        const stage = onbStage(onbOf(c));
        idx.stage[i] = stage;
        if (!stage) idx.onbN.none += 1;
        else { idx.onbN.any += 1; idx.onbN[stage] += 1; }
      }
      return idx;
    },
  );

  // ---- search ----
  // What a search looks through, made the first time somebody searches this
  // version of the list (and warmed when the box is focused) rather than
  // lowercased afresh for every person on every keystroke. One string per
  // person: the fields, lowercased, joined by a character nobody types, so a
  // match is still a match within one field.
  const SEARCH_FIELDS = ['name', 'firstName', 'lastName', 'email', 'role', 'company', 'pastRoles', 'phone', 'location'];
  // A US number is stored and typed with and without the leading 1, so drop
  // it from both sides before comparing — otherwise "+1 617 235 0003" is
  // longer than the number it is looking for and matches nothing.
  const phoneTail = (d) => (d.length === 11 && d[0] === '1' ? d.slice(1) : d);
  const searchIndex = kept(() => [listVersion, state && state.candidates], () => {
    const all = (state && state.candidates) || [];
    const hay = new Array(all.length);
    const digits = new Array(all.length);
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      hay[i] = SEARCH_FIELDS.map((f) => String(c[f] || '').toLowerCase()).join('\u0001');
      digits[i] = phoneTail(String(c.phone || '').replace(/\D/g, ''));
    }
    return { hay, digits };
  });

  // Who the filters and the search let through, in the list's own order.
  // Kept for this version of the list and this exact question, so paging,
  // ticking and the redraw after a status change do not filter 33,000 again.
  let visibleKept = { keys: null, rows: [] };
  forgetWithState(() => { visibleKept = { keys: null, rows: [] }; });
  function visibleCandidates() {
    const pri = state.texting && state.texting.priority;
    const keys = [listVersion, state.candidates, state.salesiq, state.onboarding, pri,
      filter, roleFilter, industryFilter, addedFilter, textedFilter, rankFilter, iqFilter, onbFilter, search];
    if (visibleKept.keys && keys.every((k, i) => k === visibleKept.keys[i])) return visibleKept.rows;
    const idx = candIndex();
    const all = state.candidates;
    const q = search.toLowerCase().trim();
    // A number is written a dozen ways — (617) 235-0001, 617.235.0001,
    // +1 617 235 0001 — and nobody types it back the way it was stored, so a
    // literal substring match found almost nothing. Once the query looks like a
    // number, compare digits to digits as well.
    const qDigits = phoneTail(q.replace(/\D/g, ''));
    const byDigits = qDigits.length >= 3 && /^[\d\s().+-]+$/.test(q);
    const found = q ? searchIndex() : null;
    const rows = [];
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (filter !== 'all' && c.status !== filter) continue;
      if (roleFilter === '__none' && idx.role[i]) continue;
      if (!matchesFilters(c, i, idx)) continue;
      if (q && !(byDigits && found.digits[i].includes(qDigits)) && !found.hay[i].includes(q)) continue;
      rows.push(c);
    }
    visibleKept = { keys, rows };
    return rows;
  }

  // Every role people currently hold, most common first, with how many hold it.
  function renderRoleFilter() {
    const sel = $('#roleFilter');
    if (!sel) return;
    const idx = candIndex();
    const roles = [...idx.roles.entries()].sort((a, b) => b[1].n - a[1].n || collator.compare(a[1].label, b[1].label));
    const missing = idx.noRole;
    // That role is gone from the list. "No role on file" is not a role, so it
    // stays chosen while anybody still has no role, whatever a refresh brings.
    if (roleFilter === '__none' ? !missing : roleFilter && !idx.roles.has(roleFilter)) roleFilter = '';
    setOptions(sel, `<option value="">All roles (${state.candidates.length})</option>`
      + roles.map(([key, r]) => `<option value="${esc(key)}">${esc(r.label)} (${r.n})</option>`).join('')
      + (missing ? `<option value="__none">No role on file (${missing})</option>` : ''), roleFilter);
    sel.title = roles.length ? `Filter by the role someone currently holds (${roles.length} in your list)` : 'Roles appear here once your candidates have one on file';
  }

  function initials(c) {
    const n = c.name || `${c.firstName} ${c.lastName}` || c.email;
    const parts = n.trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
  }

  const textPriorityOf = (id) => ((state.texting && state.texting.priority && state.texting.priority.order) || {})[id] || null;
  const textBlockedOf = (id) => ((state.texting && state.texting.priority && state.texting.priority.blocked) || {})[id] || '';

  // ---------------- Candidates: overview and filters ----------------
  // 2,800 rows is not a list anybody reads. The page opens on groups worth
  // looking at, each with a real count, and picking one drops into the table
  // already filtered — so the long list is somewhere you arrive on purpose
  // rather than the first thing you have to get past.
  const DAY = 864e5;
  const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY : Infinity);
  const industryLabel = (code) => ((state.industries || {})[code] || 'Other');

  // `i` is their place in the list, and `idx` the index (candIndex()) that
  // already knows the rest about them.
  function matchesFilters(c, i, idx) {
    if (industryFilter && idx.industry[i] !== industryFilter) return false;
    if (roleFilter && roleFilter !== '__none' && idx.role[i] !== roleFilter) return false;

    if (addedFilter === 'old') { if (daysSince(c.addedAt) <= 90) return false; }
    else if (addedFilter && daysSince(c.addedAt) > Number(addedFilter)) return false;

    if (textedFilter) {
      const textable = Boolean(idx.phone[i]);
      if (textedFilter === 'nonumber') { if (textable) return false; }
      else if (textedFilter === 'never') { if (c.lastTextedAt) return false; }
      else if (textedFilter === 'ready') { if (!textPriorityOf(c.id)) return false; }
      else if (textedFilter === 'any') { if (!c.lastTextedAt) return false; }
      else if (daysSince(c.lastTextedAt) > Number(textedFilter)) return false;
    }

    if (rankFilter) {
      const pri = textPriorityOf(c.id);
      if (rankFilter === 'unranked') { if (pri) return false; }
      else if (!pri || pri.rank > Number(rankFilter)) return false;
    }
    if (iqFilter && !iqMatch(idx.iq[i], iqFilter)) return false;
    if (onbFilter && !onbMatch(idx.stage[i], onbFilter)) return false;
    return true;
  }

  // Sales IQ and Onboarding docs, as filters like any other — in the menus,
  // the chips, and behind every number on the Dashboard's trackers.
  const IQ_FILTERS = [
    ['any', 'On Sales IQ'], ['none', 'Not on Sales IQ'], ['added', 'Sales IQ · not sent'], ['invited', 'Questionnaire sent'],
    ['completed', 'Questionnaire done'], ['elite', 'Elite Talent (85+)'], ['strong', 'Strong Potential (70–84)'],
    ['develop', 'Developing (50–69)'], ['notready', 'Not Sales-Ready (under 50)'],
  ];
  const ONB_FILTERS = [
    ['any', 'In Onboarding docs'], ['none', 'Not in Onboarding docs'], ['pipeline', 'Docs · packet not sent'],
    ['sent', 'Docs sent · awaiting signature'], ['signed', 'Docs signed'],
  ];
  // `s` is someone's Sales IQ record (iqOf), `stage` their Onboarding stage
  // (onbStage). The index counts every choice the same way.
  function iqMatch(s, v) {
    if (v === 'none') return !s;
    if (!s) return false;
    if (v === 'any') return true;
    if (['added', 'invited', 'completed'].includes(v)) return s.status === v;
    return s.status === 'completed' && s.tierKey === v;
  }
  function onbMatch(stage, v) {
    if (v === 'none') return !stage;
    if (v === 'any') return Boolean(stage);
    return stage === v;
  }
  const filterLabel = (list, v) => (list.find(([k]) => k === v) || [, v])[1];

  // Jump from a group straight into the table with that filter applied.
  function openSegment(patch) {
    // Every group is a fresh start, not a narrowing of whatever was last set —
    // and that includes the order. Leaving the order alone was why "Everyone"
    // looked exactly like "Best to text next": the ranked order carried over,
    // so the same fifty people stayed on top and only the counter moved. A
    // group that names an order gets it; every other one gets the plain one.
    filter = 'all'; industryFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; roleFilter = '';
    iqFilter = ''; onbFilter = '';
    sortBy = 'default';
    if (patch.iq !== undefined) iqFilter = patch.iq;
    if (patch.onb !== undefined) onbFilter = patch.onb;
    if (patch.status !== undefined) filter = patch.status;
    if (patch.industry !== undefined) industryFilter = patch.industry;
    if (patch.added !== undefined) addedFilter = patch.added;
    if (patch.texted !== undefined) textedFilter = patch.texted;
    if (patch.rank !== undefined) rankFilter = patch.rank;
    if (patch.sort !== undefined) sortBy = patch.sort;
    search = '';
    selected.clear();
    syncFilterControls();
    renderCandidates();
    // No toast. The list in front of you is the answer to "what am I looking
    // at" — a note in the corner repeating the name of the tab you just
    // pressed is one more thing to read and then dismiss.
  }

  // Rewriting a <select>'s options closes it under the cursor of anybody who
  // has it open, and these three run on every poll. Only touch the markup when
  // the options have actually changed.
  // Kept off the element itself: a dataset attribute would put a copy of every
  // option's markup back into the DOM, which is the opposite of the point.
  const lastMarkup = new WeakMap();
  function drawOnce(el, html) {
    if (lastMarkup.get(el) === html) return false;
    lastMarkup.set(el, html);
    el.innerHTML = html;
    return true;
  }
  function setOptions(sel, html, value) {
    drawOnce(sel, html);
    if (sel.value !== value) sel.value = value;
  }

  // Ticking thirty boxes and then narrowing the list used to throw the lot away
  // without a word. Keep whoever is still on screen — so nothing hidden can be
  // emailed or texted either — and say how many fell outside.
  // A search narrows the list as much as any menu does, so it narrows the
  // selection too (`what` names it in the note).
  function narrowSelection(what = 'filter') {
    if (!selected.size) return;
    const before = selected.size;
    const visible = new Set(visibleCandidates().map((c) => c.id));
    for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
    const gone = before - selected.size;
    if (gone) toast(`${gone} selected ${gone === 1 ? 'person' : 'people'} fell outside this ${what} and ${gone === 1 ? 'is' : 'are'} no longer selected.`);
  }

  // Someone removed on another device is not there to email or text, and a
  // selection that still counted them said "3 selected" over two people.
  function pruneSelection() {
    if (!selected.size || !state) return;
    for (const id of [...selected]) if (!candById(id)) selected.delete(id);
  }

  function syncFilterControls() {
    $('#industryFilter').value = industryFilter;
    $('#addedFilter').value = addedFilter;
    $('#textedFilter').value = textedFilter;
    $('#rankFilter').value = rankFilter;
    $('#sortBy').value = sortBy;
    $('#searchInput').value = search;
    $('#stageFilter').value = filter;
    $('#roleFilter').value = roleFilter;
    $('#iqFilter').value = iqFilter;
    $('#onbFilter').value = onbFilter;
  }

  // Thirty-eight tiles of every possible grouping was a page you had to read
  // before you could use it. The groupings all survive as filters below; what
  // stays up here is the handful of starting points worth a single click, plus
  // whatever the current filters add up to.
  function renderPager(total, from, pageCount) {
    const el = $('#candPager');
    el.hidden = total <= PAGE_SIZE;
    if (el.hidden) return;
    $('#pagerRange').textContent = `${(from + 1).toLocaleString()}–${Math.min(from + PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`;
    $('#pagerPage').textContent = `Page ${page + 1} of ${pageCount.toLocaleString()}`;
    $('#pagerPrev').disabled = page === 0;
    $('#pagerNext').disabled = page >= pageCount - 1;
  }

  const rankedCount = kept(() => [stateVersion, state && state.texting && state.texting.priority],
    () => Object.keys(((state.texting && state.texting.priority) || {}).order || {}).length);

  function renderViews() {
    const all = state.candidates || [];
    if (!all.length) { drawOnce($('#candViews'), ''); $('#candCount').textContent = ''; return; }
    const idx = candIndex();
    const ranked = rankedCount();
    const byStatus = (k) => idx.status[k] || 0;

    const views = [
      { label: 'Everyone', n: all.length, patch: {} },
      { label: 'Best to text next', n: Math.min(ranked, 50), patch: { rank: '50', sort: 'texting' } },
      { label: 'Replied', n: byStatus('replied'), patch: { status: 'replied' } },
      { label: 'Not contacted', n: byStatus('new'), patch: { status: 'new' } },
      { label: 'Booked', n: byStatus('booked'), patch: { status: 'booked' } },
      { label: 'Needs a number', n: idx.noNumber, patch: { texted: 'nonumber' } },
      { label: 'Sales IQ done', n: idx.iqN.completed, patch: { iq: 'completed' } },
      { label: 'Docs awaiting signature', n: idx.onbN.sent, patch: { onb: 'sent' } },
      { label: 'Docs signed', n: idx.onbN.signed, patch: { onb: 'signed' } },
    ].filter((v) => v.n > 0);

    // Which pill, if any, describes exactly what is on screen right now.
    const nothingElse = !search && !industryFilter && !roleFilter && !addedFilter;
    const active = (v) => nothingElse
      && (v.patch.iq || '') === iqFilter
      && (v.patch.onb || '') === onbFilter
      && (v.patch.status || 'all') === filter
      && (v.patch.texted || '') === textedFilter
      && (v.patch.rank || '') === rankFilter
      // "Best to text next" is an order as much as a set: once the list is
      // sorted some other way the pill no longer describes what is on screen.
      && (v.patch.sort === undefined || v.patch.sort === sortBy);

    const pills = views.map((v) => `
      <button class="view-pill${active(v) ? ' on' : ''}" data-seg='${esc(JSON.stringify(v.patch))}'>
        ${esc(v.label)}<span class="view-n">${v.n.toLocaleString()}</span>
      </button>`).join('');
    drawOnce($('#candViews'), pills);

    // The industry menu mirrors what actually exists in the list.
    setOptions($('#industryFilter'), '<option value="">Any industry</option>' + Object.entries(idx.byIndustry)
      .sort((x, y) => y[1] - x[1])
      .map(([code, n]) => `<option value="${esc(code)}">${esc(industryLabel(code))} (${n})</option>`).join(''), industryFilter);

    // Sales IQ and Onboarding docs, each option with how many it would show.
    setOptions($('#iqFilter'), '<option value="">Sales IQ: any</option>' + IQ_FILTERS
      .map(([k, label]) => `<option value="${k}">${esc(label)} (${(idx.iqN[k] || 0).toLocaleString()})</option>`).join(''), iqFilter);
    setOptions($('#onbFilter'), '<option value="">Onboarding: any</option>' + ONB_FILTERS
      .map(([k, label]) => `<option value="${k}">${esc(label)} (${(idx.onbN[k] || 0).toLocaleString()})</option>`).join(''), onbFilter);

    // And the stage menu carries its counts, so picking one is informed.
    setOptions($('#stageFilter'), `<option value="all">Any stage (${all.length.toLocaleString()})</option>` + Object.entries(STATUS)
      .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)} (${byStatus(k).toLocaleString()})</option>`).join(''), filter || 'all');
  }

  function renderActiveFilters() {
    const bits = [];
    if (filter !== 'all') bits.push([`Stage: ${(STATUS[filter] || {}).label || filter}`, () => { filter = 'all'; }]);
    if (industryFilter) bits.push([`Industry: ${industryLabel(industryFilter)}`, () => { industryFilter = ''; }]);
    // the select's own wording, not the lowercased key it is matched on —
    // this used to read "Role: account executive", or literally "Role: __none"
    if (roleFilter) bits.push([`Role: ${($('#roleFilter').selectedOptions[0] || {}).textContent || roleFilter}`, () => { roleFilter = ''; }]);
    if (addedFilter) bits.push([`Added: ${$('#addedFilter').selectedOptions[0].textContent}`, () => { addedFilter = ''; }]);
    if (textedFilter) bits.push([`Texting: ${$('#textedFilter').selectedOptions[0].textContent}`, () => { textedFilter = ''; }]);
    if (rankFilter) bits.push([`Ranking: ${$('#rankFilter').selectedOptions[0].textContent}`, () => { rankFilter = ''; }]);
    if (iqFilter) bits.push([`Sales IQ: ${filterLabel(IQ_FILTERS, iqFilter)}`, () => { iqFilter = ''; }]);
    if (onbFilter) bits.push([`Onboarding: ${filterLabel(ONB_FILTERS, onbFilter)}`, () => { onbFilter = ''; }]);
    if (search) bits.push([`Search: “${search}”`, () => { search = ''; }]);
    const label = $('#filtersLabel');
    if (label) label.textContent = bits.length ? `Filters · ${bits.length}` : 'Filters';
    const el = $('#activeFilters');
    el.hidden = bits.length === 0;
    clearFilterActions = bits.map(([, fn]) => fn);
    el.innerHTML = bits.map(([text], i) => `<button class="filter-tag" data-clear="${i}">${esc(text)} <span aria-hidden="true">×</span></button>`).join('')
      + (bits.length > 1 ? '<button class="btn-link" data-clear="all">Clear all</button>' : '');
  }
  let clearFilterActions = [];

  $('#activeFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clear]');
    if (!b) return;
    if (b.dataset.clear === 'all') { filter = 'all'; industryFilter = ''; roleFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; iqFilter = ''; onbFilter = ''; search = ''; }
    else clearFilterActions[Number(b.dataset.clear)]();
    syncFilterControls();
    renderCandidates();
  });

  $('#candViews').addEventListener('click', (e) => {
    const b = e.target.closest('.view-pill');
    if (!b) return;
    openSegment(JSON.parse(b.dataset.seg));
  });

  for (const [id, set] of [['#industryFilter', (v) => { industryFilter = v; }], ['#addedFilter', (v) => { addedFilter = v; }],
    ['#textedFilter', (v) => { textedFilter = v; }], ['#rankFilter', (v) => { rankFilter = v; }],
    ['#iqFilter', (v) => { iqFilter = v; }], ['#onbFilter', (v) => { onbFilter = v; }]]) {
    $(id).addEventListener('change', (e) => { set(e.target.value); narrowSelection(); renderCandidates(); });
  }

  // The rows in the order chosen, kept with the answer they sort: paging
  // through a list sorted by name sorted it again for every page. Each key
  // is worked out once per person rather than twice per comparison, and the
  // sort is stable, so ties keep the list's own order as they always did.
  let sortedKept = { from: null, by: '', rows: [] };
  forgetWithState(() => { sortedKept = { from: null, by: '', rows: [] }; });
  function sortedCandidates() {
    const rows = visibleCandidates();
    if (sortedKept.from === rows && sortedKept.by === sortBy) return sortedKept.rows;
    const byKey = (key, compare) => rows.map((c) => ({ c, k: key(c) })).sort(compare).map((x) => x.c);
    let out = rows;
    if (sortBy === 'newest') out = byKey((c) => String(c.addedAt || ''), (a, b) => collator.compare(b.k, a.k));
    else if (sortBy === 'name') out = byKey((c) => String(c.name || c.email), (a, b) => collator.compare(a.k, b.k));
    else if (sortBy === 'texting') {
      // Ranked people first in their own order, then everyone who cannot be
      // texted — they are still listed, because "why is this person not here"
      // is the first question the order raises.
      out = byKey((c) => textPriorityOf(c.id), (a, b) => {
        const pa = a.k; const pb = b.k;
        if (pa && pb) return pa.rank - pb.rank;
        if (pa) return -1;
        if (pb) return 1;
        return 0;
      });
    }
    sortedKept = { from: rows, by: sortBy, rows: out };
    return out;
  }

  function renderCandidates() {
    renderViews();
    const rows = sortedCandidates();
    const ranking = sortBy === 'texting';
    $('#rankHead').hidden = !ranking;

    // Changing what is being asked for starts again at the first page; paging
    // within the same question keeps your place.
    const sig = JSON.stringify([filter, industryFilter, roleFilter, addedFilter, textedFilter, rankFilter, iqFilter, onbFilter, search, sortBy]);
    if (sig !== lastFilterSig) { lastFilterSig = sig; page = 0; }
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pageCount - 1);
    const from = page * PAGE_SIZE;
    pageRows = rows.slice(from, from + PAGE_SIZE);
    renderPager(rows.length, from, pageCount);

    const tbody = $('#candidateRows');
    $('#candidatesEmpty').style.display = state.candidates.length ? 'none' : 'block';
    tbody.innerHTML = pageRows.map((c, i) => {
      const st = STATUS[c.status] || STATUS.new;
      const displayName = c.name || `${c.firstName} ${c.lastName}`.trim() || '—';
      const pri = ranking ? textPriorityOf(c.id) : null;
      const blockedWhy = ranking ? textBlockedOf(c.id) : '';
      // data-col on every cell: on a phone the row is not a row, it is a card,
      // and the stylesheet places the cells by name. Counting nth-child would
      // break the moment the ranking column appears or disappears.
      return `<tr data-id="${c.id}" class="cand-row${ranking && !pri ? ' row-muted' : ''}" tabindex="0" aria-label="Open ${esc(displayName)}’s profile">
        ${ranking ? `<td class="col-rank" data-col="rank">${pri ? pri.rank : '<span class="muted">—</span>'}</td>` : ''}
        <td class="col-check" data-col="check"><input type="checkbox" class="row-check" ${selected.has(c.id) ? 'checked' : ''}></td>
        <td data-col="name"><div class="name-cell">
          <span class="avatar ${AVATAR_TINTS[i % AVATAR_TINTS.length]}">${esc(initials(c))}</span>
          <div><div class="cand-name">${esc(displayName)}</div>${iqLine(c)}
          ${(c.role || c.company) ? `<div class="cand-line m-only">${esc([c.role, c.company].filter(Boolean).join(' · '))}</div>` : ''}
          ${c.pastRoles ? `<div class="cand-past m-only">was ${esc(String(c.pastRoles).split('|')[0].trim())}${String(c.pastRoles).split('|').length > 1 ? ` +${String(c.pastRoles).split('|').length - 1} more` : ''}</div>` : ''}
          ${pri ? `<div class="cand-sub why-text">${esc(pri.reason)}</div>`
            : blockedWhy ? `<div class="cand-sub muted">not texting: ${esc(blockedWhy)}</div>`
            : (c.location || c.notes) ? `<div class="cand-sub">${esc([c.location, c.notes].filter(Boolean).join(' · '))}</div>` : ''}</div>
        </div></td>
        <td data-col="email">${esc(c.email)}</td>
        <td data-col="text">${textPhoneOf(c) && TEXT_STATUS[c.textStatus] ? `<span class="m-only m-phone">${esc(prettyPhone(textPhoneOf(c)))}</span>` : ''}${textCell(c)}</td>
        <td data-col="role">${esc(c.role) || '<span class="muted">—</span>'}${c.pastRoles ? `<div class="cand-sub" title="${esc(c.pastRoles)}">was ${esc(String(c.pastRoles).split('|')[0].trim())}${String(c.pastRoles).split('|').length > 1 ? ` +${String(c.pastRoles).split('|').length - 1} more` : ''}</div>` : ''}</td>
        <td data-col="company">${esc(c.company) || '<span class="muted">—</span>'}</td>
        <td data-col="status">${statusControl(c)}</td>
        <td data-col="last"><span class="d-only">${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : '<span class="muted">never</span>'}</span><span class="m-only">${c.lastEmailedAt ? `Emailed ${timeAgo(c.lastEmailedAt)}` : 'Not emailed yet'}</span></td>
        <td data-col="act">${nativeActs({ phone: c.phone, email: c.email, name: displayName }, { addNumber: true, cls: 'm-only' })}<span class="row-open" aria-hidden="true">${icon('chevron', 16)}</span></td>
      </tr>`;
    }).join('');
    updateSendButton();
    renderActiveFilters();
    $('#checkAll').checked = pageRows.length > 0 && pageRows.every((c) => selected.has(c.id));
    // What the list is actually showing, which is the one number a CRM's
    // candidate tab always carries.
    const total = state.candidates.length;
    $('#candCount').textContent = total
      ? (rows.length === total
        ? `${total.toLocaleString()} candidate${total === 1 ? '' : 's'}`
        : `${rows.length.toLocaleString()} of ${total.toLocaleString()}`)
      : '';

    const noMatch = !rows.length && total > 0;
    $('#candidatesNoMatch').style.display = noMatch ? 'block' : 'none';
    if (noMatch) $('#noMatchLine').textContent = `${total.toLocaleString()} people are in the list — none of them fit this combination.`;
  }

  // What can actually be done with the current tick-boxes. Texting is offered
  // only for the selected people who have a number, and says how many that is
  // — "Text 12" when 30 are selected is the honest number, and the difference
  // is exactly the thing worth knowing.
  const selectedCandidates = () => state.candidates.filter((c) => selected.has(c.id));
  const selectedTextable = () => selectedCandidates().filter((c) => textPhoneOf(c));

  // Every number the bar shows, in one pass over the people ticked rather
  // than three over everyone.
  function selectionCounts() {
    const idx = candIndex();
    const out = { textable: 0, iq: 0, onb: 0 };
    for (const id of selected) {
      const i = idx.pos.get(id);
      if (i === undefined) continue;
      if (idx.phone[i]) out.textable += 1;
      if (canPipe(state.candidates[i])) {
        if (!idx.iq[i]) out.iq += 1;
        if (!idx.stage[i]) out.onb += 1;
      }
    }
    return out;
  }

  function updateSendButton() {
    const bar = $('#selectionBar');
    const n = selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    const { textable, iq: iqN, onb: onbN } = selectionCounts();
    $('#selCount').textContent = `${n} selected`;
    $('#selEmailBtn').innerHTML = `${icon('mail', 15)} Email ${n}`;
    $('#selTextBtn').innerHTML = `${icon('bubble', 15)} Text ${textable}`;
    $('#selTextBtn').disabled = textable === 0;
    $('#selBothBtn').disabled = textable === 0;
    $('#selNote').textContent = textable === 0
      ? 'None of these have a phone number yet'
      : (textable < n ? `${n - textable} of them have no number` : '');
    $('#selIqBtn').innerHTML = `${icon('clipboard', 15)} Add ${iqN} to Sales IQ`;
    $('#selIqBtn').disabled = iqN === 0;
    $('#selIqBtn').title = iqN ? 'Put them on the Sales IQ list — send the questionnaire when you are ready' : 'Everyone selected is on Sales IQ already (or has no email)';
    $('#selOnbBtn').innerHTML = `${icon('signdoc', 15)} Add ${onbN} to Onboarding docs`;
    $('#selOnbBtn').disabled = onbN === 0;
    $('#selOnbBtn').title = onbN ? 'Put them on the Onboarding docs pipeline — send each packet from there' : 'Everyone selected is in Onboarding docs already (or has no email)';
  }

  // A selection onto the Sales IQ list or the Onboarding docs pipeline. Nobody
  // is emailed from here: that is the next step, on those pages.
  async function addSelectionTo(where) {
    const btn = where === 'iq' ? $('#selIqBtn') : $('#selOnbBtn');
    const ids = selectedCandidates().filter((c) => canPipe(c) && (where === 'iq' ? !iqOf(c) : !onbStage(onbOf(c)))).map((c) => c.id);
    if (!ids.length) return;
    btn.disabled = true;
    try {
      const r = await api(where === 'iq' ? '/api/iq/add-from-pipeline' : '/api/onboarding/from-crm', { method: 'POST', body: { ids } });
      const added = r.added.length;
      const skipped = r.already.length + r.refused.length;
      toast(`${added.toLocaleString()} added to ${where === 'iq' ? 'Sales IQ' : 'Onboarding docs'}${skipped ? ` · ${skipped} skipped (already there, or no email)` : ''}.`);
      if (where === 'iq' && window.SalesIQ && window.SalesIQ.reload) window.SalesIQ.reload();
      await refresh();
    } catch (err) { oops(err); } finally { updateSendButton(); }
  }

  // ---------------- A candidate's profile: Sales IQ and Onboarding docs ----------------
  // In their profile: where they are with each, and the next step — onto
  // the list, or straight to sending them the next thing.
  let linksFor = null;
  function linkBtn(act, label, primary = false) {
    return `<button type="button" class="btn btn-sm${primary ? ' btn-primary' : ''}" data-link="${act}">${esc(label)}</button>`;
  }
  function renderCandLinks(c) {
    linksFor = c && c.id;
    const box = $('#candLinks');
    box.hidden = !(c && canPipe(c));
    if (box.hidden) return;
    const s = iqOf(c);
    $('#candIqStatus').innerHTML = !s ? 'Not on the Sales IQ list'
      : s.status === 'added' ? 'On the list — questionnaire not sent'
        : s.status === 'invited' ? 'Questionnaire sent — waiting on their answers'
          : `Finished — ${iqBadge(s)}`;
    $('#candIqActs').innerHTML = !s ? linkBtn('iq-add', 'Add to Sales IQ') + linkBtn('iq-send', 'Send questionnaire', true)
      : s.status === 'added' ? linkBtn('iq-send', 'Send questionnaire', true)
        : s.status === 'invited' ? linkBtn('iq-send', 'Send again')
          : linkBtn('iq-open', 'See result');
    const o = onbOf(c);
    const stage = onbStage(o);
    $('#candOnbStatus').textContent = !stage ? 'Not in Onboarding docs'
      : stage === 'pipeline' ? 'On the pipeline — packet not sent'
        : stage === 'sent' ? 'Packet sent — waiting on their signature'
          : 'Signed and returned their paperwork';
    $('#candOnbActs').innerHTML = !stage ? linkBtn('onb-add', 'Add to Onboarding docs') + linkBtn('onb-send', 'Send packet', true)
      : stage === 'pipeline' ? linkBtn('onb-open', 'Open card') + linkBtn('onb-send', 'Send packet', true)
        : stage === 'sent' ? linkBtn('onb-open', 'Open card') + linkBtn('onb-send', 'Send again')
          : linkBtn('onb-signed', 'See signed paperwork');
  }
  // Their packet, straight from here: onto the pipeline (once) and emailed.
  async function sendOnbPacket(c) {
    const parts = String(c.name || '').trim().split(/\s+/).filter(Boolean);
    const o = onbOf(c);
    if (onbStage(o) === 'sent' && !confirm(`${c.name || c.email} has already been sent their onboarding packet. Send it again?`)) return false;
    await api('/api/onboarding/from-crm', { method: 'POST', body: { ids: [c.id] } });
    const r = await api('/api/onboarding/send', { method: 'POST', body: {
      hire: { firstName: c.firstName || parts[0] || '', lastName: c.lastName || parts.slice(1).join(' '), email: c.email, phone: c.phone || '', jobTitle: 'Account Executive' },
      options: { sendEmail: true },
    } });
    const emailed = (r.steps || []).some((st) => st.step === 'Email packet' && st.status === 'done');
    toast(emailed ? `Onboarding packet emailed to ${c.email}.` : 'Email is not set up yet, so the packet was not sent — connect your mailbox in Settings.', !emailed);
    return true;
  }
  $('#candLinks').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-link]');
    const c = b && candById(linksFor);
    if (!c) return;
    const act = b.dataset.link;
    const goes = ['iq-open', 'onb-open', 'onb-signed'].includes(act);
    if (goes) closeModal($('#profileModal'));
    b.disabled = true;
    try {
      if (act === 'iq-add') {
        const r = await api('/api/iq/add-from-pipeline', { method: 'POST', body: { ids: [c.id] } });
        if (r.refused.length) throw new Error(r.refused[0].error);
        if (window.SalesIQ && window.SalesIQ.reload) window.SalesIQ.reload();
        toast(`${String(c.name || c.email).split(' ')[0]} is on the Sales IQ list.`);
        await refresh();
      } else if (act === 'iq-send' || act === 'iq-open') {
        await sendIq(c);
      } else if (act === 'onb-add') {
        const r = await api('/api/onboarding/from-crm', { method: 'POST', body: { ids: [c.id] } });
        if (r.refused.length) throw new Error(r.refused[0].error);
        toast(`${String(c.name || c.email).split(' ')[0]} is on the Onboarding docs pipeline.`);
        await refresh();
      } else if (act === 'onb-send') {
        if (await sendOnbPacket(c)) await refresh();
      } else if (act === 'onb-open' || act === 'onb-signed') {
        await sendOnb(c);
      }
    } catch (err) { oops(err); } finally {
      b.disabled = false;
      if (!goes && !$('#profileModal').hidden) refreshProfile();
    }
  });

  $('#candidateRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const cand = candById(id);
    if (e.target.classList.contains('row-check')) {
      e.target.checked ? selected.add(id) : selected.delete(id);
      updateSendButton();
      return;
    }
    // The Text column is the fastest way in for the thing people actually
    // want: putting a number on someone who has none.
    if (e.target.closest('.add-number')) { openCandidate(cand, { focus: 'phone' }); return; }
    // The row's own controls do their own thing: the tick box, the status
    // menu, and the phone's Call, Message and Mail.
    if (e.target.closest('.status-ctl, .native-act, a, input, select, button, .col-check')) return;
    // Dragging across a row to copy an address is not a request to open it.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && tr.contains(sel.anchorNode)) return;
    // Anywhere else opens their profile, where everything for them is.
    if (cand) openProfile(cand);
  });
  $('#candidateRows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr.cand-row');
    if (!tr || e.target !== tr) return;
    e.preventDefault();
    const cand = candById(tr.dataset.id);
    if (cand) openProfile(cand);
  });

  // What a row's buttons do — and the phone's More sheet, which acts on the
  // person by id so that a refresh redrawing the list under it cannot leave
  // it pressing a button that is no longer there.
  function candidateAction(act, cand) {
    if (!cand) { toast('That candidate is no longer on the list.', true); return; }
    const id = cand.id;
    if (act === 'act-edit') openCandidate(cand);
    else if (act === 'act-email') openCompose([id]);
    else if (act === 'act-text') openTextCompose([id]);
    else if (act === 'act-followup') openCompose([id], null, { followUp: true });
    else if (act === 'act-iq') sendIq(cand);
    else if (act === 'act-onb') sendOnb(cand);
    else if (act === 'act-delete') {
      if (confirm(`Remove ${cand.name || cand.email} from the pipeline?`)) {
        api(`/api/candidates/${id}`, { method: 'DELETE' })
          .then(() => { selected.delete(id); return refresh(); })
          .catch(oops);
      }
    }
  }

  // ---------------- A candidate's profile ----------------
  // Who they are, where they stand, and everything you can do for them, in
  // one place — a card on a wide screen, a sheet on a phone. The list stays
  // just the list.
  let profileId = null;
  const fmtDate = dateFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  function profileRow(label, value) {
    return value ? `<div class="profile-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '';
  }
  function profTile(act, ico, label, { primary = false, title = '', short = '' } = {}) {
    const text = short ? `<span class="d-only">${esc(label)}</span><span class="m-only">${esc(short)}</span>` : esc(label);
    return `<button type="button" class="profile-act${primary ? ' is-primary' : ''}" data-act="${act}"${title ? ` title="${esc(title)}"` : ''} aria-label="${esc(title || label)}">${icon(ico, 18)}<span>${text}</span></button>`;
  }
  function openProfile(c) {
    renderProfile(c);
    openModal('#profileModal');
  }
  function renderProfile(c) {
    profileId = c.id;
    const name = c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || '—';
    const i = candPos().get(c.id) || 0;
    const av = $('#profAvatar');
    av.className = `avatar profile-avatar ${AVATAR_TINTS[i % AVATAR_TINTS.length]}`;
    av.textContent = initials(c);
    $('#profName').textContent = name;
    $('#profSub').textContent = [c.role, c.company, c.location].filter(Boolean).join(' · ');
    $('#profTags').innerHTML = statusControl(c, 'prof-status') + [iqBadge(iqOf(c)), onbBadge(onbOf(c))].filter(Boolean).join('');

    // The app's own actions for them, the way a contact card lays them out.
    const phone = textPhoneOf(c);
    $('#profActs').innerHTML = [
      profTile('act-email', 'mail', 'Email', { primary: true, title: 'Send a tracked personal email' }),
      phone ? profTile('act-text', 'bubble', 'Text', { title: 'Send a text from the Mac' })
        : profTile('act-addnumber', 'bubble', c.phone ? 'Fix number' : 'Add number', { short: c.phone ? 'Fix #' : 'Add #', title: c.phone ? 'This number cannot be texted — correct it' : 'Add a mobile number to text them' }),
      c.status === 'emailed' ? profTile('act-followup', 'reply', 'Follow up', { title: 'Reply in the same email conversation' }) : '',
      canPipe(c) ? profTile('act-iq', 'clipboard', 'Sales IQ', { title: iqActionLabel(c) }) : '',
      canPipe(c) ? profTile('act-onb', 'signdoc', 'Onboarding', { short: 'Docs', title: onbActionLabel(c) }) : '',
    ].join('');
    // And the phone's own apps, on a phone.
    $('#profNative').innerHTML = nativeActs({ phone: c.phone, email: c.email, name }, { size: 40 });

    const dial = dialOf(c.phone);
    $('#profContact').innerHTML = [
      profileRow('Email', c.email ? `<a href="${esc(mailtoOf(c.email) || '#')}">${esc(c.email)}</a>` : ''),
      profileRow('Phone', c.phone
        ? `${dial ? `<a href="tel:${esc(dial)}">${esc(textPhoneOf(c) ? prettyPhone(textPhoneOf(c)) : c.phone)}</a>` : esc(c.phone)}${textPhoneOf(c) ? '' : ' <span class="muted">· can’t be texted</span>'}`
        : '<button type="button" class="btn-link" data-act="act-addnumber">Add a number</button>'),
      profileRow('Role', esc(c.role || '')),
      profileRow('Company', esc(c.company || '')),
      profileRow('Location', esc(c.location || '')),
      profileRow('Before', c.pastRoles ? esc(String(c.pastRoles).split('|').map((x) => x.trim()).filter(Boolean).join(' · ')) : ''),
    ].join('');

    const texting = TEXT_STATUS[c.textStatus];
    $('#profActivity').innerHTML = [
      profileRow('Added', c.addedAt ? fmtDate(c.addedAt) : ''),
      profileRow('Emailed', c.lastEmailedAt ? `${timeAgo(c.lastEmailedAt)}${c.lastSubject ? ` — <span class="muted">${esc(c.lastSubject)}</span>` : ''}${c.followUpCount ? ` · ${c.followUpCount} follow-up${c.followUpCount === 1 ? '' : 's'}` : ''}` : '<span class="muted">not yet</span>'),
      profileRow('Opened', c.openedAt ? timeAgo(c.openedAt) : ''),
      profileRow('Replied', c.emailReplies > 0 || c.lastReplyAt ? `${c.lastReplyAt ? timeAgo(c.lastReplyAt) : 'yes'}${c.emailReplies > 1 ? ` · ${c.emailReplies} replies` : ''} <button type="button" class="btn-link" data-act="act-openmail">Open conversation</button>` : ''),
      profileRow('Texted', c.lastTextedAt ? `${timeAgo(c.lastTextedAt)}${texting ? ` · ${esc(texting.label)}` : ''}${c.textCount ? ` <button type="button" class="btn-link" data-act="act-openthread">Open texts</button>` : ''}` : ''),
      profileRow('Interview', c.bookedAt ? `${esc(c.bookedEvent || 'Booked')} · ${fmtWhen(c.bookedAt)}${c.bookedJoinUrl ? ` · <a href="${esc(c.bookedJoinUrl)}" target="_blank" rel="noopener">Join link</a>` : ''}` : ''),
      profileRow('Source', esc(c.source || '')),
    ].join('');
    $('#profNotesSec').hidden = !c.notes;
    $('#profNotes').textContent = c.notes || '';
    renderCandLinks(c);
    $('#profLinksSec').hidden = $('#candLinks').hidden;
  }
  // The list and the numbers move on every look for news; an open profile
  // moves with them, and closes if the person has gone.
  function refreshProfile() {
    if (!profileId || $('#profileModal').hidden) return;
    const c = candById(profileId);
    if (!c) { closeModal($('#profileModal')); return; }
    // Never under someone choosing a status.
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#profileModal .status-ctl')) return;
    renderProfile(c);
  }
  $('#profileModal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !b.closest('#profActs, #profContact, #profActivity')) return;
    const c = candById(profileId);
    if (!c) return;
    const act = b.dataset.act;
    closeModal($('#profileModal'));
    if (act === 'act-addnumber') openCandidate(c, { focus: 'phone' });
    else if (act === 'act-openmail') { show('template'); openMail(c.id).catch(oops); }
    else if (act === 'act-openthread') { show('texting'); openThread(c.id).catch(oops); }
    else candidateAction(act, c);
  });
  $('#profileModal').addEventListener('change', (e) => {
    if (!e.target.classList.contains('status-select')) return;
    setStatus(profileId, e.target.value);
  });
  $('#profEdit').addEventListener('click', () => {
    const c = candById(profileId);
    closeModal($('#profileModal'));
    if (c) openCandidate(c);
  });
  $('#profRemove').addEventListener('click', () => {
    const c = candById(profileId);
    if (!c) return;
    if (!confirm(`Remove ${c.name || c.email} from the list?`)) return;
    closeModal($('#profileModal'));
    api(`/api/candidates/${c.id}`, { method: 'DELETE' })
      .then(() => { selected.delete(c.id); return refresh(); })
      .catch(oops);
  });

  $('#candidateRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('status-select')) return;
    const id = e.target.closest('tr').dataset.id;
    setStatus(id, e.target.value);
  });

  // ---- a status picked here ----
  // From a row, a profile or a tile's list. The page says the new status at
  // once — every menu showing that person, the counts, the lists — and then
  // tells the server. Waiting for the server first, and then for the whole
  // state to come back, made every pick take seconds on a phone. If the
  // server refuses, everything is put back as it was and the page says why:
  // the row, the phone's status pill and an open profile alike. Until a
  // state asked for after the save has come back, each new state has the
  // pick laid over it (applyPendingStatus), so a poll that set off before the
  // pick cannot flip it back.
  const pendingStatus = new Map();   // id -> { status, prev, seq, savedAt }
  let statusSeq = 0;

  function setStatus(id, status) {
    const c = candById(id);
    if (!c || !STATUS[status]) {
      api(`/api/candidates/${id}`, { method: 'PATCH', body: { status } }).then(() => refreshSoon()).catch(oops);
      return;
    }
    if (c.status === status) return;
    const seq = ++statusSeq;
    const prev = c.status;
    pendingStatus.set(id, { status, prev, seq, savedAt: 0 });
    putStatus(c, status);
    listChanged();
    showStatus(id, status);
    api(`/api/candidates/${id}`, { method: 'PATCH', body: { status } })
      .then(() => {
        const p = pendingStatus.get(id);
        // On the clock refresh() times its requests by (applyPendingStatus).
        if (p && p.seq === seq) p.savedAt = pageClock();
        refreshSoon();
      })
      .catch((err) => {
        const p = pendingStatus.get(id);
        // A later pick for the same person is on its way and decides it.
        if (p && p.seq === seq) {
          pendingStatus.delete(id);
          const now = candById(id);
          if (now) putStatus(now, prev);
          listChanged();
          showStatus(id, prev);
        }
        // What is on screen may not be what the server holds any more (it may
        // have taken an earlier pick, or none): the next look asks for the
        // whole state rather than being told nothing changed, and for this
        // person's part of the list whatever its digest says.
        stateTag = '';
        if (list) distrust.add(Wire.bucketOf(id, list.nb));
        oops(err);
        refreshSoon();
      });
  }

  // A status changed in place, with the Dashboard's per-status totals kept
  // in step (they come from the server, which has not counted it yet).
  function putStatus(c, next) {
    const prev = c.status;
    if (prev === next) return;
    const s = state && state.stats;
    if (s) {
      if (typeof s[prev] === 'number') s[prev] -= 1;
      if (typeof s[next] === 'number') s[next] += 1;
    }
    overlay(c, 'status', next);
  }

  // Every menu on screen for this person — a row, an open profile, a tile's
  // list — set to `status`, with its colour and the phone's pill over it.
  function showStatus(id, status) {
    const st = STATUS[status] || STATUS.new;
    $$(`.status-select[data-id="${CSS.escape(String(id))}"]`).forEach((sel) => {
      if (sel.value !== status) sel.value = status;
      for (const v of Object.values(STATUS)) sel.classList.toggle(v.cls, v === st);
      const face = sel.parentElement && sel.parentElement.querySelector('.status-face');
      if (face) { face.textContent = st.label; face.className = `status-face m-only ${st.cls}`; }
    });
  }

  // Something in the list changed here rather than in a new state: every
  // page drawn from the list is out of date, the one on screen is drawn
  // again now, and so are the counts that show from every page.
  function listChanged() {
    bumpList();
    if (!state) return;
    for (const v of Object.keys(VIEW_RENDERERS)) staleViews.add(v);
    renderView(currentView);
    renderEmailAllButtons();
    refreshProfile();
  }

  // Laid over each new state, after the unread flags (see refresh()). A pick
  // whose save has been answered, and which this state was asked for after,
  // is in the state already: let go of it. Any other is laid back on top.
  function applyPendingStatus(askedAt) {
    if (!pendingStatus.size || !state) return;
    let changed = false;
    for (const [id, p] of [...pendingStatus]) {
      const c = candById(id);
      if (!c || (p.savedAt && p.savedAt <= askedAt)) { pendingStatus.delete(id); continue; }
      if (c.status !== p.status) { putStatus(c, p.status); changed = true; }
    }
    if (changed) bumpList();
  }

  // Several clicks in a row (statuses picked down a list) each want to see
  // the server's view afterwards — the texting order, who is due a
  // follow-up. One look a moment after the first of them answers serves all
  // that have answered by then; a later one asks for its own.
  let soonTimer = 0;
  function refreshSoon(ms = 300) {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = 0;
      if (signedIn) refresh().catch(() => {});
    }, ms);
  }

  // The boxes on screen and the page's own box, set to the selection where
  // they are: ticking or clearing used to draw the whole list again to do it.
  function syncTicks() {
    $$('#candidateRows tr[data-id]').forEach((tr) => {
      const box = tr.querySelector('.row-check');
      if (box) box.checked = selected.has(tr.dataset.id);
    });
    $('#checkAll').checked = pageRows.length > 0 && pageRows.every((c) => selected.has(c.id));
    updateSendButton();
  }
  $('#checkAll').addEventListener('change', (e) => {
    // The page you can see. Ticking one box to act on 3,500 unseen people is
    // not something to do by accident.
    pageRows.forEach((c) => (e.target.checked ? selected.add(c.id) : selected.delete(c.id)));
    syncTicks();
  });
  // 3,514 rows filtered and rebuilt on every keystroke was ~86 ms a character.
  // A search hides people as surely as a filter does, so it lets go of any
  // of them who were ticked, the way the menus do.
  const searchRender = debounce(() => { narrowSelection('search'); renderCandidates(); }, 120);
  $('#searchInput').addEventListener('input', (e) => { search = e.target.value; searchRender(); });
  // What the search looks through is made the first time it is needed; the
  // moment the box is focused is a good time to have that done already.
  $('#searchInput').addEventListener('focus', () => {
    const warm = () => { if (state && state.candidates) searchIndex(); };
    if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 500 }); else setTimeout(warm, 50);
  });
  // Folding the filters away on a phone. The button says how many are in
  // force, so a list that is filtered never looks like a list that is short.
  $('#filtersToggle').addEventListener('click', () => {
    const card = $('#filtersToggle').closest('.list-card');
    const open = card.classList.toggle('filters-open');
    $('#filtersToggle').setAttribute('aria-expanded', String(open));
  });

  $('#emptyClear').addEventListener('click', () => {
    filter = 'all'; industryFilter = ''; roleFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; iqFilter = ''; onbFilter = ''; search = '';
    syncFilterControls(); renderCandidates();
  });
  $('#roleFilter').addEventListener('change', (e) => { roleFilter = e.target.value; narrowSelection(); renderCandidates(); });
  // Back to the top of the new page, on whatever scrolls: the window on a
  // laptop, but on a phone the page lives inside .main, and scrolling the
  // window there did nothing — Next left you at the bottom of the new page.
  function toTopOfPage() {
    const inner = mainEl && getComputedStyle(mainEl).overflowY !== 'visible' && mainEl.scrollHeight > mainEl.clientHeight;
    (inner ? mainEl : window).scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('#pagerPrev').addEventListener('click', () => { page -= 1; renderCandidates(); toTopOfPage(); });
  $('#pagerNext').addEventListener('click', () => { page += 1; renderCandidates(); toTopOfPage(); });
  $('#sortBy').addEventListener('change', (e) => { sortBy = e.target.value; renderCandidates(); });
  $('#stageFilter').addEventListener('change', (e) => {
    filter = e.target.value;
    narrowSelection();
    renderCandidates();
  });
  $('#selEmailBtn').addEventListener('click', () => openCompose([...selected]));
  $('#selTextBtn').addEventListener('click', () => openTextCompose(selectedTextable().map((c) => c.id)));
  $('#selBothBtn').addEventListener('click', () => {
    // Text first: it opens, queues and closes, leaving the email composer —
    // which needs the window to stay open while it sends — to run last.
    openTextCompose(selectedTextable().map((c) => c.id), { thenEmail: [...selected] });
  });
  $('#selClearBtn').addEventListener('click', () => { selected.clear(); syncTicks(); });
  $('#selIqBtn').addEventListener('click', () => addSelectionTo('iq'));
  $('#selOnbBtn').addEventListener('click', () => addSelectionTo('onb'));
  $('#emailAllBtn').addEventListener('click', () => openCompose(uncontactedIds()));
  $$('.follow-up-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.id === 'tplFollowUpBtn' && followUpDirty) return;   // that button sends the unsaved draft (handled below)
    openCompose(followUpDueIds(), null, { followUp: true });
  }));

  // Add-candidate modal
  // ---------------- Add / edit one candidate ----------------
  // One modal does both. Editing is how a number gets onto the 400-odd people
  // who arrived from a list with no phone column.
  let editingId = null;
  const CAND_FIELDS = {
    '#addFirst': 'firstName', '#addLast': 'lastName', '#addEmail': 'email', '#addPhone': 'phone',
    '#addRole': 'role', '#addCompany': 'company', '#addLocation': 'location', '#addNotes': 'notes',
  };

  function openCandidate(c = null, { focus = '' } = {}) {
    editingId = c ? c.id : null;
    const first = c ? (c.firstName || (c.name || '').split(' ')[0] || '') : '';
    const last = c ? (c.lastName || (c.name || '').split(' ').slice(1).join(' ')) : '';
    $('#addFirst').value = first;
    $('#addLast').value = last;
    $('#addEmail').value = c ? (c.email || '') : '';
    $('#addPhone').value = c ? (c.phone || '') : '';
    $('#addRole').value = c ? (c.role || '') : '';
    $('#addCompany').value = c ? (c.company || '') : '';
    $('#addLocation').value = c ? (c.location || '') : '';
    $('#addNotes').value = c ? (c.notes || '') : '';
    $('#addModalTitle').textContent = c ? `Edit ${c.name || c.email}` : 'Add candidate';
    $('#addSaveBtn').textContent = c ? 'Save changes' : 'Add candidate';
    openModal('#addModal');
    checkPhoneField();
    const el = focus === 'phone' ? $('#addPhone') : $('#addFirst');
    setTimeout(() => { el.focus(); el.select(); }, 40);
  }

  // Say, as it is typed, whether this number can actually be texted — the
  // same rule the server and the queue use, so there are no surprises later.
  function checkPhoneField() {
    const raw = $('#addPhone').value.trim();
    const hint = $('#addPhoneHint');
    const input = $('#addPhone');
    input.classList.remove('bad', 'good');
    if (!raw) {
      hint.textContent = 'US and Canadian numbers in any format. Leave blank if you only have an email.';
      hint.className = 'hint';
      return;
    }
    const e164 = textPhoneOf({ phone: raw });
    if (e164) {
      input.classList.add('good');
      hint.textContent = `Textable — will be saved as ${prettyPhone(e164)}.`;
      hint.className = 'hint good';
    } else {
      input.classList.add('bad');
      hint.textContent = 'Not a number we can text. Needs 10 digits (or +country code) — check for a missing digit.';
      hint.className = 'hint bad';
    }
  }
  $('#addPhone').addEventListener('input', checkPhoneField);

  $('#addCandidateBtn').addEventListener('click', () => openCandidate(null));

  $('#addSaveBtn').addEventListener('click', async () => {
    const btn = $('#addSaveBtn');
    const body = {};
    for (const [sel, field] of Object.entries(CAND_FIELDS)) body[field] = $(sel).value.trim();
    body.name = `${body.firstName} ${body.lastName}`.trim();
    btn.disabled = true;
    try {
      if (editingId) await api(`/api/candidates/${editingId}`, { method: 'PATCH', body });
      else await api('/api/candidates', { method: 'POST', body });
      closeModal($('#addModal'));
      const textable = textPhoneOf({ phone: body.phone });
      toast(editingId
        ? `Saved.${body.phone && textable ? ` ${prettyPhone(textable)} is ready to text.` : ''}`
        : 'Candidate added.');
      editingId = null;
      await refresh();
    } catch (err) { oops(err); }
    finally { btn.disabled = false; }
  });

  // ---------------- Compose & send ----------------
  let cancelSend = false;
  let composeSending = false;   // the send window's own loop is running
  let composeFollowUp = false;
  function openCompose(ids, override, { followUp = false } = {}) {
    if (!state.sending.ready) {
      toast(state.sending.reason || 'Set up your work email first (Settings → Google or App Password).', true);
      show('settings');
      return;
    }
    if (!ids.length) {
      toast(followUp
        ? `Nobody is due a follow-up — people become due ${state.followUp.days} day${state.followUp.days === 1 ? '' : 's'} after their last email if they haven't replied.`
        : 'Nobody to email — everyone has been contacted.', true);
      return;
    }
    composeIds = ids;
    composeFollowUp = followUp;
    cancelSend = false;
    const cands = ids.map(candById).filter(Boolean);
    $('#composeTitle').textContent = followUp
      ? (cands.length === 1 ? `Follow up with ${cands[0].name || cands[0].email}` : `Follow up with ${cands.length} people`)
      : (cands.length === 1 ? `Email ${cands[0].name || cands[0].email}` : `Email ${cands.length} candidates personally`);
    $('#composeTo').innerHTML =
      cands.slice(0, 6).map((c) => `<span class="to-chip">${esc(c.name || c.email)}</span>`).join('') +
      (cands.length > 6 ? `<span class="to-more">+${cands.length - 6} more</span>` : '');
    const base = followUp ? state.followUp.template : state.template;
    $('#composeSubject').value = override ? override.subject : base.subject;
    $('#composeBody').value = override ? override.body : base.body;
    // Saved templates are for outreach; a follow-up has its own single letter.
    $('#composePresetRow').hidden = followUp;
    $('#composeSaveAsBtn').hidden = followUp;
    $('#composeSaveAsRow').hidden = true;
    $('#composeSaveAsName').value = '';
    if (!followUp) fillPresetSelect($('#composePreset'), 'email', override ? '' : defaultPresetId('email'));
    composeLoaded = { subject: $('#composeSubject').value, body: $('#composeBody').value, id: override ? '' : defaultPresetId('email') };
    const atts = followUp ? [] : ((state.template && state.template.attachments) || []);
    $('#composeAttach').hidden = !atts.length;
    $('#composeAttach').innerHTML = atts.map((a) => `<span class="pv-attach">${icon('paperclip', 13)} ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span></span>`).join('');
    const sigNote = state.google.signature ? ' Your Gmail signature is added at the bottom.' : '';
    $('#composeHint').textContent = followUp
      ? `Sent as a reply in each person's existing conversation — the subject becomes “Re:” their original email ({{originalSubject}}), so it lands in the same thread. No attachment is added.${sigNote}`
      : cands.length === 1
        ? `Placeholders like {{firstName}} will be filled in for ${firstNameOf(cands[0]) || 'this candidate'}. Your Calendly booking link is added at the end.${sigNote}`
        : `Each candidate gets their own personal email — {{firstName}} etc. are filled per person, and your Calendly link is added at the end.${sigNote} Sends are spaced ~1s apart.`;
    $('#sendProgress').hidden = true;
    $('#sendProgress').innerHTML = '';
    $('#sendBar').hidden = true;
    $('#sendBarFill').style.width = '0%';
    $('#composeSendBtn').disabled = false;
    $('#composeCancelBtn').textContent = 'Cancel';
    queueMode = cands.length > (state.maxImmediate || 8);
    if (queueMode) {
      const q = state.queue || {};
      const room = Math.max(0, (q.dailyLimit || 0) - (q.sentToday || 0));
      const today = Math.min(cands.length, room);
      const perMin = q.perMinute || 30;
      const minutes = Math.max(1, Math.ceil(today / perMin));
      const eta = minutes >= 90 ? `about ${Math.round(minutes / 60)} hours` : `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
      $('#composeHint').textContent =
        `${cands.length} emails will be sent automatically in the background at up to ${perMin} per minute, each personalized. ` +
        `Your daily send limit is ${q.dailyLimit} (Google allows up to ${(q.dailyMax || 2000).toLocaleString()} a day) and you've sent ${q.sentToday || 0} in the last 24 hours, so ${today} go out today` +
        (today ? ` (${eta})` : '') +
        (today < cands.length ? ` and the remaining ${cands.length - today} continue automatically as the 24-hour window frees up.` : '.') +
        ` You can close this tab; progress shows on the Dashboard.`;
      $('#composeSendBtn').textContent = followUp ? `Queue ${cands.length} follow-ups` : `Queue ${cands.length} emails`;
    } else {
      $('#composeSendBtn').textContent = followUp
        ? (cands.length > 1 ? `Send ${cands.length} follow-ups` : 'Send follow-up')
        : (cands.length > 1 ? `Send ${cands.length} emails` : 'Send');
    }
    openModal('#composeModal');
  }
  let queueMode = false;

  $('#composeCancelBtn').addEventListener('click', () => { cancelSend = true; });
  // What the send window's fields were last filled with, so choosing another
  // template only asks first when you have typed something of your own.
  let composeLoaded = { subject: '', body: '', id: '' };
  $('#composePreset').addEventListener('change', (e) => {
    const p = presetById('email', e.target.value);
    if (!p) return;
    const edited = $('#composeSubject').value !== composeLoaded.subject || $('#composeBody').value !== composeLoaded.body;
    if (edited && !confirm(`Replace what you have written with “${p.name}”?`)) { e.target.value = composeLoaded.id; return; }
    $('#composeSubject').value = p.subject || '';
    $('#composeBody').value = p.body || '';
    composeLoaded = { subject: p.subject || '', body: p.body || '', id: p.id };
  });
  // Save as new template: a name box opens in the window itself.
  $('#composeSaveAsBtn').addEventListener('click', () => {
    $('#composeSaveAsRow').hidden = false;
    $('#composeSaveAsName').focus();
  });
  $('#composeSaveAsCancel').addEventListener('click', () => { $('#composeSaveAsRow').hidden = true; $('#composeSaveAsName').value = ''; });
  async function composeSaveAs() {
    const field = $('#composeSaveAsName');
    const name = cleanPresetName(field.value);
    if (!name) { nameMissing(field, 'email'); return; }
    const made = await createPreset('email', name, { subject: $('#composeSubject').value, body: $('#composeBody').value });
    if (!made) return;
    fillPresetSelect($('#composePreset'), 'email', made.id);
    composeLoaded = { subject: made.subject, body: made.body, id: made.id };
    $('#composeSaveAsRow').hidden = true;
    field.value = '';
  }
  $('#composeSaveAsConfirm').addEventListener('click', composeSaveAs);
  $('#composeSaveAsName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); composeSaveAs(); } });

  // Sends in batches of 8 (each request must finish inside the server's
  // 10-second limit); the modal shows live progress and can be stopped
  // between batches.
  const BATCH = 8;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  $('#composeSendBtn').addEventListener('click', async () => {
    const btn = $('#composeSendBtn');
    const cancel = $('#composeCancelBtn');
    const total = composeIds.length;
    const template = { subject: $('#composeSubject').value, body: $('#composeBody').value };
    const followUp = composeFollowUp;
    btn.disabled = true;
    if (queueMode) {
      try {
        const r = await api('/api/queue', { method: 'POST', body: { candidateIds: composeIds, template, followUp } });
        closeModal($('#composeModal'));
        selected.clear();
        toast(`${r.added} emails queued — sending has started.`);
        await refresh();
        show('dashboard');
      } catch (err) { oops(err); btn.disabled = false; }
      return;
    }
    cancel.textContent = 'Stop';
    cancelSend = false;
    const prog = $('#sendProgress');
    const bar = $('#sendBar');
    bar.hidden = false;
    prog.hidden = false;
    let sent = 0;
    let handedOff = 0;   // timed out: the background queue verifies with Gmail and finishes them
    const failed = [];
    const update = () => {
      const done = sent + failed.length + handedOff;
      $('#sendBarFill').style.width = `${Math.round((done / total) * 100)}%`;
      btn.textContent = `Sending… ${done} / ${total}`;
      prog.innerHTML = `<span class="ok-ico">${icon('checkcircle', 14)}</span> ${sent} sent${handedOff ? ` · ${handedOff} finishing in the background` : ''}${failed.length ? ` · <span class="bad-ico">${icon('xcircle', 14)}</span> ${failed.length} failed` : ''}` +
        (failed.length ? '<br>' + failed.slice(-5).map((f) => `<span class="bad-ico">${icon('xcircle', 14)}</span> ${esc(f.email || f.id)} — ${esc(f.error)}`).join('<br>') : '');
    };
    update();
    composeSending = true;
    try {
      let pending = composeIds.slice();
      let retries = 0;
      while (pending.length && !cancelSend) {
        const chunk = pending.slice(0, BATCH);
        pending = pending.slice(BATCH);
        const data = await api('/api/send', { method: 'POST', body: { candidateIds: chunk, template, followUp } });
        const deferred = data.results.filter((r) => r.retry);
        for (const r of data.results) { if (r.ok) sent++; else if (r.queued) handedOff++; else if (!r.retry) failed.push(r); }
        if (deferred.length) {
          const rest = [...deferred.map((r) => r.id), ...pending];
          const daily = deferred.find((r) => r.kind === 'daily');
          if (daily) {
            // A 24-hour cap (yours or Gmail's): hand the remainder to the queue,
            // which resumes by itself — waiting here would take hours.
            pending = [];
            await api('/api/queue', { method: 'POST', body: { candidateIds: rest, template, followUp } });
            toast(`${daily.error || 'The daily sending limit is reached.'} The remaining ${rest.length} were queued and send automatically.`, true);
            break;
          }
          if (deferred.every((r) => r.kind === 'budget')) {
            pending = rest;                       // request ran out of time; just continue
          } else if (++retries > 6) {
            pending = [];
            await api('/api/queue', { method: 'POST', body: { candidateIds: rest, template, followUp } });
            toast(`Gmail kept throttling — the remaining ${rest.length} were queued and will send automatically.`, true);
            break;
          } else {
            // Gmail asked us to slow down: wait until its retry time, then resend those.
            const until = Math.min(new Date(deferred[0].retryAt).getTime(), Date.now() + 10 * 60000);
            while (Date.now() < until && !cancelSend) {
              prog.innerHTML = `Gmail asked us to slow down — resuming in ${Math.max(1, Math.round((until - Date.now()) / 1000))}s…`;
              await wait(1000);
            }
            pending = rest;
          }
        }
        update();
        if (pending.length && !cancelSend) await wait(1500);
      }
      const stopped = cancelSend && sent + failed.length < total;
      toast(stopped ? `Stopped — ${sent} sent.` : `Sent ${sent} of ${total} email${total === 1 ? '' : 's'}.`, failed.length > 0);
      selected.clear();
      await refresh();
      if (!failed.length && !stopped) setTimeout(() => { closeModal($('#composeModal')); }, 1000);
      else {
        btn.disabled = failed.length === 0;
        btn.textContent = failed.length ? `Retry ${failed.length} failed` : 'Done';
        composeIds = failed.map((r) => r.id);
        cancel.textContent = 'Close';
      }
    } catch (err) {
      oops(err);
      btn.disabled = false;
      btn.textContent = 'Retry';
      cancel.textContent = 'Close';
    } finally {
      composeSending = false;
    }
  });

  // ---------------- Import ----------------
  const MAP_FIELDS = [
    ['email', 'Email *'], ['name', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'],
    ['role', 'Role / title'], ['company', 'Company'], ['phone', 'Phone'], ['location', 'Location'], ['notes', 'Notes'],
    ['altEmails', 'Other emails'],
  ];
  const IMPORT_TEXT_CHUNK = 3 * 1024 * 1024;   // characters of file text per request (the server accepts 6 MB)
  const IMPORT_ROW_SLICE = 4000;               // spreadsheet rows per request when reading an .xlsx
  const IMPORT_ROW_BATCH = 2000;
  const MAX_IMPORT_ROWS = 50000;
  const setImportStatus = (msg) => { $('#importStatus').textContent = msg || ''; };

  $('#fetchSheetBtn').addEventListener('click', async () => {
    const url = $('#sheetUrl').value.trim();
    if (!url) return toast('Paste your Google Sheet link first.', true);
    $('#sheetHint').textContent = 'Fetching sheet…';
    try {
      const data = await api('/api/import/sheet', { method: 'POST', body: { url } });
      $('#sheetHint').textContent = data.via === 'google-api'
        ? 'Loaded via your connected Google account.'
        : 'Loaded via public link.';
      showMapping(data, 'google-sheet', 'Google Sheet');
    } catch (err) {
      $('#sheetHint').textContent = '';
      oops(err);
    }
  });

  const dz = $('#dropzone');
  $('#csvFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    if (files.length > 1) toast(`One file at a time — importing ${files[0].name}.`);
    importFile(files[0]);
  });
  $('#pasteImportBtn').addEventListener('click', () => {
    importText($('#pasteBox').value, 'paste', 'pasted rows').catch((err) => { setImportStatus(''); oops(err); });
  });

  // Any file → rows. Spreadsheets are read in the browser; text is decoded
  // whatever its encoding, then handed to the server in pieces if it is big.
  async function importFile(file) {
    setImportStatus(`Reading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
      if (/\.numbers$/i.test(file.name)) throw new Error(`${file.name} is a Numbers document — in Numbers choose File → Export To → CSV (or Excel) and import that.`);
      if (/\.(xls|ods)$/i.test(file.name)) throw new Error(`${file.name} is in a format the app cannot read — save it as .xlsx or .csv and try again.`);
      if (isZip || /\.xlsx$/i.test(file.name)) {
        if (!isZip) throw new Error(`${file.name} is not a real .xlsx file — export it again from Excel or Google Sheets, or save as CSV.`);
        const rows = await window.XlsxLite.read(buf);
        if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error(`That sheet has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows — split it and import it in parts.`);
        setImportStatus(`Reading ${file.name}… ${rows.length.toLocaleString()} rows`);
        // Big sheets go to the server in slices; only the first can hold the header.
        const data = await api('/api/import/csv', { method: 'POST', body: { rows: rows.slice(0, IMPORT_ROW_SLICE), lines: rows.slice(0, IMPORT_ROW_SLICE).map((_, i) => i + 1), via: 'xlsx' } });
        for (let i = IMPORT_ROW_SLICE; i < rows.length; i += IMPORT_ROW_SLICE) {
          setImportStatus(`Reading ${file.name}… ${Math.min(i + IMPORT_ROW_SLICE, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} rows`);
          const slice = rows.slice(i, i + IMPORT_ROW_SLICE);
          const more = await api('/api/import/csv', { method: 'POST', body: { rows: slice, lines: slice.map((_, k) => i + k + 1), noHeader: true, via: 'xlsx' } });
          data.rows.push(...more.rows);
          data.lines.push(...more.lines);
        }
        showMapping(data, 'xlsx', file.name);
        return;
      }
      await importText(decodeText(bytes), 'csv', file.name);
    } catch (err) { setImportStatus(''); oops(err); }
  }

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    // UTF-16 without a mark: in Latin text every other byte is zero.
    const n = Math.min(bytes.length, 4000);
    let zeros = 0;
    for (let i = 1; i < n; i += 2) if (bytes[i] === 0) zeros++;
    if (n > 40 && zeros > n / 4) return new TextDecoder('utf-16le').decode(bytes);
    // Valid UTF-8 is taken as is (a genuine U+FFFD inside it is fine); only
    // bytes that are not UTF-8 at all are read as Windows-1252 (Excel on Windows).
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { try { return new TextDecoder('windows-1252').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); } }
  }

  async function importText(text, source, label) {
    const t = String(text || '');
    if (!t.trim()) throw new Error(source === 'paste' ? 'Paste some rows first.' : 'That file is empty.');
    setImportStatus(`Reading ${label || 'rows'}…`);
    let data;
    if (t.length <= IMPORT_TEXT_CHUNK) {
      data = await api('/api/import/csv', { method: 'POST', body: { text: t, via: source } });
    } else {
      // Big file: line-safe pieces; later pieces never contain the header.
      const pieces = chunkText(t, IMPORT_TEXT_CHUNK);
      data = await api('/api/import/csv', { method: 'POST', body: { text: pieces[0].text, via: source } });
      for (let i = 1; i < pieces.length; i++) {
        setImportStatus(`Reading ${label || 'rows'}… part ${i + 1} of ${pieces.length}`);
        const more = await api('/api/import/csv', { method: 'POST', body: { text: pieces[i].text, noHeader: true, via: source } });
        data.rows.push(...more.rows);
        data.lines.push(...more.lines.map((n) => n + pieces[i].line - 1));
      }
      if (data.rows.length > MAX_IMPORT_ROWS) throw new Error(`That is more than ${MAX_IMPORT_ROWS.toLocaleString()} rows — split the file and import it in parts.`);
    }
    showMapping(data, source, label);
  }

  // Split at line breaks that are not inside a quoted field, using the same
  // rule as the parser (a quote only opens a field at its start). Returns
  // pieces with the physical line each one starts on.
  function chunkText(raw, size) {
    const t = raw.replace(/\r\n?/g, '\n');
    const out = [];
    let start = 0;
    let line = 1;
    while (start < t.length) {
      if (t.length - start <= size) { out.push({ text: t.slice(start), line }); break; }
      let cut = -1;
      let q = false, atStart = true, lastSafe = -1;
      for (let i = start; i < start + size; i++) {
        const c = t[i];
        if (q) { if (c === '"') q = false; continue; }
        if (c === '"' && atStart) { q = true; atStart = false; continue; }
        if (c === '\n') { lastSafe = i; atStart = true; continue; }
        if (c === ',' || c === ';' || c === '\t' || c === '|') { atStart = true; continue; }
        if (c !== ' ') atStart = false;
      }
      cut = lastSafe >= 0 ? lastSafe : t.indexOf('\n', start + size);   // no safe break inside: take the next line break, whatever it is
      if (cut < 0) { out.push({ text: t.slice(start), line }); break; }
      const piece = t.slice(start, cut);
      out.push({ text: piece, line });
      line += (piece.match(/\n/g) || []).length + 1;
      start = cut + 1;
    }
    return out;
  }

  const currentMapping = () => {
    const mapping = {};
    $$('.map-select').forEach((sel) => { mapping[sel.dataset.key] = Number(sel.value); });
    return mapping;
  };

  function showMapping(data, source, label) {
    pendingImport = { ...data, source };
    setImportStatus('');
    $('#previewCount').textContent = `${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? '' : 's'}${label ? ` · ${label}` : ''}`;
    const conf = data.confidence || {};
    const note = (key) => conf[key] === 'content'
      ? ' <span class="map-note" title="Recognised from the values in the column">recognised</span>'
      : conf[key] === 'guess' ? ' <span class="map-note map-guess" title="Best guess — check it">guessed</span>' : '';
    $('#mappingGrid').innerHTML = MAP_FIELDS.map(([key, lbl]) => `
      <div><label class="label">${lbl}${note(key)}</label>
        <select class="input map-select" data-key="${key}">
          <option value="-1">— skip —</option>
          ${data.headers.map((h, i) =>
            `<option value="${i}" ${data.mapping[key] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select></div>`).join('');
    $('#headerlessNote').hidden = !data.headerless;
    const preview = data.rows.slice(0, 5);
    $('#previewTable').innerHTML =
      `<thead><tr>${data.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${preview.map((r) => `<tr>${data.headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#importUpdateExisting').checked = true;
    $('#importResult').hidden = true;
    $('#mappingCard').hidden = false;
    $('#mappingCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    runDryRun();
  }

  // What the import would do, shown before it happens and refreshed whenever
  // a column choice changes.
  let dryRunSeq = 0;
  async function runDryRun() {
    if (!pendingImport) return;
    const seq = ++dryRunSeq;
    const mapping = currentMapping();
    const sum = $('#importSummary');
    if (mapping.email === -1) {
      sum.innerHTML = '<span class="bad-text">Pick which column holds the email address.</span>';
      setCommitLabel(null);
      return;
    }
    sum.textContent = 'Checking these rows against your list…';
    setCommitLabel(null);
    try {
      const totals = await dryRunBatches(pendingImport.rows, mapping);
      if (seq !== dryRunSeq || !pendingImport) return;
      pendingImport.dryRun = totals;
      renderSummary(totals);
    } catch (err) {
      if (seq === dryRunSeq) {
        sum.innerHTML = `<span class="bad-text">Could not check the rows: ${esc(err.message)}</span> <button class="btn-link" id="dryRunRetry">Try again</button>`;
        $('#dryRunRetry').addEventListener('click', runDryRun);
      }
    }
  }
  const debouncedDryRun = debounce(runDryRun, 200);
  $('#mappingGrid').addEventListener('change', debouncedDryRun);
  $('#importUpdateExisting').addEventListener('change', () => { if (pendingImport && pendingImport.dryRun) setCommitLabel(pendingImport.dryRun); });

  // Rows repeated later in the file are settled here, before batching, so a
  // repeat in batch 3 of an address from batch 1 is counted as a repeat.
  const rowEmailKey = (row, mapping) => {
    const cell = mapping.email >= 0 ? String(row[mapping.email] || '') : '';
    const m = cell.match(/<([^<>]+)>\s*$/);
    const k = (m ? m[1] : cell).replace(/^mailto:/i, '').trim().toLowerCase();
    // Gmail ignores dots and "+tags": one inbox, however it is spelled.
    const g = k.match(/^([^@]+)@(gmail|googlemail)\.com$/);
    return g ? `${g[1].split('+')[0].replace(/\./g, '')}@gmail.com` : k;
  };
  function splitRepeats(rows, lines, mapping) {
    const seen = new Set();
    const keep = [], keepLines = [];
    let repeats = 0;
    rows.forEach((row, i) => {
      const k = rowEmailKey(row, mapping);
      if (k && seen.has(k)) { repeats++; return; }
      if (k) seen.add(k);
      keep.push(row); keepLines.push(lines ? lines[i] : i + 1);
    });
    return { rows: keep, lines: keepLines, repeats };
  }
  async function dryRunBatches(allRows, mapping) {
    const totals = { total: 0, newCount: 0, existing: 0, existingByPhone: 0, updatable: 0, duplicate: 0, invalid: 0, shifted: 0, invalidSamples: [], existingSamples: [] };
    const { rows, lines, repeats } = splitRepeats(allRows, pendingImport.lines, mapping);
    totals.total += repeats; totals.duplicate += repeats;
    for (let i = 0; i < rows.length; i += IMPORT_ROW_BATCH) {
      const r = await api('/api/import/preview', { method: 'POST', body: { rows: rows.slice(i, i + IMPORT_ROW_BATCH), lines: lines.slice(i, i + IMPORT_ROW_BATCH), headerless: pendingImport.headerless, mapping } });
      for (const k of ['total', 'newCount', 'existing', 'existingByPhone', 'updatable', 'duplicate', 'invalid', 'shifted']) totals[k] += r[k] || 0;
      if (totals.invalidSamples.length < 10) totals.invalidSamples.push(...(r.invalidSamples || []));
      if (totals.existingSamples.length < 5) totals.existingSamples.push(...(r.existingSamples || []));
    }
    totals.invalidSamples.sort((a, b) => a.row - b.row);
    return totals;
  }

  function renderSummary(t) {
    const parts = [`<strong>${t.newCount.toLocaleString()} new</strong>`];
    const why = [t.existingByPhone && `${t.existingByPhone.toLocaleString()} recognised by phone number`, t.updatable && `${t.updatable.toLocaleString()} with blank details this file can fill in`].filter(Boolean);
    if (t.existing) parts.push(`${t.existing.toLocaleString()} already in your list${why.length ? ` (${why.join('; ')})` : ''}`);
    if (t.duplicate) parts.push(`${t.duplicate.toLocaleString()} repeated in the file`);
    if (t.invalid) parts.push(`<span class="bad-text">${t.invalid.toLocaleString()} without a usable email</span>`);
    let html = `<div class="summary-line">${t.total.toLocaleString()} row${t.total === 1 ? '' : 's'}: ${parts.join(' · ')}</div>`;
    if (t.shifted) html += `<div class="muted small">${t.shifted.toLocaleString()} row${t.shifted === 1 ? '' : 's'} had the email in a different column than the rest — worth a glance in the preview.</div>`;
    if (pendingImport && pendingImport.skipped) html += `<div class="muted small">${pendingImport.skipped} line${pendingImport.skipped === 1 ? '' : 's'} above the header row (a title or notes) ${pendingImport.skipped === 1 ? 'was' : 'were'} ignored.</div>`;
    if (t.existing && !t.newCount) {
      html += `<div class="muted small">Everyone in this file is already in your candidate list, so there is nobody new to add${t.updatable ? ' — their blank details can still be filled in from the file' : ''}.</div>`;
    }
    if (t.invalidSamples.length) {
      html += `<ul class="problem-list">${t.invalidSamples.slice(0, 10).map((x) =>
        `<li>Row ${x.row}${x.name ? ` (${esc(x.name)})` : ''}: ${x.cell ? `“${esc(x.cell)}” is not an email address` : 'no email address in the row'}</li>`).join('')}` +
        `${t.invalid > 10 ? `<li class="muted">…and ${(t.invalid - 10).toLocaleString()} more</li>` : ''}</ul>`;
    }
    $('#importSummary').innerHTML = html;
    setCommitLabel(t);
  }

  function setCommitLabel(t) {
    const btn = $('#commitImportBtn');
    if (!t) { btn.disabled = true; btn.textContent = 'Import candidates'; return; }
    const upd = $('#importUpdateExisting').checked ? t.updatable : 0;
    if (t.newCount) {
      btn.disabled = false;
      btn.textContent = `Import ${t.newCount.toLocaleString()} candidate${t.newCount === 1 ? '' : 's'}${upd ? ` and update ${upd.toLocaleString()}` : ''}`;
    } else if (upd) {
      btn.disabled = false;
      btn.textContent = `Update ${upd.toLocaleString()} existing candidate${upd === 1 ? '' : 's'}`;
    } else {
      btn.disabled = true;
      btn.textContent = 'Nothing new to import';
    }
  }

  $('#cancelImportBtn').addEventListener('click', () => { $('#mappingCard').hidden = true; pendingImport = null; });
  // True while an import is being written. The page will not reload itself for
  // an update meanwhile, and closing the tab asks first: the batches already
  // written are kept, but the rest of the file exists only in this page.
  let importRunning = false;
  window.addEventListener('beforeunload', (e) => {
    if (!importRunning) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // A batch that met a busy moment (someone else saving, the store slow to
  // answer, a dropped connection) is sent again, a few times, before giving up.
  // Sending one again is safe: anyone it already added is simply "already in
  // your list" the second time.
  const retryable = (err) => err && (err.retry || [409, 502, 503, 504].includes(err.status) || err instanceof TypeError);
  async function commitBatch(body) {
    for (let attempt = 1; ; attempt++) {
      try { return await api('/api/import/commit', { method: 'POST', body }); }
      catch (err) {
        if (attempt >= 4 || !retryable(err)) throw err;
        commitBatch.retried = true;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }

  $('#commitImportBtn').addEventListener('click', async () => {
    if (!pendingImport) return;
    const mapping = currentMapping();
    if (mapping.email === -1) return toast('Pick which column holds the email address.', true);
    const btn = $('#commitImportBtn');
    if (btn.dataset.busy) return;
    const label = btn.textContent;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = 'Importing…';
    $('#importUpdateExisting').disabled = true;
    $$('.map-select').forEach((el) => { el.disabled = true; });
    const totals = { added: 0, updated: 0, existing: 0, duplicate: 0, invalid: 0 };
    const { rows, lines, repeats } = splitRepeats(pendingImport.rows, pendingImport.lines, mapping);
    totals.duplicate += repeats;
    let done = 0;
    let retried = false;
    const listBefore = state ? state.candidates.length : null;
    importRunning = true;
    try {
      for (let i = 0; i < rows.length; i += IMPORT_ROW_BATCH) {
        if (rows.length > IMPORT_ROW_BATCH) btn.textContent = `Importing… ${Math.min(i + IMPORT_ROW_BATCH, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`;
        commitBatch.retried = false;
        const r = await commitBatch({
          rows: rows.slice(i, i + IMPORT_ROW_BATCH), lines: lines.slice(i, i + IMPORT_ROW_BATCH), headerless: pendingImport.headerless,
          mapping, source: pendingImport.source, updateExisting: $('#importUpdateExisting').checked,
        });
        for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
        if (commitBatch.retried) retried = true;
        done = Math.min(i + IMPORT_ROW_BATCH, rows.length);
      }
      $('#mappingCard').hidden = true;
      pendingImport = null;
      importRunning = false;
      const fresh = await refresh().then(() => true, () => false);
      if (fresh && state) {
        totals.onList = state.candidates.length;
        // A batch sent again after a lost answer reports its own people as
        // "already in your list". The list itself says how many were added.
        if (retried && listBefore != null) {
          const gained = Math.max(0, state.candidates.length - listBefore);
          if (gained > totals.added) { totals.existing = Math.max(0, totals.existing - (gained - totals.added)); totals.added = gained; }
        }
      }
      showImportResult(totals);
      $('#importResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      // Say exactly what already went in, and leave the rest ready to retry.
      if (done > 0 && pendingImport) {
        pendingImport.rows = rows.slice(done);
        pendingImport.lines = lines.slice(done);
        showImportResult(totals, `Stopped partway: ${err.message} — ${totals.added.toLocaleString()} added so far. The remaining ${(rows.length - done).toLocaleString()} rows are still loaded below; click Import again to continue.`);
        runDryRun();
      } else {
        oops(err);
      }
      btn.textContent = label;
    } finally {
      importRunning = false;
      delete btn.dataset.busy;
      btn.disabled = !pendingImport;
      $('#importUpdateExisting').disabled = false;
      $$('.map-select').forEach((el) => { el.disabled = false; });
    }
  });

  // ---------------- Apollo: add candidates without a file ----------------
  // Searching is free and only counts matches. Revealing addresses costs one
  // Apollo credit each, so nothing is revealed until the second button, the
  // batch size is what the user typed, and the result says what was spent.
  const APOLLO_DEFAULTS = {
    titles: 'account executive, outside sales representative, business development representative',
    locations: 'United States',
    keywords: 'merchant services, payment processing',
    count: '50',
    minMonths: '12',
    maxMonths: '30',
  };
  let apolloIds = [];        // ids from the last search that have not been added yet
  let apolloBusy = false;

  // Ids already paid for in this browser, so a repeat search does not spend
  // credits revealing the same people twice.
  function apolloSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(teamKey('apolloSeen')) || '[]')); } catch { return new Set(); }
  }
  function rememberApollo(ids) {
    try {
      const all = [...apolloSeen(), ...ids].slice(-5000);
      localStorage.setItem(teamKey('apolloSeen'), JSON.stringify(all));
    } catch {}
  }

  function apolloCriteria() {
    const val = (sel, dflt) => (($(sel) && $(sel).value.trim()) || dflt);
    return {
      titles: val('#apolloTitles', APOLLO_DEFAULTS.titles),
      locations: val('#apolloLocations', APOLLO_DEFAULTS.locations),
      keywords: val('#apolloKeywords', APOLLO_DEFAULTS.keywords),
      minMonthsInRole: val('#apolloMinMonths', APOLLO_DEFAULTS.minMonths),
      maxMonthsInRole: val('#apolloMaxMonths', APOLLO_DEFAULTS.maxMonths),
    };
  }
  const apolloWanted = () => {
    const max = (state.apollo && state.apollo.maxPerPull) || 200;
    return Math.min(max, Math.max(1, Number($('#apolloCount').value) || Number(APOLLO_DEFAULTS.count)));
  };

  function renderApollo() {
    const a = state.apollo || {};
    const badge = $('#apolloStatus');
    if (!badge) return;
    badge.textContent = a.configured ? 'ready' : 'API key needed';
    badge.className = `badge ${a.configured ? 'tint-mint' : 'tint-amber'}`;
    for (const [sel, v] of [['#apolloTitles', APOLLO_DEFAULTS.titles], ['#apolloLocations', APOLLO_DEFAULTS.locations],
      ['#apolloKeywords', APOLLO_DEFAULTS.keywords], ['#apolloCount', APOLLO_DEFAULTS.count],
      ['#apolloMinMonths', APOLLO_DEFAULTS.minMonths], ['#apolloMaxMonths', APOLLO_DEFAULTS.maxMonths]]) {
      const el = $(sel);
      if (el && !el.value && document.activeElement !== el) el.value = v;
    }
    $('#apolloSearchBtn').disabled = apolloBusy || !a.configured;
    // The key can be pasted here instead of hunting for it in Settings.
    $('#apolloKeyRow').hidden = Boolean(a.configured);
    $('#apolloKeyHint').hidden = Boolean(a.configured);
    if (!a.configured && !$('#apolloResult').textContent) {
      $('#apolloResult').innerHTML = 'Paste your Apollo API key above to switch this on. It is the same key as in <button class="btn link" type="button" data-apollo-settings>Settings → Apollo</button>.';
    }
  }

  // Save the key straight from the Import page.
  $('#apolloKeySaveBtn').addEventListener('click', async () => {
    const el = $('#apolloKeyInline');
    const key = el.value.trim();
    if (!key) { el.focus(); return toast('Paste the key from Apollo first.', true); }
    const btn = $('#apolloKeySaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api('/api/settings', { method: 'POST', body: { apolloApiKey: key } });
      el.value = '';
      await refresh();
      $('#apolloResult').textContent = 'Key saved. Press Search to see how many people match — searching costs nothing.';
      toast('Apollo key saved.');
    } catch (err) {
      oops(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save key';
    }
  });

  // "Settings → Apollo" anywhere takes you to the field itself.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-apollo-settings]')) return;
    show('settings');
    const field = $('#setApolloApiKey');
    if (!field) return;
    $('#apolloSettingsCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    field.focus();
    field.classList.add('flash');
    setTimeout(() => field.classList.remove('flash'), 2200);
  });

  $('#apolloSearchBtn').addEventListener('click', async () => {
    if (apolloBusy) return;
    apolloBusy = true;
    $('#apolloSearchBtn').disabled = true;
    $('#apolloImportBtn').disabled = true;
    $('#apolloResult').textContent = 'Searching Apollo…';
    try {
      const want = apolloWanted();
      const seen = apolloSeen();
      const body = apolloCriteria();
      let total = 0;
      let fresh = [];
      // One page is 100 people; fetch a few more only if a bigger batch was asked for.
      for (let page = 1; page <= 3; page++) {
        const r = await api('/api/apollo/search', { method: 'POST', body: { ...body, page } });
        total = r.total || 0;
        fresh = fresh.concat((r.ids || []).filter((id) => !seen.has(id) && !fresh.includes(id)));
        if (fresh.length >= want || page >= (r.pages || 1)) break;
      }
      apolloIds = fresh;
      const take = Math.min(want, apolloIds.length);
      $('#apolloImportBtn').disabled = take === 0;
      $('#apolloImportBtn').textContent = take ? `Add ${take} candidates (about ${take} credits)` : 'Nothing new to add';
      $('#apolloResult').textContent = take
        ? `${total.toLocaleString()} people match. ${take} ready to add, at one Apollo credit each. Anyone already in your list is skipped and nobody from your own company is added.`
        : `${total.toLocaleString()} people match, but every one of them has already been pulled in this browser. Change the titles, locations or months in role for new people.`;
    } catch (err) {
      // Keep the reason on the card: a plan problem is not fixed by pressing
      // Search again, and a toast disappears before it can be read.
      $('#apolloResult').textContent = err.message || String(err);
      if (err.planUpgrade) {
        $('#apolloStatus').textContent = 'plan does not allow it';
        $('#apolloStatus').className = 'badge tint-amber';
        $('#apolloResult').innerHTML = `${esc(err.message)} <a href="https://www.apollo.io/pricing" target="_blank" rel="noopener">See Apollo's plans</a>.`;
      }
      oops(err);
    } finally {
      apolloBusy = false;
      $('#apolloSearchBtn').disabled = false;
    }
  });

  $('#apolloImportBtn').addEventListener('click', async () => {
    if (apolloBusy || !apolloIds.length) return;
    const take = Math.min(apolloWanted(), apolloIds.length);
    if (!confirm(`Reveal ${take} email addresses? This uses about ${take} of your Apollo credits and adds those people to your candidate list.`)) return;
    const batchSize = (state.apollo && state.apollo.batch) || 10;
    const ids = apolloIds.slice(0, take);
    const btn = $('#apolloImportBtn');
    const label = btn.textContent;
    apolloBusy = true;
    btn.disabled = true;
    $('#apolloSearchBtn').disabled = true;
    const t = { added: 0, updated: 0, credits: 0, known: 0, own: 0, noEmail: 0 };
    let done = 0;
    try {
      for (let i = 0; i < ids.length; i += batchSize) {
        const slice = ids.slice(i, i + batchSize);
        const r = await api('/api/apollo/import', { method: 'POST', body: { ids: slice } });
        t.added += r.added || 0;
        t.updated += r.updated || 0;
        t.credits += r.credits || 0;
        t.known += r.alreadyKnown || 0;
        t.own += r.skippedOwnCompany || 0;
        t.noEmail += r.skippedNoEmail || 0;
        rememberApollo(slice);
        done += slice.length;
        btn.textContent = `Adding… ${done} / ${ids.length}`;
        $('#apolloResult').textContent = `${t.added} added so far · ${t.credits} credits used.`;
      }
      apolloIds = apolloIds.slice(done);
      await refresh();
      const bits = [`${t.added} candidate${t.added === 1 ? '' : 's'} added`];
      if (t.known) bits.push(`${t.known} already in your list${t.updated ? ` (${t.updated} filled in with new details)` : ''}`);
      if (t.own) bits.push(`${t.own} skipped as your own colleagues`);
      if (t.noEmail) bits.push(`${t.noEmail} had no usable address`);
      bits.push(`${t.credits} Apollo credits used`);
      $('#apolloResult').textContent = `${bits.join(' · ')}.`;
      toast(`${t.added} candidate${t.added === 1 ? '' : 's'} added from Apollo.`);
    } catch (err) {
      apolloIds = apolloIds.slice(done);
      $('#apolloResult').textContent = `Stopped after ${t.added} added and ${t.credits} credits used — ${err.message}`;
      oops(err);
      if (done) await refresh().catch(() => {});
    } finally {
      apolloBusy = false;
      $('#apolloSearchBtn').disabled = false;
      btn.disabled = apolloIds.length === 0;
      btn.textContent = apolloIds.length ? label : 'Add candidates';
    }
  });

  function showImportResult(t, note) {
    const el = $('#importResult');
    const good = t.added > 0 || t.updated > 0;
    const bits = [`<strong>${t.added.toLocaleString()} added</strong>`];
    if (t.existing) bits.push(`${t.existing.toLocaleString()} already in your list${t.updated ? ` (${t.updated.toLocaleString()} of them updated with new details)` : ''}`);
    if (t.duplicate) bits.push(`${t.duplicate.toLocaleString()} repeated in the file`);
    if (t.invalid) bits.push(`${t.invalid.toLocaleString()} without a usable email`);
    if (t.onList != null) bits.push(`your list now has ${t.onList.toLocaleString()} candidates`);
    el.className = `notice ${note ? 'warn' : good ? 'ok' : 'warn'}`;
    el.innerHTML = `<span class="notice-ico">${icon(good && !note ? 'checkcircle' : 'alert', 16)}</span><div>${bits.join(' · ')}` +
      (note ? `<br><span class="small">${esc(note)}</span>` : '') +
      (!note && !t.added && t.existing ? '<br><span class="small">Nothing was added because every address in the file is already in your candidate list.</span>' : '') +
      `</div><button class="btn notice-action" id="viewCandidatesBtn">View candidates</button>`;
    el.hidden = false;
    // Newest first with nothing filtered, so the people just imported are the
    // first thing on screen — not on page 70 of a list in the order added.
    $('#viewCandidatesBtn').addEventListener('click', () => { show('candidates'); page = 0; openSegment({ sort: 'newest' }); });
    if (note) return;
    toast(t.added ? `Imported ${t.added.toLocaleString()} candidate${t.added === 1 ? '' : 's'}.`
      : t.updated ? `Updated ${t.updated.toLocaleString()} existing candidate${t.updated === 1 ? '' : 's'}.`
      : 'Nothing new to import — everyone in that file is already in your list.', !good);
  }

  // ---------------- Template ----------------
  const SAMPLE = { firstName: 'Jordan', lastName: 'Lee', name: 'Jordan Lee', role: 'Payments Analyst', company: 'Acme Corp', email: 'jordan@example.com' };

  function firstNameOf(c) {
    return c.firstName || (c.name ? c.name.trim().split(/\s+/)[0] : '');
  }

  // A mirror of fill() in lib/template.js, which is what actually goes out.
  // The two had drifted: {{lastName}} was not derived from a single "name"
  // column, so a sheet-imported candidate previewed a blank surname and was
  // sent the real one; and {{fullName}} did not fall back to the first and
  // last name, so an Apollo import previewed "there" and was sent their name.
  // A preview that does not match the send is worse than no preview.
  // template-parity-test feeds both implementations the same records and
  // fails if they ever disagree again.
  const TPL_FALLBACKS = { firstName: 'there', fullName: 'there', role: 'professional' };
  const replaceVars = (text, vars) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    const v = vars[k];
    if (v) return v;
    return TPL_FALLBACKS[k] || '';
  });
  function fillClient(text, cand) {
    const s = state.settings;
    const vars = {
      firstName: firstNameOf(cand),
      lastName: cand.lastName || (cand.name ? cand.name.trim().split(/\s+/).slice(1).join(' ') : ''),
      fullName: cand.name || [cand.firstName, cand.lastName].filter(Boolean).join(' '),
      role: cand.role || '',
      company: cand.company || '',
      email: cand.email || '',
      calendlyUrl: s.calendlyUrl || '',
      originalSubject: cand.lastSubject || '',
    };
    // Preview-only nicety: for somebody not yet emailed there is no original
    // subject, so a follow-up preview shows the subject they *would* get
    // rather than "Re: ". Anyone actually due a follow-up has been emailed and
    // carries the real one, which is what the server uses.
    if (!vars.originalSubject) {
      vars.originalSubject = replaceVars($('#tplSubject').value || state.template.subject, vars);
    }
    return replaceVars(text, vars);
  }

  // A subject line is collapsed to single spaces and trimmed before it is sent
  // (lib/template.js), because a placeholder that resolves to nothing would
  // otherwise leave a gap in it. The preview has to do the same or it shows a
  // subject nobody will receive.
  const fillSubject = (text, cand) => fillClient(text, cand).replace(/\s+/g, ' ').trim();
  // Follow-ups: who is due comes from the server (same rule the queue uses).
  const followUpDueIds = () => (state && state.followUp && state.followUp.dueIds) || [];

  // How the sender reads on an email. sending.from is normally the address
  // alone, but when Google is connected and its profile could not be read it
  // is the words "connected Google account" instead -- wrapping that in angle
  // brackets makes the preview look like a broken address.
  const looksLikeAddress = (v) => /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(String(v || '').trim());
  function senderLine() {
    const from = state.sending.from;
    if (!from) return '';
    const name = (state.settings.fromName || '').trim();
    return name && looksLikeAddress(from) ? `${name} <${from}>` : from;
  }

  function renderTemplatePreview() {
    if (!state) return;
    const sel = $('#previewCandidate');
    const current = sel.value;
    sel.innerHTML = '<option value="">Sample candidate</option>' +
      state.candidates.slice(0, 50).map((c) =>
        `<option value="${c.id}">${esc(c.name || c.email)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
    const cand = candById(sel.value) || SAMPLE;
    $('#pvSubject').textContent = fillSubject($('#tplSubject').value, cand);
    $('#pvFrom').textContent = senderLine() || 'your work email (set up in Settings)';
    const bodyHtml = esc(fillClient($('#tplBody').value, cand)).split('\n').join('<br>');
    const cal = state.settings.calendlyUrl;
    $('#pvBody').innerHTML = bodyHtml + (cal
      ? `<p style="margin:22px 0 6px"><a href="${esc(cal)}" style="display:inline-block;background:var(--blue);color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px;font-weight:600;font-size:14px" onclick="return false">Book a time with me</a></p><p style="margin:0;font-size:12px;color:var(--muted)">${esc(cal)}</p>`
      : '');
    $('#calendlyHintTpl').innerHTML = cal
      ? `The “Book a time with me” button links to <strong>${esc(cal)}</strong> and is appended to every email automatically.`
      : `No Calendly link yet — add one in <a href="#" data-goto="settings">Settings</a> and a booking button is appended to every email automatically.`;

    // Signature comes from the connected work Gmail account — nothing to type.
    const sig = state.google.signature;
    const sigEl = $('#pvSignature');
    sigEl.hidden = !sig;
    sigEl.innerHTML = sig || '';
    const g = state.google;
    $('#signatureHintTpl').innerHTML = sig
      ? `Your Gmail signature (from ${esc(g.email || 'your connected account')}) is added at the bottom automatically.`
      : !g.signatureEnabled
        ? `Gmail signature is turned off in <a href="#" data-goto="settings">Settings</a>, so emails end after the booking button.`
        : g.connected && g.signatureError
          ? `Couldn’t read your Gmail signature (${esc(g.signatureError)}). In <a href="#" data-goto="settings">Settings</a>, click Reconnect and accept all requested permissions.`
          : g.connected
            ? `No signature is set on ${esc(g.email || 'the connected Gmail account')} — add one in Gmail (Settings → General → Signature), then click Reconnect in Settings.`
            : `Your work Gmail signature is appended automatically once Google is connected in <a href="#" data-goto="settings">Settings</a>. (SMTP/App Password sends don’t carry a Gmail signature.)`;
  }

  // Unsaved edits must survive the 30s refresh and page switches.
  // ---------------- Attachments ----------------
  const MAX_ATTACH = 4 * 1048576;
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
  const thumbs = {};
  function renderAttachments() {
    const list = (state.template && state.template.attachments) || [];
    $('#attachList').innerHTML = list.map((a) => `<li class="attach-item" data-id="${esc(a.id)}">
        <span class="attach-thumb" data-id="${esc(a.id)}">${a.type && a.type.startsWith('image/') && thumbs[a.id] ? `<img src="${thumbs[a.id]}" alt="">` : icon('doc', 16)}</span>
        <span class="attach-name" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="attach-size muted small">${fmtSize(a.size)}</span>
        <button class="icon-btn attach-remove" title="Remove" aria-label="Remove ${esc(a.name)}" data-id="${esc(a.id)}">${icon('x', 14)}</button>
      </li>`).join('') || '<li class="attach-empty muted small">No attachments — emails go out as text only.</li>';
    // The flyer that ships with the app can always be put back.
    const hasBuiltin = list.some((a) => a.builtin);
    $('#attachRestore').hidden = hasBuiltin || list.length >= 3;
    $('#attachAddBtn').disabled = list.length >= 3;
    list.filter((a) => a.type && a.type.startsWith('image/') && !thumbs[a.id]).forEach((a) => loadThumb(a.id));
    const pv = $('#pvAttachments');
    pv.hidden = !list.length;
    pv.innerHTML = list.map((a) => `<span class="pv-attach">${icon('paperclip', 13)} ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span></span>`).join('');
  }
  async function loadThumb(id) {
    try {
      const r = await api(`/api/template/attachments/${encodeURIComponent(id)}/preview`);
      thumbs[id] = r.dataUrl;
      const el = $(`.attach-thumb[data-id="${CSS.escape(id)}"]`);
      if (el) el.innerHTML = `<img src="${r.dataUrl}" alt="">`;
    } catch {}
  }
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsDataURL(blob);
  });
  // Big images are re-encoded in the browser so they fit and send quickly.
  // A transparent image stays a PNG (JPEG has no transparency, and flattening
  // one onto a default black canvas ruins dark artwork); only if that is still
  // too large is it flattened onto white and saved as a JPEG.
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    const draw = (maxEdge, background) => {
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return { canvas, ctx };
    };
    const base = file.name.replace(/\.[^.]+$/, '');
    const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    const { canvas, ctx } = draw(2200, null);
    let transparent = false;
    try {
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < px.length; i += 4) { if (px[i] < 255) { transparent = true; break; } }
    } catch { transparent = true; }   // tainted canvas: assume transparency and keep PNG
    if (transparent) {
      const png = await toBlob(canvas, 'image/png');
      if (png && png.size <= MAX_ATTACH) return { blob: png, type: 'image/png', name: `${base}.png` };
    }
    const flat = draw(2200, '#ffffff').canvas;
    for (const q of [0.9, 0.8, 0.7]) {
      const jpg = await toBlob(flat, 'image/jpeg', q);
      if (jpg && jpg.size <= MAX_ATTACH) return { blob: jpg, type: 'image/jpeg', name: `${base}.jpg` };
    }
    throw new Error('That image is too large even after shrinking — export it smaller, or as a PDF.');
  }
  $('#attachRestore').addEventListener('click', async () => {
    try {
      await api('/api/template/attachments/restore-builtin', { method: 'POST' });
        await refresh();
    } catch (err) { oops(err); }
  });
  $('#attachAddBtn').addEventListener('click', () => $('#attachFile').click());
  $('#attachFile').addEventListener('change', async () => {
    const file = $('#attachFile').files[0];
    $('#attachFile').value = '';
    if (!file) return;
    const btn = $('#attachAddBtn');
    btn.disabled = true;
    try {
      let blob = file, name = file.name;
      if (file.size > MAX_ATTACH && /^image\/(png|jpeg|webp)$/.test(file.type)) {
        toast('Large image — shrinking it so it sends quickly…');
        ({ blob, name } = await shrinkImage(file));
      }
      if (blob.size > MAX_ATTACH) throw new Error('That file is over 4 MB. Export it smaller, or as a PDF.');
      const data = await toBase64(blob);
      await api('/api/template/attachments', { method: 'POST', body: { name, data } });
      await refresh();
    } catch (err) { oops(err); }
    finally { btn.disabled = false; renderAttachments(); }
  });
  $('#attachList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.attach-remove');
    if (!btn) return;
    try {
      await api(`/api/template/attachments/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        await refresh();
    } catch (err) { oops(err); }
  });

  let templateDirty = false;
  // A new template being made in an editor, not saved yet: what the editor
  // held before + New was pressed, so Cancel can put it back.
  const presetDraft = { email: null, text: null };
  function setTemplateDirty(d) {
    templateDirty = d;
    $('#saveTemplateBtn').textContent = presetDraft.email ? 'Save new template' : (d ? 'Save template •' : 'Save template');
  }
  ['#tplSubject', '#tplBody', '#tplName'].forEach((s) =>
    $(s).addEventListener('input', () => { setTemplateDirty(true); debouncedPreview(); }));
  const debouncedPreview = debounce(renderTemplatePreview, 200);
  $('#previewCandidate').addEventListener('change', () => { renderTemplatePreview(); renderFollowUpPreview(); });

  $$('.tpl-token').forEach((btn) => btn.addEventListener('click', () => {
    const ta = $('#tplBody');
    const t = btn.dataset.token;
    const start = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + t + ta.value.slice(ta.selectionEnd ?? start);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + t.length;
    setTemplateDirty(true);
    renderTemplatePreview();
  }));

  $('#saveTemplateBtn').addEventListener('click', () => savePresetEditor('email'));
  $('#resetTemplateBtn').addEventListener('click', async () => {
    if (!confirm('Put the starter email back into your default template? Your current wording of it is replaced.')) return;
    try {
      const r = await api('/api/template/reset', { method: 'POST' });
      $('#tplSubject').value = r.template.subject;
      $('#tplBody').value = r.template.body;
      setTemplateDirty(false);
      renderTemplatePreview();
      await refresh();
    } catch (err) { oops(err); }
  });

  // ---------------- Candidate list backups ----------------
  // The list is copied to a separate backup every day by the server. From
  // here: a spreadsheet of everyone, a copy on demand, and "restore missing",
  // which only ever adds back people who are not on the list now.
  const backupWhen = dateFormat([], { dateStyle: 'medium', timeStyle: 'short' });
  function renderBackups() {
    if (!state) return;
    const list = state.backups || [];
    const n = state.candidates.length;
    const newest = list[0];
    $('#backupBadge').textContent = newest ? `last backup ${timeAgo(newest.at)}` : 'first backup today';
    $('#backupSummary').textContent = newest
      ? `${n.toLocaleString()} candidates on your list. They are saved on the server as you work, and copied to a separate backup every day. ${list.length === 1 ? 'One backup so far' : `${list.length} backups kept`} — the newest 20 are always kept.`
      : `${n.toLocaleString()} candidates on your list. They are saved on the server as you work; the first daily backup is made within the next few minutes, or press Back up now.`;
    const html = list.map((b) => `<li><span class="when">${esc(backupWhen(b.at))}</span>` +
      `<span class="muted">${Number(b.count || 0).toLocaleString()} candidates · ${b.reason === 'daily' ? 'daily' : 'made by hand'}</span>` +
      `<button class="btn-link" data-restore="${esc(b.key)}">Restore missing</button></li>`).join('');
    const ul = $('#backupList');
    if (ul.dataset.html !== html) { ul.innerHTML = html; ul.dataset.html = html; }
  }
  // Fetched rather than followed, so an expired session or a storage error is
  // a message on screen instead of a file that turns out to hold an error.
  $('#exportCandidatesBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/candidates/export');
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Download failed (${res.status})`); }
      const blob = await res.blob();
      const name = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'candidates.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (err) { oops(err); }
  });
  $('#backupNowBtn').addEventListener('click', async () => {
    const btn = $('#backupNowBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/backups', { method: 'POST' });
      state.backups = r.backups;
      renderBackups();
      toast(`Backed up ${r.backup.count.toLocaleString()} candidates.`);
    } catch (err) { oops(err); }
    finally { btn.disabled = false; }
  });
  $('#backupList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-restore]');
    if (!btn) return;
    try {
      const check = await api('/api/backups/restore', { method: 'POST', body: { key: btn.dataset.restore, dryRun: true } });
      const skipped = check.deleted ? ` ${check.deleted.toLocaleString()} ${check.deleted === 1 ? 'other was' : 'others were'} deleted on purpose and stay deleted.` : '';
      if (!check.missing) { toast(`Everyone in that backup is already on your list — nothing to restore.${skipped}`); return; }
      const who = (check.names || []).join(', ') + (check.missing > (check.names || []).length ? ', …' : '');
      if (!confirm(`${check.missing.toLocaleString()} ${check.missing === 1 ? 'person in this backup is' : 'people in this backup are'} not on your list now (${who}). Add them back? Nobody already on the list is changed.${skipped}`)) return;
      const r = await api('/api/backups/restore', { method: 'POST', body: { key: btn.dataset.restore } });
      toast(`Restored ${r.restored.toLocaleString()} candidate${r.restored === 1 ? '' : 's'}.`);
      await refresh();
    } catch (err) { oops(err); }
  });

  // ---------------- Saved templates ----------------
  // Any number of named emails and texts, kept on the server with the team.
  // Each Settings editor shows one of them at a time; the send windows offer
  // them all. One of each kind is the default: what the send window opens
  // with, and what the queue uses when nothing else was chosen.
  const presetShown = { email: '', text: '' };
  function presetsOf(kind) { return (state && state.templates && state.templates[kind]) || []; }
  function defaultPresetId(kind) { return (state && state.templates && state.templates.defaults && state.templates.defaults[kind]) || ''; }
  function presetById(kind, id) { return presetsOf(kind).find((p) => p.id === id) || null; }
  const nameField = (kind) => $(kind === 'email' ? '#tplName' : '#txName');
  const cleanPresetName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function editorWords(kind) {
    return kind === 'email'
      ? { subject: $('#tplSubject').value, body: $('#tplBody').value }
      : { body: $('#txBody').value };
  }
  function setEditorWords(kind, w) {
    if (kind === 'email') {
      $('#tplSubject').value = w.subject || '';
      $('#tplBody').value = w.body || '';
      renderTemplatePreview();
    } else {
      $('#txBody').value = w.body || '';
      renderTextPreview();
    }
  }
  // The template an editor is showing. If it is deleted elsewhere while the
  // editor holds unsaved words, the editor stays on it (shown as deleted) —
  // sliding to the default would make Save write those words over the default.
  function currentPreset(kind) {
    if (!presetById(kind, presetShown[kind]) && !presetDirty(kind)) presetShown[kind] = defaultPresetId(kind);
    return presetById(kind, presetShown[kind]);
  }
  // Save pressed on an editor whose template was deleted elsewhere: offer to
  // keep the words as a new template instead of writing them anywhere else.
  async function saveOrphanedEdits(kind) {
    const words = kind === 'email'
      ? { subject: $('#tplSubject').value, body: $('#tplBody').value }
      : { body: $('#txBody').value };
    if (!confirm('The template you were editing was deleted (perhaps in another tab). Save these words as a new template?')) return;
    const made = await createPreset(kind, cleanPresetName(nameField(kind).value) || suggestName(kind), words);
    if (!made) return;
    presetShown[kind] = made.id;
    setPresetDirty(kind, false);
    renderPresetBar(kind);
  }
  function presetOptions(kind, selectedId) {
    const def = defaultPresetId(kind);
    return presetsOf(kind).map((p) =>
      `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}${p.id === def ? ' — default' : ''}</option>`).join('');
  }
  function fillPresetSelect(sel, kind, selectedId) {
    const html = presetOptions(kind, selectedId);
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = selectedId;
  }
  // The row above an editor: the picker, and what can be done to the one shown.
  function renderPresetBar(kind) {
    const pre = kind === 'email' ? 'tpl' : 'tx';
    const noun = kind === 'email' ? 'template' : 'text';
    const saveBtn = $(kind === 'email' ? '#saveTemplateBtn' : '#txSave');
    const sel = $(`#${pre}Preset`);
    $(`#${pre}PresetCancel`).hidden = !presetDraft[kind];
    if (presetDraft[kind]) {
      // A new one being made: it has no place in the list until it is saved.
      const html = `<option value="" selected>New ${noun} (not saved yet)</option>${presetOptions(kind, '')}`;
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      sel.value = '';
      $(`#${pre}PresetDefault`).hidden = true;
      $(`#${pre}PresetDelete`).hidden = true;
      $(kind === 'email' ? '#resetTemplateBtn' : '#txReset').hidden = true;
      $(`#${pre}PresetNote`).textContent = `Type a name, change the ${kind === 'email' ? 'subject and message' : 'message'} if you like, then press ${kind === 'email' ? 'Save new template' : 'Save new text'}.`;
      saveBtn.textContent = kind === 'email' ? 'Save new template' : 'Save new text';
      return;
    }
    const p = currentPreset(kind);
    if (!p) {
      // Deleted elsewhere while being edited: say so, and offer nothing that would act on it.
      const html = `<option value="" selected>(deleted — unsaved)</option>${presetOptions(kind, '')}`;
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      sel.value = '';
      for (const id of ['PresetDefault', 'PresetDelete']) $(`#${pre}${id}`).hidden = true;
      $(`#${pre}PresetNote`).textContent = 'This template was deleted elsewhere. Save keeps your words as a new one.';
      return;
    }
    // The name of the one shown, unless you are part-way through changing it.
    if (!presetDirty(kind)) nameField(kind).value = p.name;
    const isDefault = p.id === defaultPresetId(kind);
    fillPresetSelect($(`#${pre}Preset`), kind, p.id);
    $(`#${pre}PresetDefault`).hidden = isDefault;
    $(`#${pre}PresetDelete`).hidden = isDefault;
    $(`#${pre}PresetNote`).textContent = isDefault
      ? `The ${kind === 'email' ? 'send window' : 'text composer'} opens with this one.`
      : (p.updatedAt ? `Saved ${timeAgo(p.updatedAt)}` : '');
    // "Restore starter text" belongs to the default only.
    $(kind === 'email' ? '#resetTemplateBtn' : '#txReset').hidden = !isDefault;
    $(kind === 'email' ? '#saveTemplateBtn' : '#txSave').textContent =
      `${kind === 'email' ? 'Save template' : 'Save message'}${(kind === 'email' ? templateDirty : textTemplateDirty) ? ' •' : ''}`;
  }
  const presetDirty = (kind) => (kind === 'email' ? templateDirty : textTemplateDirty);
  function setPresetDirty(kind, d) {
    if (kind === 'email') setTemplateDirty(d);
    else { textTemplateDirty = d; $('#txSave').textContent = presetDraft.text ? 'Save new text' : (d ? 'Save message •' : 'Save message'); }
  }
  function loadPresetIntoEditor(kind) {
    const p = currentPreset(kind);
    if (!p) return;
    setEditorWords(kind, p);
    nameField(kind).value = p.name;
  }
  function suggestName(kind) {
    const base = kind === 'email' ? 'New email' : 'New text';
    const taken = new Set(presetsOf(kind).map((p) => p.name.toLowerCase()));
    for (let i = 1; ; i++) { const n = i === 1 ? base : `${base} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
  }
  // Keep words as a new, named template. Used by the editors and by both
  // send windows; returns the new template, or null.
  async function createPreset(kind, name, words) {
    try {
      const r = await api(`/api/templates/${kind}`, { method: 'POST', body: { name, ...words } });
      state.templates = r.templates;
      toast(`Saved as “${r.preset.name}”. Pick it from the Template list whenever you ${kind === 'email' ? 'email' : 'text'}.`);
      refresh().catch(() => {});
      return r.preset;
    } catch (err) { oops(err); return null; }
  }
  function nameMissing(field, kind) {
    toast(`Give the ${kind === 'email' ? 'template' : 'text'} a name first — it is how you find it in the Template list.`, true);
    field.focus();
  }
  // Save on an editor: the new template being made, or the one shown —
  // its name and words together.
  async function savePresetEditor(kind) {
    const name = cleanPresetName(nameField(kind).value);
    if (presetDraft[kind]) {
      if (!name) { nameMissing(nameField(kind), kind); return; }
      const made = await createPreset(kind, name, editorWords(kind));
      if (!made) return;
      presetDraft[kind] = null;
      presetShown[kind] = made.id;
      setPresetDirty(kind, false);
      renderPresetBar(kind);
      return;
    }
    const p = currentPreset(kind);
    if (!p) { await saveOrphanedEdits(kind); return; }
    if (!name) { nameMissing(nameField(kind), kind); return; }
    try {
      const r = await api(`/api/templates/${kind}/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { name, ...editorWords(kind) } });
      state.templates = r.templates;
      setPresetDirty(kind, false);
      renderPresetBar(kind);
      toast(p.id === defaultPresetId(kind)
        ? `“${name}” saved — the ${kind === 'email' ? 'send window' : 'text composer'} opens with it.`
        : `“${name}” saved. Pick it under Template when you ${kind === 'email' ? 'send' : 'text'}.`);
      await refresh();
    } catch (err) { oops(err); }
  }
  for (const kind of ['email', 'text']) {
    const pre = kind === 'email' ? 'tpl' : 'tx';
    $(`#${pre}Preset`).addEventListener('change', (e) => {
      const next = e.target.value;
      const was = presetDraft[kind] ? null : currentPreset(kind);
      if (!next) return;
      const question = presetDraft[kind]
        ? `Discard the new ${kind === 'email' ? 'template' : 'text'} you were making?`
        : `Discard your unsaved changes${was ? ` to “${was.name}”` : ''}?`;
      if (presetDirty(kind) && !confirm(question)) {
        e.target.value = was ? was.id : '';
        return;
      }
      presetDraft[kind] = null;
      presetShown[kind] = next;
      setPresetDirty(kind, false);
      loadPresetIntoEditor(kind);
      renderPresetBar(kind);
    });
    // + New: a new template starts as a copy of what the editor holds, with
    // an empty name to fill in. Nothing is stored until Save.
    $(`#${pre}PresetNew`).addEventListener('click', () => {
      if (!presetDraft[kind]) {
        presetDraft[kind] = {
          fromId: presetShown[kind] || defaultPresetId(kind),
          dirty: presetDirty(kind),
          words: editorWords(kind),
          name: nameField(kind).value,
        };
        nameField(kind).value = '';
        setPresetDirty(kind, true);   // unsaved: kept through refreshes, and leaving asks first
        renderPresetBar(kind);
      }
      nameField(kind).focus();
    });
    $(`#${pre}PresetCancel`).addEventListener('click', () => {
      const d = presetDraft[kind];
      if (!d) return;
      presetDraft[kind] = null;
      presetShown[kind] = d.fromId;
      if (d.dirty) { setEditorWords(kind, d.words); nameField(kind).value = d.name; setPresetDirty(kind, true); }
      else { setPresetDirty(kind, false); loadPresetIntoEditor(kind); }
      renderPresetBar(kind);
    });
    nameField(kind).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); savePresetEditor(kind); } });
    $(`#${pre}PresetDefault`).addEventListener('click', async () => {
      const p = currentPreset(kind);
      if (!p) return;
      if (presetDirty(kind) && !confirm(`“${p.name}” has unsaved changes. Make the saved version the default anyway?`)) return;
      try {
        const r = await api(`/api/templates/${kind}/${encodeURIComponent(p.id)}/default`, { method: 'POST' });
        state.templates = r.templates;
        renderPresetBar(kind);
        toast(`“${p.name}” is now the default — the ${kind === 'email' ? 'send window' : 'text composer'} opens with it.`);
        await refresh();
      } catch (err) { oops(err); }
    });
    $(`#${pre}PresetDelete`).addEventListener('click', async () => {
      const p = currentPreset(kind);
      if (!p || !confirm(`Delete the template “${p.name}”? Messages already queued with it still go out as written.`)) return;
      try {
        const r = await api(`/api/templates/${kind}/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        state.templates = r.templates;
        presetShown[kind] = defaultPresetId(kind);
        setPresetDirty(kind, false);
        loadPresetIntoEditor(kind);
        renderPresetBar(kind);
        toast(`Deleted “${p.name}”.`);
      } catch (err) { oops(err); }
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ---------------- Follow-up email ----------------
  let followUpDirty = false;
  function setFollowUpDirty(d) {
    followUpDirty = d;
    $('#saveFollowUpBtn').textContent = d ? 'Save follow-up •' : 'Save follow-up';
  }
  function renderFollowUpEditor() {
    if (!state || !state.followUp) return;
    if (!followUpDirty) {
      $('#fuSubject').value = state.followUp.template.subject;
      $('#fuBody').value = state.followUp.template.body;
    }
    renderFollowUpPreview();
  }
  function renderFollowUpPreview() {
    if (!state) return;
    const sel = $('#previewCandidate');
    const cand = candById(sel.value) || state.candidates.find((c) => c.status === 'emailed') || SAMPLE;
    $('#fuPvSubject').textContent = fillSubject($('#fuSubject').value, cand);
    $('#fuPvBody').innerHTML = esc(fillClient($('#fuBody').value, cand)).split('\n').join('<br>');
    const fu = state.followUp || { days: 3, max: 2 };
  }
  const debouncedFollowUpPreview = debounce(renderFollowUpPreview, 200);
  ['#fuSubject', '#fuBody'].forEach((sel) => $(sel).addEventListener('input', () => { setFollowUpDirty(true); debouncedFollowUpPreview(); }));
  $$('.fu-token').forEach((btn) => btn.addEventListener('click', () => {
    const ta = $('#fuBody');
    const t = btn.dataset.fuToken;
    const start = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + t + ta.value.slice(ta.selectionEnd ?? start);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + t.length;
    setFollowUpDirty(true);
    renderFollowUpPreview();
  }));
  $('#saveFollowUpBtn').addEventListener('click', async () => {
    try {
      await api('/api/followup', { method: 'POST', body: { subject: $('#fuSubject').value, body: $('#fuBody').value } });
      setFollowUpDirty(false);
      toast('Follow-up email saved.');
      await refresh();
    } catch (err) { oops(err); }
  });
  $('#resetFollowUpBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/followup/reset', { method: 'POST' });
      $('#fuSubject').value = r.followUp.subject;
      $('#fuBody').value = r.followUp.body;
      setFollowUpDirty(false);
      renderFollowUpPreview();
      } catch (err) { oops(err); }
  });
  $('#tplFollowUpBtn').addEventListener('click', () => {
    if (followUpDirty) openCompose(followUpDueIds(), { subject: $('#fuSubject').value, body: $('#fuBody').value }, { followUp: true });
  });

  // ---------------- Settings ----------------
  $('#copyRedirectBtn').addEventListener('click', async () => {
    const uri = $('#redirectUriCode').textContent.trim();
    try { await navigator.clipboard.writeText(uri); toast('Redirect URI copied — paste it under Authorized redirect URIs in Google Cloud.'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#redirectUriCode')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Select and copy the address.'); }
  });

  let settingsDirty = false;
  function setSettingsDirty(d) {
    settingsDirty = d;
    $('#saveSettingsBtn').textContent = d ? 'Save settings •' : 'Save settings';
  }
  // The Team card is the first thing in this view but it saves itself through
  // its own buttons, so typing a PIN there must not mark the settings form
  // below as having unsaved changes — which would also freeze it against
  // server updates until something was pressed.
  $$('#view-settings input:not([data-no-dirty])').forEach((el) => el.addEventListener('input', () => setSettingsDirty(true)));

  // ---------------- Text composer ----------------
  // Texting one person, or a handful, without touching the saved template.
  // Queued rather than sent on the spot: the pace, the daily cap and the
  // recipient's own clock are all decided server-side, and a text that goes
  // out the instant a button is pressed would defeat all three.
  let textComposeIds = [];
  let textComposeThenEmail = null;

  function openTextCompose(ids, { thenEmail = null, title = '' } = {}) {
    const want = new Set(ids);
    const people = state.candidates.filter((c) => want.has(c.id) && textPhoneOf(c));
    if (!people.length) {
      toast('None of those people have a phone number yet — add one from the Text column.', true);
      return;
    }
    textComposeIds = people.map((c) => c.id);
    textComposeThenEmail = thenEmail;
    $('#textComposeTitle').textContent = title || (people.length === 1
      ? `Text ${people[0].name || prettyPhone(textPhoneOf(people[0]))}`
      : `Text ${people.length.toLocaleString()} people`);
    const shown = people.length > 12 ? 4 : 12;
    $('#textComposeTo').innerHTML = people.slice(0, shown).map((c) =>
      `<span class="to-chip">${esc(c.name || 'Unnamed')} <span class="muted">${esc(prettyPhone(textPhoneOf(c)))}</span></span>`).join('')
      + (people.length > shown ? `<span class="to-chip muted">+${(people.length - shown).toLocaleString()} more</span>` : '');
    const def = presetById('text', defaultPresetId('text'));
    $('#textComposeBody').value = (def && def.body) || (state.texting && state.texting.template && state.texting.template.body) || '';
    fillPresetSelect($('#textComposePreset'), 'text', def ? def.id : '');
    textComposeLoaded = { body: $('#textComposeBody').value, id: def ? def.id : '' };
    $('#textComposeSendBtn').textContent = people.length > 1 ? `Queue ${people.length.toLocaleString()} texts` : 'Send text';
    $('#textComposeNow').checked = false;   // never sticky between sends
    $('#textComposeSaveAsRow').hidden = true;
    $('#textComposeSaveAsName').value = '';
    openModal('#textComposeModal');
    renderTextComposePreview();
    setTimeout(() => $('#textComposeBody').focus(), 40);
  }

  function renderTextComposePreview() {
    const who = candById(textComposeIds[0]) || {};
    const first = who.firstName || (who.name || '').split(' ')[0] || 'there';
    const body = ($('#textComposeBody').value || '')
      .replace(/\{\{\s*firstName\s*\}\}/g, first)
      .replace(/\{\{\s*fullName\s*\}\}/g, who.name || first)
      .replace(/\{\{\s*role\s*\}\}/g, who.role || 'professional')
      .replace(/\{\{\s*company\s*\}\}/g, who.company || '');
    const link = state.settings.calendlyUrl;
    const full = link && !body.includes(link) ? `${body.trim()}\n\n${link}` : body.trim();
    $('#textComposePreview').textContent = full;

    const q = (state.texting && state.texting.queue) || {};
    const n = textComposeIds.length;
    const nowMode = $('#textComposeNow').checked;
    const bits = [`${full.length} characters`];
    if (!q.relay || !q.relay.online) bits.push('the Mac relay is offline, so these will wait until it is back');
    else if (nowMode) bits.push('goes out within a few seconds, whatever the hour where they are');
    else if (n > 1) bits.push(`sent one at a time, roughly every ${Math.round(((q.minGap || 45) + (q.maxGap || 150)) / 2)}s`);
    if (!nowMode && q.startHour !== undefined) bits.push(`only between ${q.startHour}:00 and ${q.endHour}:00 where each person lives`);
    if (q.remainingToday !== undefined && n > q.remainingToday) bits.push(`only ${q.remainingToday} fit under today's cap — the rest go tomorrow`);
    $('#textComposeHint').textContent = bits.join(' · ');
    $('#textComposeHint').className = nowMode ? 'hint bad' : 'hint';
  }

  $('#textComposeBody').addEventListener('input', renderTextComposePreview);
  let textComposeLoaded = { body: '', id: '' };
  $('#textComposePreset').addEventListener('change', (e) => {
    const p = presetById('text', e.target.value);
    if (!p) return;
    if ($('#textComposeBody').value !== textComposeLoaded.body && !confirm(`Replace what you have written with “${p.name}”?`)) {
      e.target.value = textComposeLoaded.id; return;
    }
    $('#textComposeBody').value = p.body || '';
    textComposeLoaded = { body: p.body || '', id: p.id };
    renderTextComposePreview();
  });
  $('#textComposeSaveAsBtn').addEventListener('click', () => {
    $('#textComposeSaveAsRow').hidden = false;
    $('#textComposeSaveAsName').focus();
  });
  $('#textComposeSaveAsCancel').addEventListener('click', () => { $('#textComposeSaveAsRow').hidden = true; $('#textComposeSaveAsName').value = ''; });
  async function textComposeSaveAs() {
    const field = $('#textComposeSaveAsName');
    const name = cleanPresetName(field.value);
    if (!name) { nameMissing(field, 'text'); return; }
    const made = await createPreset('text', name, { body: $('#textComposeBody').value });
    if (!made) return;
    fillPresetSelect($('#textComposePreset'), 'text', made.id);
    textComposeLoaded = { body: made.body, id: made.id };
    $('#textComposeSaveAsRow').hidden = true;
    field.value = '';
  }
  $('#textComposeSaveAsConfirm').addEventListener('click', textComposeSaveAs);
  $('#textComposeSaveAsName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); textComposeSaveAs(); } });
  $('#textComposeNow').addEventListener('change', renderTextComposePreview);
  $$('.tc-token').forEach((b) => b.addEventListener('click', () => {
    const el = $('#textComposeBody');
    const at = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, at) + b.dataset.tcToken + el.value.slice(el.selectionEnd ?? at);
    el.focus();
    el.selectionStart = el.selectionEnd = at + b.dataset.tcToken.length;
    renderTextComposePreview();
  }));

  $('#textComposeSendBtn').addEventListener('click', async () => {
    const btn = $('#textComposeSendBtn');
    const body = $('#textComposeBody').value.trim();
    if (!body) { toast('The message is empty.', true); return; }
    btn.disabled = true;
    try {
      const sendNow = $('#textComposeNow').checked;
      if (sendNow && textComposeIds.length > 3
          && !confirm(`Send ${textComposeIds.length} texts right now, ignoring the quiet hours? That is meant for testing one message, not a batch.`)) {
        btn.disabled = false; return;
      }
      const tq = (state.texting && state.texting.queue) || {};
      const n = textComposeIds.length;
      if (n > 1 && (!tq.relay || !tq.relay.online)) {
        if (!confirm(`The Mac relay is offline, so nothing will send until it is back. Queue these ${n.toLocaleString()} texts anyway?`)) { btn.disabled = false; return; }
      } else if (n > 1 && !sendNow && !confirm(`Text ${n.toLocaleString()} people? They go out one at a time, only during daytime hours where each person lives.`)) {
        btn.disabled = false; return;
      }
      const r = await api('/api/texts/queue', { method: 'POST', body: { ids: textComposeIds, template: { body }, ignoreQuietHours: sendNow } });
      const skip = r.skipped || {};
      const notes = [];
      // Reasons the ranking filtered them out, in the words it used.
      for (const [why, n] of Object.entries(r.reasons || {})) notes.push(`${n} ${why}`);
      if (skip.queued) notes.push(`${skip.queued} ${skip.queued === 1 ? 'is' : 'are'} already waiting in the queue`);
      if (skip.alreadyTexted) notes.push(`${skip.alreadyTexted} ${skip.alreadyTexted === 1 ? 'was' : 'were'} texted in the last 24h`);
      if (skip.optedOut) notes.push(`${skip.optedOut} asked to stop`);
      if (skip.noPhone) notes.push(`${skip.noPhone} had no usable number`);
      const did = [];
      if (r.added) did.push(`${r.added} text${r.added === 1 ? '' : 's'} queued`);
      if (r.promoted) did.push(`${r.promoted} moved to the front to go now`);
      // Never report "nothing happened" without saying why — that was the whole
      // problem: a red toast with no reason and no way to tell what to do next.
      toast(did.length
        ? `${did.join(' · ')}${notes.length ? ` · ${notes.join(', ')}` : ''}.`
        : `Nothing to send — ${notes.length ? notes.join(', ') : 'those people cannot be texted right now'}.`,
        !did.length);
      closeModal($('#textComposeModal'));
      const alsoEmail = textComposeThenEmail;
      textComposeThenEmail = null;
      await refresh();
      if (alsoEmail && alsoEmail.length) openCompose(alsoEmail);
    } catch (err) { oops(err); }
    finally { btn.disabled = false; }
  });

  // ---------------- Texting ----------------
  // A parallel channel to email: the queue lives on the server, but the
  // sending is done by the relay on the Mac Studio, so most of this page is
  // about whether that Mac is there and what it has managed to do.
  let textTemplateDirty = false;
  let relayTokenRevealed = '';

  // The same rule the server applies in lib/phone.js, so the count on the
  // button is the number that will actually be queued — a "Text 40 people"
  // that turns into 31 is exactly the kind of thing that stops being trusted.
  function textPhoneOf(c) {
    let raw = String((c && c.phone) || '').trim();
    if (!raw) return '';
    raw = raw.replace(/\b(?:ext|x|extension)\.?\s*\d+\s*$/i, '');
    const plus = raw.trimStart().startsWith('+');
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    const nanp = (ten) => {
      if (!/^\d{10}$/.test(ten)) return false;
      const area = ten.slice(0, 3);
      const exch = ten.slice(3, 6);
      if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exch)) return false;
      if (area[1] === '1' && area[2] === '1') return false;
      if (exch[1] === '1' && exch[2] === '1') return false;
      if (area === '555') return false;
      if (exch === '555' && /^01\d\d$/.test(ten.slice(6))) return false;
      return true;
    };
    if (digits.length === 11 && digits[0] === '1') return nanp(digits.slice(1)) ? `+${digits}` : '';
    if (!plus) return digits.length === 10 && nanp(digits) ? `+1${digits}` : '';
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  }
  const prettyPhone = (e164) => (/^\+1\d{10}$/.test(e164)
    ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`
    : e164);

  // ---------------- Call, Message and Mail, through the phone's own apps ----------------
  // For the moment the candidate is five minutes late for the interview: one
  // tap rings them, texts them or opens a fresh email, from the phone itself
  // rather than through Gmail or the Mac. Shown on a phone only (mobile.css);
  // the desktop keeps the app's own actions.
  //
  // A number can be rung even when it cannot be texted by the relay — a
  // landline, an extension — so calling falls back to whatever digits there are.
  function dialOf(raw) {
    const e164 = textPhoneOf({ phone: raw });
    if (e164) return e164;
    const s = String(raw || '').replace(/\b(?:ext|x|extension)\.?\s*\d+\s*$/i, '').trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return '';
    return (s.startsWith('+') ? '+' : '') + digits;
  }
  const mailtoOf = (email) => {
    const e = String(email || '').trim();
    return /^[^\s@]+@[^\s@]+$/.test(e) ? `mailto:${e.split('@').map(encodeURIComponent).join('@')}` : '';
  };
  // who: { phone, email, name }. With addNumber, a missing number is a button
  // that opens the candidate to add one, rather than a dead icon.
  function nativeActs(who, { size = 34, labels = true, addNumber = false, cls = '' } = {}) {
    const name = who.name || 'them';
    const dial = dialOf(who.phone);
    const mail = mailtoOf(who.email);
    const shown = dial ? prettyPhone(dial) : '';
    const noNumber = addNumber ? 'No phone number yet — tap to add one' : 'No phone number on file';
    const one = (kind, href, label, app, title, offTitle) => {
      const inner = `${appIcon(app, size)}${labels ? `<span class="native-label">${label}</span>` : ''}`;
      if (href) return `<a class="native-act native-${kind}" href="${esc(href)}" aria-label="${esc(title)}" title="${esc(title)}">${inner}</a>`;
      if (addNumber && kind !== 'mail') {
        return `<button type="button" class="native-act native-${kind} is-off add-number" aria-label="${esc(offTitle)}" title="${esc(offTitle)}">${inner}</button>`;
      }
      return `<span class="native-act native-${kind} is-off" role="img" aria-label="${esc(offTitle)}" title="${esc(offTitle)}">${inner}</span>`;
    };
    return `<div class="native-acts${cls ? ` ${cls}` : ''}">`
      + one('call', dial && `tel:${dial}`, 'Call', 'phone', `Call ${name}${shown ? ` on ${shown}` : ''}`, noNumber)
      + one('sms', dial && `sms:${dial}`, 'Message', 'messages', `Text ${name} from your phone${shown ? ` (${shown})` : ''}`, noNumber)
      + one('mail', mail, 'Mail', 'mail', `Email ${name} from your phone’s Mail app`, 'No email address on file')
      + '</div>';
  }
  // Kept until the list changes: the Texting page's header counts them every
  // time it is drawn.
  const textableIds = kept(() => [listVersion, state && state.candidates], () => state.candidates
    .filter((c) => textPhoneOf(c) && !c.lastTextedAt && c.status !== 'declined' && c.status !== 'booked')
    .map((c) => c.id));

  // How many conversations are unread on each channel, counted once per
  // version of the list for the bell, the tabs, the switches and the app icon.
  const unreadTally = kept(() => [listVersion, state && state.candidates], () => {
    const n = { text: 0, email: 0 };
    for (const c of (state && state.candidates) || []) {
      if (c.textUnread) n.text += 1;
      if (c.emailUnread) n.email += 1;
    }
    return n;
  });

  function textCell(c) {
    const phone = textPhoneOf(c);
    const raw = String((c && c.phone) || '').trim();
    // A number we cannot dial is worth saying so, not hiding behind a dash.
    if (!phone) {
      return raw
        ? `<button class="text-pip is-none add-number" title="${esc(raw)} is not a number we can text — click to fix it"><i class="dot"></i>bad number</button>`
        : '<button class="text-pip add-number" title="Add a mobile number">+ add number</button>';
    }
    const st = TEXT_STATUS[c.textStatus];
    if (!st) return `<span class="text-pip"><i class="dot"></i>${esc(prettyPhone(phone))}</span>`;
    const when = c.textRepliedAt || c.textReadAt || c.textDeliveredAt || c.lastTextedAt;
    return `<span class="text-pip ${st.cls}" title="${esc(prettyPhone(phone))}${when ? ` · ${fullStamp(when)}` : ''}">
      <i class="dot"></i>${st.label}</span>`;
  }

  // ---------------- Messages ----------------
  // A conversation view, because a reply with no record of what it answers is
  // unreadable. The thread itself is fetched per conversation rather than
  // shipped with the dashboard state: fifty messages for each of 2,800 people
  // would be most of the payload, and all but one of them is off screen.
  let convFilter = 'all';
  let convSearch = '';
  let openThreadId = null;
  let thread = null;          // the fetched conversation, or null
  let threadLoading = false;
  let threadSeq = 0;          // which request for a thread is the latest

  // The table's initials() wants a candidate and falls back to an email. A
  // conversation may only ever have had a phone number, so this one takes what
  // it is given and degrades to the number rather than to "undefined".
  const convInitials = (name, fallback) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return String(fallback || '?').replace(/\D/g, '').slice(-2) || '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };

  // Everyone we have actually exchanged a message with, newest first.
  // Both conversation lists are sorted by recency and can run to thousands of
  // rows. Building them all cost 15,813 DOM nodes for Texting and 5,624 for
  // Email — rebuilt on every poll, for a list nobody scrolls past the top of.
  // So: render a screenful, and grow when you reach the bottom.
  const CONV_PAGE = 60;

  // The row you have open is always included, so a conversation you opened
  // from a search does not vanish when the search is cleared.
  function convPage(rows, shown, openId) {
    const slice = rows.slice(0, shown);
    if (openId && !slice.some((c) => c.id === openId)) {
      const open = rows.find((c) => c.id === openId);
      if (open) slice.push(open);
    }
    return slice;
  }

  // Writing innerHTML resets scrollTop. A poll landing while you are half way
  // down the list should not throw you back to the top.
  function keepingScroll(el, write) {
    const top = el.scrollTop;
    write();
    if (top && el.scrollHeight > el.clientHeight) el.scrollTop = top;
  }

  const moreRow = (n) => (n > 0 ? `<li class="conv-more">${n.toLocaleString()} more</li>` : '');

  // Grow the list as it is scrolled, rather than making anyone click for it.
  function growOnScroll(el, more, render) {
    el.addEventListener('scroll', () => {
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 240) return;
      if (more()) render();
    }, { passive: true });
  }

  // What a list last drew: which answer, how many of its rows from the top,
  // and whether the open conversation was tacked on below them (convPage).
  const drawnAs = (all, rows, shown) => ({ all, n: Math.min(shown, all.length), extra: rows.length > Math.min(shown, all.length) });

  // Grown by scrolling, a list adds the next rows under the ones it has
  // rather than drawing every row again. Not when it is no longer the answer
  // it drew, nor when the open conversation was tacked on below (it has to
  // move into its place): then the caller draws it whole. Returns whether
  // it was done here.
  function appendRows(el, drawn, all, shown, row) {
    if (!drawn || drawn.all !== all || drawn.extra) return false;
    const to = Math.min(shown, all.length);
    if (to <= drawn.n) return true;
    const more = el.querySelector('.conv-more');
    if (more) more.remove();
    el.insertAdjacentHTML('beforeend', all.slice(drawn.n, to).map(row).join('') + moreRow(all.length - to));
    drawn.n = to;
    return true;
  }

  // Search looks through every conversation on the channel, whatever filter
  // is showing: somebody who has not replied is still somebody you can look
  // up, and on Email's Replied tab they used to be impossible to find. A
  // number matches however it is typed, the way the Candidates search does,
  // and so do the words of the last message.
  function convMatcher(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    const tail = (d) => (d.length === 11 && d[0] === '1' ? d.slice(1) : d);
    const qDigits = tail(q.replace(/\D/g, ''));
    const byDigits = qDigits.length >= 3 && /^[\d\s().+-]+$/.test(q);
    return (c, extra) => {
      if (byDigits && tail(String(c.phone || '').replace(/\D/g, '')).includes(qDigits)) return true;
      return `${c.name || ''} ${c.email || ''} ${c.phone || ''} ${c.company || ''} ${c.role || ''} ${extra || ''}`.toLowerCase().includes(q);
    };
  }

  // Kept for this version of the list, this search and this tab: the list is
  // drawn after every poll, grows as it is scrolled, and is asked whether
  // there is more, each time over every conversation there is.
  const conversations = kept(() => [listVersion, state && state.candidates, convSearch, convFilter], () => {
    const all = (state.candidates || []).filter((c) => c.textCount > 0);
    const match = convMatcher(convSearch);
    return all
      .filter((c) => (match ? match(c, (c.textLast || {}).text) : convFilter === 'unread' ? c.textUnread : true))
      .map((c) => ({ c, k: String((c.textLast || {}).ts || '') }))
      .sort((a, b) => collator.compare(b.k, a.k))
      .map((x) => x.c);
  });

  const unreadCount = () => unreadTally().text;

  function convRow(c) {
    const last = c.textLast || {};
    const who = c.name || textPhoneOf(c) || 'Unknown';
    return `<li><button class="conv${c.id === openThreadId ? ' on' : ''}${c.textUnread ? ' unread' : ''}" data-conv="${esc(c.id)}">
            <span class="avatar">${esc(convInitials(c.name, c.phone))}</span>
            <span class="conv-main">
              <span class="conv-top"><span class="conv-name">${esc(who)}</span><span class="conv-when"${last.ts ? ` data-ago="${esc(last.ts)}"` : ''}>${last.ts ? timeAgo(last.ts) : ''}</span><span class="conv-chev">${icon('chevron', 12)}</span></span>
              <span class="conv-last">${last.dir === 'out' ? '<span class="conv-you">You:</span> ' : ''}${esc(last.text || '')}</span>
            </span>
            ${c.textUnread ? '<span class="conv-dot" aria-label="unread"></span>' : ''}
          </button></li>`;
  }

  // What the list last drew, so that growing it only adds the new rows under
  // the ones already there (see growOnScroll).
  let convDrawn = null;
  forgetWithState(() => { convDrawn = null; });
  let convShown = CONV_PAGE;
  function renderConvList({ more = false } = {}) {
    const all = conversations();
    const el = $('#convList');
    if (more && appendRows(el, convDrawn, all, convShown, convRow)) return;
    const rows = convPage(all, convShown, openThreadId);
    const n = unreadCount();
    $('#convUnreadN').textContent = n || '';
    $('#convUnreadN').hidden = !n;
    $$('[data-conv-tab]').forEach((b) => b.classList.toggle('on', b.dataset.convTab === convFilter));
    // While a search is running it covers every conversation, so the filter
    // steps back rather than looking as if it still applied.
    $('#view-texting .conv-col').classList.toggle('is-searching', Boolean(convSearch.trim()));
    keepingScroll(el, () => { el.innerHTML = rows.length
      ? rows.map(convRow).join('') + moreRow(all.length - rows.length)
      : `<li class="conv-none">${convSearch.trim() ? `No results for “${esc(convSearch.trim())}”.` : convFilter === 'unread' ? 'Nothing unread.' : 'No conversations yet. Texts you send show up here.'}</li>`; });
    convDrawn = drawnAs(all, rows, convShown);
  }

  // `quiet` means this is the background refresh of a conversation already on
  // screen, not you opening one. Blanking it to "Loading…" every 30 seconds
  // made a conversation you were reading flicker; leave what is there and swap
  // it when the new copy arrives.
  async function openThread(id, { markSeen = true, quiet = false } = {}) {
    // A different conversation gets its own half-written reply, not the last
    // one's: one box shared by all of them carried a draft meant for one
    // person into the next conversation opened, a tap away from sending it
    // to the wrong one.
    if (id !== openThreadId) restoreDraft('text', id, $('#threadInput'));
    openThreadId = id;
    threadLoading = true;
    // On a phone the thread is a screen pushed over the list. `quiet` is the
    // background refresh of a thread already on screen, which must not push a
    // second time.
    if (!quiet) pushThread('texting');
    renderConvList();
    $('#threadEmpty').hidden = true;
    $('#threadLive').hidden = false;
    if (!quiet) $('#threadBody').innerHTML = '<p class="thread-loading">Loading…</p>';
    // Only the latest request may draw. A background refresh of the last
    // conversation that answers after you have opened another one used to
    // put that person's messages under this one's reply box — and a reply
    // typed to the name on screen went to somebody else.
    const seq = ++threadSeq;
    let got;
    try {
      got = await api(`/api/texts/thread?id=${encodeURIComponent(id)}`);
    } catch (e) {
      if (seq !== threadSeq || id !== openThreadId) return;
      threadLoading = false;
      // A failed background refresh keeps the conversation you were reading.
      if (quiet) return;
      thread = null;
      $('#threadBody').innerHTML = `<p class="thread-loading">${esc(e.message)}</p>`;
      return;
    }
    if (seq !== threadSeq || id !== openThreadId) return;
    thread = got;
    threadLoading = false;
    renderThread();
    if (markSeen) {
      const c = candById(id);
      if (c && c.textUnread) {
        // Read up to the newest message this screen now shows, so one that
        // lands a moment later is still news.
        const lastIn = [...(thread.thread || [])].reverse().find((m) => m.dir === 'in' && !m.kind);
        markRead('text', [{ c, ts: newest(lastIn && lastIn.ts, lastInTs(c, 'text')) }]);
        renderConvList();
      }
    }
  }

  function renderThread() {
    if (!thread) return;
    $('#threadAvatar').textContent = convInitials(thread.name, thread.phone);
    $('#threadName').textContent = thread.name || thread.phone || 'Unknown';
    const bits = [thread.phone, thread.role, thread.company].filter(Boolean);
    $('#threadSub').textContent = bits.join(' · ');
    const tc = candById(openThreadId) || {};
    $('#threadNative').innerHTML = nativeActs({ phone: thread.phone || tc.phone, email: tc.email, name: thread.name || tc.name }, { size: 30, labels: false });

    // Anything still queued for the Mac is shown as a pending bubble, so a
    // reply does not disappear between pressing send and the relay picking
    // it up a minute later.
    const msgs = [
      ...thread.thread.map((m) => ({ ...m, pending: false })),
      ...(thread.pending || []).map((m) => ({ dir: 'out', ts: null, text: m.text, pending: true })),
    ];
    $('#threadBody').innerHTML = msgs.length
      ? msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const gap = !prev || (m.ts && prev.ts && new Date(m.ts) - new Date(prev.ts) > 60 * 60 * 1000);
          const stamp = gap && m.ts ? `<div class="thread-stamp">${esc(whenLabel(m.ts))}</div>` : '';
          // A tapback or a Driving Focus reply is the phone talking, not the
          // candidate: shown, but quietly, and never counted as a reply.
          const machine = m.dir !== 'out' && m.kind;
          return `${stamp}<div class="msg ${m.dir === 'out' ? 'out' : 'in'}${m.pending ? ' pending' : ''}${machine ? ' machine' : ''}">
            <div class="bubble">${esc(m.text)}</div>
            ${m.pending ? '<div class="msg-meta">Sending…</div>' : ''}
            ${machine ? `<span class="msg-tag">${m.kind === 'reaction' ? 'Tapback' : 'Auto-reply'}</span>` : ''}
          </div>`;
        }).join('')
      : '<p class="thread-loading">No messages yet.</p>';
    $('#threadBody').scrollTop = $('#threadBody').scrollHeight;

    const stopped = thread.optedOut;
    $('#threadInput').disabled = stopped;
    $('#threadSend').disabled = stopped;
    $('#threadInput').placeholder = stopped ? 'They replied STOP' : 'Text Message';
    const relay = ((state.texting || {}).queue || {}).relay || {};
    $('#threadNote').textContent = stopped
      ? 'They replied STOP, so nothing more can be sent to this number.'
      : relay.online ? '' : 'The Mac relay is offline — replies will queue and send when it is back.';
  }

  function whenLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = clockTime(d);
    if (sameDay) return `Today ${time}`;
    const yday = new Date(now); yday.setDate(now.getDate() - 1);
    if (d.toDateString() === yday.toDateString()) return `Yesterday ${time}`;
    return `${monthDay(d)} ${time}`;
  }

  // A text is on its way. Disabling the button stopped a second tap, but not
  // a second press of Enter: the box still held the words until the first
  // answer came back, so they went twice. Nothing more is sent until it has.
  let replySending = false;
  async function sendReply() {
    const box = $('#threadInput');
    const body = box.value.trim();
    if (replySending || !body || !openThreadId) return;
    replySending = true;
    $('#threadSend').disabled = true;
    try {
      const to = openThreadId;
      try {
        await api('/api/texts/reply', { method: 'POST', body: { id: to, body } });
      } finally {
        replySending = false;
      }
      saveDraft('text', to, '');
      if (openThreadId === to) { box.value = ''; box.style.height = ''; }
      // Show it immediately rather than waiting for the next poll.
      // Only in its own conversation: another may have been opened while
      // this was on its way.
      if (thread && thread.id === to && openThreadId === to) { thread.pending = [...(thread.pending || []), { text: body }]; renderThread(); }
      await refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#threadSend').disabled = Boolean(thread && thread.optedOut);
    }
  }

  // ---- drafts: one per conversation ----
  // Kept for the session as well, so a reload to take a new version of the
  // app does not throw away what was being written.
  const DRAFTS_KEY = 'wp-drafts';
  let drafts = null;
  function draftStore() {
    if (!drafts) { try { drafts = JSON.parse(sessionStorage.getItem(DRAFTS_KEY)) || {}; } catch { drafts = {}; } }
    return drafts;
  }
  const draftKey = (ch, id) => `${currentTeam ? currentTeam.id : ''}:${ch}:${id}`;
  function saveDraft(ch, id, text) {
    if (!id) return;
    const d = draftStore();
    const k = draftKey(ch, id);
    if (text && text.trim()) d[k] = text; else delete d[k];
    try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(d)); } catch { /* kept in memory */ }
  }
  function restoreDraft(ch, id, box) {
    if (!box) return;
    box.value = draftStore()[draftKey(ch, id)] || '';
    box.style.height = '';
    if (box.value) { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, ch === 'email' ? 160 : 120)}px`; }
  }

  // An email reply carries everything before it underneath ("On Monday,
  // Blake wrote: > …"). In a conversation that history is already on the
  // screen, so it is split off and folded away.
  function splitQuoted(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const at = lines.findIndex((l, i) => /^On .{4,200}wrote:\s*$/i.test(l.trim())
      || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l.trim())
      || /^From:\s.+/.test(l.trim()) && i > 0 && lines[i - 1].trim() === ''
      || (/^>/.test(l) && lines.slice(i).filter((x) => x.trim()).every((x) => /^>/.test(x))));
    if (at <= 0) return { main: String(text || ''), quoted: '' };
    const main = lines.slice(0, at).join('\n').replace(/\s+$/, '');
    if (!main.trim()) return { main: String(text || ''), quoted: '' };
    return { main, quoted: lines.slice(at).join('\n').trim() };
  }

  // ---------------- The inbox ----------------
  // The same shape as Messages, over a different store. Email conversations
  // are NOT mirrored onto the candidate: Gmail already holds them, and a copy
  // would go stale the moment a reply is sent from a phone or from Gmail
  // itself. So the list is built from what we know locally — who was emailed,
  // who answered — and the thread is read live when it is opened.
  let mailFilter = 'replied';
  let mailSearch = '';
  let openMailId = null;
  let mail = null;
  let mailLoading = false;
  let mailSeq = 0;

  // Kept the way the Texting list is (see conversations()).
  const mailboxes = kept(() => [listVersion, state && state.candidates, mailSearch, mailFilter], () => {
    const all = (state.candidates || []).filter((c) => c.lastEmailedAt || c.emailReplies);
    const match = convMatcher(mailSearch);
    const when = (c) => (c.emailLast && c.emailLast.ts) || c.lastReplyAt || c.lastEmailedAt || '';
    return all
      .filter((c) => (match
        ? match(c, `${(c.emailLast || {}).text || ''} ${c.lastSubject || ''}`)
        : mailFilter === 'unread' ? c.emailUnread : mailFilter === 'replied' ? c.emailReplies > 0 : true))
      .map((c) => ({ c, k: String(when(c)) }))
      .sort((a, b) => collator.compare(b.k, a.k))
      .map((x) => x.c);
  });

  const mailUnreadCount = () => unreadTally().email;

  function mailRow(c) {
    const last = c.emailLast;
    const ts = (last && last.ts) || c.lastReplyAt || c.lastEmailedAt || '';
    const preview = last ? last.text : c.lastSubject || 'Sent, no reply yet';
    return `<li><button class="conv${c.id === openMailId ? ' on' : ''}${c.emailUnread ? ' unread' : ''}" data-mail="${esc(c.id)}">
            <span class="avatar">${esc(convInitials(c.name, c.email))}</span>
            <span class="conv-main">
              <span class="conv-top"><span class="conv-name">${esc(c.name || c.email || 'Unknown')}</span>${c.emailBounced && !c.emailReplies ? '<span class="conv-flag" title="Bounced">!</span>' : ''}<span class="conv-when"${ts ? ` data-ago="${esc(ts)}"` : ''}>${ts ? timeAgo(ts) : ''}</span><span class="conv-chev">${icon('chevron', 12)}</span></span>
              <span class="conv-last">${last ? '' : '<span class="conv-you">You:</span> '}${esc(preview)}</span>
            </span>
            ${c.emailUnread ? '<span class="conv-dot" aria-label="unread"></span>' : ''}
          </button></li>`;
  }

  let mailDrawn = null;
  forgetWithState(() => { mailDrawn = null; });
  let mailShown = CONV_PAGE;
  function renderMailList({ more = false } = {}) {
    const all = mailboxes();
    const el = $('#mailList');
    if (more && appendRows(el, mailDrawn, all, mailShown, mailRow)) return;
    const rows = convPage(all, mailShown, openMailId);
    const n = mailUnreadCount();
    $('#mailUnreadN').textContent = n || '';
    $('#mailUnreadN').hidden = !n;
    $$('[data-mail-tab]').forEach((b) => b.classList.toggle('on', b.dataset.mailTab === mailFilter));
    $('#view-template .conv-col').classList.toggle('is-searching', Boolean(mailSearch.trim()));
    keepingScroll(el, () => { el.innerHTML = rows.length
      ? rows.map(mailRow).join('') + moreRow(all.length - rows.length)
      : `<li class="conv-none">${mailSearch.trim() ? `No results for “${esc(mailSearch.trim())}”.` : mailFilter === 'unread' ? 'Nothing unread.' : mailFilter === 'replied' ? 'Nobody has replied by email yet.' : 'Nothing emailed yet.'}</li>`; });
    mailDrawn = drawnAs(all, rows, mailShown);
  }

  async function openMail(id, { markSeen = true, quiet = false } = {}) {
    if (id !== openMailId) restoreDraft('email', id, $('#mailInput'));
    openMailId = id;
    mailLoading = true;
    if (!quiet) pushThread('template');
    renderMailList();
    $('#mailEmpty').hidden = true;
    $('#mailLive').hidden = false;
    if (!quiet) $('#mailBody').innerHTML = '<p class="thread-loading">Reading the conversation from Gmail…</p>';
    // As for texts: only the latest request may draw.
    const seq = ++mailSeq;
    let got;
    try {
      got = await api(`/api/emails/thread?id=${encodeURIComponent(id)}`);
    } catch (e) {
      if (seq !== mailSeq || id !== openMailId) return;
      mailLoading = false;
      if (quiet) return;
      mail = null;
      $('#mailBody').innerHTML = `<p class="thread-loading">${esc(e.message)}</p>`;
      return;
    }
    if (seq !== mailSeq || id !== openMailId) return;
    mail = got;
    mailLoading = false;
    const mc = candById(id);
    mailShownSig = mc ? mailSig(mc) : '';
    renderMail();
    if (markSeen && mc && mc.emailUnread) {
      const lastIn = [...(mail.messages || [])].reverse().find((m) => m.dir !== 'out' && !m.kind);
      markRead('email', [{ c: mc, ts: newest(lastIn && lastIn.date, lastInTs(mc, 'email')) }]);
      renderMailList();
    }
  }
  // What the list knew about a conversation when it was last read from
  // Gmail: when it changes, the copy on screen is out of date.
  let mailShownSig = '';
  const mailSig = (c) => `${lastInTs(c, 'email')}|${c.emailReplies || 0}|${c.lastEmailedAt || ''}`;

  function renderMail() {
    if (!mail) return;
    $('#mailAvatar').textContent = convInitials(mail.name, mail.email);
    $('#mailName').textContent = mail.name || mail.email || 'Unknown';
    $('#mailSub').textContent = [mail.email, mail.role, mail.company].filter(Boolean).join(' · ');
    const mc = candById(openMailId) || {};
    $('#mailNative').innerHTML = nativeActs({ phone: mc.phone, email: mail.email || mc.email, name: mail.name || mc.name }, { size: 30, labels: false });
    const gm = $('#mailGmail');
    gm.hidden = !mail.gmailUrl;
    if (mail.gmailUrl) gm.href = mail.gmailUrl;

    if (mail.unavailable) {
      $('#mailBody').innerHTML = `<p class="thread-loading">${esc(mail.unavailable)}</p>`;
    } else {
      const them = mail.name || mail.email || 'Them';
      $('#mailBody').innerHTML = (mail.messages || []).length
        ? mail.messages.map((m, i) => {
            const prev = mail.messages[i - 1];
            const gap = !prev || (m.date && prev.date && new Date(m.date) - new Date(prev.date) > 60 * 60 * 1000);
            const stamp = gap && m.date ? `<div class="thread-stamp">${esc(whenLabel(m.date))}</div>` : '';
            const { main, quoted } = splitQuoted(m.text || m.snippet || '');
            // A bounce is the mail system talking, not the candidate, so it is
            // marked rather than dressed up as a reply.
            const tag = m.kind === 'bounce' ? '<span class="msg-tag bad">Bounce</span>'
              : m.kind === 'auto' ? '<span class="msg-tag">Auto-reply</span>' : '';
            // Each message says who and when, the way Mail heads one; the
            // earlier messages it quotes are folded away behind "•••", since
            // they are already on the screen above it.
            return `${stamp}<div class="msg ${m.dir === 'out' ? 'out' : 'in'}${m.kind ? ' machine' : ''}">
              <div class="msg-head"><span class="msg-who">${esc(m.dir === 'out' ? 'You' : them)}</span>${m.date ? `<span class="msg-when">${esc(whenLabel(m.date))}</span>` : ''}</div>
              <div class="bubble">${esc(main)}${mail.limited && !m.text ? '<span class="msg-clip"> …</span>' : ''}${quoted ? `<details class="msg-quote"><summary aria-label="Show quoted text">•••</summary><div class="msg-quoted">${esc(quoted)}</div></details>` : ''}</div>
              ${tag}
            </div>`;
          }).join('')
        : '<p class="thread-loading">Nothing in this conversation yet.</p>';
    }
    $('#mailBody').scrollTop = $('#mailBody').scrollHeight;

    const can = Boolean(mail.canReply);
    $('#mailInput').disabled = !can;
    $('#mailSend').disabled = !can;
    $('#mailNote').textContent = can && mail.limited
      ? 'Only previews are readable with the current Google permissions — Settings → Google → Reconnect and tick every box to see full messages.'
      : '';
  }

  // As for texts: a second Cmd/Ctrl-Enter while the first email is still on
  // its way sent it again, because only the button was disabled.
  let mailSending = false;
  async function sendMailReply() {
    const box = $('#mailInput');
    const body = box.value.trim();
    if (mailSending || !body || !openMailId) return;
    mailSending = true;
    $('#mailSend').disabled = true;
    try {
      const to = openMailId;
      try {
        await api('/api/emails/reply', { method: 'POST', body: { id: to, body } });
      } finally {
        mailSending = false;
      }
      saveDraft('email', to, '');
      if (openMailId === to) { box.value = ''; box.style.height = ''; }
      toast('Reply sent.');
      await refresh();
      // The conversation is already on screen — swap the new copy in rather
      // than blanking it, so your reply appears without a flash.
      await openMail(openMailId, { markSeen: false, quiet: true });
    } catch (e) {
      toast(e.message, true);
      $('#mailSend').disabled = false;
    }
  }

  function wireMail() {
    $('#mailList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mail]');
      if (b) openMail(b.dataset.mail);
    });
    $$('[data-mail-tab]').forEach((b) => b.addEventListener('click', () => { mailFilter = b.dataset.mailTab; mailShown = CONV_PAGE; renderMailList(); }));
    // Debounced: every keystroke used to rebuild the whole list.
    const mailSearchRender = debounce(renderMailList, 120);
    $('#mailSearch').addEventListener('input', (e) => { mailSearch = e.target.value; mailShown = CONV_PAGE; mailSearchRender(); });
    growOnScroll($('#mailList'), () => {
      if (mailShown >= mailboxes().length) return false;
      mailShown += CONV_PAGE;
      return true;
    }, () => renderMailList({ more: true }));
    $('#mailCompose').addEventListener('submit', (e) => { e.preventDefault(); sendMailReply(); });
    // An email is long-form, so Enter makes a paragraph and Cmd/Ctrl-Enter sends.
    $('#mailInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMailReply(); }
    });
    $('#mailInput').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
      saveDraft('email', openMailId, e.target.value);
    });
    // Who this is: their card, with everything that can be done for them —
    // not the edit form, which put the keyboard up over the conversation.
    $('#mailOpenCandidate').addEventListener('click', () => { const c = openMailId && candById(openMailId); if (c) openProfile(c); });
  }

  // ---------------- Light and dark ----------------
  // The attribute is already set by the inline script in <head>; this only
  // reads it back and lets you change it. Kept in localStorage rather than on
  // the server because it is a property of the screen you are sitting at, not
  // of the account — the same login on a phone at night wants its own answer.
  const THEME_KEY = 'wp-theme';
  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

  function setTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { /* no storage */ }
    $$('.theme-switch').forEach((sw) => sw.setAttribute('aria-checked', String(dark)));
  }

  function mountTheme() {
    $$('.head-chrome').forEach((row) => {
      if (row.querySelector('.theme-switch')) return;
      const sw = document.createElement('button');
      sw.className = 'theme-switch';
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(isDark()));
      sw.setAttribute('aria-label', 'Dark mode');
      sw.title = 'Light / dark';
      sw.innerHTML = `<span class="theme-knob">
          <span class="theme-ico theme-sun">${icon('sun', 16)}</span>
          <span class="theme-ico theme-moon">${icon('moon', 15)}</span>
        </span>`;
      sw.addEventListener('click', () => setTheme(!isDark()));
      row.appendChild(sw);
    });
  }

  // Only while no choice has been made: if you flip your Mac to dark at sunset,
  // the CRM follows. The moment you touch the switch, it stops listening.
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (e) => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* no storage */ }
      if (saved) return;
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      $$('.theme-switch').forEach((sw) => sw.setAttribute('aria-checked', String(e.matches)));
    };
    if (mq.addEventListener) mq.addEventListener('change', follow);
    else if (mq.addListener) mq.addListener(follow);
  }

  // ---------------- The bell ----------------
  // One button, injected into every page's header rather than copied into six
  // of them, so a reply is visible from wherever you happen to be standing.
  function mountBell() {
    $$('.head-chrome').forEach((row) => {
      if (row.querySelector('.bell')) return;
      const b = document.createElement('button');
      b.className = 'bell';
      b.type = 'button';
      b.title = 'Notifications';
      b.setAttribute('aria-label', 'Notifications');
      b.innerHTML = `${icon('bell', 18)}<span class="bell-n" hidden></span>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
      // Rung once, then done: a bell left holding the class rang again every
      // time its page was shown.
      b.addEventListener('animationend', () => b.classList.remove('ring'));
      row.appendChild(b);
    });
  }

  // One bell for both channels. Two would mean deciding which to look at, and
  // a reply is a reply whichever way it arrived.
  const allUnread = () => unreadCount() + mailUnreadCount();

  // ---- read and unread ----
  // What this screen has read, and up to which reply: `${id}:${ch}` -> the
  // time of the newest reply shown when it was read. A conversation opened
  // here is read here at once and stays read: a poll that set off before the
  // tap, or a "seen" call lost on a bad connection, used to bring the old
  // flag back, and the badge re-lit and the bell rang again for a reply
  // already read. A reply newer than the one read is news, and still shows.
  const locallyRead = new Map();
  const seenToldAt = new Map();      // when the server was last told, per key
  const UNREAD_FLAG = { text: 'textUnread', email: 'emailUnread' };
  const tsNum = (ts) => { const n = Date.parse(ts || ''); return Number.isFinite(n) ? n : 0; };
  const newest = (...ts) => ts.filter(Boolean).sort((a, b) => tsNum(b) - tsNum(a))[0] || '';

  // The newest thing they wrote on a channel, as the list knows it.
  function lastInTs(c, ch) {
    if (ch === 'email') return (c.emailLast && c.emailLast.ts) || c.lastReplyAt || '';
    return (c.textLastIn && c.textLastIn.ts) || (c.textLast && c.textLast.dir === 'in' ? c.textLast.ts : '') || '';
  }

  // Every reply the bell has already rung for, by who, which channel and
  // which message. null until the first render, so a page load with unread
  // waiting does not read as something having just arrived.
  let rungKeys = null;
  function resetUnreadMemory() { locallyRead.clear(); seenToldAt.clear(); rungKeys = null; }

  // Read, here and on the server. `list` is [{ c, ts }], ts being the newest
  // reply the screen showed; the server keeps the flag if anything newer has
  // come in since.
  function markRead(ch, list) {
    const flag = UNREAD_FLAG[ch];
    const items = [];
    for (const { c, ts } of list) {
      if (!c) continue;
      const seen = ts || lastInTs(c, ch);
      locallyRead.set(`${c.id}:${ch}`, seen);
      overlay(c, flag, false);
      items.push(seen ? { id: c.id, ts: seen } : { id: c.id });
    }
    if (!items.length) return Promise.resolve();
    // A flag changed in place: every unread count and list kept from the
    // list is out of date.
    bumpList();
    renderUnread();
    return tellSeen(ch, items);
  }
  function tellSeen(ch, items) {
    const now = Date.now();
    items.forEach((i) => seenToldAt.set(`${i.id}:${ch}`, now));
    const send = () => api(ch === 'email' ? '/api/emails/seen' : '/api/texts/seen', { method: 'POST', body: { items } });
    // One more try, then leave it to the next full poll (applyLocallyRead),
    // which asks again for as long as the server still says unread.
    return send().catch(() => wait(2500).then(send)).catch(() => { stateTag = ''; });
  }
  // Laid over each fresh copy of the state, before anything is drawn.
  function applyLocallyRead() {
    if (!state || !locallyRead.size) return;
    const again = { text: [], email: [] };
    let changed = false;
    for (const [key, seen] of [...locallyRead]) {
      const at = key.lastIndexOf(':');
      const id = key.slice(0, at);
      const ch = key.slice(at + 1);
      const c = candById(id);
      // Gone, or read on the server too: nothing left to hold.
      if (!c || !c[UNREAD_FLAG[ch]]) { locallyRead.delete(key); continue; }
      // Something newer than what was read: that is news.
      if (seen && tsNum(lastInTs(c, ch)) > tsNum(seen) + 1000) { locallyRead.delete(key); continue; }
      overlay(c, UNREAD_FLAG[ch], false);
      changed = true;
      if (Date.now() - (seenToldAt.get(key) || 0) > 20000) again[ch].push(seen ? { id, ts: seen } : { id });
    }
    if (changed) bumpList();
    for (const ch of ['text', 'email']) if (again[ch].length) tellSeen(ch, again[ch]);
  }

  // Every count of unread in one place — the bell, the Inbox tab, the Email
  // and Texts switch, the Unread filters and the app icon — so no two of
  // them can disagree after something is read.
  function renderUnread() {
    renderBell();
    renderNavCounts();
    renderAppBadge();
  }
  // The number on the Home Screen icon, where the device supports it.
  const badgeCanAsk = () => {
    try { return installed() && 'setAppBadge' in navigator && 'Notification' in window && Notification.permission === 'default'; } catch { return false; }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bellBadgeAsk')) return;
    Promise.resolve(Notification.requestPermission()).catch(() => {}).then(() => {
      appBadgeShown = -1;
      renderAppBadge();
      if (!$('#bellPanel').hidden) renderBellPanel();
    });
  });
  let appBadgeShown = -1;
  function renderAppBadge() {
    const n = state ? allUnread() : 0;
    if (n === appBadgeShown) return;
    appBadgeShown = n;
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch { /* not supported here */ }
  }

  // Kept until the list changes: the bell is drawn after every new state and
  // every conversation read.
  const unreadKeys = kept(() => [listVersion, state && state.candidates], () => {
    const out = [];
    for (const c of state.candidates || []) {
      if (c.textUnread) out.push(`${c.id}:text:${lastInTs(c, 'text')}`);
      if (c.emailUnread) out.push(`${c.id}:email:${lastInTs(c, 'email')}`);
    }
    return out;
  });

  function renderBell() {
    const n = allUnread();
    // It rings for a reply it has not rung for before — not whenever the
    // count goes up, which rang again for replies already read.
    const keys = unreadKeys();
    const arrived = rungKeys !== null && keys.some((k) => !rungKeys.has(k));
    if (!rungKeys) rungKeys = new Set();
    keys.forEach((k) => rungKeys.add(k));
    $$('.bell').forEach((b) => {
      const dot = b.querySelector('.bell-n');
      dot.textContent = n > 99 ? '99+' : String(n);
      dot.hidden = !n;
      b.classList.toggle('lit', Boolean(n));
    });
    // Only the bell on screen rings. One on a hidden page cannot play the
    // animation, so it would never let go of the class.
    if (arrived) {
      const b = $$('.bell').find((x) => x.getClientRects().length);
      if (b) {
        // Restarted even if it is already running: two replies a second
        // apart ring twice, not once.
        b.classList.remove('ring');
        void b.offsetWidth;
        b.classList.add('ring');
      }
    }
    if (!$('#bellPanel').hidden) renderBellPanel();
  }

  // One entry per conversation, not per person: someone who answered both
  // the text and the email is two things to read, not one. Built from the
  // unread flags as well as the last message, so everything the badge counts
  // is listed and can be read or cleared from here.
  const BELL_EARLIER_DAYS = 7;
  // Kept until the list changes, unread and read apart, each newest first.
  const bellItems = kept(() => [listVersion, state && state.candidates], () => {
    const out = [];
    for (const c of state.candidates || []) {
      const tin = c.textLastIn || (c.textLast && c.textLast.dir === 'in' ? c.textLast : null);
      if (tin || c.textUnread) {
        out.push({ c, ch: 'text', ts: tin ? tin.ts : (c.textLast || {}).ts, text: tin ? tin.text : 'New text message', unread: Boolean(c.textUnread), who: c.name || textPhoneOf(c) || 'Unknown' });
      }
      if (c.emailLast || c.emailUnread) {
        out.push({ c, ch: 'email', ts: c.emailLast ? c.emailLast.ts : c.lastReplyAt, text: c.emailLast ? c.emailLast.text : 'New email reply', unread: Boolean(c.emailUnread), who: c.name || c.email || 'Unknown' });
      }
    }
    const sorted = out.map((i) => ({ i, k: String(i.ts || '') })).sort((a, b) => collator.compare(b.k, a.k)).map((x) => x.i);
    return { unread: sorted.filter((i) => i.unread), read: sorted.filter((i) => !i.unread) };
  });

  const bellRow = (i) => `<button class="bell-row${i.unread ? ' new' : ''}" data-bell-open="${esc(i.c.id)}" data-bell-ch="${i.ch}">
        <span class="avatar">${esc(convInitials(i.c.name, i.ch === 'text' ? i.c.phone : i.c.email))}</span>
        <span class="bell-main">
          <span class="bell-top"><span class="bell-name">${esc(i.who)}</span><span class="bell-when"${i.ts ? ` data-ago="${esc(i.ts)}"` : ''}>${i.ts ? timeAgo(i.ts) : ''}</span></span>
          <span class="bell-text">${esc(i.text || '')}</span>
        </span>
        <span class="act-tag ch-${i.ch === 'text' ? 'text' : 'email'}">${i.ch === 'text' ? 'Text' : 'Email'}</span>
      </button>`;

  // Every unread reply at once was thousands of rows and two seconds before
  // the sheet came up on a phone. It opens on the newest forty and adds the
  // next forty as it is scrolled (wired in wireMessages()); Mark all read
  // still reads every one of them.
  const BELL_PAGE = 40;
  let bellShown = BELL_PAGE;
  let bellDrawn = null;   // { items, n }: what the New section last drew
  forgetWithState(() => { bellDrawn = null; });
  function renderBellPanel({ more = false } = {}) {
    const items = bellItems();
    const body = $('#bellBody');
    if (more && bellDrawn && bellDrawn.items === items) {
      const to = Math.min(bellShown, items.unread.length);
      const last = [...body.querySelectorAll('.bell-row.new')].pop();
      if (to <= bellDrawn.n) return;
      if (last) {
        last.insertAdjacentHTML('afterend', items.unread.slice(bellDrawn.n, to).map(bellRow).join(''));
        bellDrawn.n = to;
        return;
      }
    }
    const unread = items.unread.slice(0, bellShown);
    // Earlier is the last week's, and only a handful: the same old replies
    // sitting under the new ones every time read as the same news again.
    const since = Date.now() - BELL_EARLIER_DAYS * 86400000;
    const recent = [];
    for (const i of items.read) {
      if (recent.length >= 5) break;
      if (tsNum(i.ts) >= since) recent.push(i);
    }
    keepingScroll(body, () => {
      body.innerHTML = unread.length || recent.length
        ? `${unread.length ? `<div class="bell-sec">New</div>${unread.map(bellRow).join('')}` : ''}
         ${recent.length ? `<div class="bell-sec">Earlier</div>${recent.map(bellRow).join('')}` : ''}`
        : '<p class="bell-none">No replies yet. When someone writes back — by text or by email — it lands here.</p>';
      // On an iPhone the Home Screen icon shows the unread count only once the
      // app may show notifications, which it can only ask for when you tap.
      if (badgeCanAsk()) body.insertAdjacentHTML('beforeend', '<button type="button" class="bell-badge-ask" id="bellBadgeAsk">Show the unread count on the app icon</button>');
    });
    $('#bellClear').hidden = !allUnread();
    bellDrawn = { items, n: unread.length };
  }

  // On a phone the panel is a sheet (mobile.css): it rises over a dimmed page,
  // holds the page still behind it, and slides back down when put away. On a
  // desktop it is the small popover under the bell, shown and hidden at once.
  let bellTimer = 0;
  let bellOpener = null;
  const bellIsOpen = () => !$('#bellPanel').hidden && !$('#bellPanel').classList.contains('is-closing');
  function toggleBell(force) {
    const panel = $('#bellPanel');
    const back = $('#bellBackdrop');
    const open = bellIsOpen();
    const want = force !== undefined ? force : !open;
    if (want === open) return;
    clearTimeout(bellTimer);
    const sheet = window.matchMedia('(max-width: 800px)').matches;
    if (want) {
      // Opened afresh at the top, with the first forty.
      bellShown = BELL_PAGE;
      renderBellPanel();
      bellOpener = document.activeElement;
      panel.classList.remove('is-closing');
      back.classList.remove('is-closing');
      panel.style.transform = '';
      back.style.opacity = '';
      panel.hidden = false;
      back.hidden = !sheet;
      $('#bellBody').scrollTop = 0;
      if (sheet) {
        $('.main').classList.add('bell-open');
        $('#bellClose').focus({ preventScroll: true });
      }
      return;
    }
    const done = () => {
      panel.hidden = true;
      back.hidden = true;
      panel.classList.remove('is-closing');
      back.classList.remove('is-closing');
      panel.style.transform = '';
      back.style.opacity = '';
      $('.main').classList.remove('bell-open');
      if (sheet && bellOpener && document.contains(bellOpener)) bellOpener.focus({ preventScroll: true });
      bellOpener = null;
    };
    if (!sheet || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    // From wherever a swipe left it, down and out.
    panel.style.transform = '';
    back.style.opacity = '';
    panel.classList.add('is-closing');
    back.classList.add('is-closing');
    bellTimer = setTimeout(done, 280);
  }

  function wireMessages() {
    $('#convList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-conv]');
      if (b) openThread(b.dataset.conv);
    });
    // Email's tab strip is styled with the same class, so match on the data
    // attribute: a document-wide '.conv-tab' bound this handler to Email's tabs
    // too, which set convFilter to undefined and lit all three of them at once.
    $$('[data-conv-tab]').forEach((b) => b.addEventListener('click', () => { convFilter = b.dataset.convTab; convShown = CONV_PAGE; renderConvList(); }));
    const convSearchRender = debounce(renderConvList, 120);
    $('#convSearch').addEventListener('input', (e) => { convSearch = e.target.value; convShown = CONV_PAGE; convSearchRender(); });
    growOnScroll($('#convList'), () => {
      if (convShown >= conversations().length) return false;
      convShown += CONV_PAGE;
      return true;
    }, () => renderConvList({ more: true }));
    growOnScroll($('#bellBody'), () => {
      if (!state || bellShown >= bellItems().unread.length) return false;
      bellShown += BELL_PAGE;
      return true;
    }, () => renderBellPanel({ more: true }));
    $('#threadCompose').addEventListener('submit', (e) => { e.preventDefault(); sendReply(); });
    // Enter sends and shift-enter makes a new line, the way every messenger
    // works — on a keyboard. A soft keyboard has no shift to hold, so there
    // the return key makes the line break and the send button sends.
    $('#threadInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (window.matchMedia('(pointer: coarse)').matches) return;
      e.preventDefault();
      sendReply();
    });
    $('#threadInput').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
      saveDraft('text', openThreadId, e.target.value);
    });
    $('#threadOpenCandidate').addEventListener('click', () => { const c = openThreadId && candById(openThreadId); if (c) openProfile(c); });
    // The name and picture at the top of a conversation open the same card.
    document.addEventListener('click', (e) => {
      const who = e.target.closest('[data-thread-profile]');
      if (!who) return;
      const id = who.closest('#view-template') ? openMailId : openThreadId;
      const c = id && candById(id);
      if (c) openProfile(c);
    });

    $('#bellPanel').addEventListener('click', (e) => {
      const r = e.target.closest('[data-bell-open]');
      if (!r) return;
      toggleBell(false);
      if (r.dataset.bellCh === 'email') { show('template'); openMail(r.dataset.bellOpen); }
      else { show('texting'); openThread(r.dataset.bellOpen); }
    });
    // Read exactly what was listed, each up to the reply shown: one that
    // arrives on the server meanwhile is still news, where "all" cleared it
    // unseen. The two channels go independently, so one failing does not
    // leave the other unsent.
    $('#bellClear').addEventListener('click', () => {
      const text = [];
      const email = [];
      for (const c of state.candidates || []) {
        if (c.textUnread) text.push({ c, ts: lastInTs(c, 'text') });
        if (c.emailUnread) email.push({ c, ts: lastInTs(c, 'email') });
      }
      Promise.allSettled([markRead('text', text), markRead('email', email)]);
      renderConvList(); renderMailList();
    });
    document.addEventListener('click', (e) => {
      if ($('#bellPanel').hidden) return;
      if (e.target.closest('#bellPanel') || e.target.closest('.bell')) return;
      toggleBell(false);
    });
    // iOS sends no click to the document for a tap on a plain element, so the
    // dimmed page and the close button close it themselves.
    $('#bellBackdrop').addEventListener('click', () => toggleBell(false));
    $('#bellClose').addEventListener('click', () => toggleBell(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleBell(false); });
    // Swipe the sheet down to put it away: from the handle and title at any
    // time, and from the list once it is scrolled to its top — otherwise the
    // same drag just scrolls the list.
    (() => {
      const panel = $('#bellPanel');
      const back = $('#bellBackdrop');
      let drag = null;
      panel.addEventListener('touchstart', (e) => {
        drag = null;
        if (e.touches.length !== 1 || !window.matchMedia('(max-width: 800px)').matches) return;
        const body = $('#bellBody');
        if (body.contains(e.target) && body.scrollTop > 0) return;
        if (e.target.closest('button') && !body.contains(e.target)) return;
        const t = e.touches[0];
        drag = { x: t.clientX, y: t.clientY, dy: 0, at: e.timeStamp, v: 0, on: false };
      }, { passive: true });
      panel.addEventListener('touchmove', (e) => {
        if (!drag) return;
        const t = e.touches[0];
        const dy = t.clientY - drag.y;
        const dx = t.clientX - drag.x;
        if (!drag.on) {
          if (Math.abs(dy) < 4 && Math.abs(dx) < 4) return;
          if (dy <= 0 || Math.abs(dx) > dy) { drag = null; return; }
          drag.on = true;
          panel.style.transition = 'none';
        }
        e.preventDefault();
        const d = Math.max(0, dy);
        drag.v = (d - drag.dy) / Math.max(1, e.timeStamp - drag.at);
        drag.dy = d;
        drag.at = e.timeStamp;
        panel.style.transform = `translateY(${d}px)`;
        back.style.opacity = String(Math.max(0.15, 1 - d / 420));
      }, { passive: false });
      const end = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!d.on) return;
        panel.style.transition = '';
        if (d.dy > 110 || (d.dy > 36 && d.v > 0.45)) { toggleBell(false); return; }
        panel.style.transform = '';
        back.style.opacity = '';
      };
      panel.addEventListener('touchend', end, { passive: true });
      panel.addEventListener('touchcancel', end, { passive: true });
    })();
  }

  // The Texting page's own header: Text everyone, and Stop while a send is
  // running. Drawn with the page (VIEW_RENDERERS), not on every render from
  // every page — counting who can be texted is a pass over the whole list.
  function renderTextingHead() {
    const q = ((state.texting || {}).queue) || {};
    // The funnel strip that used to sit here said exactly what the dashboard's
    // Channels card says, on a page that is now only conversations.
    const n = textableIds().length;
    const btn = $('#textSendAllBtn');
    btn.textContent = n ? `Text ${n} with a number` : 'Nobody left to text';
    btn.disabled = n === 0;
    $('#textStopBtn').hidden = !q.active;
  }

  // Texting's half of Settings: the Mac, the default text and the pace.
  // Drawn with Settings (renderSettingsPage).
  function renderTextSettings() {
    const t = state.texting || {};
    const q = t.queue || {};
    // Is the Mac actually there?
    const r = q.relay || {};
    const chip = $('#relayChip');
    if (r.online) {
      chip.className = 'badge tint-green';
      chip.innerHTML = `<i class="relay-dot on"></i>${esc(r.host || 'Mac')} online${r.bluebubbles === false ? ` · ${r.backend === 'bluebubbles' ? 'BlueBubbles' : 'Messages'} not answering` : ''}`;
    } else if (r.lastSeenAt) {
      chip.className = 'badge tint-amber';
      chip.innerHTML = `<i class="relay-dot off"></i>last seen ${timeAgo(r.lastSeenAt)}`;
    } else {
      chip.className = 'badge tint-navy';
      chip.innerHTML = `<i class="relay-dot off"></i>not set up yet`;
    }
    $('#relayTokenHint').textContent = t.tokenSet
      ? 'A separate secret from your dashboard password. Generating a new one stops the old Mac until you update its config.'
      : 'Generate a token, then paste it into ~/.wp-relay/config.json on the Mac Studio.';

    if (!textTemplateDirty) {
      const p = currentPreset('text');
      if (p) $('#txBody').value = p.body || '';
      else if (t.template) $('#txBody').value = t.template.body || '';
    }
    renderPresetBar('text');
    // Only the focused field was protected, so typing a new pace and tabbing to
    // the next box lost the first one the moment anything else moved — which is
    // exactly when you adjust the pace, mid-send. These live in Settings with
    // everything else, so the same unsaved-edits flag covers them.
    for (const [id, val] of [['txDailyLimit', q.dailyLimit], ['txGapMin', q.minGap], ['txGapMax', q.maxGap], ['txStartHour', q.startHour], ['txEndHour', q.endHour]]) {
      const el = $(`#${id}`);
      if (el && !settingsDirty && document.activeElement !== el) el.value = val ?? '';
    }
    const sun = $('#txSunday');
    if (sun && !settingsDirty && document.activeElement !== sun) sun.checked = Boolean(q.sunday);
    $('#txOptOutHint').textContent = q.optOut
      ? `${q.optOut} number${q.optOut === 1 ? '' : 's'} asked to stop and will never be texted again.`
      : 'Anyone who replies STOP is blocked automatically and permanently.';

    renderTextPreview();
    renderTextSendingCard();
  }

  function renderTextPreview() {
    // Same filler as the email preview, and the same tidying lib/template.js
    // does before a text is handed to the relay. This used to resolve four
    // placeholders of the eight the send understands, so {{lastName}},
    // {{email}} and the rest sat in the preview as literal braces while the
    // real message had them filled in -- and blank lines the send collapses
    // were shown uncollapsed, making the character count wrong too.
    const who = state.candidates.find((c) => textPhoneOf(c))
      || { name: 'Sam Rivera', role: 'Account Executive', company: 'Acme Payments' };
    const filled = fillClient($('#txBody').value || '', who)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const calendly = String(state.settings.calendlyUrl || '').trim();
    const withLink = calendly && !filled.includes(calendly) ? `${filled}\n\n${calendly}` : filled;
    $('#txPreview').textContent = withLink;
    const chars = withLink.length;
    const chip = $('#txChars');
    chip.textContent = `${chars} characters`;
    chip.className = `badge ${chars > 480 ? 'tint-amber' : 'tint-blue'}`;
    $('#txPreviewHint').textContent = chars > 480
      ? 'Long messages read as a broadcast. Under about 300 characters gets far more replies.'
      : '';
  }

  function renderTextSendingCard() {
    const q = (state.texting && state.texting.queue) || {};
    const card = $('#textSendingCard');
    const visible = q.active || q.failed > 0;
    card.hidden = !visible;
    if (!visible) return;
    const total = q.total || (q.pending + q.sent);
    $('#textSendingFill').style.width = `${total ? Math.round((q.sent / total) * 100) : 100}%`;
    $('#textSendingBadge').textContent = q.active ? `${q.sent} of ${total} sent` : `finished · ${q.sent} sent`;
    const clock = clockTime;
    const parts = [];
    const r = q.relay || {};
    if (q.pending && !r.online) {
      parts.push(`${q.pending} waiting — the Mac relay is offline, so nothing can send until it is back`);
    } else if (q.active) {
      const avg = Math.round(((q.minGap || 45) + (q.maxGap || 150)) / 2);
      const doable = Math.min(q.pending, q.remainingToday);
      parts.push(`${q.pending} still to send, about one every ${avg}s`);
      if (doable > 0) parts.push(`roughly ${Math.max(1, Math.round((doable * avg) / 60))} min for the ${doable === q.pending ? 'lot' : `${doable} that fit today`}`);
      if (q.pausedUntil && q.pauseKind === 'daily') parts.push(`daily cap of ${q.dailyLimit} reached — resumes ${clock(q.pausedUntil)}`);
      else if (doable < q.pending) parts.push(`the other ${q.pending - doable} go tomorrow (the cap is ${q.dailyLimit}/day, and Apple bans accounts that go much past ${q.dailyMax})`);
      if (q.leased) parts.push(`${q.leased} out with the Mac right now`);
    }
    parts.push(`${q.sentToday} sent in the last 24h (cap ${q.dailyLimit})`);
    parts.push(`quiet outside ${q.startHour}:00–${q.endHour}:00 where each person lives`);
    if (q.failed) parts.push(`${q.failed} failed — ${(q.failures || []).map((f) => `${f.phone}: ${f.error}`).slice(-2).join(' · ')}`);
    $('#textSendingMeta').textContent = parts.join(' · ');
    $('#textRetryBtn').hidden = !q.failed;
    $('#textRetryBtn').textContent = `Retry ${q.failed} failed`;
  }

  async function loadRelayToken() {
    try {
      const r = await api('/api/texts/relay-token');
      relayTokenRevealed = r.token || '';
      $('#relayTokenInput').value = relayTokenRevealed ? '••••••••••••••••••••' : '';
      $('#relayTokenShow').disabled = !relayTokenRevealed;
      if (r.envOverride) {
        $('#relayTokenHint').textContent = 'A RELAY_TOKEN environment variable is set on the server and takes precedence over this one.';
      }
    } catch {}
  }

  $('#relayTokenShow').addEventListener('click', () => {
    const input = $('#relayTokenInput');
    const hidden = input.value.startsWith('•');
    input.value = hidden ? relayTokenRevealed : '••••••••••••••••••••';
    $('#relayTokenShow').textContent = hidden ? 'Hide' : 'Show';
    if (hidden) {
      // execCommand('copy') returns nothing useful on iOS and often does
      // nothing at all, and this said "copied" either way. The token is on
      // screen now, so say that instead when the copy does not happen.
      input.select();
      navigator.clipboard?.writeText(input.value)
        .then(() => toast('Token copied — paste it into config.json on the Mac.'))
        .catch(() => toast('Token shown — copy it by hand into config.json on the Mac.'));
    }
  });

  $('#relayTokenGen').addEventListener('click', async () => {
    if (relayTokenRevealed && !confirm('Generate a new token? The Mac will stop sending until you paste the new one into its config.')) return;
    try {
      const r = await api('/api/texts/relay-token', { method: 'POST' });
      relayTokenRevealed = r.token;
      $('#relayTokenInput').value = r.token;
      $('#relayTokenShow').textContent = 'Hide';
      $('#relayTokenShow').disabled = false;
      toast('Token generated. Copy it into ~/.wp-relay/config.json on the Mac Studio.');
      await refresh();
    } catch (err) { oops(err); }
  });

  $('#txBody').addEventListener('input', () => { setPresetDirty('text', true); renderTextPreview(); });
  $('#txName').addEventListener('input', () => setPresetDirty('text', true));
  $$('.tx-token').forEach((b) => b.addEventListener('click', () => {
    const el = $('#txBody');
    const at = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, at) + b.dataset.txToken + el.value.slice(el.selectionEnd ?? at);
    el.focus();
    el.selectionStart = el.selectionEnd = at + b.dataset.txToken.length;
    setPresetDirty('text', true);
    renderTextPreview();
  }));

  $('#txSave').addEventListener('click', () => savePresetEditor('text'));

  $('#txReset').addEventListener('click', async () => {
    if (!confirm('Put the starter text back into your default text? Your current wording of it is replaced.')) return;
    try {
      const r = await api('/api/texts/template/reset', { method: 'POST' });
      $('#txBody').value = r.textTemplate.body;
      textTemplateDirty = false;
      renderTextPreview();
        await refresh();
    } catch (err) { oops(err); }
  });

  $('#txSavePace').addEventListener('click', async () => {
    try {
      const r = await api('/api/settings', {
        method: 'POST',
        body: {
          textDailyLimit: $('#txDailyLimit').value, textMinGap: $('#txGapMin').value, textMaxGap: $('#txGapMax').value,
          textStartHour: $('#txStartHour').value, textEndHour: $('#txEndHour').value, textSunday: $('#txSunday').checked,
        },
      });
      // Say so when a number was changed, rather than quietly showing a different one.
      const changed = (r.adjusted || []).filter((a) => a.key.startsWith('text'));
      toast(changed.length
        ? `Saved. ${changed.map((a) => `${a.label} set to ${a.to} — ${a.reason}`).join('; ')}`
        : 'Texting pace saved.');
      await refresh();
    } catch (err) { oops(err); }
  });

  // Text everyone: through the composer, so the message can be chosen from
  // the saved texts and read before anything is queued.
  $('#textSendAllBtn').addEventListener('click', () => {
    const ids = textableIds();
    if (!ids.length) { toast('Nobody with a number is waiting for a text.', true); return; }
    openTextCompose(ids, { title: `Text everyone with a number (${ids.length.toLocaleString()})` });
  });

  $('#textStopBtn').addEventListener('click', async () => {
    if (!confirm('Stop texting? Anything not yet sent is dropped from the queue.')) return;
    try { await api('/api/texts/queue', { method: 'DELETE' }); toast('Texting stopped.'); await refresh(); } catch (err) { oops(err); }
  });

  $('#textRetryBtn').addEventListener('click', async () => {
    try { const r = await api('/api/texts/queue/retry-failed', { method: 'POST' }); toast(`${r.requeued} re-queued.`); await refresh(); } catch (err) { oops(err); }
  });

  // ---- the Team card ----
  // Once a new name has been typed, the poll stops overwriting the field.
  // Tabbing out of it to reach Rename must not lose what was typed, which is
  // what checking only document.activeElement would do.
  let teamNameDirty = false;
  $('#teamName').addEventListener('input', () => { teamNameDirty = true; });

  function renderTeamSettings() {
    if (!currentTeam) return;
    if (!knownTeams.some((t) => t.id === currentTeam.id)) knownTeams = [{ id: currentTeam.id, name: currentTeam.name }];
    $('#teamBadge').textContent = currentTeam.name;
    const nameField = $('#teamName');
    if (!teamNameDirty && document.activeElement !== nameField) nameField.value = currentTeam.name;
    $('#teamPinHint').textContent = currentTeam.usesAppPassword
      ? 'This team still signs in with the APP_PASSWORD environment variable, the way the dashboard always did. Give it four digits of its own here — after that the admin password only creates and deletes teams.'
      : 'Four digits. Changing it signs every device out of this team, including this one.';
    const sel = $('#deleteTeamSelect');
    if (document.activeElement !== sel) {
      sel.innerHTML = knownTeams.map((t) =>
        `<option value="${esc(t.id)}"${t.id === currentTeam.id ? ' selected' : ''}>${esc(t.name)}${t.id === currentTeam.id ? ' — the one you are in' : ''}</option>`).join('');
    }
  }

  // Each of these asks the server and then re-reads the answer, rather than
  // assuming it worked: a rename that collides, a PIN that is too short and a
  // wrong admin password all come back as plain messages.
  $('#teamRenameBtn').addEventListener('click', async () => {
    const btn = $('#teamRenameBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/teams/rename', { method: 'POST', body: { name: $('#teamName').value } });
      teamNameDirty = false;
      setTeam(r.team);
      await loadTeams().catch(() => {});
      renderTeamSettings();
      toast(`This team is now “${r.team.name}”.`);
    } catch (err) { oops(err); } finally { btn.disabled = false; }
  });

  $('#teamPinBtn').addEventListener('click', async () => {
    const btn = $('#teamPinBtn');
    btn.disabled = true;
    try {
      await api('/api/teams/pin', { method: 'POST', body: { current: $('#teamPinCurrent').value, pin: $('#teamPinNew').value } });
      $('#teamPinCurrent').value = '';
      $('#teamPinNew').value = '';
      toast('PIN changed — sign in again with the new one.');
      signedOut();
    } catch (err) { oops(err); } finally { btn.disabled = false; }
  });

  $('#teamSignOutAllBtn').addEventListener('click', async () => {
    if (!confirm('Sign every device out of this team? Everyone will need the PIN again.')) return;
    try {
      await api('/api/teams/sign-out-all', { method: 'POST' });
      signedOut();
    } catch (err) { oops(err); }
  });

  $('#addTeamBtn').addEventListener('click', async () => {
    const btn = $('#addTeamBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/teams/create', {
        method: 'POST',
        body: { name: $('#addTeamName').value, pin: $('#addTeamPin').value, adminPassword: $('#addTeamAdmin').value },
      });
      ['#addTeamName', '#addTeamPin', '#addTeamAdmin'].forEach((sel) => { $(sel).value = ''; });
      await loadTeams().catch(() => {});
      renderTeamSettings();
      toast(`${r.team.name} is ready, and empty. They sign in with the PIN you just set.`);
    } catch (err) { oops(err); } finally { btn.disabled = false; }
  });

  $('#deleteTeamBtn').addEventListener('click', async () => {
    const id = $('#deleteTeamSelect').value;
    const target = knownTeams.find((t) => t.id === id);
    if (!target) return;
    if (!confirm(`Delete ${target.name}? Their candidates, templates, connections and history are erased for good.`)) return;
    const btn = $('#deleteTeamBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/teams/delete', {
        method: 'POST',
        body: { id, confirm: $('#deleteTeamConfirm').value, adminPassword: $('#deleteTeamAdmin').value },
      });
      ['#deleteTeamConfirm', '#deleteTeamAdmin'].forEach((sel) => { $(sel).value = ''; });
      if (r.signedOut) { signedOut(); return; }
      await loadTeams().catch(() => {});
      renderTeamSettings();
      toast(`${target.name} deleted.`);
    } catch (err) { oops(err); } finally { btn.disabled = false; }
  });

  // Settings itself. Drawn when it is the page on screen, or the next time it
  // is shown (renderSettingsPage, VIEW_RENDERERS) — not on every new state
  // from every page.
  function renderSettings() {
    renderBackups();
    renderTeamSettings();
    if (!teamsRefreshedAt || Date.now() - teamsRefreshedAt > 30000) {
      teamsRefreshedAt = Date.now();
      loadTeams().then(renderTeamSettings).catch(() => {});
    }
    // Signing back in while Settings is on screen never passes through show(),
    // so the Sales IQ card would sit on the last team's answer, or none.
    if (currentView === 'settings' && salesiqFor !== (currentTeam ? currentTeam.id : '')) loadSalesiq();
    const s = state.settings;
    // Never overwrite what the user is typing: skip the form while it has unsaved edits.
    const setIf = (sel, val) => { const el = $(sel); if (!settingsDirty && document.activeElement !== el) el.value = val || ''; };
    setIf('#setCalendlyUrl', s.calendlyUrl);
    setIf('#calendlyToken', s.calendlyToken);
    setIf('#setFromName', s.fromName);
    setIf('#setDailyLimit', s.dailyLimit);
    setIf('#setPerMinute', s.perMinute);
    // The daily ceiling depends on the account that is actually sending.
    const dailyMax = (state.queue && state.queue.dailyMax) || 2000;
    $('#setDailyLimit').max = String(dailyMax);
    $('#dailyLimitHint').textContent = `Up to ${dailyMax.toLocaleString()} (${dailyMax > 500 ? 'Google Workspace' : 'free Gmail'}). When it is reached the queue pauses and resumes by itself as the 24-hour window frees up.`;
    setIf('#setFollowUpDays', s.followUpDays);
    setIf('#setMaxFollowUps', s.maxFollowUps);
    if (!settingsDirty) $('#setGmailSignature').checked = s.gmailSignature !== false;
    setIf('#setApolloApiKey', s.apolloApiKey);
    setIf('#setNtfyTopic', s.ntfyTopic);
    setIf('#setSmtpUser', s.smtpUser);
    setIf('#setSmtpPass', s.smtpPass);
    setIf('#setGoogleClientId', s.googleClientId);
    setIf('#setGoogleClientSecret', s.googleClientSecret);
    $('#redirectUriCode').textContent = state.google.redirectUri;
    // The app derives this address from the site's primary domain; if the
    // dashboard is open on another address, say so — it explains a mismatch.
    const hint = $('#redirectHint');
    try {
      const appOrigin = new URL(state.google.redirectUri).origin;
      if (appOrigin !== location.origin) {
        hint.classList.add('warn-text');
        hint.innerHTML = `You are viewing the dashboard at <strong>${esc(location.origin)}</strong>, but the site's primary address is <strong>${esc(appOrigin)}</strong>, so that is what Google is told. Add the address above to the OAuth client (Authorized redirect URIs → Add URI → Save) — or open the dashboard at ${esc(appOrigin)}. If Google answers <em>redirect_uri_mismatch</em>, the address above is missing there.`;
      } else {
        hint.classList.remove('warn-text');
      }
    } catch {}

    const badge = $('#googleBadge');
    if (state.google.connected) {
      badge.textContent = state.google.email ? `connected · ${state.google.email}` : 'connected';
      badge.className = 'badge tint-green';
      $('#googleConnectBtn').textContent = 'Reconnect';
      $('#googleDisconnectBtn').hidden = false;
    } else if (state.google.expired) {
      badge.textContent = 'connection expired — click Reconnect';
      badge.className = 'badge tint-amber';
      $('#googleConnectBtn').textContent = 'Reconnect';
      $('#googleDisconnectBtn').hidden = false;
    } else {
      badge.textContent = state.google.configured ? 'ready to connect' : 'not configured';
      badge.className = 'badge' + (state.google.configured ? ' tint-blue' : '');
      $('#googleConnectBtn').textContent = 'Connect Google';
      $('#googleDisconnectBtn').hidden = true;
    }
  }

  // Who the email goes out as, in the sidebar's foot (which a phone shows at
  // the top of Settings), and the Import page's last sheet. Small, and the
  // first is in sight from every page on a laptop, so they are drawn with
  // every new state.
  function renderAccount() {
    const acct = $('#connPill');
    if (state.sending.ready) {
      const name = (state.settings.fromName || '').trim() || state.sending.from;
      acct.className = 'account ok';
      $('#connLabel').textContent = name;
      // Break only at the "@" if the address is too long for one line.
      $('#connText').innerHTML = esc(state.sending.from).replace('@', '<wbr>@');
      $('#connText').title = `Sending as ${senderLine()}`;
    } else {
      acct.className = 'account warn';
      $('#connLabel').textContent = state.google.expired ? 'Google expired' : 'Email not set up';
      $('#connText').textContent = state.google.expired ? 'Reconnect in Settings' : 'Connect in Settings';
    }

    if (state.settings.lastSheetUrl && !$('#sheetUrl').value) $('#sheetUrl').value = state.settings.lastSheetUrl;
  }

  async function saveSettings(extra = {}) {
    const body = {
      calendlyUrl: $('#setCalendlyUrl').value,
      calendlyToken: $('#calendlyToken').value,
      fromName: $('#setFromName').value,
      dailyLimit: $('#setDailyLimit').value,
      perMinute: $('#setPerMinute').value,
      followUpDays: $('#setFollowUpDays').value,
      maxFollowUps: $('#setMaxFollowUps').value,
      gmailSignature: $('#setGmailSignature').checked,
      apolloApiKey: $('#setApolloApiKey').value,
      ntfyTopic: $('#setNtfyTopic').value,
      smtpUser: $('#setSmtpUser').value,
      smtpPass: $('#setSmtpPass').value,
      googleClientId: $('#setGoogleClientId').value,
      googleClientSecret: $('#setGoogleClientSecret').value,
      ...extra,
    };
    const r = await api('/api/settings', { method: 'POST', body });
    setSettingsDirty(false);
    await refresh();
    return r;
  }

  // What the server actually stored when a number was outside what Gmail allows.
  function adjustedNote(r) {
    const list = (r && r.adjusted) || [];
    if (!list.length) return '';
    return list.map((a) => `${a.label} set to ${a.to} (you entered ${a.from})${a.reason ? ` — ${a.reason}` : ''}`).join('; ') + '.';
  }

  $('#saveSettingsBtn').addEventListener('click', () =>
    saveSettings().then((r) => {
      const note = adjustedNote(r);
      toast(note ? `Settings saved. ${note}` : 'Settings saved.');
    }).catch(oops));

  // Persist any typed credentials before leaving for Google's consent page.
  $('#googleConnectBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await saveSettings();
      if (!state.google.configured) {
        toast('Enter your Google OAuth Client ID and Secret first (see the hint below the fields).', true);
        return;
      }
      const { url } = await api('/api/google/auth-url');
      window.location.href = url;
    } catch (err) { oops(err); }
  });
  $('#googleDisconnectBtn').addEventListener('click', () =>
    api('/auth/google/disconnect', { method: 'POST' }).then(refresh).catch(oops));

  $('#testNotifyBtn').addEventListener('click', async () => {
    try {
      await saveSettings();
      await api('/api/test-notification', { method: 'POST' });
      toast('Test notification sent — check your phone.');
    } catch (err) { oops(err); }
  });

  $('#registerWebhookBtn').addEventListener('click', async () => {
    try {
      await saveSettings();
      const r = await api('/api/calendly/register-webhook', { method: 'POST', body: {
        token: $('#calendlyToken').value,
        publicUrl: state.baseUrl,
      }});
      // Say what was actually cleaned up. A subscription left behind under an
      // older hostname is the usual reason bookings were being rejected, and
      // silently fixing it looks identical to not fixing it.
      const stale = (r.replacedUrls || []).length;
      $('#calendlyHint').textContent = `Booking alerts enabled — Calendly now notifies this app at ${r.url}.`
        + (stale ? ` Removed ${stale} old subscription${stale === 1 ? '' : 's'} pointing at a previous address, which is what was being rejected.` : '');
      toast(stale
        ? `Calendly webhook registered, and ${stale} stale subscription${stale === 1 ? '' : 's'} removed.`
        : 'Calendly webhook registered. Bookings will update the pipeline and ping your phone.');
      await refresh();
    } catch (err) { oops(err); }
  });

  // ---------------- Sales IQ ----------------
  // The one thing this app shares with the Sales IQ hiring dashboard is who
  // booked an interview. The connection code is the bearer secret for exactly
  // that, so it lives in these variables and the field below and nowhere else:
  // not /api/state, not storage, not a toast.
  const SALESIQ_MASK = '••••••••••••••••••••';
  let salesiqCode = '';
  let salesiqConnected = false;
  let salesiqShown = false;
  let salesiqStatus = 'checking';   // 'checking' | 'ok' | 'error'
  let salesiqBusy = false;
  let salesiqFor = null;            // the team whose answer the card is showing
  // Bumped by every request and by signing out, so an answer that lands after
  // something newer — a load racing a Regenerate, or the last team's code
  // arriving after a switch — is dropped rather than shown.
  let salesiqGen = 0;

  function renderSalesiq() {
    const chip = $('#salesiqChip');
    if (salesiqStatus === 'checking') {
      chip.className = 'badge';
      chip.textContent = 'checking…';
    } else if (salesiqStatus === 'error') {
      chip.className = 'badge tint-amber';
      chip.textContent = 'could not check';
    } else {
      chip.className = `badge ${salesiqConnected ? 'tint-green' : 'tint-navy'}`;
      chip.textContent = salesiqConnected ? 'Connected' : 'Not connected';
    }
    const has = Boolean(salesiqCode);
    $('#salesiqCodeInput').value = has ? (salesiqShown ? salesiqCode : SALESIQ_MASK) : '';
    $('#salesiqShow').textContent = has && salesiqShown ? 'Hide' : 'Show';
    $('#salesiqShow').disabled = !has;
    $('#salesiqCopy').disabled = !has;
    // Until the server has said whether a code exists, Generate cannot know
    // whether it is about to break a working connection without asking.
    const gen = $('#salesiqGen');
    gen.textContent = salesiqConnected ? 'Regenerate' : 'Generate';
    gen.classList.toggle('btn-primary', !salesiqConnected);
    gen.disabled = salesiqBusy || salesiqStatus !== 'ok';
    $('#salesiqDisconnect').hidden = !salesiqConnected;
    $('#salesiqDisconnect').disabled = salesiqBusy;
  }

  function takeSalesiq(r) {
    const code = r && r.connected ? String(r.code || '') : '';
    // A new code starts hidden like the first one did.
    if (code !== salesiqCode) salesiqShown = false;
    salesiqCode = code;
    salesiqConnected = Boolean(r && r.connected);
    salesiqStatus = 'ok';
  }

  function clearSalesiq() {
    salesiqGen++;
    salesiqCode = '';
    salesiqConnected = false;
    salesiqShown = false;
    salesiqStatus = 'checking';
    salesiqBusy = false;
    salesiqFor = null;
    renderSalesiq();
  }

  // The answer carries the code, so it is fetched with no-store: whatever
  // headers the server sends, it must not land in the browser's HTTP cache.
  async function loadSalesiq() {
    if (salesiqBusy) return;
    const mine = ++salesiqGen;
    const team = currentTeam ? currentTeam.id : '';
    salesiqFor = team;
    try {
      const r = await api('/api/salesiq-connection', { cache: 'no-store' });
      if (mine !== salesiqGen) return;
      if (team && r.team && r.team.id !== team) return;
      takeSalesiq(r);
      // Every visit to Settings starts with the code covered.
      salesiqShown = false;
    } catch {
      if (mine !== salesiqGen) return;
      salesiqStatus = 'error';
      // A lapsed session lands here too; the render after signing back in
      // should ask again rather than keep saying it could not check.
      salesiqFor = null;
    }
    renderSalesiq();
  }

  async function changeSalesiq(method) {
    const mine = ++salesiqGen;
    salesiqBusy = true;
    renderSalesiq();
    try {
      const r = await api('/api/salesiq-connection', { method, cache: 'no-store' });
      if (mine !== salesiqGen) return false;
      takeSalesiq(r);
      return true;
    } finally {
      if (mine === salesiqGen) { salesiqBusy = false; renderSalesiq(); }
    }
  }

  $('#salesiqShow').addEventListener('click', () => {
    if (!salesiqCode) return;
    salesiqShown = !salesiqShown;
    renderSalesiq();
  });

  $('#salesiqCopy').addEventListener('click', async () => {
    if (!salesiqCode) return;
    try {
      await navigator.clipboard.writeText(salesiqCode);
      toast('Connection code copied — paste it into Sales IQ → Interview bookings → Connect.');
    } catch {
      // There is no clipboard API off HTTPS, and Safari refuses it often
      // enough. Leave the code on screen and selected so ⌘C or a long-press
      // finishes the job.
      salesiqShown = true;
      renderSalesiq();
      const input = $('#salesiqCodeInput');
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      toast('The code is selected — copy it, then paste it into Sales IQ → Interview bookings → Connect.');
    }
  });

  $('#salesiqGen').addEventListener('click', async () => {
    if (salesiqConnected && !confirm('Generate a new connection code? The current one stops working straight away, and Sales IQ gets no new bookings until you paste the new code into it.')) return;
    try {
      if (!(await changeSalesiq('POST'))) return;
      toast('New connection code ready — press Copy, then paste it into Sales IQ → Interview bookings → Connect.');
    } catch (err) {
      // The server may have rotated before the answer was lost, so ask it
      // rather than trust what is on screen.
      oops(err);
      loadSalesiq();
    }
  });

  $('#salesiqDisconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect Sales IQ? Its connection code stops working straight away and no more bookings are sent to it.')) return;
    try {
      if (!(await changeSalesiq('DELETE'))) return;
      toast('Sales IQ disconnected.');
    } catch (err) {
      oops(err);
      loadSalesiq();
    }
  });

  // ---------------- Modals ----------------
  // Opening one used to leave the keyboard behind it: Tab walked the page
  // underneath while the dialog sat on top, and closing it dropped focus on
  // <body>, so the next Tab started again from the top of the document.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusablesIn = (m) => [...m.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
  const openModals = () => $$('.modal-backdrop:not([hidden])');
  const focusBefore = new WeakMap();

  function openModal(sel) {
    const m = $(sel);
    if (!m.hidden) return m;
    focusBefore.set(m, document.activeElement);
    m.hidden = false;
    // Whatever you came here to fill in, if there is one; otherwise the first
    // thing you can act on. Callers that know better focus their own field
    // straight after this and win.
    const items = focusablesIn(m);
    const field = items.find((el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) || items[0];
    if (window.matchMedia('(pointer: coarse)').matches) {
      // On a touch screen this is a sheet sliding up from the bottom, and
      // focusing a field on the first frame raises the keyboard into the
      // middle of that and lays the whole thing out twice. The dialog itself
      // takes focus instead, which is all the Tab trap needs; the field is one
      // tap away.
      m.setAttribute('tabindex', '-1');
      m.focus({ preventScroll: true });
    } else if (field) {
      field.focus();
    }
    return m;
  }

  function closeModal(m) {
    if (!m || m.hidden) return;
    m.hidden = true;
    const back = focusBefore.get(m);
    focusBefore.delete(m);
    if (back && document.contains(back) && back.offsetParent !== null) back.focus();
  }

  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });
  document.addEventListener('keydown', (e) => {
    const open = openModals();
    if (!open.length) return;
    if (e.key === 'Escape') { open.forEach(closeModal); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the topmost dialog.
    const m = open[open.length - 1];
    const items = focusablesIn(m);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const here = document.activeElement;
    if (!m.contains(here)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && here === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
  });

  // ---------------- The service worker ----------------
  // Fire and forget, on purpose. Nothing in the app waits for this, reads from
  // Cache Storage, or behaves differently depending on whether it worked — in
  // a private window, on an old browser, or when registration simply fails,
  // every request goes to the network and this is the app it was before.
  let updateReady = null;
  let pulledAt = 0;           // when the page was last pulled down to refresh
  let askedForUpdate = false;
  let updateTaken = false;
  let reloadingForUpdate = false;
  let updateDismissed = null;  // the waiting version whose notice was put away
  const openedAt = Date.now();
  // Whether a worker was already in charge when the page opened. Without one,
  // the first install claims the page, and that is not an update.
  const hadController = 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller);

  // Is anything on screen that a reload would throw away? A send part-way
  // through, a dialog, a half-written message, an edit not yet saved.
  function somethingInFlight() {
    if (!state) return true;                              // nothing known yet
    if (importRunning) return true;
    // The email and text queues are not in the page: they run on the server
    // and the Mac, and carry on through a reload. Counting them here kept a
    // paced campaign's app on the old version for weeks. The one send that
    // does live in the page is the send window's own loop.
    if (composeSending) return true;
    if ($('.modal-backdrop:not([hidden])')) return true;
    if (window.SalesIQ && window.SalesIQ.busy()) return true;
    if (window.Onboarding && window.Onboarding.busy()) return true;
    if (templateDirty || followUpDirty || settingsDirty || textTemplateDirty) return true;
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value) return true;
    return false;
  }

  // Take a waiting version without being asked, but only at the two moments
  // when a reload costs nothing: while the app is still starting, and on the
  // way back into it from somewhere else. Otherwise the notice waits — a page
  // that reloads out from under somebody reading it is its own kind of rude,
  // and one that reloads mid-send is worse than one that is a day old.
  //
  // This is here because it went wrong in exactly the way it was going to:
  // a fix shipped, the worker installed it, and the app kept serving the old
  // one because nobody knew there was a button to press.
  function takeUpdate(moment) {
    if (!updateReady || updateTaken) return;
    if (moment === 'launch' && Date.now() - openedAt > 20000) return;
    if (somethingInFlight()) return;
    applyUpdate();
  }

  // The page reloads from the controllerchange below, once the new worker
  // has actually taken over — not here, or it would reload into the old one.
  // Unless it already has: another window of the app took it first, and
  // asking a worker that is already in charge to take over does nothing at
  // all, which left this window's Reload button dead.
  function applyUpdate() {
    if (!updateReady || updateReady.state !== 'installed') {
      reloadingForUpdate = true;
      location.reload();
      return;
    }
    updateTaken = true;
    askedForUpdate = true;
    updateReady.postMessage('SKIP_WAITING');
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#reloadForUpdate')) applyUpdate();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // updateViaCache: 'none' so the browser always revalidates the worker
      // script itself. A service worker cached without revalidation is the one
      // mistake a later deploy cannot fix.
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then((reg) => {
          const offerIfWaiting = (worker) => {
            // A worker reaching "installed" while one is already in charge is
            // an update. The same event on a first-ever install is not, and
            // must not put a Reload button in front of somebody.
            if (!worker || worker.state !== 'installed' || !navigator.serviceWorker.controller) return;
            // A newer one than before: it gets its own chance to be taken.
            if (worker !== updateReady) { updateTaken = false; askedForUpdate = false; }
            updateReady = worker;
            if (state) renderNotices();
            takeUpdate('launch');
            // It finished coming down just after a pull asked for it.
            if (Date.now() - pulledAt < 20000) takeUpdate('pull');
          };
          offerIfWaiting(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            if (worker) worker.addEventListener('statechange', () => offerIfWaiting(worker));
          });
          // Look for a new one on the way back to the app and once a day, so a
          // shell can never sit stale for a week against a moving API.
          const lookAgain = () => { reg.update().catch(() => {}); };
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            // Coming back to the app is the moment a reload is least in the
            // way, and the moment a native app would have updated itself.
            takeUpdate('return');
            lookAgain();
          });
          setInterval(lookAgain, 24 * 3600 * 1000);
        })
        .catch(() => { /* no service worker; the app does not need one */ });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Only ever after somebody pressed Reload. A first install fires this
        // too — the worker claims the page it was registered from — and
        // reloading on that put the app in a loop: reload, register, claim,
        // reload. It is also the rule that matters most in an app that sends
        // real email: nothing reloads the page out from under a send except a
        // person deciding to.
        if (reloadingForUpdate) return;
        if (askedForUpdate) { reloadingForUpdate = true; location.reload(); return; }
        if (!hadController) return;
        // Another window of the app moved to the new version. This one is
        // still running the old code: it moves too at the next quiet moment
        // (coming back, a pull), and its Reload reloads straight away.
        updateTaken = false;
        if (state) renderNotices();
      });
    });
  }

  // ---------------- The phone ----------------
  // Everything below runs on every device but only does anything on a narrow
  // one. The layout is CSS; what needs JavaScript is the four things CSS
  // cannot express: a height that survives the software keyboard, a thread
  // that is pushed and popped rather than revealed, somewhere for the account
  // controls to live, and a way to ask for fresh data when there is no
  // address bar to pull.
  const phoneQuery = window.matchMedia('(max-width: 800px)');
  const onPhone = () => phoneQuery.matches;
  const installed = () => window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // ---- a height the keyboard cannot lie about ----
  // 100dvh is right until iOS opens the keyboard in a standalone app, where
  // it shrinks the visual viewport and often does not put it back — leaving a
  // dead band under the composer and the tab bar floating in it.
  const viewport = window.visualViewport;
  let heightTick = false;
  function syncAppHeight() {
    if (heightTick) return;
    heightTick = true;
    requestAnimationFrame(() => {
      heightTick = false;
      const h = Math.round(viewport ? viewport.height : window.innerHeight);
      if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
    });
  }
  if (viewport) viewport.addEventListener('resize', syncAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 150));
  window.addEventListener('resize', syncAppHeight);
  syncAppHeight();

  // ---- the title shrinks as you scroll, the way a navigation bar does ----
  let scrollTick = false;
  mainEl.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      mainEl.classList.toggle('scrolled', mainEl.scrollTop > 14);
    });
  }, { passive: true });

  // ---- Email and Texting: a thread is a screen you push ----
  // It rides on real history, so the iOS edge-swipe back closes the thread
  // instead of leaving the app, and so does the button. Whichever one is used,
  // popstate does the work — the class is never changed in two places.
  const messengerOf = (view) => $(`#view-${view} .messenger`);
  const threadIsOpen = () => Boolean($('.messenger.thread-open'));

  function pushThread(view) {
    if (!onPhone()) return;
    const m = messengerOf(view);
    if (!m || m.classList.contains('thread-open')) return;
    // A pull to refresh still holding the page down would hold the
    // conversation screen inside it, under the tab bar.
    const page = m.closest('.view');
    if (page && page.style.transform) { page.style.transition = 'none'; page.style.transform = ''; }
    m.classList.add('thread-open');
    // Opened from the bell over another conversation, it takes that one's
    // place in the history: pushed on top, the first Back went to a thread no
    // longer on screen and appeared to do nothing.
    const entry = [{ view, thread: true }, '', location.hash || `#${view}`];
    if (history.state && history.state.thread) history.replaceState(...entry);
    else history.pushState(...entry);
    // The route guard has to know a thread is now the current state, or the
    // popstate that closes it looks like a repeat of where we already were and
    // gets skipped.
    lastRouted = `${view}|t`;
  }
  function syncThreadStack(open) {
    $$('.messenger').forEach((m) => m.classList.toggle('thread-open', Boolean(open) && onPhone()));
  }
  function backFromThread() {
    // Only walk the history if the thread put an entry there; a thread opened
    // before the phone layout existed (a resize, say) has not.
    if (history.state && history.state.thread) history.back();
    else syncThreadStack(false);
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-thread-back]')) { e.preventDefault(); backFromThread(); }
  });
  // Leaving the page the thread belongs to closes it, or coming back to that
  // page would land straight in a thread nobody asked for.
  phoneQuery.addEventListener('change', () => { syncThreadStack(threadIsOpen() && onPhone()); placeAccountControls(); placeTabHighlight(); });

  // ---- swipe from the left edge to go back ----
  // A Home Screen app has no browser around it to provide the gesture, so the
  // conversation provides it: the screen follows the finger from the left
  // edge, and let go past a third of the way (or flicked) it goes back to the
  // list; otherwise it settles where it was.
  (function edgeSwipeBack() {
    const EDGE = 28;
    let s = null;
    const parts = (col) => [col, col.closest('.messenger').querySelector('.conv-col')];
    document.addEventListener('touchstart', (e) => {
      s = null;
      if (!onPhone() || e.touches.length !== 1) return;
      const col = e.target.closest('.messenger.thread-open .thread-col');
      if (!col || e.touches[0].clientX > EDGE) return;
      s = { x: e.touches[0].clientX, y: e.touches[0].clientY, col, dx: 0, on: false, t: performance.now(), v: 0 };
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!s) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (dx <= 0 || Math.abs(dy) > dx) { s = null; return; }
        s.on = true;
        parts(s.col).forEach((el) => { el.style.transition = 'none'; });
      }
      e.preventDefault();
      const now = performance.now();
      const w = s.col.getBoundingClientRect().width || window.innerWidth;
      const d = Math.max(0, dx);
      s.v = (d - s.dx) / Math.max(1, now - s.t);
      s.t = now;
      s.dx = d;
      const [col, list] = parts(s.col);
      col.style.transform = `translateX(${d}px)`;
      if (list) list.style.transform = `translateX(${-22 + 22 * Math.min(1, d / w)}%)`;
    }, { passive: false });
    const finish = (cancelled) => {
      if (!s) return;
      const { col, on, dx, v } = s;
      s = null;
      if (!on) return;
      const w = col.getBoundingClientRect().width || window.innerWidth;
      const back = !cancelled && (dx > w / 3 || (v > 0.45 && dx > 40));
      // Hand the position back to the stylesheet with its transition on, so
      // it carries on from where the finger left it — out, or back in.
      parts(col).forEach((el) => { el.style.transition = ''; el.style.transform = ''; });
      if (!back) return;
      // Closed in this same frame, so the slide out starts from the finger
      // rather than snapping back first while the history catches up.
      syncThreadStack(false);
      backFromThread();
    };
    document.addEventListener('touchend', () => finish(false), { passive: true });
    document.addEventListener('touchcancel', () => finish(true), { passive: true });
  }());

  // ---- the account pill and Sign out ----
  // They live in the sidebar foot, which is not on screen on a phone. Moving
  // the real elements into Settings keeps one copy of state; a second copy
  // would be one more thing that can disagree with the server.
  function placeAccountControls() {
    const foot = $('.sidebar-foot');
    const slot = $('#settingsAccount');
    if (!foot || !slot) return;
    const wantSlot = onPhone();
    if (wantSlot && foot.parentElement !== slot) slot.appendChild(foot);
    else if (!wantSlot && foot.parentElement === slot) $('.sidebar').appendChild(foot);
  }
  placeAccountControls();

  // ---- pull down to refresh ----
  // A Home Screen app has no reload button and no address bar, so pulling
  // the page down is how you ask for the latest: the page slides down, an
  // activity spinner fills in spoke by spoke as you pull, and letting go past
  // the mark holds it there while the app looks again — the team's list, the
  // page's own list (Sales IQ, Onboarding docs), and a newer version of the
  // app itself, which it then moves to.
  //
  // It only takes the gesture when everything under your finger is already at
  // its top and the finger is going down, so an ordinary scroll — including
  // scrolling a conversation list back up — is never intercepted.
  const PTR_TRIGGER = 64;   // how far the page has to come down to count
  const PTR_HOLD = 52;      // where it rests while it looks
  const PTR_MAX = 120;
  (function pullToRefresh() {
    const ind = document.createElement('div');
    ind.className = 'ptr';
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = `<svg class="ptr-spin" viewBox="0 0 28 28" width="28" height="28">${Array.from({ length: 8 }, (_, i) => `<rect x="12.9" y="2.5" width="2.2" height="7" rx="1.1" transform="rotate(${i * 45} 14 14)" style="--k:${i}"/>`).join('')}</svg>`;
    document.body.appendChild(ind);
    const spokes = [...ind.querySelectorAll('rect')];

    let start = null;      // where the finger went down, while it may still pull
    let pulling = false;
    let busy = false;
    let page = null;       // the page being pulled
    let dist = 0;

    // Is every scroller between the finger and the page already at its top?
    const atTop = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.scrollTop > 0) return false;
        if (n === mainEl) return true;
      }
      return true;
    };
    const paint = (d, { settle = false } = {}) => {
      dist = d;
      const t = settle ? 'transform .38s var(--ease-in-ios, ease)' : 'none';
      if (page) { page.style.transition = t; page.style.transform = d ? `translateY(${d}px)` : ''; }
      ind.style.transition = settle ? 'height .38s var(--ease-in-ios, ease), opacity .25s' : 'none';
      ind.style.height = `${d}px`;
      if (!busy) {
        // One spoke more for every eighth of the way to the mark.
        const shown = Math.min(8, Math.round((d / PTR_TRIGGER) * 8));
        spokes.forEach((r, i) => { r.style.opacity = i < shown ? '' : '0'; });
        ind.classList.toggle('is-armed', d >= PTR_TRIGGER);
      }
      ind.classList.toggle('is-on', d > 0 || busy);
    };
    const release = () => {
      paint(0, { settle: true });
      const was = page;
      setTimeout(() => {
        if (dist || busy) return;
        if (was) { was.style.transition = ''; was.style.transform = ''; }
        if (page === was) page = null;
      }, 400);
    };

    mainEl.addEventListener('touchstart', (e) => {
      start = null;
      if (busy || !onPhone() || e.touches.length !== 1) return;
      if (!$('#bellPanel').hidden) return;
      // A conversation is a screen of its own over the page: pulling down in
      // it scrolls back through the messages, it never refreshes the page
      // underneath.
      if (threadIsOpen() && e.target.closest('.messenger.thread-open .thread-col')) return;
      const target = e.target;
      if (target.closest('input, textarea, select, [contenteditable="true"], .messenger.thread-open .thread-compose, #bellPanel, #bellBackdrop')) return;
      if (!atTop(target)) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      pulling = false;
    }, { passive: true });

    mainEl.addEventListener('touchmove', (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      if (!pulling) {
        // Decided on the first real movement: down and more down than across
        // is a pull; anything else is left entirely to the browser.
        if (Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
        if (dy <= 0 || Math.abs(dx) > dy) { start = null; return; }
        pulling = true;
        page = $('.view.active');
      }
      e.preventDefault();
      // Resistance: easy to the mark, then heavier the further past it.
      const d = dy <= 0 ? 0 : dy * 0.5 < PTR_TRIGGER ? dy * 0.5 : PTR_TRIGGER + (dy * 0.5 - PTR_TRIGGER) * 0.35;
      paint(Math.min(PTR_MAX, d));
    }, { passive: false });

    const end = () => {
      if (!start) return;
      start = null;
      if (!pulling) return;
      pulling = false;
      if (dist < PTR_TRIGGER) { release(); return; }
      busy = true;
      spokes.forEach((r) => { r.style.opacity = ''; });
      ind.classList.remove('is-armed');
      ind.classList.add('is-busy');
      paint(PTR_HOLD, { settle: true });
      pullRefresh().finally(() => {
        busy = false;
        ind.classList.remove('is-busy');
        release();
      });
    };
    // Cancelled — iOS took the gesture for itself, Notification Center say —
    // is never a request to refresh.
    const cancel = () => {
      if (!start) return;
      start = null;
      if (pulling) { pulling = false; release(); }
    };
    mainEl.addEventListener('touchend', end, { passive: true });
    mainEl.addEventListener('touchcancel', cancel, { passive: true });
  }());

  // What a pull does: everything the app shows, looked at again, for at least
  // long enough that the spinner reads as "done" rather than a flicker.
  async function pullRefresh() {
    pulledAt = Date.now();
    const own = currentView === 'onboarding' && window.Onboarding ? window.Onboarding.refresh()
      : currentView === 'salesiq' && window.SalesIQ ? Promise.resolve(window.SalesIQ.reload()) : null;
    const shell = 'serviceWorker' in navigator
      ? navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update())
      : null;
    await Promise.allSettled([poll(), own, shell, new Promise((r) => setTimeout(r, 700))]);
    if (pollFails) toast('Couldn’t refresh — no connection. Showing what this phone last had.', true);
    // A newer version of the app is waiting: a pull is somebody asking for
    // the latest, so this is the moment to take it.
    takeUpdate('pull');
  }

  // ---- coming back to the app ----
  // iOS freezes a backgrounded web app rather than keeping it running, and
  // under memory pressure cold-starts it instead. Either way what is on
  // screen when it comes back may be minutes or days old, so ask again.
  // pageshow covers the restored-from-freeze case that visibilitychange misses.
  window.addEventListener('pageshow', (e) => { if (e.persisted) poll(); });

  // ---------------- Boot ----------------
  // The five expensive renders, and the page each one draws. Measured against
  // 3,514 candidates they were 55 of the 61 ms a full render cost, and four of
  // the five were drawing a page nobody was looking at. They run for the view
  // you are on; the others are marked stale and drawn when you arrive.
  //
  // Texting's header and Settings — its editors, previews and the attachment
  // thumbnail (a 432 KB fetch) — are drawn the same way, when their page is
  // the one on screen, rather than on every render from any page.
  const VIEW_RENDERERS = {
    dashboard: [renderDashboard],
    candidates: [renderRoleFilter, renderCandidates],
    template: [renderMailList],
    texting: [renderTextingHead, renderConvList],
    settings: [renderSettingsPage],
  };
  const staleViews = new Set();

  function renderView(view) {
    const fns = VIEW_RENDERERS[view];
    // Nothing to draw from before the first state (or after signing out):
    // the page stays marked, and is drawn once there is.
    if (!fns || !state) return;
    staleViews.delete(view);
    for (const fn of fns) fn();
  }

  function renderSettingsPage() {
    renderTextSettings();
    renderSettings();
    // Only prime the template editor when there are no unsaved edits.
    if (!templateDirty) {
      const p = currentPreset('email');
      $('#tplSubject').value = p ? p.subject : state.template.subject;
      $('#tplBody').value = p ? p.body : state.template.body;
    }
    renderPresetBar('email');
    renderAttachments();
    renderTemplatePreview();
    renderFollowUpEditor();
  }

  // The counts beside the nav items are visible from every page, so they are
  // cheap by construction and always run.
  // The whole number, in the badge as well as the sidebar — it fits, and a
  // number you cannot read is not worth drawing. Only a five-figure count is
  // wider than a tab, and that is the only one shortened.
  function setNavCount(sel, n) {
    const el = $(sel);
    el.textContent = n ? n.toLocaleString() : '';
    el.dataset.short = n ? (n > 9999 ? '9,999+' : n.toLocaleString()) : '';
  }
  // Only unread replies are counted on a tab. How many candidates there are,
  // or how many are left to email or text, is not a count anyone needs on a
  // tab at all times, so no tab carries one.
  function renderNavCounts() {
    const mail = mailUnreadCount() || 0;
    const texts = unreadCount() || 0;
    setNavCount('#navEmailCount', mail);
    // The phone's Inbox tab is Email and Texting together, so it counts the
    // unread in both, and the switch at the top of the page says which.
    setNavCount('#navInboxCount', mail + texts);
    const put = (view, n) => $$(`.group-count[data-count-for="${view}"]`).forEach((el) => { el.textContent = n ? n.toLocaleString() : ''; });
    put('template', mail);
    put('texting', texts);
    // And the Unread filter inside each list, which is drawn with its list
    // only when that page is on screen.
    for (const [sel, n] of [['#mailUnreadN', mail], ['#convUnreadN', texts]]) {
      const el = $(sel);
      if (!el) continue;
      el.textContent = n || '';
      el.hidden = !n;
    }
  }

  // A conversation on screen is being read: a reply that lands in it is read
  // as it arrives, and never lights the bell or a badge for something already
  // in front of you. On a phone that means the thread is pushed; on a wider
  // screen the thread column is always showing on its page.
  function threadOnScreen(view) {
    if (currentView !== view || document.hidden) return false;
    if (!(view === 'texting' ? openThreadId : openMailId)) return false;
    const m = messengerOf(view);
    if (onPhone()) return Boolean(m && m.classList.contains('thread-open'));
    // Wider, it is a column beside the list — or, up to 900px, under it and
    // perhaps scrolled out of sight. It counts only if it is in view.
    const col = m && m.querySelector('.thread-col');
    const r = col && col.getBoundingClientRect();
    return Boolean(r && r.height && r.bottom > 0 && r.top < window.innerHeight);
  }

  function renderAll() {
    renderNotices();
    renderApollo();
    mountTheme();
    mountTeam();
    mountBell();
    mountConnection();
    // The controls are created hidden and filled in here, because mounting
    // happens after the team is known, not before.
    renderTeamChip();
    const liveText = threadOnScreen('texting');
    const liveMail = threadOnScreen('template');
    const byId = candById;
    const tc = liveText && byId(openThreadId);
    const mc = liveMail && byId(openMailId);
    if (tc && tc.textUnread) markRead('text', [{ c: tc, ts: lastInTs(tc, 'text') }]);
    if (mc && mc.emailUnread) markRead('email', [{ c: mc, ts: lastInTs(mc, 'email') }]);
    renderUnread();
    renderConnection();
    // These two are cheap and cross-view: the send and follow-up buttons live
    // in the Email header, the due badge in Settings, and the queue timer has
    // to keep running wherever you are. They used to ride along inside
    // renderDashboard, which meant they stopped updating once that became
    // dashboard-only.
    renderEmailAllButtons();
    scheduleQueueWork();
    // A thread on screen stays live: a reply arriving while you are reading it
    // should appear, not wait for you to click away and back. One that is not
    // on screen is not fetched at all — it is read again when it is opened.
    if (liveText && !threadLoading) openThread(openThreadId, { quiet: true });
    // An email conversation is read from Gmail, so only when the list says
    // something in it has changed.
    if (mc && !mailLoading && mailSig(mc) !== mailShownSig) openMail(openMailId, { quiet: true });
    renderAccount();
    for (const v of Object.keys(VIEW_RENDERERS)) staleViews.add(v);
    renderView(currentView);
  }

  // Booking times (feed + phone push) are formatted server-side in the
  // user's zone, which is learned from the browser and saved with settings.
  function syncTimeZone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && state.settings.timeZone !== tz) {
        api('/api/settings', { method: 'POST', body: { timeZone: tz } }).catch(() => {});
      }
    } catch {}
  }

  // Runs once we have an authenticated session (at boot, or after sign-in):
  // handles OAuth deep links and starts the light polling that keeps
  // bookings/status fresh while the tab is open.
  let started = false;
  function start() {
    if (started) return;
    started = true;
    wireMessages();
    wireMail();
    syncTimeZone();
    const hash = location.hash.replace('#', '');
    if (hash) {
      const [, query] = hash.split('?');
      show(viewInAddressBar(), { record: false });
      const params = new URLSearchParams(query || '');
      if (params.get('connected')) toast('Google connected — you can now import private sheets and send Gmail.');
      if (params.get('error')) toast(`Google sign-in problem: ${params.get('error')}`, true);
    }
    // Keep the page, drop the one-shot Google sign-in parameters, and give the
    // first entry a state object so Back from the second page works.
    history.replaceState({ view: currentView }, '', addressFor(currentView));
    // Polling a tab nobody is looking at buys nothing and costs a function
    // call every 30 seconds for as long as it stays open. Coming back to the
    // tab refreshes straight away, so it is also fresher than waiting out the
    // rest of an interval — which is what used to happen.
    setInterval(() => { if (!document.hidden) poll(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll();
    });
    window.addEventListener('online', () => poll());
    window.addEventListener('offline', () => { pollFails = Math.max(pollFails, 2); renderConnection(); });
    // The first look for replies and the first Calendly sync each make the
    // server read and perhaps rewrite the whole list, and then fetch it all
    // again. At launch that landed on top of the page's own first load —
    // the moment it most needs the connection and the server — so they wait
    // a little, then keep their usual pace.
    setTimeout(() => { checkReplies(); setInterval(checkReplies, 60000); }, BACKGROUND_DELAY);
    setTimeout(() => { syncCalendly(); setInterval(syncCalendly, 5 * 60000); }, BACKGROUND_DELAY + 1000);
  }
  const BACKGROUND_DELAY = 15000;

  // Ask the server to look at a few sent threads for replies; new replies
  // flip candidates to "Replied" and appear in the feed.
  // Said once a day, not on every launch of the app: it is a setting to
  // change, not news.
  const SCOPE_HINT_KEY = () => teamKey('scopeHintAt');
  function scopeHintDue() {
    try { return Date.now() - Number(localStorage.getItem(SCOPE_HINT_KEY()) || 0) > 24 * 3600 * 1000; } catch { return true; }
  }
  let scopeHintShown = false;
  let replyTextLimited = false;
  async function checkReplies() {
    if (!signedIn || !state || !state.google.connected || document.hidden) return;
    try {
      const r = await api('/api/replies/check', { method: 'POST' });
      replyTextLimited = Boolean(r.scopeError);
      if (r.scopeError && !scopeHintShown && scopeHintDue()) {
        scopeHintShown = true;
        try { localStorage.setItem(SCOPE_HINT_KEY(), String(Date.now())); } catch {}
        toast(r.scopeError, true);
      }
      if (r.replies > 0) { await refresh(); toast(`${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'} detected.`); }
    } catch {}
  }

  (async () => {
    // The session, as index.html asked for it while the page loaded; asked
    // again if that answer failed.
    const authStatus = async () => {
      const e = takeEarly('auth');
      if (e) {
        try {
          const r = await fetchJson(null, { ms: STATE_MS }, e);
          if (r.status === 200 && r.body) return r.body;
        } catch { /* asked again below */ }
      }
      return api('/api/auth/status');
    };
    const boot = async () => {
      const a = await authStatus();
      if (a.setupRequired) { $('#setupScreen').hidden = false; return; }
      knownTeams = a.teams || [];
      numericPins = Boolean(a.numericPins);
      authRequired = Boolean(a.required);
      if (a.required && !a.authed) { renderTeamPicker(); showLogin(); return; }
      setTeam(a.team);
      signedIn = true;
      await refresh();
      start();
      // A new version that was already waiting when the app opened: now that
      // the app knows nothing is in flight, it moves to it.
      takeUpdate('launch');
    };
    // A blip at load used to leave the page dead until somebody noticed and
    // reloaded it: one toast, no polling started, no retry. Keep trying.
    const attempt = async (first) => {
      try {
        await boot();
        offlineBoot = false;
        if (pollFails) { pollFails = 0; renderConnection(); }
      } catch (err) {
        if (err.message === 'Please sign in.' || err.message === 'Set APP_PASSWORD first.') return;
        if (first) oops(err);
        // Opened with no connection on Onboarding docs: what this device kept
        // for the team it was last signed in to, while the retries go on.
        offlineBoot = true;
        if (first && !currentTeam && lastTeam() && viewInAddressBar() === 'onboarding' && window.Onboarding) {
          show('onboarding', { record: false });
          window.Onboarding.showCached(lastTeam());
        }
        mountConnection();
        // No network at all is not a blip: say so straight away.
        pollFails = navigator.onLine ? pollFails + 1 : Math.max(pollFails + 1, 2);
        renderConnection();
        setTimeout(() => attempt(false), Math.min(5000 * pollFails, 30000));
      }
    };
    attempt(true);
  })();
})();
