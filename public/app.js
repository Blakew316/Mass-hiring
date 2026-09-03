/* Wholesale Payments · Hiring CRM — frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let state = null;            // last /api/state payload
  let selected = new Set();    // selected candidate ids
  let filter = 'all';
  let search = '';
  let pendingImport = null;    // {headers, rows, mapping, source}
  let composeIds = [];

  const STATUS = {
    new:      { label: 'Not contacted', cls: 'tint-navy' },
    emailed:  { label: 'Emailed',       cls: 'tint-blue' },
    replied:  { label: 'Replied',       cls: 'tint-mint' },
    booked:   { label: 'Booked',        cls: 'tint-green' },
    declined: { label: 'Not interested',cls: 'tint-red' },
  };
  const AVATAR_TINTS = ['tint-blue', 'tint-green', 'tint-mint', 'tint-navy'];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- API ----------------
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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) show(go.dataset.goto);
  });

  // ---------------- Dashboard ----------------
  function renderDashboard() {
    const s = state.stats;
    $('#statTotal').textContent = s.total;
    $('#statEmailed').textContent = contactedCount();
    $('#statReplied').textContent = s.replied;
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
    ];
    const max = Math.max(1, ...steps.map(([, n]) => n));
    $('#pipeline').innerHTML = steps.map(([label, n, color]) => `
      <div class="pipe-row">
        <div class="pipe-label">${label}</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${(n / max) * 100}%;background:${color};opacity:.75"></div></div>
        <div class="pipe-count">${n}</div>
      </div>`).join('');

    // Candidate updates only: opens, replies, bookings, cancellations.
    const icons = {
      opened: ['eye', 'tint-blue'], replied: ['bubble', 'tint-mint'],
      booked: ['calendar', 'tint-green'], canceled: ['xcircle', 'tint-red'],
    };
    const list = state.events.filter((ev) => icons[ev.type]).slice(0, 15);
    $('#activityList').innerHTML = list.length
      ? list.map((ev) => {
          const [ico, cls] = icons[ev.type];
          return `<li><span class="act-ico ${cls}">${icon(ico, 14)}</span>
            <div><div>${esc(ev.message)}</div><div class="act-time">${timeAgo(ev.ts)}</div></div></li>`;
        }).join('')
      : '<li class="empty-line">No updates yet — opens, replies, bookings and cancellations show up here.</li>';

    // Setup checklist
    const st = state.settings;
    const items = [
      ['Import your candidates from Google Sheets or CSV', state.stats.total > 0, 'import'],
      ['Set up sending from your work email', state.sending.ready, 'settings'],
      ['Add your Calendly booking link', Boolean(st.calendlyUrl), 'settings'],
      ['Turn on phone notifications for bookings', Boolean(st.ntfyTopic), 'settings'],
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
    return s.emailed + s.replied + s.booked + s.declined;
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
      rows = cs.map((c) => candRow(c,
        `Sent ${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : ''} · ${c.openedAt ? `${icon('eye', 12)} opened ${timeAgo(c.openedAt)}` : 'not opened yet'}`,
        `${statusSelect(c)}${gmailLink(c)}`));
    } else if (kind === 'replied') {
      const cs = state.candidates.filter((c) => c.status === 'replied' || (c.replies && c.replies.length)).sort((a, b) => String(b.lastReplyAt || b.repliedAt || '').localeCompare(String(a.lastReplyAt || a.repliedAt || '')));
      $('#tileTitle').textContent = `Replied (${cs.length})`;
      $('#tileSub').textContent = 'Who replied and what they said. Change a status here once you have followed up.';
      rows = cs.map((c) => {
        const last = (c.replies || []).slice(-1)[0];
        const text = last ? (last.text || last.snippet || '') : '';
        const quote = text
          ? `<blockquote class="reply-quote">${esc(text)}</blockquote>`
          : `<blockquote class="reply-quote muted-quote">Reply text not available yet — Settings → Google → Reconnect (and tick all permissions) lets the app read replies.</blockquote>`;
        const when = c.lastReplyAt || c.repliedAt;
        return candRow(c, `Replied ${when ? timeAgo(when) : ''}${(c.replies || []).length > 1 ? ` · ${c.replies.length} messages` : ''}`,
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
              ${c ? statusSelect(c) : ''}
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
    if (q.active) parts.push(`${q.pending} still to send at ~${q.perMinute}/min`);
    parts.push(`${q.sentToday} sent in the last 24h (limit ${q.dailyLimit})`);
    if (q.pausedUntil) parts.push(`paused until ${new Date(q.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    if (q.note) parts.push(q.note);
    if (q.failed) parts.push(`${q.failed} failed — ${q.failures.map((f) => `${f.email}: ${f.error}`).slice(-3).join(' · ')}`);
    $('#sendingMeta').textContent = parts.join(' · ');
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
  }

  function timeAgo(ts) {
    const sec = (Date.now() - new Date(ts).getTime()) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------------- Candidates ----------------
  function visibleCandidates() {
    const q = search.toLowerCase();
    return state.candidates.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!q) return true;
      return [c.name, c.firstName, c.lastName, c.email, c.role, c.company]
        .some((f) => String(f || '').toLowerCase().includes(q));
    });
  }

  function initials(c) {
    const n = c.name || `${c.firstName} ${c.lastName}` || c.email;
    const parts = n.trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
  }

  function renderCandidates() {
    const rows = visibleCandidates();
    const tbody = $('#candidateRows');
    $('#candidatesEmpty').style.display = state.candidates.length ? 'none' : 'block';
    tbody.innerHTML = rows.map((c, i) => {
      const st = STATUS[c.status] || STATUS.new;
      const displayName = c.name || `${c.firstName} ${c.lastName}`.trim() || '—';
      return `<tr data-id="${c.id}">
        <td class="col-check"><input type="checkbox" class="row-check" ${selected.has(c.id) ? 'checked' : ''}></td>
        <td><div class="name-cell">
          <span class="avatar ${AVATAR_TINTS[i % AVATAR_TINTS.length]}">${esc(initials(c))}</span>
          <div><div class="cand-name">${esc(displayName)}</div>
          ${c.notes ? `<div class="cand-sub">${esc(c.notes)}</div>` : ''}</div>
        </div></td>
        <td>${esc(c.email)}</td>
        <td>${esc(c.role) || '<span class="muted">—</span>'}</td>
        <td>${esc(c.company) || '<span class="muted">—</span>'}</td>
        <td><select class="status-select ${st.cls}" title="Change status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></td>
        <td>${c.lastEmailedAt ? timeAgo(c.lastEmailedAt) : '<span class="muted">never</span>'}</td>
        <td><div class="row-actions">
          <button class="icon-btn act-email" title="Send personal email">${icon('mail', 16)}</button>
          <button class="icon-btn act-delete" title="Remove">${icon('trash', 16)}</button>
        </div></td>
      </tr>`;
    }).join('');
    updateSendButton();
    $('#checkAll').checked = rows.length > 0 && rows.every((c) => selected.has(c.id));
  }

  function updateSendButton() {
    const btn = $('#sendSelectedBtn');
    btn.disabled = selected.size === 0;
    $('#sendSelectedLabel').textContent = selected.size > 1 ? `Email ${selected.size} selected` : 'Email selected';
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
    if (e.target.closest('.act-email')) { openCompose([id]); return; }
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
  $('#filterChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    $$('#filterChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderCandidates();
  });
  $('#sendSelectedBtn').addEventListener('click', () => openCompose([...selected]));
  $('#candEmailAllBtn').addEventListener('click', () => openCompose(uncontactedIds()));
  $('#dashEmailAllBtn').addEventListener('click', () => openCompose(uncontactedIds()));
  // From the template page, send exactly what's in the editor (saved or not).
  $('#tplSendAllBtn').addEventListener('click', () =>
    openCompose(uncontactedIds(), { subject: $('#tplSubject').value, body: $('#tplBody').value }));

  // Add-candidate modal
  $('#addCandidateBtn').addEventListener('click', () => { $('#addModal').hidden = false; });
  $('#addSaveBtn').addEventListener('click', async () => {
    try {
      await api('/api/candidates', { method: 'POST', body: {
        firstName: $('#addFirst').value, lastName: $('#addLast').value,
        name: `${$('#addFirst').value} ${$('#addLast').value}`.trim(),
        email: $('#addEmail').value, role: $('#addRole').value,
        company: $('#addCompany').value, notes: $('#addNotes').value,
      }});
      ['#addFirst', '#addLast', '#addEmail', '#addRole', '#addCompany', '#addNotes'].forEach((s) => ($(s).value = ''));
      $('#addModal').hidden = true;
      toast('Candidate added.');
      await refresh();
    } catch (err) { oops(err); }
  });

  // ---------------- Compose & send ----------------
  let cancelSend = false;
  function openCompose(ids, override) {
    if (!state.sending.ready) {
      toast(state.sending.reason || 'Set up your work email first (Settings → Google or App Password).', true);
      show('settings');
      return;
    }
    if (!ids.length) { toast('Nobody to email — everyone has been contacted.', true); return; }
    composeIds = ids;
    cancelSend = false;
    const cands = ids.map((id) => state.candidates.find((c) => c.id === id)).filter(Boolean);
    $('#composeTitle').textContent = cands.length === 1
      ? `Email ${cands[0].name || cands[0].email}`
      : `Email ${cands.length} candidates personally`;
    $('#composeTo').innerHTML =
      cands.slice(0, 6).map((c) => `<span class="to-chip">${esc(c.name || c.email)}</span>`).join('') +
      (cands.length > 6 ? `<span class="to-more">+${cands.length - 6} more</span>` : '');
    $('#composeSubject').value = override ? override.subject : state.template.subject;
    $('#composeBody').value = override ? override.body : state.template.body;
    const sigNote = state.google.signature ? ' Your Gmail signature is added at the bottom.' : '';
    $('#composeHint').textContent = cands.length === 1
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
      const perHour = (q.perMinute || 6) * 60;
      $('#composeHint').textContent =
        `${cands.length} emails will be sent automatically in the background at about ${q.perMinute || 6} per minute (${perHour}/hour), each personalized. ` +
        `Gmail allows about ${q.dailyLimit} per day and you've sent ${q.sentToday || 0} in the last 24 hours, so ${today} go out today` +
        (today < cands.length ? ` and the remaining ${cands.length - today} continue automatically tomorrow.` : '.') +
        ` You can close this tab; progress shows on the Dashboard.`;
      $('#composeSendBtn').textContent = `Queue ${cands.length} emails`;
    } else {
      $('#composeSendBtn').textContent = cands.length > 1 ? `Send ${cands.length} emails` : 'Send';
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
    btn.disabled = true;
    if (queueMode) {
      try {
        const r = await api('/api/queue', { method: 'POST', body: { candidateIds: composeIds, template } });
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
    const failed = [];
    const update = () => {
      const done = sent + failed.length;
      $('#sendBarFill').style.width = `${Math.round((done / total) * 100)}%`;
      btn.textContent = `Sending… ${done} / ${total}`;
      prog.innerHTML = `<span class="ok-ico">${icon('checkcircle', 14)}</span> ${sent} sent${failed.length ? ` · <span class="bad-ico">${icon('xcircle', 14)}</span> ${failed.length} failed` : ''}` +
        (failed.length ? '<br>' + failed.slice(-5).map((f) => `<span class="bad-ico">${icon('xcircle', 14)}</span> ${esc(f.email || f.id)} — ${esc(f.error)}`).join('<br>') : '');
    };
    update();
    try {
      let pending = composeIds.slice();
      let retries = 0;
      while (pending.length && !cancelSend) {
        const chunk = pending.slice(0, BATCH);
        pending = pending.slice(BATCH);
        const data = await api('/api/send', { method: 'POST', body: { candidateIds: chunk, template } });
        const deferred = data.results.filter((r) => r.retry);
        for (const r of data.results) { if (r.ok) sent++; else if (!r.retry) failed.push(r); }
        if (deferred.length) {
          const rest = [...deferred.map((r) => r.id), ...pending];
          if (deferred.some((r) => r.kind === 'daily')) {
            // Gmail's 24-hour cap: hand the remainder to the queue, which resumes by itself.
            pending = [];
            await api('/api/queue', { method: 'POST', body: { candidateIds: rest, template } });
            toast(`Gmail's daily limit is reached — the remaining ${rest.length} were queued and will send automatically.`, true);
            break;
          }
          if (deferred.every((r) => r.kind === 'budget')) {
            pending = rest;                       // request ran out of time; just continue
          } else if (++retries > 6) {
            pending = [];
            await api('/api/queue', { method: 'POST', body: { candidateIds: rest, template } });
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
  $('#fetchSheetBtn').addEventListener('click', async () => {
    const url = $('#sheetUrl').value.trim();
    if (!url) return toast('Paste your Google Sheet link first.', true);
    $('#sheetHint').textContent = 'Fetching sheet…';
    try {
      const data = await api('/api/import/sheet', { method: 'POST', body: { url } });
      $('#sheetHint').textContent = data.via === 'google-api'
        ? 'Loaded via your connected Google account.'
        : 'Loaded via public link.';
      showMapping(data, 'google-sheet');
    } catch (err) {
      $('#sheetHint').textContent = '';
      oops(err);
    }
  });

  const dz = $('#dropzone');
  $('#csvFile').addEventListener('change', (e) => e.target.files[0] && readCsv(e.target.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) readCsv(e.dataTransfer.files[0]);
  });

  function readCsv(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = await api('/api/import/csv', { method: 'POST', body: { text: reader.result } });
        showMapping(data, 'csv');
      } catch (err) { oops(err); }
    };
    reader.readAsText(file);
  }

  const MAP_FIELDS = [
    ['email', 'Email *'], ['name', 'Full name'], ['firstName', 'First name'],
    ['lastName', 'Last name'], ['role', 'Role / title'], ['company', 'Company'],
    ['phone', 'Phone'], ['notes', 'Notes'],
  ];

  function showMapping(data, source) {
    pendingImport = { ...data, source };
    $('#previewCount').textContent = `${data.rows.length} rows`;
    $('#mappingGrid').innerHTML = MAP_FIELDS.map(([key, label]) => `
      <div><label class="label">${label}</label>
        <select class="input map-select" data-key="${key}">
          <option value="-1">— skip —</option>
          ${data.headers.map((h, i) =>
            `<option value="${i}" ${data.mapping[key] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select></div>`).join('');
    const preview = data.rows.slice(0, 5);
    $('#previewTable').innerHTML =
      `<thead><tr>${data.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${preview.map((r) => `<tr>${data.headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#mappingCard').hidden = false;
    $('#mappingCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#cancelImportBtn').addEventListener('click', () => { $('#mappingCard').hidden = true; pendingImport = null; });
  $('#commitImportBtn').addEventListener('click', async () => {
    if (!pendingImport) return;
    const mapping = {};
    $$('.map-select').forEach((sel) => { mapping[sel.dataset.key] = Number(sel.value); });
    if (mapping.email === -1) return toast('Pick which column holds the email address.', true);
    try {
      const r = await api('/api/import/commit', { method: 'POST', body: {
        rows: pendingImport.rows, mapping, source: pendingImport.source,
      }});
      toast(`Imported ${r.added} candidates${r.skipped ? ` (${r.skipped} skipped)` : ''}.`);
      $('#mappingCard').hidden = true;
      pendingImport = null;
      await refresh();
      show('candidates');
    } catch (err) { oops(err); }
  });

  // ---------------- Template ----------------
  const SAMPLE = { firstName: 'Jordan', lastName: 'Lee', name: 'Jordan Lee', role: 'Payments Analyst', company: 'Acme Corp', email: 'jordan@example.com' };

  function firstNameOf(c) {
    return c.firstName || (c.name ? c.name.trim().split(/\s+/)[0] : '');
  }

  // Client-side mirror of the server's placeholder fill, for live preview.
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
    return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? '');
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
  let templateDirty = false;
  function setTemplateDirty(d) {
    templateDirty = d;
    $('#saveTemplateBtn').textContent = d ? 'Save template •' : 'Save template';
  }
  ['#tplSubject', '#tplBody'].forEach((s) =>
    $(s).addEventListener('input', () => { setTemplateDirty(true); debouncedPreview(); }));
  const debouncedPreview = debounce(renderTemplatePreview, 200);
  $('#previewCandidate').addEventListener('change', renderTemplatePreview);

  $$('.token').forEach((btn) => btn.addEventListener('click', () => {
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

  // ---------------- Settings ----------------
  function renderSettings() {
    const s = state.settings;
    const setIf = (sel, val) => { const el = $(sel); if (document.activeElement !== el) el.value = val || ''; };
    setIf('#setCalendlyUrl', s.calendlyUrl);
    setIf('#calendlyToken', s.calendlyToken);
    setIf('#setFromName', s.fromName);
    setIf('#setDailyLimit', s.dailyLimit);
    setIf('#setPerMinute', s.perMinute);
    $('#setGmailSignature').checked = s.gmailSignature !== false;
    setIf('#setNtfyTopic', s.ntfyTopic);
    setIf('#setSmtpUser', s.smtpUser);
    setIf('#setSmtpPass', s.smtpPass);
    setIf('#setGoogleClientId', s.googleClientId);
    setIf('#setGoogleClientSecret', s.googleClientSecret);
    $('#redirectUriCode').textContent = state.google.redirectUri;

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
      gmailSignature: $('#setGmailSignature').checked,
      ntfyTopic: $('#setNtfyTopic').value,
      smtpUser: $('#setSmtpUser').value,
      smtpPass: $('#setSmtpPass').value,
      googleClientId: $('#setGoogleClientId').value,
      googleClientSecret: $('#setGoogleClientSecret').value,
      ...extra,
    };
    await api('/api/settings', { method: 'POST', body });
    await refresh();
  }

  $('#saveSettingsBtn').addEventListener('click', () =>
    saveSettings().then(() => toast('Settings saved.')).catch(oops));

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
      $('#calendlyHint').textContent = `Booking alerts enabled — Calendly now notifies this app at ${r.url}.`;
      toast('Calendly webhook registered. Bookings will update the pipeline and ping your phone.');
      await refresh();
    } catch (err) { oops(err); }
  });

  // ---------------- Modals ----------------
  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });

  // ---------------- Boot ----------------
  function renderAll() {
    renderNotices();
    renderDashboard();
    renderCandidates();
    renderSettings();
    // Only prime the template editor when there are no unsaved edits.
    if (!templateDirty) {
      $('#tplSubject').value = state.template.subject;
      $('#tplBody').value = state.template.body;
    }
    renderTemplatePreview();
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
  async function checkReplies() {
    if (!state || !state.google.connected || document.hidden) return;
    try {
      const r = await api('/api/replies/check', { method: 'POST' });
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
