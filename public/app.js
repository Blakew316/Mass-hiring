/* Wholesale Payments · Hiring CRM — frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let state = null;            // last /api/state payload
  let selected = new Set();    // selected candidate ids
  let filter = 'all';
  let search = '';
  let roleFilter = '';          // exact current role someone holds, '' = every role
  let sortBy = 'default';       // 'texting' = the order to work down at 60/day
  let candView = 'overview';    // 'overview' = pick a group; 'list' = the focused table
  let industryFilter = '';
  let addedFilter = '';
  let textedFilter = '';
  let rankFilter = '';
  let feedChannel = readFeedChannel();  // 'all' | 'email' | 'text'
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

  // ---------------- Sign-in ----------------
  function showLogin() {
    $('#loginScreen').hidden = false;
    setTimeout(() => $('#loginPassword').focus(), 50);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#loginPassword').value } });
      $('#loginPassword').value = '';
      $('#loginScreen').hidden = true;
      await refresh();
      start();
    } catch (err) {
      $('#loginError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#signOutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // Persistence / security warnings that must not be missable.
  function renderNotices() {
    const n = [];
    if (state.storage && !state.storage.persistent) {
      n.push(`<div class="notice danger"><span class="notice-ico">${icon('alert', 16)}</span><div><strong>Your data is not being saved permanently.</strong> Netlify Blobs is unavailable${state.storage.error ? ` (${esc(state.storage.error)})` : ''}, so settings and candidates will be lost on the next deploy or restart. Check that Blobs is enabled for this site in Netlify, then redeploy.</div></div>`);
    }
    if (state.storage && state.storage.deployed && state.auth && !state.auth.required) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('lock', 16)}</span><div><strong>This dashboard is public.</strong> Anyone with the URL could send email from your account. Add an environment variable named <code>APP_PASSWORD</code> in Netlify (Project configuration → Environment variables), then redeploy to require a sign-in.</div></div>`);
    }
    if (state.lastError) {
      n.push(`<div class="notice warn"><span class="notice-ico">${icon('alert', 16)}</span><div>${esc(state.lastError)}</div></div>`);
    }
    $('#notices').innerHTML = n.join('');
    $('#signOutBtn').hidden = !(state.auth && state.auth.required);
  }

  async function refresh() {
    state = await api('/api/state');
    renderAll();
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
  function show(view) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    if (view === 'template') renderTemplatePreview();
    if (view === 'texting') { renderTexting(); loadRelayToken(); }
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) show(go.dataset.goto);
    const chip = e.target.closest('[data-feed]');
    if (chip) {
      feedChannel = chip.dataset.feed;
      try { localStorage.setItem('feedChannel', feedChannel); } catch {}
      renderFeed();
    }
  });

  // ---------------- Dashboard ----------------
  function renderDashboard() {
    const s = state.stats;
    const all = state.candidates;
    const textCount = (fn) => all.filter(fn).length;
    const t = {
      sent: textCount((c) => ['sent', 'delivered', 'read', 'replied'].includes(c.textStatus)),
      delivered: textCount((c) => ['delivered', 'read', 'replied'].includes(c.textStatus)),
      read: textCount((c) => ['read', 'replied'].includes(c.textStatus)),
      replied: textCount((c) => c.textStatus === 'replied'),
      dead: textCount((c) => c.textStatus === 'not-imessage'),
    };
    const emailOpened = textCount((c) => Boolean(c.openedAt));
    const contacted = textCount((c) => Boolean(c.lastEmailedAt) || Boolean(c.lastTextedAt));

    $('#statTotal').textContent = s.total;
    $('#statEmailed').textContent = contacted;
    $('#statReplied').textContent = s.replied;
    // Both tiles used to be email-only, which made texting invisible on the
    // page people actually look at.
    $('#statContactedSplit').textContent = `${s.emailed.toLocaleString()} emailed · ${t.sent.toLocaleString()} texted`;
    $('#statRepliedSplit').textContent = `${t.replied.toLocaleString()} by text`;
    $('#statBooked').textContent = state.calendly && state.calendly.syncEnabled ? upcomingInterviews().length : s.booked;
    $('#navCount').textContent = s.total || '';
    renderEmailAllButtons();
    renderSendingCard();
    scheduleQueueWork();

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
        <div class="pipe-count">${n}</div>
      </div>`).join('');

    renderChannels(t, emailOpened, s);
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
      ['Personalize your default email template', true, 'template'],
    ];
    const allDone = items.every(([, d]) => d);
    $('#setupCard').hidden = allDone;
    $('#setupList').innerHTML = items.map(([label, done, goto]) => `
      <li><span class="setup-check ${done ? 'done' : 'todo'}">${done ? icon('check', 11) : ''}</span>
        <span>${label}</span>
        ${done ? '' : `<button class="btn link" data-goto="${goto}">Set up ${icon('chevron', 13)}</button>`}
      </li>`).join('');
  }

  function contactedCount() {
    const s = state.stats;
    return s.emailed + s.replied + s.booked + s.declined + (s.bounced || 0);
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
      $$('#filterChips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.filter === 'all'));
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
      const realReplies = (c) => (c.replies || []).filter((r) => !r.kind);
      const cs = state.candidates.filter((c) => c.status === 'replied').sort((a, b) => String(b.lastReplyAt || b.repliedAt || '').localeCompare(String(a.lastReplyAt || a.repliedAt || '')));
      $('#tileTitle').textContent = `Replied (${cs.length})`;
      $('#tileSub').textContent = 'Real replies only — bounces and automatic replies are filtered out. Change a status here once you have followed up.';
      rows = cs.map((c) => {
        const reps = realReplies(c);
        const last = reps.slice(-1)[0];
        const text = last ? (last.text || last.snippet || '') : '';
        const quote = text
          ? `<blockquote class="reply-quote">${esc(text)}</blockquote>`
          : `<blockquote class="reply-quote muted-quote">${replyTextLimited
              ? 'Reply text can’t be read with the current Google permissions — Settings → Google → Reconnect and tick every box.'
              : 'Reply text hasn’t been captured yet — it fills in automatically within a minute or two. Use “Open in Gmail” to read it now.'}</blockquote>`;
        const when = c.lastReplyAt || c.repliedAt;
        return candRow(c, `Replied ${when ? timeAgo(when) : ''}${reps.length > 1 ? ` · ${reps.length} messages` : ''}`,
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
    $('#tileModal').hidden = false;
  }
  $$('.stat-card[data-tile]').forEach((card) => {
    card.addEventListener('click', () => openTile(card.dataset.tile));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTile(card.dataset.tile); } });
  });
  // Link an unmatched Calendly booking to a candidate: inline search, click to link.
  $('#tileActions').addEventListener('click', (e) => {
    if (e.target.closest('#tileFollowUpBtn')) { $('#tileModal').hidden = true; openCompose(followUpDueIds(), null, { followUp: true }); }
  });
  $('#tileList').addEventListener('click', (e) => {
    const fu = e.target.closest('.tile-followup');
    if (fu) { $('#tileModal').hidden = true; openCompose([fu.dataset.id], null, { followUp: true }); return; }
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
    if (!state || !state.calendly || !state.calendly.syncEnabled || document.hidden) return;
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
  function renderChannels(t, emailOpened, s) {
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
      ['Sent', s.emailed, 'var(--blue)', ''],
      ['Opened', emailOpened, 'var(--mint)'],
      ['Replied', s.replied, 'var(--green)'],
      ['Booked', s.booked, '#23a55a'],
      ['Bounced', s.bounced || 0, 'var(--amber)'],
    ], s.emailed);

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
      const v = localStorage.getItem('feedChannel');
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
    $('#sendCountBadge').textContent = n ? `${n} to send` : 'nothing to send';
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
    return state.candidates.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (roleFilter === '__none' && roleKey(c.role)) return false;
      if (!matchesFilters(c)) return false;
      if (!q) return true;
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
    sel.innerHTML = `<option value="">All roles (${state.candidates.length})</option>`
      + roles.map(([key, r]) => `<option value="${esc(key)}">${esc(r.label)} (${r.n})</option>`).join('')
      + (missing ? `<option value="__none">No role on file (${missing})</option>` : '');
    sel.value = roleFilter;
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
  function openSegment(patch, { label = '' } = {}) {
    // Every group is a fresh start, not a narrowing of whatever was last set.
    filter = 'all'; industryFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; roleFilter = '';
    if (patch.status !== undefined) filter = patch.status;
    if (patch.industry !== undefined) industryFilter = patch.industry;
    if (patch.added !== undefined) addedFilter = patch.added;
    if (patch.texted !== undefined) textedFilter = patch.texted;
    if (patch.rank !== undefined) rankFilter = patch.rank;
    if (patch.sort !== undefined) sortBy = patch.sort;
    search = '';
    selected.clear();
    candView = 'list';
    syncFilterControls();
    renderCandidates();
    if (label) toast(`Showing ${label}.`);
  }

  function syncFilterControls() {
    $('#industryFilter').value = industryFilter;
    $('#addedFilter').value = addedFilter;
    $('#textedFilter').value = textedFilter;
    $('#rankFilter').value = rankFilter;
    $('#sortBy').value = sortBy;
    $('#searchInput').value = search;
    $$('#filterChips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.filter === filter));
  }

  function renderSegments() {
    if (!state.candidates.length) return;
    const all = state.candidates;
    const pri = (state.texting && state.texting.priority) || { order: {} };
    const ranked = Object.keys(pri.order || {}).length;
    const card = (label, n, patch, ico = 'users', tone = 'navy') => ({ label, n, patch, ico, tone });

    // Each tile carries an icon and a colour so the groups are distinguishable
    // at a glance and read as something to press, rather than as white panels
    // on a white page.
    const cards = (el, items) => {
      $(el).innerHTML = items.filter((i) => i.n > 0).map((i) => `
        <button class="segment tone-${i.tone}" data-seg='${esc(JSON.stringify(i.patch))}' data-label="${esc(i.label)}">
          <span class="segment-ico">${icon(i.ico, 16)}</span>
          <span class="segment-n">${i.n.toLocaleString()}</span>
          <span class="segment-label">${esc(i.label)}</span>
        </button>`).join('') || '<p class="muted">Nothing here yet.</p>';
    };

    const count = (fn) => all.filter(fn).length;

    cards('#segStart', [
      card('Everyone', all.length, {}, 'users', 'navy'),
      card('Best to text next', Math.min(ranked, 50), { rank: '50', sort: 'texting' }, 'send', 'blue'),
      card('Replied to you', count((c) => c.status === 'replied'), { status: 'replied' }, 'reply', 'mint'),
      card('Interviews booked', count((c) => c.status === 'booked'), { status: 'booked' }, 'calendar', 'green'),
      card('Ready to text', ranked, { texted: 'ready', sort: 'texting' }, 'bubble', 'blue'),
      card('Never contacted', count((c) => c.status === 'new'), { status: 'new' }, 'circle', 'navy'),
      card('Missing a phone number', count((c) => !textPhoneOf(c)), { texted: 'nonumber' }, 'alert', 'amber'),
    ]);

    const byIndustry = {};
    for (const c of all) { const k = c.industry || 'other'; byIndustry[k] = (byIndustry[k] || 0) + 1; }
    // A fixed colour per industry, so the same pool looks the same every visit.
    // Each industry gets its own colour and its own icon, so the row reads as
    // a set of places people come from rather than a row of identical boxes.
    const INDUSTRY_TONE = {
      payments: 'blue', solar: 'amber', security: 'navy', pest: 'green', timeshare: 'mint',
      auto: 'blue', home: 'amber', telecom: 'navy', insurance: 'green', smb: 'mint', b2b: 'navy', weak: 'navy', other: 'navy',
    };
    const INDUSTRY_ICO = {
      payments: 'card', solar: 'sun', security: 'shield', pest: 'bug', timeshare: 'key',
      auto: 'car', home: 'home', telecom: 'wifi', insurance: 'umbrella', smb: 'store',
      b2b: 'briefcase', weak: 'users', other: 'grid',
    };
    cards('#segIndustry', Object.entries(byIndustry)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => card(industryLabel(code), n, { industry: code }, INDUSTRY_ICO[code] || 'grid', INDUSTRY_TONE[code] || 'navy')));

    // Stage tiles borrow the colours the status badges already use everywhere
    // else, so a stage means the same colour wherever it appears.
    const STAGE_TONE = { new: 'navy', emailed: 'blue', replied: 'mint', booked: 'green', declined: 'red', bounced: 'amber' };
    const STAGE_ICO = { new: 'circle', emailed: 'mail', replied: 'reply', booked: 'calendar', declined: 'xcircle', bounced: 'alert' };
    cards('#segStage', Object.entries(STATUS)
      .map(([k, v]) => card(v.label, count((c) => c.status === k), { status: k }, STAGE_ICO[k] || 'circle', STAGE_TONE[k] || 'navy')));

    cards('#segAdded', [
      card('Today', count((c) => daysSince(c.addedAt) <= 1), { added: '1', sort: 'newest' }, 'calendar', 'green'),
      card('This week', count((c) => daysSince(c.addedAt) <= 7), { added: '7', sort: 'newest' }, 'calendar', 'mint'),
      card('This month', count((c) => daysSince(c.addedAt) <= 30), { added: '30', sort: 'newest' }, 'calendar', 'blue'),
      card('Last 90 days', count((c) => daysSince(c.addedAt) <= 90), { added: '90', sort: 'newest' }, 'calendar', 'navy'),
      card('Older than 90 days', count((c) => daysSince(c.addedAt) > 90), { added: 'old' }, 'calendar', 'navy'),
    ]);

    cards('#segTexting', [
      card('Texted today', count((c) => daysSince(c.lastTextedAt) <= 1), { texted: '1' }, 'send', 'blue'),
      card('Texted this week', count((c) => daysSince(c.lastTextedAt) <= 7), { texted: '7' }, 'send', 'blue'),
      card('Texted at some point', count((c) => Boolean(c.lastTextedAt)), { texted: 'any' }, 'bubble', 'navy'),
      card('Replied to a text', count((c) => c.textStatus === 'replied'), { texted: 'any' }, 'reply', 'green'),
      card('Read your text', count((c) => c.textStatus === 'read'), { texted: 'any' }, 'eye', 'mint'),
      card('No iMessage account', count((c) => c.textStatus === 'not-imessage'), { texted: 'any' }, 'xcircle', 'amber'),
      card('Never texted', count((c) => !c.lastTextedAt && textPhoneOf(c)), { texted: 'never' }, 'circle', 'navy'),
    ]);

    // The industry menu in the focused view mirrors what actually exists.
    const sel = $('#industryFilter');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Any industry</option>' + Object.entries(byIndustry)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `<option value="${esc(code)}">${esc(industryLabel(code))} (${n})</option>`).join('');
    sel.value = keep;
  }

  function renderActiveFilters() {
    const bits = [];
    if (filter !== 'all') bits.push([`Stage: ${(STATUS[filter] || {}).label || filter}`, () => { filter = 'all'; }]);
    if (industryFilter) bits.push([`Industry: ${industryLabel(industryFilter)}`, () => { industryFilter = ''; }]);
    if (roleFilter) bits.push([`Role: ${roleFilter}`, () => { roleFilter = ''; }]);
    if (addedFilter) bits.push([`Added: ${$('#addedFilter').selectedOptions[0].textContent}`, () => { addedFilter = ''; }]);
    if (textedFilter) bits.push([`Texting: ${$('#textedFilter').selectedOptions[0].textContent}`, () => { textedFilter = ''; }]);
    if (rankFilter) bits.push([`Ranking: ${$('#rankFilter').selectedOptions[0].textContent}`, () => { rankFilter = ''; }]);
    if (search) bits.push([`Search: “${search}”`, () => { search = ''; }]);
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

  $$('.segment-grid').forEach((grid) => grid.addEventListener('click', (e) => {
    const b = e.target.closest('.segment');
    if (!b) return;
    openSegment(JSON.parse(b.dataset.seg), { label: b.dataset.label.toLowerCase() });
  }));

  $('#backToOverview').addEventListener('click', () => {
    candView = 'overview';
    selected.clear();
    renderCandidates();
  });

  $('#overviewSearch').addEventListener('input', (e) => {
    const v = e.target.value;
    if (!v.trim()) return;
    search = v;
    candView = 'list';
    syncFilterControls();
    renderCandidates();
    setTimeout(() => { const el = $('#searchInput'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 30);
    e.target.value = '';
  });

  for (const [id, set] of [['#industryFilter', (v) => { industryFilter = v; }], ['#addedFilter', (v) => { addedFilter = v; }],
    ['#textedFilter', (v) => { textedFilter = v; }], ['#rankFilter', (v) => { rankFilter = v; }]]) {
    $(id).addEventListener('change', (e) => { set(e.target.value); selected.clear(); renderCandidates(); });
  }

  function renderCandidates() {
    const hasPeople = state.candidates.length > 0;
    const overview = candView === 'overview' && hasPeople;
    $('#candOverview').hidden = !overview;
    $('#candList').hidden = overview || !hasPeople;
    $('#candTableWrap').hidden = overview;
    if (overview) {
      renderSegments();
      $('#candidatesEmpty').style.display = 'none';
      return;
    }

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
    const tbody = $('#candidateRows');
    $('#candidatesEmpty').style.display = state.candidates.length ? 'none' : 'block';
    tbody.innerHTML = rows.map((c, i) => {
      const st = STATUS[c.status] || STATUS.new;
      const displayName = c.name || `${c.firstName} ${c.lastName}`.trim() || '—';
      const pri = ranking ? textPriorityOf(c.id) : null;
      const blockedWhy = ranking ? textBlockedOf(c.id) : '';
      return `<tr data-id="${c.id}"${ranking && !pri ? ' class="row-muted"' : ''}>
        ${ranking ? `<td class="col-rank">${pri ? pri.rank : '<span class="muted">—</span>'}</td>` : ''}
        <td class="col-check"><input type="checkbox" class="row-check" ${selected.has(c.id) ? 'checked' : ''}></td>
        <td><div class="name-cell">
          <span class="avatar ${AVATAR_TINTS[i % AVATAR_TINTS.length]}">${esc(initials(c))}</span>
          <div><div class="cand-name">${esc(displayName)}</div>
          ${pri ? `<div class="cand-sub why-text">${esc(pri.reason)}</div>`
            : blockedWhy ? `<div class="cand-sub muted">not texting: ${esc(blockedWhy)}</div>`
            : (c.location || c.notes) ? `<div class="cand-sub">${esc([c.location, c.notes].filter(Boolean).join(' · '))}</div>` : ''}</div>
        </div></td>
        <td>${esc(c.email)}</td>
        <td>${textCell(c)}</td>
        <td>${esc(c.role) || '<span class="muted">—</span>'}${c.pastRoles ? `<div class="cand-sub" title="${esc(c.pastRoles)}">was ${esc(String(c.pastRoles).split('|')[0].trim())}${String(c.pastRoles).split('|').length > 1 ? ` +${String(c.pastRoles).split('|').length - 1} more` : ''}</div>` : ''}</td>
        <td>${esc(c.company) || '<span class="muted">—</span>'}</td>
        <td><select class="status-select ${st.cls}" title="Change status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></td>
        <td>${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : '<span class="muted">never</span>'}</td>
        <td><div class="row-actions">
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
    $('#checkAll').checked = rows.length > 0 && rows.every((c) => selected.has(c.id));
    const empty = $('#candidatesEmpty');
    if (!rows.length && state.candidates.length) {
      empty.style.display = 'block';
      empty.innerHTML = `<h3>Nobody matches those filters</h3>
        <p>${state.candidates.length.toLocaleString()} people are in the list — none of them fit this combination.</p>
        <button class="btn btn-primary" id="emptyClear">Clear the filters</button>`;
      const btn = $('#emptyClear');
      if (btn) btn.addEventListener('click', () => {
        filter = 'all'; industryFilter = ''; roleFilter = ''; addedFilter = ''; textedFilter = ''; rankFilter = ''; search = '';
        syncFilterControls(); renderCandidates();
      });
    }
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
    const rows = visibleCandidates();
    rows.forEach((c) => (e.target.checked ? selected.add(c.id) : selected.delete(c.id)));
    renderCandidates();
  });
  $('#searchInput').addEventListener('input', (e) => { search = e.target.value; renderCandidates(); });
  // Arriving on the tab starts at the overview; it is a landing page, not a
  // filter that persists from whatever was last looked at.
  $$('.nav-item[data-view="candidates"]').forEach((b) => b.addEventListener('click', () => {
    if (candView === 'list' && !search && filter === 'all' && !industryFilter && !addedFilter && !textedFilter && !rankFilter) {
      candView = 'overview'; renderCandidates();
    }
  }));
  $('#roleFilter').addEventListener('change', (e) => { roleFilter = e.target.value; selected.clear(); renderCandidates(); });
  $('#sortBy').addEventListener('change', (e) => { sortBy = e.target.value; renderCandidates(); });
  $('#filterChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    $$('#filterChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
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
  $('#candEmailAllBtn').addEventListener('click', () => openCompose(uncontactedIds()));
  $('#dashEmailAllBtn').addEventListener('click', () => openCompose(uncontactedIds()));
  $$('.follow-up-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.id === 'tplFollowUpBtn' && followUpDirty) return;   // that button sends the unsaved draft (handled below)
    openCompose(followUpDueIds(), null, { followUp: true });
  }));
  // From the template page, send exactly what's in the editor (saved or not).
  $('#tplSendAllBtn').addEventListener('click', () =>
    openCompose(uncontactedIds(), { subject: $('#tplSubject').value, body: $('#tplBody').value }));

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
    $('#addModal').hidden = false;
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
      $('#addModal').hidden = true;
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
    $('#composeModal').hidden = false;
  }
  let queueMode = false;

  $('#composeCancelBtn').addEventListener('click', () => { cancelSend = true; });

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
        $('#composeModal').hidden = true;
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
      if (!failed.length && !stopped) setTimeout(() => { $('#composeModal').hidden = true; }, 1000);
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
    try {
      for (let i = 0; i < rows.length; i += IMPORT_ROW_BATCH) {
        if (rows.length > IMPORT_ROW_BATCH) btn.textContent = `Importing… ${Math.min(i + IMPORT_ROW_BATCH, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`;
        const r = await api('/api/import/commit', { method: 'POST', body: {
          rows: rows.slice(i, i + IMPORT_ROW_BATCH), lines: lines.slice(i, i + IMPORT_ROW_BATCH), headerless: pendingImport.headerless,
          mapping, source: pendingImport.source, updateExisting: $('#importUpdateExisting').checked,
        }});
        for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
        done = Math.min(i + IMPORT_ROW_BATCH, rows.length);
      }
      $('#mappingCard').hidden = true;
      pendingImport = null;
      showImportResult(totals);
      await refresh();
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
    try { return new Set(JSON.parse(localStorage.getItem('apolloSeen') || '[]')); } catch { return new Set(); }
  }
  function rememberApollo(ids) {
    try {
      const all = [...apolloSeen(), ...ids].slice(-5000);
      localStorage.setItem('apolloSeen', JSON.stringify(all));
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
    el.className = `notice ${note ? 'warn' : good ? 'ok' : 'warn'}`;
    el.innerHTML = `<span class="notice-ico">${icon(good && !note ? 'checkcircle' : 'alert', 16)}</span><div>${bits.join(' · ')}` +
      (note ? `<br><span class="small">${esc(note)}</span>` : '') +
      (!note && !t.added && t.existing ? '<br><span class="small">Nothing was added because every address in the file is already in your candidate list.</span>' : '') +
      `</div><button class="btn notice-action" id="viewCandidatesBtn">View candidates</button>`;
    el.hidden = false;
    $('#viewCandidatesBtn').addEventListener('click', () => show('candidates'));
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

  // Client-side mirror of the server's placeholder fill, for live preview.
  const replaceVars = (text, vars) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? '');
  function fillClient(text, cand) {
    const s = state.settings;
    const vars = {
      firstName: firstNameOf(cand) || 'there',
      lastName: cand.lastName || '',
      fullName: cand.name || 'there',
      role: cand.role || 'professional',
      company: cand.company || '',
      email: cand.email || '',
      calendlyUrl: s.calendlyUrl || '',
    };
    // The subject this person received (or would receive), for {{originalSubject}} in follow-ups.
    vars.originalSubject = cand.lastSubject || replaceVars($('#tplSubject').value || state.template.subject, vars);
    return replaceVars(text, vars);
  }
  // Follow-ups: who is due comes from the server (same rule the queue uses).
  const followUpDueIds = () => (state && state.followUp && state.followUp.dueIds) || [];

  function renderTemplatePreview() {
    if (!state) return;
    const sel = $('#previewCandidate');
    const current = sel.value;
    sel.innerHTML = '<option value="">Sample candidate</option>' +
      state.candidates.slice(0, 50).map((c) =>
        `<option value="${c.id}">${esc(c.name || c.email)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
    const cand = state.candidates.find((c) => c.id === sel.value) || SAMPLE;
    $('#pvSubject').textContent = fillClient($('#tplSubject').value, cand);
    $('#pvFrom').textContent = state.sending.from
      ? (state.settings.fromName ? `${state.settings.fromName} <${state.sending.from}>` : state.sending.from)
      : 'your work email (set up in Settings)';
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
      toast('The Account Executive flyer is attached again.');
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
      toast(`${name} will be attached to every email.`);
      await refresh();
    } catch (err) { oops(err); }
    finally { btn.disabled = false; renderAttachments(); }
  });
  $('#attachList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.attach-remove');
    if (!btn) return;
    try {
      await api(`/api/template/attachments/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      toast('Attachment removed — emails will go out without it.');
      await refresh();
    } catch (err) { oops(err); }
  });

  let templateDirty = false;
  function setTemplateDirty(d) {
    templateDirty = d;
    $('#saveTemplateBtn').textContent = d ? 'Save template •' : 'Save template';
  }
  ['#tplSubject', '#tplBody'].forEach((s) =>
    $(s).addEventListener('input', () => { setTemplateDirty(true); debouncedPreview(); }));
  const debouncedPreview = debounce(renderTemplatePreview, 200);
  $('#previewCandidate').addEventListener('change', () => { renderTemplatePreview(); renderFollowUpPreview(); });

  $$('.token:not(.fu-token):not(.tx-token)').forEach((btn) => btn.addEventListener('click', () => {
    const ta = $('#tplBody');
    const t = btn.dataset.token;
    const start = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + t + ta.value.slice(ta.selectionEnd ?? start);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + t.length;
    setTemplateDirty(true);
    renderTemplatePreview();
  }));

  $('#saveTemplateBtn').addEventListener('click', async () => {
    try {
      await api('/api/template', { method: 'POST', body: { subject: $('#tplSubject').value, body: $('#tplBody').value } });
      setTemplateDirty(false);
      toast('Template saved — it’s now the default for all outreach.');
      await refresh();
    } catch (err) { oops(err); }
  });
  $('#resetTemplateBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/template/reset', { method: 'POST' });
      $('#tplSubject').value = r.template.subject;
      $('#tplBody').value = r.template.body;
      setTemplateDirty(false);
      renderTemplatePreview();
      toast('Template reset to default.');
    } catch (err) { oops(err); }
  });

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
    $('#fuPvSubject').textContent = fillClient($('#fuSubject').value, cand);
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
      toast('Follow-up email reset to the default.');
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
  $$('#view-settings input').forEach((el) => el.addEventListener('input', () => setSettingsDirty(true)));

  // ---------------- Text composer ----------------
  // Texting one person, or a handful, without touching the saved template.
  // Queued rather than sent on the spot: the pace, the daily cap and the
  // recipient's own clock are all decided server-side, and a text that goes
  // out the instant a button is pressed would defeat all three.
  let textComposeIds = [];
  let textComposeThenEmail = null;

  function openTextCompose(ids, { thenEmail = null } = {}) {
    const people = state.candidates.filter((c) => ids.includes(c.id) && textPhoneOf(c));
    if (!people.length) {
      toast('None of those people have a phone number yet — add one from the Text column.', true);
      return;
    }
    textComposeIds = people.map((c) => c.id);
    textComposeThenEmail = thenEmail;
    $('#textComposeTitle').textContent = people.length === 1
      ? `Text ${people[0].name || prettyPhone(textPhoneOf(people[0]))}`
      : `Text ${people.length} people`;
    $('#textComposeTo').innerHTML = people.slice(0, 12).map((c) =>
      `<span class="to-chip">${esc(c.name || 'Unnamed')} <span class="muted">${esc(prettyPhone(textPhoneOf(c)))}</span></span>`).join('')
      + (people.length > 12 ? `<span class="to-chip muted">+${people.length - 12} more</span>` : '');
    $('#textComposeBody').value = (state.texting && state.texting.template && state.texting.template.body) || '';
    $('#textComposeNow').checked = false;   // never sticky between sends
    $('#textComposeModal').hidden = false;
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
      $('#textComposeModal').hidden = true;
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
  function conversations() {
    const all = (state.candidates || []).filter((c) => c.textCount > 0);
    const q = convSearch.trim().toLowerCase();
    return all
      .filter((c) => (convFilter === 'unread' ? c.textUnread : true))
      .filter((c) => !q || `${c.name || ''} ${c.phone || ''} ${c.company || ''}`.toLowerCase().includes(q))
      .sort((a, b) => String((b.textLast || {}).ts || '').localeCompare(String((a.textLast || {}).ts || '')));
  }

  const unreadCount = () => (state.candidates || []).filter((c) => c.textUnread).length;

  function renderConvList() {
    const rows = conversations();
    const n = unreadCount();
    $('#convUnreadN').textContent = n || '';
    $('#convUnreadN').hidden = !n;
    $$('.conv-tab').forEach((b) => b.classList.toggle('on', b.dataset.convTab === convFilter));
    $('#convList').innerHTML = rows.length
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
        }).join('')
      : `<li class="conv-none">${convFilter === 'unread' ? 'Nothing unread.' : convSearch ? 'No conversation matches that.' : 'No conversations yet. Texts you send show up here.'}</li>`;
  }

  async function openThread(id, { markSeen = true } = {}) {
    openThreadId = id;
    threadLoading = true;
    renderConvList();
    $('#threadEmpty').hidden = true;
    $('#threadLive').hidden = false;
    $('#threadBody').innerHTML = '<p class="thread-loading">Loading…</p>';
    try {
      thread = await api(`/api/texts/thread?id=${encodeURIComponent(id)}`);
    } catch (e) {
      thread = null;
      $('#threadBody').innerHTML = `<p class="thread-loading">${esc(e.message)}</p>`;
      threadLoading = false;
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

  // ---------------- The bell ----------------
  // One button, injected into every page's header rather than copied into six
  // of them, so a reply is visible from wherever you happen to be standing.
  function mountBell() {
    $$('.head-actions').forEach((row) => {
      if (row.querySelector('.bell')) return;
      const b = document.createElement('button');
      b.className = 'bell';
      b.type = 'button';
      b.title = 'Replies';
      b.innerHTML = `${icon('bubble', 17)}<span class="bell-n" hidden></span>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
      row.appendChild(b);
    });
  }

  function renderBell() {
    const n = unreadCount();
    $$('.bell').forEach((b) => {
      const dot = b.querySelector('.bell-n');
      dot.textContent = n > 9 ? '9+' : String(n);
      dot.hidden = !n;
      b.classList.toggle('lit', Boolean(n));
    });
    if (!$('#bellPanel').hidden) renderBellPanel();
  }

  function renderBellPanel() {
    const unread = (state.candidates || [])
      .filter((c) => c.textUnread)
      .sort((a, b) => String((b.textLast || {}).ts || '').localeCompare(String((a.textLast || {}).ts || '')));
    const recent = (state.candidates || [])
      .filter((c) => !c.textUnread && c.textLast && c.textLast.dir === 'in')
      .sort((a, b) => String((b.textLast || {}).ts || '').localeCompare(String((a.textLast || {}).ts || '')))
      .slice(0, 6);
    const row = (c, isNew) => {
      const last = c.textLast || {};
      return `<button class="bell-row${isNew ? ' new' : ''}" data-bell-open="${esc(c.id)}">
        <span class="avatar">${esc(convInitials(c.name, c.phone))}</span>
        <span class="bell-main">
          <span class="bell-top"><span class="bell-name">${esc(c.name || textPhoneOf(c) || 'Unknown')}</span><span class="bell-when">${last.ts ? timeAgo(last.ts) : ''}</span></span>
          <span class="bell-text">${esc(last.text || '')}</span>
        </span>
      </button>`;
    };
    $('#bellBody').innerHTML = unread.length || recent.length
      ? `${unread.length ? `<div class="bell-sec">New</div>${unread.map((c) => row(c, true)).join('')}` : ''}
         ${recent.length ? `<div class="bell-sec">Earlier</div>${recent.map((c) => row(c, false)).join('')}` : ''}`
      : '<p class="bell-none">No replies yet. When someone texts back it lands here.</p>';
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
    $$('.conv-tab').forEach((b) => b.addEventListener('click', () => { convFilter = b.dataset.convTab; renderConvList(); }));
    $('#convSearch').addEventListener('input', (e) => { convSearch = e.target.value; renderConvList(); });
    $('#threadCompose').addEventListener('submit', (e) => { e.preventDefault(); sendReply(); });
    // Enter sends, shift-enter makes a new line — the way every messenger works.
    $('#threadInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
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
      show('texting');
      openThread(r.dataset.bellOpen);
    });
    $('#bellClear').addEventListener('click', async () => {
      (state.candidates || []).forEach((c) => { c.textUnread = false; });
      renderBell(); renderConvList();
      try { await api('/api/texts/seen', { method: 'POST', body: { all: true } }); } catch {}
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
    const by = (s) => state.candidates.filter((c) => c.textStatus === s).length;
    // Someone who replied was necessarily delivered and read, so the funnel
    // counts everyone who reached at least that step rather than exactly it.
    const atLeast = (...kinds) => state.candidates.filter((c) => kinds.includes(c.textStatus)).length;
    $('#txWithPhone').textContent = t.withPhone || 0;
    $('#txSent').textContent = atLeast('sent', 'delivered', 'read', 'replied');
    $('#txDelivered').textContent = atLeast('delivered', 'read', 'replied');
    $('#txRead').textContent = atLeast('read', 'replied');
    $('#txReplied').textContent = by('replied');

    const n = textableIds().length;
    $('#navTextCount').textContent = n ? String(n) : '';
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

    if (!textTemplateDirty && t.template) $('#txBody').value = t.template.body || '';
    for (const [id, val] of [['txDailyLimit', q.dailyLimit], ['txGapMin', q.minGap], ['txGapMax', q.maxGap], ['txStartHour', q.startHour], ['txEndHour', q.endHour]]) {
      const el = $(`#${id}`);
      if (el && document.activeElement !== el) el.value = val ?? '';
    }
    const sun = $('#txSunday');
    if (sun && document.activeElement !== sun) sun.checked = Boolean(q.sunday);
    $('#txOptOutHint').textContent = q.optOut
      ? `${q.optOut} number${q.optOut === 1 ? '' : 's'} asked to stop and will never be texted again.`
      : 'Anyone who replies STOP is blocked automatically and permanently.';

    renderTextPreview();
    renderTextSendingCard();
  }

  function renderTextPreview() {
    const body = $('#txBody').value || '';
    const who = state.candidates.find((c) => textPhoneOf(c)) || { name: 'Sam Rivera', role: 'Account Executive', company: 'Acme Payments' };
    const first = (who.firstName || (who.name || '').split(' ')[0] || 'there');
    const filled = body
      .replace(/\{\{\s*firstName\s*\}\}/g, first)
      .replace(/\{\{\s*fullName\s*\}\}/g, who.name || first)
      .replace(/\{\{\s*role\s*\}\}/g, who.role || 'professional')
      .replace(/\{\{\s*company\s*\}\}/g, who.company || '');
    const withLink = state.settings.calendlyUrl && !filled.includes(state.settings.calendlyUrl)
      ? `${filled.trim()}\n\n${state.settings.calendlyUrl}` : filled.trim();
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
    if (hidden) { input.select(); document.execCommand?.('copy'); toast('Token copied — paste it into config.json on the Mac.'); }
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

  $('#txBody').addEventListener('input', () => { textTemplateDirty = true; renderTextPreview(); });
  $$('.tx-token').forEach((b) => b.addEventListener('click', () => {
    const el = $('#txBody');
    const at = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, at) + b.dataset.txToken + el.value.slice(el.selectionEnd ?? at);
    el.focus();
    el.selectionStart = el.selectionEnd = at + b.dataset.txToken.length;
    textTemplateDirty = true;
    renderTextPreview();
  }));

  $('#txSave').addEventListener('click', async () => {
    try {
      await api('/api/texts/template', { method: 'POST', body: { body: $('#txBody').value } });
      textTemplateDirty = false;
      toast('Message saved.');
      await refresh();
    } catch (err) { oops(err); }
  });

  $('#txReset').addEventListener('click', async () => {
    try {
      const r = await api('/api/texts/template/reset', { method: 'POST' });
      $('#txBody').value = r.textTemplate.body;
      textTemplateDirty = false;
      renderTextPreview();
      toast('Message reset.');
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

  $('#textSendAllBtn').addEventListener('click', async () => {
    const ids = textableIds();
    const q = (state.texting && state.texting.queue) || {};
    if (!q.relay || !q.relay.online) {
      if (!confirm('The Mac relay is offline, so nothing will send until it is back. Queue these texts anyway?')) return;
    } else if (!confirm(`Text ${ids.length} ${ids.length === 1 ? 'person' : 'people'}? They go out one at a time, only during daytime hours where each person lives.`)) {
      return;
    }
    try {
      const r = await api('/api/texts/queue', { method: 'POST', body: { ids } });
      const skip = r.skipped || {};
      const notes = [];
      if (skip.noPhone) notes.push(`${skip.noPhone} had no usable number`);
      if (skip.optedOut) notes.push(`${skip.optedOut} asked to stop`);
      if (skip.alreadyTexted) notes.push(`${skip.alreadyTexted} were texted already`);
      toast(`${r.added} queued${notes.length ? ` · ${notes.join(', ')}` : ''}.`);
      await refresh();
    } catch (err) { oops(err); }
  });

  $('#textStopBtn').addEventListener('click', async () => {
    if (!confirm('Stop texting? Anything not yet sent is dropped from the queue.')) return;
    try { await api('/api/texts/queue', { method: 'DELETE' }); toast('Texting stopped.'); await refresh(); } catch (err) { oops(err); }
  });

  $('#textRetryBtn').addEventListener('click', async () => {
    try { const r = await api('/api/texts/queue/retry-failed', { method: 'POST' }); toast(`${r.requeued} re-queued.`); await refresh(); } catch (err) { oops(err); }
  });

  function renderSettings() {
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
      $('#connText').title = `Sending as ${name} <${state.sending.from}>`;
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
  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop:not([hidden])').forEach((m) => { m.hidden = true; });
  });

  // ---------------- Boot ----------------
  function renderAll() {
    renderNotices();
    renderDashboard();
    renderRoleFilter();
    renderCandidates();
    renderApollo();
    renderTexting();
    mountBell();
    renderBell();
    renderConvList();
    // A thread left open stays live: a reply arriving while you are reading it
    // should appear, not wait for you to click away and back.
    if (openThreadId && !threadLoading) openThread(openThreadId, { markSeen: false });
    renderSettings();
    // Only prime the template editor when there are no unsaved edits.
    if (!templateDirty) {
      $('#tplSubject').value = state.template.subject;
      $('#tplBody').value = state.template.body;
    }
    renderAttachments();
    renderTemplatePreview();
    renderFollowUpEditor();
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
    syncTimeZone();
    const hash = location.hash.replace('#', '');
    if (hash) {
      const [view, query] = hash.split('?');
      if ($(`#view-${view}`)) show(view);
      const params = new URLSearchParams(query || '');
      if (params.get('connected')) toast('Google connected — you can now import private sheets and send Gmail.');
      if (params.get('error')) toast(`Google sign-in problem: ${params.get('error')}`, true);
      history.replaceState(null, '', location.pathname);
    }
    setInterval(() => refresh().catch(() => {}), 30000);
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
    if (!state || !state.google.connected || document.hidden) return;
    try {
      const r = await api('/api/replies/check', { method: 'POST' });
      replyTextLimited = Boolean(r.scopeError);
      if (r.scopeError && !scopeHintShown) { scopeHintShown = true; toast(r.scopeError, true); }
      if (r.replies > 0) { await refresh(); toast(`${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'} detected.`); }
    } catch {}
  }

  (async () => {
    try {
      const a = await api('/api/auth/status');
      if (a.setupRequired) { $('#setupScreen').hidden = false; return; }
      if (a.required && !a.authed) { showLogin(); return; }
      await refresh();
      start();
    } catch (err) {
      if (err.message !== 'Please sign in.' && err.message !== 'Set APP_PASSWORD first.') oops(err);
    }
  })();
})();
