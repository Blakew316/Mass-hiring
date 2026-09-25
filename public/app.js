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
  let feedChannel = readFeedChannel();  // 'all' | 'email' | 'text'
  // 3,500 rows rendered at once is a 400,000-pixel page and the reason the
  // list felt like everything at once. A page at a time, like any CRM.
  const PAGE_SIZE = 50;
  let page = 0;
  let lastFilterSig = '';
  let pageRows = [];           // what is actually on screen right now
  let pendingImport = null;    // {headers, rows, mapping, source}
  let composeIds = [];

  const STATUS = {
    new:      { label: 'Not contacted', cls: 'tint-navy' },
    emailed:  { label: 'Emailed',       cls: 'tint-blue' },
    replied:  { label: 'Replied',       cls: 'tint-mint' },
    booked:   { label: 'Booked',        cls: 'tint-green' },
    declined: { label: 'Not interested',cls: 'tint-red' },
    bounced:  { label: 'Bounced',       cls: 'tint-amber' },
  };
  const AVATAR_TINTS = ['tint-blue', 'tint-green', 'tint-mint', 'tint-navy'];
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
  // Another admin may have made or renamed a team since this page loaded, and
  // the delete list has to mean something. Refreshed when Settings is looked
  // at, not on the 30-second poll, which must stay one request.
  let teamsRefreshedAt = 0;
  const lastTeam = () => { try { return localStorage.getItem(LAST_TEAM_KEY) || ''; } catch { return ''; } };

  function setTeam(team) {
    const changed = (currentTeam && currentTeam.id) !== (team && team.id);
    currentTeam = team || null;
    if (currentTeam) { try { localStorage.setItem(LAST_TEAM_KEY, currentTeam.id); } catch {} }
    // Anything kept per team has to be re-read when the team changes, or the
    // new team inherits the old one's view of things.
    if (changed) feedChannel = readFeedChannel();
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
    selected = new Set();
    filter = 'all';
    search = '';
    roleFilter = '';
    sortBy = 'default';
    industryFilter = '';
    addedFilter = '';
    textedFilter = '';
    rankFilter = '';
    page = 0;
    pageRows = [];
    lastFilterSig = '';
    pendingImport = null;
    composeIds = [];
    openThreadId = null;
    openMailId = null;
    threadLoading = false;
    for (const k of Object.keys(thumbs)) delete thumbs[k];
    for (const k of Object.keys(scrollMemory)) delete scrollMemory[k];
    // Unsaved edits and the template shown belong to the team they were made
    // in: carried into the next team, pressing Save would write them there.
    try {
      presetShown.email = ''; presetShown.text = '';
      presetDraft.email = null; presetDraft.text = null;
      setTemplateDirty(false); setFollowUpDirty(false); setPresetDirty('text', false); setSettingsDirty(false);
    } catch { /* not declared yet: nothing to reset */ }
  }

  function signedOut() {
    signedIn = false;
    resetClientState();
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
    if (updateReady) {
      n.push(`<div class="notice ok"><span class="notice-ico">${icon('download', 16)}</span><div><strong>A new version is ready.</strong> It will be picked up on its own the next time you come back to the app, once whatever is part-way through has finished — or reload now.</div><button class="btn btn-sm notice-action" id="reloadForUpdate">Reload</button></div>`);
    }
    if (state.storage && !state.storage.persistent) {
      n.push(`<div class="notice danger"><span class="notice-ico">${icon('alert', 16)}</span><div><strong>Your data is not being saved permanently.</strong> Netlify Blobs is unavailable${state.storage.error ? ` (${esc(state.storage.error)})` : ''}, so settings and candidates will be lost on the next deploy or restart. Check that Blobs is enabled for this site in Netlify, then redeploy.</div></div>`);
    }
    if (state.storage && state.storage.deployed && state.auth && !state.auth.required) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('lock', 16)}</span><div><strong>This dashboard is public.</strong> Anyone with the URL could send email from your account. Add an environment variable named <code>APP_PASSWORD</code> in Netlify (Project configuration → Environment variables), then redeploy. That is the admin password — it locks the dashboard and is what lets you create and delete teams.</div></div>`);
    }
    if (state.lastError) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('alert', 16)}</span><div>${esc(state.lastError)}</div></div>`);
    }
    $('#notices').innerHTML = n.join('');
    $('#signOutBtn').hidden = !(state.auth && state.auth.required);
  }

  // The 30-second poll. The server tags the state, so an unchanged poll comes
  // back 304 with no body — nothing to parse, and nothing to re-render, which
  // is the whole point: most polls change nothing and should cost nothing.
  let stateTag = '';
  async function refresh() {
    const res = await fetch('/api/state', {
      headers: stateTag ? { 'If-None-Match': stateTag } : {},
    });
    // Answered, therefore in touch: a 304 is as current as a 200, it just has
    // nothing new to say.
    if (res.status === 304) { lastSyncAt = Date.now(); return false; }
    if (res.status === 401) { showLogin(); const e = new Error('Please sign in.'); e.authFailed = true; throw e; }
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    lastSyncAt = Date.now();
    const tag = res.headers.get('ETag') || '';
    // The tag is remembered only once this version is actually on screen. Saved
    // first, a body cut off in transit or a drawing error left the page asking
    // "anything newer than this?", being told no, and showing the old list —
    // an import that never appeared — until something else changed.
    stateTag = '';
    state = await res.json();
    authRequired = Boolean(state.auth && state.auth.required);
    setTeam(state.team);
    renderAll();
    stateTag = tag;
    return true;
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
      ? new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
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
  // Set now as well as in show(), so the first paint is already the right
  // width rather than reflowing the moment you navigate.
  if (mainEl) mainEl.dataset.view = currentView;
  const scrollMemory = Object.create(null);
  function show(view, { record = true } = {}) {
    if (!$(`#view-${view}`)) return;
    if (currentView !== view) scrollMemory[currentView] = mainEl ? mainEl.scrollTop : 0;
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    // Which page this is, for the stylesheet: Candidates is a table and wants
    // the window, everything else is capped for reading.
    if (mainEl) mainEl.dataset.view = view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    // Anything that fell behind while you were on another page is drawn now,
    // rather than on every poll for six pages at once.
    if (staleViews.has(view)) renderView(view);
    // The editors moved to Settings; Email and Texting are conversations only.
    if (view === 'settings') { renderTemplatePreview(); loadRelayToken(); placeAccountControls(); }
    if (view === 'texting') renderTexting();
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
    if (record && location.hash !== `#${view}`) history.pushState({ view }, '', `#${view}`);
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
    lastRouted = key;
    show(view, { record: false });
    // On a phone a thread is its own entry in the history, so going back out
    // of one is the same gesture as going back out of a page.
    syncThreadStack(thread);
  }
  window.addEventListener('popstate', (e) => {
    route((e.state && e.state.view) || viewInAddressBar(), Boolean(e.state && e.state.thread));
  });
  // Typing a page into the address bar, or following a link to #texting from
  // outside, changes the hash without reloading and without a popstate.
  window.addEventListener('hashchange', () => route(viewInAddressBar(), false));
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => {
    // Tapping the tab you are already on is how iOS pops back to the top of
    // it — here, out of an open conversation.
    if (b.dataset.view === currentView && threadIsOpen()) { backFromThread(); return; }
    show(b.dataset.view);
  }));
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

  // ---------------- Dashboard ----------------
  function renderDashboard() {
    const s = state.stats;
    const all = state.candidates;
    const textCount = (fn) => all.filter(fn).length;
    // "Sent" is everyone we tried to text, which has to include the numbers that
    // turned out to have no iMessage account — we sent to them, it failed. Left
    // out of the total, "No iMessage" was a percentage of something it was not
    // part of, and could read over 100%; and "Delivered 100%" quietly hid every
    // failure.
    const t = {
      sent: textCount((c) => ['sent', 'delivered', 'read', 'replied', 'not-imessage'].includes(c.textStatus)),
      delivered: textCount((c) => ['delivered', 'read', 'replied'].includes(c.textStatus)),
      read: textCount((c) => ['read', 'replied'].includes(c.textStatus)),
      replied: textCount((c) => c.textStatus === 'replied'),
      dead: textCount((c) => c.textStatus === 'not-imessage'),
    };
    // The email funnel, counted the way the texting one already was: how many
    // people ever reached each stage, so every row is a subset of the one above
    // it. Counting the *current status* instead mixed two different questions —
    // somebody who opened and then replied has status "replied", so they landed
    // in Opened but not in Sent, and the funnel read 200%.
    const e = {
      // status is included as well as the timestamp: an older or imported record
      // can carry the stage without the date, and leaving those out would make
      // Sent smaller than the rows beneath it.
      sent: textCount((c) => Boolean(c.lastEmailedAt) || c.emailBounced
        || c.status === 'bounced' || c.status === 'emailed'),
      opened: textCount((c) => Boolean(c.openedAt)),
      replied: textCount((c) => c.emailReplies > 0 || Boolean(c.lastReplyAt)),
      // Scoped to people who were emailed: a booking that came from a text
      // belongs in the texting story, not this one.
      booked: textCount((c) => Boolean(c.bookedAt) && Boolean(c.lastEmailedAt)),
      bounced: textCount((c) => c.emailBounced || c.status === 'bounced'),
    };
    const contacted = textCount((c) => Boolean(c.lastEmailedAt) || Boolean(c.lastTextedAt));

    // Everyone who ever answered, on either channel. The status-only count
    // dropped anyone who replied and then booked, while the split beside it
    // still counted them — so the smaller half could exceed the whole.
    const repliedEither = textCount((c) => c.emailReplies > 0 || Boolean(c.lastReplyAt)
      || c.textStatus === 'replied' || Boolean(c.textRepliedAt) || c.status === 'replied');

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

  function upcomingInterviews() {
    const since = Date.now() - 3600 * 1000;
    return (state.interviews || []).filter((i) => i.status === 'active' && new Date(i.start).getTime() >= since);
  }

  // ---------------- Stat tiles → detail views ----------------
  const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
      <div class="tile-side">${sideHtml}</div>
    </li>`;
  }
  const statusSelect = (c) => `<select class="status-select ${(STATUS[c.status] || STATUS.new).cls} tile-status" data-id="${c.id}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v.label}</option>`).join('')}</select>`;
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
          const c = i.candidateId ? state.candidates.find((x) => x.id === i.candidateId) : null;
          const who = c ? (c.name || c.email) : (i.inviteeName || i.inviteeEmail || 'Unknown invitee');
          const detail = c ? [c.role, c.company].filter(Boolean).join(' @ ') : 'not in your candidate list';
          return `<li class="tile-row">
            <span class="avatar tint-green">${esc(initials(c || { name: who, email: i.inviteeEmail }))}</span>
            <div class="tile-main">
              <div class="tile-when">${esc(fmtWhen(i.start))}${i.end ? ` – ${new Date(i.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</div>
              <div class="tile-name">${esc(who)} <span class="muted small">· ${esc(i.name)}</span></div>
              <div class="tile-email">${esc(i.inviteeEmail || (c && c.email) || '')}${detail ? ` · ${esc(detail)}` : ''}</div>
            </div>
            <div class="tile-side">
              ${i.joinUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(i.joinUrl)}">Join call</a>` : ''}
              ${i.rescheduleUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(i.rescheduleUrl)}">Reschedule</a>` : ''}
              ${c ? statusSelect(c) : `<button class="tile-link link-btn" data-uri="${esc(i.uri)}" data-email="${esc(i.inviteeEmail || '')}" data-name="${esc(i.inviteeName || '')}">${icon('users', 13)} Link to candidate</button>`}
            </div>
          </li>`;
        });
      } else {
        rows = bookedCands.map((c) => candRow(c, `Interview ${c.bookedAt ? fmtWhen(c.bookedAt) : 'time not recorded'}${c.bookedEvent ? ` · ${esc(c.bookedEvent)}` : ''}`,
          `${c.bookedJoinUrl ? `<a class="tile-link" target="_blank" rel="noopener" href="${esc(c.bookedJoinUrl)}">Join call</a>` : ''}${statusSelect(c)}`));
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
  $('#tileList').addEventListener('click', (e) => {
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
    api(`/api/candidates/${e.target.dataset.id}`, { method: 'PATCH', body: { status: e.target.value } }).then(refresh).catch(oops);
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
      else if (r.ok) refresh().catch(() => {});
    } catch {}
  }

  // Everyone still at "Not contacted".
  function uncontactedIds() {
    return state.candidates.filter((c) => c.status === 'new').map((c) => c.id);
  }

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
  };

  function readFeedChannel() {
    try {
      const v = localStorage.getItem(teamKey('feedChannel'));
      return v === 'email' || v === 'text' ? v : 'all';
    } catch { return 'all'; }
  }

  function feedEvents(channel) {
    return (state.events || []).filter((ev) => {
      const k = FEED_KIND[ev.type];
      if (!k) return false;
      return channel === 'all' || k.ch === 'both' || k.ch === channel;
    });
  }

  function renderFeed() {
    // The chip counts each channel's own updates. Bookings show under every
    // filter but are counted only in All, so "Texting 2" never means "2, one
    // of which is a booking".
    const shown = feedEvents('all');
    const own = (ch) => shown.filter((ev) => FEED_KIND[ev.type].ch === ch).length;
    const counts = { all: shown.length, email: own('email'), text: own('text') };
    // A filter that can only ever show what "All" already shows is noise, so
    // the row appears once there is genuinely something to separate.
    const worthFiltering = counts.email > 0 && counts.text > 0;
    $('#feedFilters').innerHTML = worthFiltering
      ? [['all', 'All'], ['email', 'Email'], ['text', 'Texting']].map(([k, label]) =>
          `<button class="feed-chip${feedChannel === k ? ' on' : ''}" data-feed="${k}">${label}<span class="feed-n">${counts[k]}</span></button>`).join('')
      : '';
    if (!worthFiltering) feedChannel = 'all';

    const list = feedEvents(feedChannel).slice(0, 15);
    const empty = feedChannel === 'text'
      ? 'No texting updates yet — reads, replies and opt-outs show up here.'
      : feedChannel === 'email'
        ? 'No email updates yet — opens and replies show up here.'
        : 'No updates yet — opens, replies, texts, bookings and cancellations show up here.';
    $('#activityList').innerHTML = list.length
      ? list.map((ev) => {
          const k = FEED_KIND[ev.type];
          return `<li><span class="act-ico ${k.cls}">${icon(k.ico, 14)}</span>
            <div><div>${esc(ev.message)}</div>
              <div class="act-time">${k.tag ? `<span class="act-tag ch-${k.ch}">${k.tag}</span>` : ''}${timeAgo(ev.ts)}</div></div></li>`;
        }).join('')
      : `<li class="empty-line">${empty}</li>`;
  }

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
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (sameDay ? '' : ` ${d.toLocaleDateString([], { weekday: 'short' })}`);
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

  function timeAgo(ts) {
    const sec = (Date.now() - new Date(ts).getTime()) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------------- Candidates ----------------
  // A role written a dozen slightly different ways is still one role to a
  // person reading the list, so compare them loosely.
  const roleKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function visibleCandidates() {
    const q = search.toLowerCase().trim();
    // A number is written a dozen ways — (617) 235-0001, 617.235.0001,
    // +1 617 235 0001 — and nobody types it back the way it was stored, so a
    // literal substring match found almost nothing. Once the query looks like a
    // number, compare digits to digits as well.
    // A US number is stored and typed with and without the leading 1, so drop
    // it from both sides before comparing — otherwise "+1 617 235 0003" is
    // longer than the number it is looking for and matches nothing.
    const tail = (d) => (d.length === 11 && d[0] === '1' ? d.slice(1) : d);
    const qDigits = tail(q.replace(/\D/g, ''));
    const byDigits = qDigits.length >= 3 && /^[\d\s().+-]+$/.test(q);
    return state.candidates.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (roleFilter === '__none' && roleKey(c.role)) return false;
      if (!matchesFilters(c)) return false;
      if (!q) return true;
      if (byDigits && tail(String(c.phone || '').replace(/\D/g, '')).includes(qDigits)) return true;
      return [c.name, c.firstName, c.lastName, c.email, c.role, c.company, c.pastRoles, c.phone, c.location]
        .some((f) => String(f || '').toLowerCase().includes(q));
    });
  }

  // Every role people currently hold, most common first, with how many hold it.
  function renderRoleFilter() {
    const sel = $('#roleFilter');
    if (!sel) return;
    const counts = new Map();
    for (const c of state.candidates) {
      const key = roleKey(c.role);
      if (!key) continue;
      const entry = counts.get(key) || { label: String(c.role).trim(), n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
    const roles = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label));
    const missing = state.candidates.filter((c) => !roleKey(c.role)).length;
    if (roleFilter && !counts.has(roleFilter)) roleFilter = '';     // that role is gone from the list
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

  function matchesFilters(c) {
    if (industryFilter && (c.industry || 'other') !== industryFilter) return false;
    if (roleFilter && roleFilter !== '__none' && roleKey(c.role) !== roleFilter) return false;

    if (addedFilter === 'old') { if (daysSince(c.addedAt) <= 90) return false; }
    else if (addedFilter && daysSince(c.addedAt) > Number(addedFilter)) return false;

    if (textedFilter) {
      const textable = Boolean(textPhoneOf(c));
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
    return true;
  }

  // Jump from a group straight into the table with that filter applied.
  function openSegment(patch) {
    // Every group is a fresh start, not a narrowing of whatever was last set —
    // and that includes the order. Leaving the order alone was why "Everyone"
    // looked exactly like "Best to text next": the ranked order carried over,
    // so the same fifty people stayed on top and only the counter moved. A
    // group that names an order gets it; every other one gets the plain one.
    filter = 'all'; industryFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; roleFilter = '';
    sortBy = 'default';
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
  function narrowSelection() {
    if (!selected.size) return;
    const before = selected.size;
    const visible = new Set(visibleCandidates().map((c) => c.id));
    for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
    const gone = before - selected.size;
    if (gone) toast(`${gone} selected ${gone === 1 ? 'person' : 'people'} fell outside this filter and ${gone === 1 ? 'is' : 'are'} no longer selected.`);
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

  function renderViews() {
    const all = state.candidates || [];
    if (!all.length) { drawOnce($('#candViews'), ''); $('#candCount').textContent = ''; return; }
    const pri = (state.texting && state.texting.priority) || { order: {} };
    const ranked = Object.keys(pri.order || {}).length;
    const count = (fn) => all.filter(fn).length;

    const views = [
      { label: 'Everyone', n: all.length, patch: {} },
      { label: 'Best to text next', n: Math.min(ranked, 50), patch: { rank: '50', sort: 'texting' } },
      { label: 'Replied', n: count((c) => c.status === 'replied'), patch: { status: 'replied' } },
      { label: 'Not contacted', n: count((c) => c.status === 'new'), patch: { status: 'new' } },
      { label: 'Booked', n: count((c) => c.status === 'booked'), patch: { status: 'booked' } },
      { label: 'Needs a number', n: count((c) => !textPhoneOf(c)), patch: { texted: 'nonumber' } },
    ].filter((v) => v.n > 0);

    // Which pill, if any, describes exactly what is on screen right now.
    const nothingElse = !search && !industryFilter && !roleFilter && !addedFilter;
    const active = (v) => nothingElse
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
    const byIndustry = {};
    for (const c of all) { const k = c.industry || 'other'; byIndustry[k] = (byIndustry[k] || 0) + 1; }
    setOptions($('#industryFilter'), '<option value="">Any industry</option>' + Object.entries(byIndustry)
      .sort((x, y) => y[1] - x[1])
      .map(([code, n]) => `<option value="${esc(code)}">${esc(industryLabel(code))} (${n})</option>`).join(''), industryFilter);

    // And the stage menu carries its counts, so picking one is informed.
    setOptions($('#stageFilter'), `<option value="all">Any stage (${all.length.toLocaleString()})</option>` + Object.entries(STATUS)
      .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)} (${count((c) => c.status === k).toLocaleString()})</option>`).join(''), filter || 'all');
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
    if (b.dataset.clear === 'all') { filter = 'all'; industryFilter = ''; roleFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; search = ''; }
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
    ['#textedFilter', (v) => { textedFilter = v; }], ['#rankFilter', (v) => { rankFilter = v; }]]) {
    $(id).addEventListener('change', (e) => { set(e.target.value); narrowSelection(); renderCandidates(); });
  }

  function renderCandidates() {
    renderViews();
    let rows = visibleCandidates();
    const ranking = sortBy === 'texting';
    if (sortBy === 'newest') rows = [...rows].sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    else if (sortBy === 'name') rows = [...rows].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    if (ranking) {
      // Ranked people first in their own order, then everyone who cannot be
      // texted — they are still listed, because "why is this person not here"
      // is the first question the order raises.
      rows = [...rows].sort((a, b) => {
        const pa = textPriorityOf(a.id); const pb = textPriorityOf(b.id);
        if (pa && pb) return pa.rank - pb.rank;
        if (pa) return -1;
        if (pb) return 1;
        return 0;
      });
    }
    $('#rankHead').hidden = !ranking;

    // Changing what is being asked for starts again at the first page; paging
    // within the same question keeps your place.
    const sig = JSON.stringify([filter, industryFilter, roleFilter, addedFilter, textedFilter, rankFilter, search, sortBy]);
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
      return `<tr data-id="${c.id}"${ranking && !pri ? ' class="row-muted"' : ''}>
        ${ranking ? `<td class="col-rank" data-col="rank">${pri ? pri.rank : '<span class="muted">—</span>'}</td>` : ''}
        <td class="col-check" data-col="check"><input type="checkbox" class="row-check" ${selected.has(c.id) ? 'checked' : ''}></td>
        <td data-col="name"><div class="name-cell">
          <span class="avatar ${AVATAR_TINTS[i % AVATAR_TINTS.length]}">${esc(initials(c))}</span>
          <div><div class="cand-name">${esc(displayName)}</div>
          ${pri ? `<div class="cand-sub why-text">${esc(pri.reason)}</div>`
            : blockedWhy ? `<div class="cand-sub muted">not texting: ${esc(blockedWhy)}</div>`
            : (c.location || c.notes) ? `<div class="cand-sub">${esc([c.location, c.notes].filter(Boolean).join(' · '))}</div>` : ''}</div>
        </div></td>
        <td data-col="email">${esc(c.email)}</td>
        <td data-col="text">${textCell(c)}</td>
        <td data-col="role">${esc(c.role) || '<span class="muted">—</span>'}${c.pastRoles ? `<div class="cand-sub" title="${esc(c.pastRoles)}">was ${esc(String(c.pastRoles).split('|')[0].trim())}${String(c.pastRoles).split('|').length > 1 ? ` +${String(c.pastRoles).split('|').length - 1} more` : ''}</div>` : ''}</td>
        <td data-col="company">${esc(c.company) || '<span class="muted">—</span>'}</td>
        <td data-col="status"><select class="status-select ${st.cls}" title="Change status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></td>
        <td data-col="last">${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : '<span class="muted">never</span>'}</td>
        <td data-col="act"><div class="row-actions">
          <button class="icon-btn act-edit" title="Edit details (name, phone, role…)">${icon('doc', 16)}</button>
          <button class="icon-btn act-email" title="Send personal email">${icon('mail', 16)}</button>
          ${textPhoneOf(c) ? `<button class="icon-btn act-text" title="Send a text">${icon('bubble', 16)}</button>` : ''}
          ${c.status === 'emailed' ? `<button class="icon-btn act-followup" title="Follow up (reply in the same conversation)">${icon('reply', 16)}</button>` : ''}
          <button class="icon-btn act-delete" title="Remove">${icon('trash', 16)}</button>
        </div></td>
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

  function updateSendButton() {
    const bar = $('#selectionBar');
    const n = selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    const textable = selectedTextable().length;
    $('#selCount').textContent = `${n} selected`;
    $('#selEmailBtn').innerHTML = `${icon('mail', 15)} Email ${n}`;
    $('#selTextBtn').innerHTML = `${icon('bubble', 15)} Text ${textable}`;
    $('#selTextBtn').disabled = textable === 0;
    $('#selBothBtn').disabled = textable === 0;
    $('#selNote').textContent = textable === 0
      ? 'None of these have a phone number yet'
      : (textable < n ? `${n - textable} of them have no number` : '');
  }

  $('#candidateRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const cand = state.candidates.find((c) => c.id === id);
    if (e.target.classList.contains('row-check')) {
      e.target.checked ? selected.add(id) : selected.delete(id);
      updateSendButton();
      return;
    }
    if (e.target.closest('.act-edit')) { openCandidate(cand); return; }
    // The Text column is the fastest way in for the thing people actually
    // want: putting a number on someone who has none.
    if (e.target.closest('.add-number')) { openCandidate(cand, { focus: 'phone' }); return; }
    if (e.target.closest('.act-email')) { openCompose([id]); return; }
    if (e.target.closest('.act-text')) { openTextCompose([id]); return; }
    if (e.target.closest('.act-followup')) { openCompose([id], null, { followUp: true }); return; }
    if (e.target.closest('.act-delete')) {
      if (confirm(`Remove ${cand.name || cand.email} from the pipeline?`)) {
        api(`/api/candidates/${id}`, { method: 'DELETE' })
          .then(() => { selected.delete(id); return refresh(); })
          .catch(oops);
      }
      return;
    }
  });

  $('#candidateRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('status-select')) return;
    const id = e.target.closest('tr').dataset.id;
    api(`/api/candidates/${id}`, { method: 'PATCH', body: { status: e.target.value } }).then(refresh).catch(oops);
  });

  $('#checkAll').addEventListener('change', (e) => {
    // The page you can see. Ticking one box to act on 3,500 unseen people is
    // not something to do by accident.
    pageRows.forEach((c) => (e.target.checked ? selected.add(c.id) : selected.delete(c.id)));
    renderCandidates();
  });
  // 3,514 rows filtered and rebuilt on every keystroke was ~86 ms a character.
  const searchRender = debounce(renderCandidates, 120);
  $('#searchInput').addEventListener('input', (e) => { search = e.target.value; searchRender(); });
  // Folding the filters away on a phone. The button says how many are in
  // force, so a list that is filtered never looks like a list that is short.
  $('#filtersToggle').addEventListener('click', () => {
    const card = $('#filtersToggle').closest('.list-card');
    const open = card.classList.toggle('filters-open');
    $('#filtersToggle').setAttribute('aria-expanded', String(open));
  });

  $('#emptyClear').addEventListener('click', () => {
    filter = 'all'; industryFilter = ''; roleFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; search = '';
    syncFilterControls(); renderCandidates();
  });
  $('#roleFilter').addEventListener('change', (e) => { roleFilter = e.target.value; narrowSelection(); renderCandidates(); });
  $('#pagerPrev').addEventListener('click', () => { page -= 1; renderCandidates(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#pagerNext').addEventListener('click', () => { page += 1; renderCandidates(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
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
  $('#selClearBtn').addEventListener('click', () => { selected.clear(); renderCandidates(); });
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
    const cands = ids.map((id) => state.candidates.find((c) => c.id === id)).filter(Boolean);
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
    }
  });

  // ---------------- Import ----------------
  const MAP_FIELDS = [
    ['email', 'Email *'], ['name', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'],
    ['role', 'Role / title'], ['company', 'Company'], ['phone', 'Phone'], ['location', 'Location'], ['notes', 'Notes'],
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
    return (m ? m[1] : cell).replace(/^mailto:/i, '').trim().toLowerCase();
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
    const totals = { total: 0, newCount: 0, existing: 0, updatable: 0, duplicate: 0, invalid: 0, shifted: 0, invalidSamples: [], existingSamples: [] };
    const { rows, lines, repeats } = splitRepeats(allRows, pendingImport.lines, mapping);
    totals.total += repeats; totals.duplicate += repeats;
    for (let i = 0; i < rows.length; i += IMPORT_ROW_BATCH) {
      const r = await api('/api/import/preview', { method: 'POST', body: { rows: rows.slice(i, i + IMPORT_ROW_BATCH), lines: lines.slice(i, i + IMPORT_ROW_BATCH), headerless: pendingImport.headerless, mapping } });
      for (const k of ['total', 'newCount', 'existing', 'updatable', 'duplicate', 'invalid', 'shifted']) totals[k] += r[k] || 0;
      if (totals.invalidSamples.length < 10) totals.invalidSamples.push(...(r.invalidSamples || []));
      if (totals.existingSamples.length < 5) totals.existingSamples.push(...(r.existingSamples || []));
    }
    totals.invalidSamples.sort((a, b) => a.row - b.row);
    return totals;
  }

  function renderSummary(t) {
    const parts = [`<strong>${t.newCount.toLocaleString()} new</strong>`];
    if (t.existing) parts.push(`${t.existing.toLocaleString()} already in your list${t.updatable ? ` (${t.updatable.toLocaleString()} with blank details this file can fill in)` : ''}`);
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
    const cand = state.candidates.find((c) => c.id === sel.value) || SAMPLE;
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
  function renderBackups() {
    if (!state) return;
    const list = state.backups || [];
    const n = state.candidates.length;
    const newest = list[0];
    $('#backupBadge').textContent = newest ? `last backup ${timeAgo(newest.at)}` : 'first backup today';
    $('#backupSummary').textContent = newest
      ? `${n.toLocaleString()} candidates on your list. They are saved on the server as you work, and copied to a separate backup every day. ${list.length === 1 ? 'One backup so far' : `${list.length} backups kept`} — the newest 20 are always kept.`
      : `${n.toLocaleString()} candidates on your list. They are saved on the server as you work; the first daily backup is made within the next few minutes, or press Back up now.`;
    const html = list.map((b) => `<li><span class="when">${esc(new Date(b.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>` +
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
    const cand = state.candidates.find((c) => c.id === sel.value) || state.candidates.find((c) => c.status === 'emailed') || SAMPLE;
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
    const who = state.candidates.find((c) => c.id === textComposeIds[0]) || {};
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
  const textableIds = () => state.candidates
    .filter((c) => textPhoneOf(c) && !c.lastTextedAt && c.status !== 'declined' && c.status !== 'booked')
    .map((c) => c.id);

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
    return `<span class="text-pip ${st.cls}" title="${esc(prettyPhone(phone))}${when ? ` · ${new Date(when).toLocaleString()}` : ''}">
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

  function conversations() {
    const all = (state.candidates || []).filter((c) => c.textCount > 0);
    const q = convSearch.trim().toLowerCase();
    return all
      .filter((c) => (convFilter === 'unread' ? c.textUnread : true))
      .filter((c) => !q || `${c.name || ''} ${c.phone || ''} ${c.company || ''}`.toLowerCase().includes(q))
      .sort((a, b) => String((b.textLast || {}).ts || '').localeCompare(String((a.textLast || {}).ts || '')));
  }

  const unreadCount = () => (state.candidates || []).filter((c) => c.textUnread).length;

  let convShown = CONV_PAGE;
  function renderConvList() {
    const all = conversations();
    const rows = convPage(all, convShown, openThreadId);
    const n = unreadCount();
    $('#convUnreadN').textContent = n || '';
    $('#convUnreadN').hidden = !n;
    $$('[data-conv-tab]').forEach((b) => b.classList.toggle('on', b.dataset.convTab === convFilter));
    const el = $('#convList');
    keepingScroll(el, () => { el.innerHTML = rows.length
      ? rows.map((c) => {
          const last = c.textLast || {};
          const who = c.name || textPhoneOf(c) || 'Unknown';
          return `<li><button class="conv${c.id === openThreadId ? ' on' : ''}${c.textUnread ? ' unread' : ''}" data-conv="${esc(c.id)}">
            <span class="avatar">${esc(convInitials(c.name, c.phone))}</span>
            <span class="conv-main">
              <span class="conv-top"><span class="conv-name">${esc(who)}</span><span class="conv-when">${last.ts ? timeAgo(last.ts) : ''}</span></span>
              <span class="conv-last">${last.dir === 'out' ? '<span class="conv-you">You:</span> ' : ''}${esc(last.text || '')}</span>
            </span>
            ${c.textUnread ? '<span class="conv-dot" aria-label="unread"></span>' : ''}
          </button></li>`;
        }).join('') + moreRow(all.length - rows.length)
      : `<li class="conv-none">${convFilter === 'unread' ? 'Nothing unread.' : convSearch ? 'No conversation matches that.' : 'No conversations yet. Texts you send show up here.'}</li>`; });
  }

  // `quiet` means this is the background refresh of a conversation already on
  // screen, not you opening one. Blanking it to "Loading…" every 30 seconds
  // made a conversation you were reading flicker; leave what is there and swap
  // it when the new copy arrives.
  async function openThread(id, { markSeen = true, quiet = false } = {}) {
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
    try {
      thread = await api(`/api/texts/thread?id=${encodeURIComponent(id)}`);
    } catch (e) {
      threadLoading = false;
      // A failed background refresh keeps the conversation you were reading.
      if (quiet) return;
      thread = null;
      $('#threadBody').innerHTML = `<p class="thread-loading">${esc(e.message)}</p>`;
      return;
    }
    threadLoading = false;
    renderThread();
    if (markSeen) {
      const c = (state.candidates || []).find((x) => x.id === id);
      if (c && c.textUnread) {
        c.textUnread = false;           // locally, so the badge clears at once
        renderConvList(); renderBell();
        api('/api/texts/seen', { method: 'POST', body: { id } }).catch(() => {});
      }
    }
  }

  function renderThread() {
    if (!thread) return;
    $('#threadAvatar').textContent = convInitials(thread.name, thread.phone);
    $('#threadName').textContent = thread.name || thread.phone || 'Unknown';
    const bits = [thread.phone, thread.role, thread.company].filter(Boolean);
    $('#threadSub').textContent = bits.join(' · ');

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
          return `${stamp}<div class="msg ${m.dir === 'out' ? 'out' : 'in'}${m.pending ? ' pending' : ''}">
            <div class="bubble">${esc(m.text)}</div>
            ${m.pending ? '<div class="msg-meta">Sending…</div>' : ''}
          </div>`;
        }).join('')
      : '<p class="thread-loading">No messages yet.</p>';
    $('#threadBody').scrollTop = $('#threadBody').scrollHeight;

    const stopped = thread.optedOut;
    $('#threadInput').disabled = stopped;
    $('#threadSend').disabled = stopped;
    $('#threadInput').placeholder = stopped ? 'They replied STOP' : 'iMessage';
    const relay = ((state.texting || {}).queue || {}).relay || {};
    $('#threadNote').textContent = stopped
      ? 'They replied STOP, so nothing more can be sent to this number.'
      : relay.online ? '' : 'The Mac relay is offline — replies will queue and send when it is back.';
  }

  function whenLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today ${time}`;
    const yday = new Date(now); yday.setDate(now.getDate() - 1);
    if (d.toDateString() === yday.toDateString()) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  async function sendReply() {
    const box = $('#threadInput');
    const body = box.value.trim();
    if (!body || !openThreadId) return;
    $('#threadSend').disabled = true;
    try {
      await api('/api/texts/reply', { method: 'POST', body: { id: openThreadId, body } });
      box.value = '';
      box.style.height = '';
      // Show it immediately rather than waiting for the next poll.
      if (thread) { thread.pending = [...(thread.pending || []), { text: body }]; renderThread(); }
      await refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#threadSend').disabled = Boolean(thread && thread.optedOut);
    }
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

  function mailboxes() {
    const all = (state.candidates || []).filter((c) => c.lastEmailedAt || c.emailReplies);
    const q = mailSearch.trim().toLowerCase();
    const when = (c) => (c.emailLast && c.emailLast.ts) || c.lastReplyAt || c.lastEmailedAt || '';
    return all
      .filter((c) => (mailFilter === 'unread' ? c.emailUnread : mailFilter === 'replied' ? c.emailReplies > 0 : true))
      .filter((c) => !q || `${c.name || ''} ${c.email || ''} ${c.company || ''}`.toLowerCase().includes(q))
      .sort((a, b) => String(when(b)).localeCompare(String(when(a))));
  }

  const mailUnreadCount = () => (state.candidates || []).filter((c) => c.emailUnread).length;

  let mailShown = CONV_PAGE;
  function renderMailList() {
    const all = mailboxes();
    const rows = convPage(all, mailShown, openMailId);
    const n = mailUnreadCount();
    $('#mailUnreadN').textContent = n || '';
    $('#mailUnreadN').hidden = !n;
    $$('[data-mail-tab]').forEach((b) => b.classList.toggle('on', b.dataset.mailTab === mailFilter));
    const el = $('#mailList');
    keepingScroll(el, () => { el.innerHTML = rows.length
      ? rows.map((c) => {
          const last = c.emailLast;
          const ts = (last && last.ts) || c.lastReplyAt || c.lastEmailedAt || '';
          const preview = last ? last.text : c.lastSubject || 'Sent, no reply yet';
          return `<li><button class="conv${c.id === openMailId ? ' on' : ''}${c.emailUnread ? ' unread' : ''}" data-mail="${esc(c.id)}">
            <span class="avatar">${esc(convInitials(c.name, c.email))}</span>
            <span class="conv-main">
              <span class="conv-top"><span class="conv-name">${esc(c.name || c.email || 'Unknown')}</span><span class="conv-when">${ts ? timeAgo(ts) : ''}</span></span>
              <span class="conv-last">${last ? '' : '<span class="conv-you">You:</span> '}${esc(preview)}</span>
            </span>
            ${c.emailBounced && !c.emailReplies ? '<span class="conv-flag" title="Bounced">!</span>' : ''}
            ${c.emailUnread ? '<span class="conv-dot"></span>' : ''}
          </button></li>`;
        }).join('') + moreRow(all.length - rows.length)
      : `<li class="conv-none">${mailFilter === 'unread' ? 'Nothing unread.' : mailFilter === 'replied' ? 'Nobody has replied by email yet.' : mailSearch ? 'No conversation matches that.' : 'Nothing emailed yet.'}</li>`; });
  }

  async function openMail(id, { markSeen = true, quiet = false } = {}) {
    openMailId = id;
    mailLoading = true;
    if (!quiet) pushThread('template');
    renderMailList();
    $('#mailEmpty').hidden = true;
    $('#mailLive').hidden = false;
    if (!quiet) $('#mailBody').innerHTML = '<p class="thread-loading">Reading the conversation from Gmail…</p>';
    try {
      mail = await api(`/api/emails/thread?id=${encodeURIComponent(id)}`);
    } catch (e) {
      mailLoading = false;
      if (quiet) return;
      mail = null;
      $('#mailBody').innerHTML = `<p class="thread-loading">${esc(e.message)}</p>`;
      return;
    }
    mailLoading = false;
    renderMail();
    if (markSeen) {
      const c = (state.candidates || []).find((x) => x.id === id);
      if (c && c.emailUnread) {
        c.emailUnread = false;
        renderMailList(); renderBell();
        api('/api/emails/seen', { method: 'POST', body: { id } }).catch(() => {});
      }
    }
  }

  function renderMail() {
    if (!mail) return;
    $('#mailAvatar').textContent = convInitials(mail.name, mail.email);
    $('#mailName').textContent = mail.name || mail.email || 'Unknown';
    $('#mailSub').textContent = [mail.email, mail.role, mail.company].filter(Boolean).join(' · ');
    const gm = $('#mailGmail');
    gm.hidden = !mail.gmailUrl;
    if (mail.gmailUrl) gm.href = mail.gmailUrl;

    if (mail.unavailable) {
      $('#mailBody').innerHTML = `<p class="thread-loading">${esc(mail.unavailable)}</p>`;
    } else {
      $('#mailBody').innerHTML = (mail.messages || []).length
        ? mail.messages.map((m, i) => {
            const prev = mail.messages[i - 1];
            const gap = !prev || (m.date && prev.date && new Date(m.date) - new Date(prev.date) > 60 * 60 * 1000);
            const stamp = gap && m.date ? `<div class="thread-stamp">${esc(whenLabel(m.date))}</div>` : '';
            const text = m.text || m.snippet || '';
            // A bounce is the mail system talking, not the candidate, so it is
            // marked rather than dressed up as a reply.
            const tag = m.kind === 'bounce' ? '<span class="msg-tag bad">Bounce</span>'
              : m.kind === 'auto' ? '<span class="msg-tag">Auto-reply</span>' : '';
            return `${stamp}<div class="msg ${m.dir === 'out' ? 'out' : 'in'}${m.kind ? ' machine' : ''}">
              <div class="bubble">${esc(text)}${mail.limited && !m.text ? '<span class="msg-clip"> …</span>' : ''}</div>
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

  async function sendMailReply() {
    const box = $('#mailInput');
    const body = box.value.trim();
    if (!body || !openMailId) return;
    $('#mailSend').disabled = true;
    try {
      await api('/api/emails/reply', { method: 'POST', body: { id: openMailId, body } });
      box.value = '';
      box.style.height = '';
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
    }, renderMailList);
    $('#mailCompose').addEventListener('submit', (e) => { e.preventDefault(); sendMailReply(); });
    // An email is long-form, so Enter makes a paragraph and Cmd/Ctrl-Enter sends.
    $('#mailInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMailReply(); }
    });
    $('#mailInput').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
    });
    $('#mailOpenCandidate').addEventListener('click', () => { if (openMailId) openCandidate(openMailId); });
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
      row.appendChild(b);
    });
  }

  // One bell for both channels. Two would mean deciding which to look at, and
  // a reply is a reply whichever way it arrived.
  const allUnread = () => unreadCount() + mailUnreadCount();

  // null until the first render, so a page load with unread waiting does not
  // read as something having just arrived.
  let lastBellCount = null;

  function renderBell() {
    const n = allUnread();
    const arrived = lastBellCount !== null && n > lastBellCount;
    lastBellCount = n;
    $$('.bell').forEach((b) => {
      const dot = b.querySelector('.bell-n');
      dot.textContent = n > 9 ? '9+' : String(n);
      dot.hidden = !n;
      b.classList.toggle('lit', Boolean(n));
      if (arrived) {
        // Restart the animation even if it is already running: two replies a
        // second apart should ring twice, not once.
        b.classList.remove('ring');
        void b.offsetWidth;
        b.classList.add('ring');
      }
    });
    if (!$('#bellPanel').hidden) renderBellPanel();
  }

  // One entry per unanswered conversation, not per person: someone who
  // answered both the text and the email is two things to read, not one.
  function bellItems() {
    const out = [];
    for (const c of state.candidates || []) {
      if (c.textLast && c.textLast.dir === 'in') {
        out.push({ c, ch: 'text', ts: c.textLast.ts, text: c.textLast.text, unread: Boolean(c.textUnread), who: c.name || textPhoneOf(c) || 'Unknown' });
      }
      if (c.emailLast) {
        out.push({ c, ch: 'email', ts: c.emailLast.ts, text: c.emailLast.text, unread: Boolean(c.emailUnread), who: c.name || c.email || 'Unknown' });
      }
    }
    return out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  }

  function renderBellPanel() {
    const items = bellItems();
    const unread = items.filter((i) => i.unread);
    const recent = items.filter((i) => !i.unread).slice(0, 6);
    const row = (i) => `<button class="bell-row${i.unread ? ' new' : ''}" data-bell-open="${esc(i.c.id)}" data-bell-ch="${i.ch}">
        <span class="avatar">${esc(convInitials(i.c.name, i.ch === 'text' ? i.c.phone : i.c.email))}</span>
        <span class="bell-main">
          <span class="bell-top"><span class="bell-name">${esc(i.who)}</span><span class="bell-when">${i.ts ? timeAgo(i.ts) : ''}</span></span>
          <span class="bell-text">${esc(i.text || '')}</span>
        </span>
        <span class="act-tag ch-${i.ch === 'text' ? 'text' : 'email'}">${i.ch === 'text' ? 'Text' : 'Email'}</span>
      </button>`;
    $('#bellBody').innerHTML = unread.length || recent.length
      ? `${unread.length ? `<div class="bell-sec">New</div>${unread.map(row).join('')}` : ''}
         ${recent.length ? `<div class="bell-sec">Earlier</div>${recent.map(row).join('')}` : ''}`
      : '<p class="bell-none">No replies yet. When someone writes back — by text or by email — it lands here.</p>';
    $('#bellClear').hidden = !unread.length;
  }

  function toggleBell(force) {
    const panel = $('#bellPanel');
    const show = force !== undefined ? force : panel.hidden;
    panel.hidden = !show;
    if (show) renderBellPanel();
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
    }, renderConvList);
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
    });
    $('#threadOpenCandidate').addEventListener('click', () => { if (openThreadId) openCandidate(openThreadId); });

    $('#bellPanel').addEventListener('click', (e) => {
      const r = e.target.closest('[data-bell-open]');
      if (!r) return;
      toggleBell(false);
      if (r.dataset.bellCh === 'email') { show('template'); openMail(r.dataset.bellOpen); }
      else { show('texting'); openThread(r.dataset.bellOpen); }
    });
    $('#bellClear').addEventListener('click', async () => {
      (state.candidates || []).forEach((c) => { c.textUnread = false; c.emailUnread = false; });
      renderBell(); renderConvList(); renderMailList();
      try {
        await api('/api/texts/seen', { method: 'POST', body: { all: true } });
        await api('/api/emails/seen', { method: 'POST', body: { all: true } });
      } catch {}
    });
    document.addEventListener('click', (e) => {
      if ($('#bellPanel').hidden) return;
      if (e.target.closest('#bellPanel') || e.target.closest('.bell')) return;
      toggleBell(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleBell(false); });
  }

  function renderTexting() {
    const t = state.texting || {};
    const q = t.queue || {};
    // The funnel strip that used to sit here said exactly what the dashboard's
    // Channels card says, on a page that is now only conversations.
    const n = textableIds().length;
    setNavCount('#navTextCount', n || 0);
    const btn = $('#textSendAllBtn');
    btn.textContent = n ? `Text ${n} with a number` : 'Nobody left to text';
    btn.disabled = n === 0;

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
    $('#textStopBtn').hidden = !q.active;
    if (!visible) return;
    const total = q.total || (q.pending + q.sent);
    $('#textSendingFill').style.width = `${total ? Math.round((q.sent / total) * 100) : 100}%`;
    $('#textSendingBadge').textContent = q.active ? `${q.sent} of ${total} sent` : `finished · ${q.sent} sent`;
    const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

  function renderSettings() {
    renderBackups();
    renderTeamSettings();
    if (!teamsRefreshedAt || Date.now() - teamsRefreshedAt > 30000) {
      teamsRefreshedAt = Date.now();
      loadTeams().then(renderTeamSettings).catch(() => {});
    }
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
  let askedForUpdate = false;
  let updateTaken = false;
  let reloadingForUpdate = false;
  const openedAt = Date.now();

  // Is anything on screen that a reload would throw away? A send part-way
  // through, a dialog, a half-written message, an edit not yet saved.
  function somethingInFlight() {
    if (!state) return true;                              // nothing known yet
    if (importRunning) return true;
    if (state.queue && state.queue.active) return true;
    if (state.texting && state.texting.queue && state.texting.queue.active) return true;
    if ($('.modal-backdrop:not([hidden])')) return true;
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
    updateTaken = true;
    askedForUpdate = true;
    updateReady.postMessage('SKIP_WAITING');
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#reloadForUpdate')) return;
    if (!updateReady) { location.reload(); return; }
    // The page reloads from the controllerchange below, once the new worker
    // has actually taken over — not here, or it would reload into the old one.
    askedForUpdate = true;
    updateTaken = true;
    updateReady.postMessage('SKIP_WAITING');
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
            updateReady = worker;
            if (state) renderNotices();
            takeUpdate('launch');
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
        if (!askedForUpdate || reloadingForUpdate) return;
        reloadingForUpdate = true;
        location.reload();
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
    m.classList.add('thread-open');
    history.pushState({ view, thread: true }, '', location.hash || `#${view}`);
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
  phoneQuery.addEventListener('change', () => { syncThreadStack(threadIsOpen() && onPhone()); placeAccountControls(); });

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
  // A Home Screen app has no reload button and no address bar, so the only
  // way to ask "is that really all of it?" is to wait out the poll. This is
  // deliberately narrow: it only takes over the gesture when the list is
  // already at the very top and the finger is travelling down, so an ordinary
  // scroll is never intercepted.
  (function pullToRefresh() {
    const PULL = 72;
    const spinner = document.createElement('div');
    spinner.className = 'ptr';
    spinner.innerHTML = icon('reply', 20);
    let startY = 0, pulling = false, armed = false;

    mainEl.addEventListener('touchstart', (e) => {
      if (!onPhone() || mainEl.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      pulling = true;
      armed = false;
    }, { passive: true });

    mainEl.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || mainEl.scrollTop > 0) { reset(); return; }
      if (!spinner.isConnected) mainEl.prepend(spinner);
      e.preventDefault();
      const give = Math.min(dy * 0.45, PULL + 18);
      mainEl.style.transform = `translateY(${give}px)`;
      armed = give >= PULL * 0.62;
      spinner.classList.toggle('armed', armed);
    }, { passive: false });

    const finish = () => {
      if (!pulling) return;
      pulling = false;
      mainEl.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
      mainEl.style.transform = '';
      setTimeout(() => { mainEl.style.transition = ''; }, 300);
      if (!armed) { spinner.remove(); return; }
      spinner.classList.remove('armed');
      spinner.classList.add('spinning');
      poll().finally(() => {
        spinner.classList.remove('spinning');
        spinner.remove();
      });
      armed = false;
    };
    const reset = () => {
      pulling = false;
      armed = false;
      mainEl.style.transform = '';
      spinner.remove();
    };
    mainEl.addEventListener('touchend', finish, { passive: true });
    mainEl.addEventListener('touchcancel', reset, { passive: true });
  }());

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
  const VIEW_RENDERERS = {
    dashboard: [renderDashboard],
    candidates: [renderRoleFilter, renderCandidates],
    template: [renderMailList],
    texting: [renderConvList],
  };
  const staleViews = new Set();

  function renderView(view) {
    const fns = VIEW_RENDERERS[view];
    if (!fns) return;
    staleViews.delete(view);
    for (const fn of fns) fn();
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
  function renderNavCounts() {
    setNavCount('#navCount', (state.stats && state.stats.total) || 0);
    setNavCount('#navEmailCount', mailUnreadCount() || 0);
  }

  function renderAll() {
    renderNotices();
    renderApollo();
    renderTexting();
    mountTheme();
    mountTeam();
    mountBell();
    mountConnection();
    // The controls are created hidden and filled in here, because mounting
    // happens after the team is known, not before.
    renderTeamChip();
    renderBell();
    renderConnection();
    renderNavCounts();
    // These two are cheap and cross-view: the send and follow-up buttons live
    // in the Email header, the due badge in Settings, and the queue timer has
    // to keep running wherever you are. They used to ride along inside
    // renderDashboard, which meant they stopped updating once that became
    // dashboard-only.
    renderEmailAllButtons();
    scheduleQueueWork();
    // A thread left open stays live: a reply arriving while you are reading it
    // should appear, not wait for you to click away and back.
    if (openThreadId && !threadLoading) openThread(openThreadId, { markSeen: false, quiet: true });
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
    history.replaceState({ view: currentView }, '', `#${currentView}`);
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
    checkReplies();
    setInterval(checkReplies, 60000);
    syncCalendly();
    setInterval(syncCalendly, 5 * 60000);
  }

  // Ask the server to look at a few sent threads for replies; new replies
  // flip candidates to "Replied" and appear in the feed.
  let scopeHintShown = false;
  let replyTextLimited = false;
  async function checkReplies() {
    if (!signedIn || !state || !state.google.connected || document.hidden) return;
    try {
      const r = await api('/api/replies/check', { method: 'POST' });
      replyTextLimited = Boolean(r.scopeError);
      if (r.scopeError && !scopeHintShown) { scopeHintShown = true; toast(r.scopeError, true); }
      if (r.replies > 0) { await refresh(); toast(`${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'} detected.`); }
    } catch {}
  }

  (async () => {
    const boot = async () => {
      const a = await api('/api/auth/status');
      if (a.setupRequired) { $('#setupScreen').hidden = false; return; }
      knownTeams = a.teams || [];
      numericPins = Boolean(a.numericPins);
      authRequired = Boolean(a.required);
      if (a.required && !a.authed) { renderTeamPicker(); showLogin(); return; }
      setTeam(a.team);
      signedIn = true;
      await refresh();
      start();
    };
    // A blip at load used to leave the page dead until somebody noticed and
    // reloaded it: one toast, no polling started, no retry. Keep trying.
    const attempt = async (first) => {
      try {
        await boot();
        if (pollFails) { pollFails = 0; renderConnection(); }
      } catch (err) {
        if (err.message === 'Please sign in.' || err.message === 'Set APP_PASSWORD first.') return;
        if (first) oops(err);
        mountConnection();
        pollFails += 1;
        renderConnection();
        setTimeout(() => attempt(false), Math.min(5000 * pollFails, 30000));
      }
    };
    attempt(true);
  })();
})();
