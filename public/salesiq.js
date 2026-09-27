/* =========================================================
   Sales IQ — the Hiring Dashboard, as a page of this site.

   The Sales IQ app's dashboard (its js/roster.js, js/contact.js,
   js/resume.js and the bookings half of js/sync.js), with one
   difference that matters: everything it knew lived in one
   browser's localStorage, and now it lives on the server, with
   this team. So the same list is on every device you sign in
   from, a booking reaches it whether or not a dashboard is open,
   and a candidate who finishes on their own phone lands here by
   themselves rather than by way of an email and a pasted link.

   Everything on screen is the Sales IQ app's: its markup, its
   words, its styles (/salesiq.css, under .siq). IDs carry a
   siq- prefix and a handful of class names a q- prefix, because
   the rest of the site already uses those names.
   ========================================================= */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const root = $("#siq");
  if (!root) return;

  const COMPANY = "Wholesale Payments";
  const MIN = 60 * 1000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  let candidates = [];
  let reports = [];
  let settings = { team: "", managerEmail: "" };
  let TEAMS = [];
  let TIERS = [];
  let calendly = { syncEnabled: false, webhook: false, lastSyncAt: null, error: "" };
  let mail = { ready: false, from: "", reason: "" };
  let hostTeam = null;
  let loaded = false;
  let active = false;

  /* ---------------- talking to the server ---------------- */

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const e = new Error((data && data.error) || `Request failed (${res.status})`);
      Object.assign(e, data || {}, { status: res.status });
      throw e;
    }
    return data || {};
  }

  let etag = "";
  let loading = null;
  // Which team's list is being asked for. A switch of team moves it on, and
  // an answer that was asked for before the switch is dropped on arrival.
  let generation = 0;
  // The 30-second look. Tagged, so a look at a list that hasn't moved costs a
  // 304 and nothing is redrawn.
  function load() {
    if (loading) return loading;
    const gen = generation;
    const p = (async () => {
      const res = await fetch("/api/iq/state", {
        headers: etag ? { "If-None-Match": etag } : {},
        credentials: "same-origin",
      });
      if (gen !== generation) return false;
      if (res.status === 304) return false;
      if (res.status === 401) {
        // Signed out: the site is already showing its sign-in screen.
        deactivate();
        return false;
      }
      if (!res.ok) throw new Error(`Sales IQ couldn't load (${res.status})`);
      const st = await res.json();
      if (gen !== generation) return false;
      apply(st);
      etag = res.headers.get("ETag") || "";
      return true;
    })().finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  }

  // After a change: the next look must not be answered "unchanged".
  async function reload() {
    etag = "";
    try { await load(); } catch (err) { toast(err.message, "error"); }
  }

  /* ---------------- the state, applied ---------------- */

  let knownIds = null;

  function apply(st) {
    const first = !loaded;
    candidates = Array.isArray(st.candidates) ? st.candidates : [];
    reports = Array.isArray(st.reports) ? st.reports : [];
    settings = st.settings || { team: "", managerEmail: "" };
    TEAMS = Array.isArray(st.teams) ? st.teams : [];
    TIERS = Array.isArray(st.tiers) ? st.tiers : [];
    calendly = st.calendly || calendly;
    mail = st.mail || mail;
    hostTeam = st.hostTeam || null;
    if (st.previewUrl) $("#siq-btn-preview").setAttribute("href", st.previewUrl);
    loaded = true;

    if (first) fillTeams();
    syncSettingsUi();
    render();
    renderReports();
    renderStatus();
    if (first) {
      [listEl, $("#siq-upcoming-list"), reportList].forEach((l) => l.classList.add("first-paint"));
      setTimeout(() => root.querySelectorAll(".list.first-paint").forEach((l) => l.classList.remove("first-paint")), 900);
      suggestTeam();
      openPendingReport();
    }

    // Anyone who booked since the last look: said once, while you're here.
    const ids = new Set(candidates.map((c) => c.id));
    if (knownIds) {
      const added = candidates.filter((c) => !knownIds.has(c.id) && c.source === "calendly" && (c.status || "added") === "added");
      if (added.length && active) announce(added);
    }
    knownIds = ids;
  }

  /* ---------------- team picker + manager email setting ---------------- */

  const managerInput = $("#siq-manager-email");
  const managerCheck = $("#siq-manager-email-check");
  const teamSelect = $("#siq-team-select");

  function fillTeams() {
    teamSelect.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
    TEAMS.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.textContent = t.name;
      teamSelect.appendChild(opt);
    });
  }

  // What the server holds, into the controls — unless you're typing in one.
  function syncSettingsUi() {
    if (document.activeElement !== managerInput) managerInput.value = settings.managerEmail || "";
    if (document.activeElement !== teamSelect) {
      const savedEmail = (settings.managerEmail || "").toLowerCase();
      const match =
        TEAMS.find((t) => t.name === settings.team) ||
        TEAMS.find((t) => t.email.toLowerCase() === savedEmail && savedEmail);
      teamSelect.value = match ? match.name : "";
    }
    const note = $("#siq-mail-note");
    note.hidden = Boolean(mail.ready);
    note.textContent = mail.ready
      ? ""
      : "Results and invitations are emailed from your connected Google account — connect it in Settings. Until then, invitations open as drafts in your mail app.";
  }

  let saving = Promise.resolve();
  function saveSettings(team, managerEmail) {
    settings = { team, managerEmail };
    saving = saving.then(() => api("/api/iq/settings", { method: "PUT", body: { team, managerEmail } }))
      .then((r) => { if (r && r.settings) settings = r.settings; etag = ""; })
      .catch((err) => toast(err.message, "error"));
    return saving;
  }

  teamSelect.addEventListener("change", () => {
    const team = TEAMS.find((t) => t.name === teamSelect.value);
    if (!team) return;
    managerInput.value = team.email;
    commitManagerEmail(team.name);
  });

  function commitManagerEmail(teamName) {
    const val = managerInput.value.trim();
    const valid = EMAIL_RE.test(val);
    if (val && !valid) {
      managerCheck.textContent = "";
      managerCheck.classList.remove("show");
      return;
    }
    const team = typeof teamName === "string" ? teamName : teamSelect.value;
    if (val === (settings.managerEmail || "") && team === (settings.team || "")) return;
    saveSettings(team, val).then(() => {
      renderHead();
      if (val) {
        managerCheck.textContent = "Saved ✓";
        managerCheck.classList.add("show");
        window.clearTimeout(commitManagerEmail._t);
        commitManagerEmail._t = window.setTimeout(() => managerCheck.classList.remove("show"), 2200);
      }
    });
    settings = { team, managerEmail: val };
    renderHead();
  }
  managerInput.addEventListener("change", commitManagerEmail);
  managerInput.addEventListener("blur", commitManagerEmail);
  managerInput.addEventListener("input", () => {
    const team = TEAMS.find((t) => t.name === teamSelect.value);
    if (team && managerInput.value.trim().toLowerCase() !== team.email.toLowerCase()) {
      teamSelect.value = "";
    }
  });

  /** Picks the matching team in the team picker if no results address is set yet. */
  function suggestTeam() {
    const name = hostTeam && hostTeam.name;
    if (!name || settings.team || settings.managerEmail) return;
    const norm = (n) => String(n || "").toLowerCase().replace(/^team\s+/, "").trim();
    const team = TEAMS.find((t) => norm(t.name) === norm(name));
    if (!team) return;
    teamSelect.value = team.name;
    teamSelect.dispatchEvent(new Event("change"));
  }

  /* ---------------- Message / Call / Email ----------------
     Native Messages, Phone and Mail through sms:, tel: and mailto: links, so
     an installed iPhone app (or any phone) hands off to the device's own
     apps. Nothing is ever sent from here: each link only opens a draft or a
     call screen you confirm yourself. */

  /**
   * A dialable number, or "" when there is none. US numbers written as
   * 10 digits (or 11 starting with 1) gain +1 so they dial from anywhere.
   */
  function dialable(phone) {
    let raw = String(phone || "").trim();
    if (!raw) return "";
    raw = raw
      .replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "")   // extension: can't be dialed
      .replace(/\(0\)/g, "");                                    // "+44 (0)20…" trunk zero
    const digits = raw.replace(/\D/g, "");
    if (raw.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? "+" + digits : "";
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    if (digits.length === 7) return digits;
    return "";   // two numbers in one field, or not a phone number at all
  }

  function firstName(c) {
    return String((c && c.name) || "").trim().split(/\s+/)[0] || "there";
  }

  function interviewTime(c) {
    if (!c || !c.interviewAt || c.interviewCanceled) return null;
    const d = new Date(c.interviewAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function clock(d) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // "today at 4:30 PM", "tomorrow at 9:00 AM", "on Mon, Sep 28 at 2:15 PM"
  function when(d) {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (sameDay(d, now)) return `today at ${clock(d)}`;
    if (sameDay(d, tomorrow)) return `tomorrow at ${clock(d)}`;
    return `on ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${clock(d)}`;
  }

  // From just before the start until an hour after (the same window the
  // Upcoming interviews list keeps them in), the draft asks whether they're
  // joining; otherwise it simply opens the conversation about the interview.
  function isAroundNow(d) {
    const diff = d.getTime() - Date.now();
    return diff <= 10 * MIN && diff >= -60 * MIN;
  }

  function textBody(c) {
    const d = interviewTime(c);
    const hi = `Hi ${firstName(c)}, this is the ${COMPANY} hiring team`;
    if (d && isAroundNow(d)) return `${hi} — we're ready for your interview at ${clock(d)}. Are you still able to join?`;
    if (d) return `${hi}, reaching out about your interview ${when(d)}.`;
    return `${hi}, reaching out about the sales position.`;
  }

  function emailSubject(c) {
    return interviewTime(c) ? `Your interview with ${COMPANY}` : `${COMPANY} — sales position`;
  }

  function emailBody(c) {
    const d = interviewTime(c);
    let middle;
    if (d && isAroundNow(d)) {
      middle = `We're ready for your interview at ${clock(d)}. Are you still able to join? Reply here or give us a call and we'll get you in.`;
    } else if (d) {
      middle = `Reaching out about your interview ${when(d)}.`;
    } else {
      middle = "Reaching out about the sales position.";
    }
    return `Hi ${firstName(c)},\n\n${middle}\n\nThank you,\n${COMPANY} Hiring Team`;
  }

  // "?&body=" is read by both iOS Messages and Android.
  function smsHref(c) {
    const num = dialable(c && c.phone);
    return num ? `sms:${num}?&body=${encodeURIComponent(textBody(c))}` : "";
  }

  function telHref(c) {
    const num = dialable(c && c.phone);
    return num ? `tel:${num}` : "";
  }

  function mailHref(c) {
    const email = String((c && c.email) || "").trim();
    if (!EMAIL_RE.test(email)) return "";
    // Encoded so a stray ? & # in the address can't add recipients or cut the draft.
    return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(emailSubject(c))}&body=${encodeURIComponent(emailBody(c))}`;
  }

  // Plain outline glyphs in the text color — no app colors.
  const glyph = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const GLYPHS = {
    msg: glyph('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>'),
    call: glyph('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
    mail: glyph('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><polyline points="3 6.5 12 13 21 6.5"/>'),
  };

  const KINDS = [
    { kind: "msg", label: "Message", verb: "Text", href: smsHref, none: "No phone number to text" },
    { kind: "call", label: "Call", verb: "Call", href: telHref, none: "No phone number to call" },
    { kind: "mail", label: "Email", verb: "Email", href: mailHref, none: "No email address" },
  ];

  /**
   * The Message / Call / Email trio for a candidate.
   * size "sm" — icons only (list rows); "lg" — icons with labels (the card).
   * A missing phone or email renders a dimmed, inert icon.
   */
  function trio(c, size = "sm") {
    const name = escapeHtml(c && c.name);
    const items = KINDS.map((k) => {
      const href = k.href(c);
      const label = size === "lg" ? `<span class="contact-label">${k.label}</span>` : "";
      if (!href) {
        return `<span class="contact-btn is-off" data-contact="${k.kind}" title="${k.none}" aria-hidden="true"><span class="contact-icon">${GLYPHS[k.kind]}</span>${label}</span>`;
      }
      return `<a class="contact-btn" data-contact="${k.kind}" href="${escapeHtml(href)}" title="${k.verb} ${name}" aria-label="${k.verb} ${name}"><span class="contact-icon">${GLYPHS[k.kind]}</span>${label}</a>`;
    }).join("");
    return `<div class="contact-trio contact-${size}">${items}</div>`;
  }

  /** A fresh link for one button, so the draft matches the time it's tapped. */
  function contactHref(kind, c) {
    const k = KINDS.find((x) => x.kind === kind);
    return k ? k.href(c) : "";
  }

  /* ---------------- rendering ---------------- */

  const listEl = $("#siq-roster-list");
  const emptyEl = $("#siq-roster-empty");
  const countEl = $("#siq-cand-count");
  const tileUpload = $("#siq-tile-upload");
  const tileAdd = $("#siq-tile-add");
  const uploadStatus = $("#siq-upload-status");
  const fileInput = $("#siq-resume-input");
  const sendbar = $("#siq-sendbar");
  const sendAllBtn = $("#siq-btn-send-all");
  const sendAllLabel = $("#siq-btn-send-all-label");
  const sendbarNote = $("#siq-sendbar-note");
  let statusTimer = null;
  let noteTimer = null;

  const STATUS_LABELS = {
    added: "Not sent",
    invited: "Sent",
    completed: "Completed",
  };
  const FILTER_EMPTY = {
    added: ["All caught up", "Everyone on your list has been sent the questionnaire."],
    invited: ["No one waiting", "Nobody is waiting on the questionnaire right now."],
    completed: ["None completed yet", "Nobody has completed the questionnaire yet."],
  };

  const ICONS = {
    cal: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
    clock: '<svg class="meta-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20 7 4"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  };

  function initials(name) {
    return String(name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  const statusOf = (c) => c.status || "added";

  function pendingCandidates() {
    return candidates.filter((c) => statusOf(c) === "added");
  }

  function statusText(c) {
    const key = statusOf(c);
    return key === "completed" && typeof c.score === "number"
      ? `${STATUS_LABELS.completed} · ${c.score}/100`
      : STATUS_LABELS[key] || STATUS_LABELS.added;
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function clockParts(d) {
    const parts = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).split(/\s+/);
    return { time: parts[0], ampm: parts.slice(1).join(" ") };
  }

  // Calendar days, not 24-hour steps, so a daylight-saving night can't
  // turn tomorrow into today.
  function dayLabel(d) {
    const now = new Date();
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, now)) return "Today";
    if (same(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return "Tomorrow";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function ago(ms) {
    const m = Math.max(1, Math.round(ms / MIN));
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? "1 day" : `${d} days`;
  }

  /** 254 → "4m 14s"; 3671 → "1h 01m". */
  function formatDuration(sec) {
    if (!sec && sec !== 0) return "";
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
    return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
  }

  /**
   * Where a candidate's interview stands right now, for the list, the
   * upcoming panel and the card. null when there is no interview.
   *   soon — within the hour · now — at start time · late — started, up to
   *   an hour ago (the moment to text or call) · past · canceled
   */
  function interviewState(c) {
    if (c.interviewCanceled) return { key: "canceled", cls: "is-canceled", short: "Interview canceled", long: "Interview canceled" };
    const t = Date.parse(c.interviewAt || "");
    if (!Number.isFinite(t)) return null;
    const diff = t - Date.now();
    const d = new Date(t);
    const abs = formatWhen(c.interviewAt);
    if (diff > 60 * MIN) {
      const rel = diff < 20 * 3600 * 1000
        ? `Starts in ${ago(diff)}`
        : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      return { key: "later", cls: "", at: d, rel, short: `Interview ${abs}`, long: `Interview ${abs}` };
    }
    if (diff > 5 * MIN) {
      return { key: "soon", cls: "is-soon", at: d, rel: `Starts in ${ago(diff)}`, short: `Interview in ${ago(diff)}`, long: `Interview starts in ${ago(diff)}` };
    }
    if (diff >= -5 * MIN) {
      return { key: "now", cls: "is-soon", at: d, rel: "Starting now", short: "Interview starting now", long: "Interview starting now" };
    }
    if (diff >= -60 * MIN) {
      return { key: "late", cls: "is-late", at: d, rel: `Started ${ago(-diff)} ago`, short: `Interview started ${ago(-diff)} ago`, long: `Interview started ${ago(-diff)} ago` };
    }
    return { key: "past", cls: "is-past", at: d, rel: "", short: `Interviewed ${abs}`, long: `Interviewed ${abs}` };
  }

  // Interviews that are coming up, or started less than an hour ago.
  function upcomingCandidates() {
    return candidates
      .map((c) => ({ c, s: interviewState(c) }))
      .filter((x) => x.s && ["later", "soon", "now", "late"].includes(x.s.key))
      .sort((a, b) => a.s.at - b.s.at);
  }

  /* ---- candidate list ---- */

  const rosterEmptyTitle = emptyEl.querySelector(".list-empty-title");
  const rosterEmptySub = emptyEl.querySelector(".list-empty-sub");
  const ROSTER_EMPTY_TEXT = [rosterEmptyTitle.textContent, rosterEmptySub.textContent];
  const filterBar = $("#siq-cand-filter");
  let filter = "all";

  function setFilter(next) {
    filter = STATUS_LABELS[next] ? next : "all";
    render();
  }

  filterBar.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-filter]");
    if (seg) setFilter(seg.dataset.filter);
  });

  function candidateRow(c) {
    const key = statusOf(c);
    const s = interviewState(c);
    const meta = [c.email, c.phone].filter(Boolean).join("  ·  ");
    const row = document.createElement("div");
    row.className = "list-row cand-row is-tappable";
    row.dataset.id = c.id;
    row.innerHTML = `
      <button type="button" class="row-main" data-open aria-haspopup="dialog">
        <span class="q-avatar">${escapeHtml(initials(c.name)) || "?"}</span>
        <span class="row-info">
          <span class="row-top">
            <span class="row-name">${escapeHtml(c.name)}</span>
            <span class="status-chip status-${key}">${escapeHtml(statusText(c))}</span>
          </span>
          <span class="row-meta">${escapeHtml(meta)}</span>
          ${s ? `<span class="row-when ${s.cls}">${ICONS.cal}<span>${escapeHtml(s.short)}</span></span>` : ""}
        </span>
      </button>
      ${trio(c, "sm")}
      <span class="row-chevron" aria-hidden="true">${ICONS.chevron}</span>`;
    return row;
  }

  function renderRoster() {
    const shown = filter === "all" ? candidates : candidates.filter((c) => statusOf(c) === filter);
    listEl.innerHTML = "";
    shown.forEach((c) => listEl.appendChild(candidateRow(c)));

    countEl.hidden = candidates.length === 0;
    countEl.textContent = String(candidates.length);
    emptyEl.hidden = shown.length > 0;
    const filtered = candidates.length > 0 && filter !== "all";
    rosterEmptyTitle.textContent = filtered ? FILTER_EMPTY[filter][0] : ROSTER_EMPTY_TEXT[0];
    rosterEmptySub.textContent = filtered ? FILTER_EMPTY[filter][1] : ROSTER_EMPTY_TEXT[1];

    filterBar.querySelectorAll("[data-filter]").forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  // Tapping anywhere on a row but Message / Call / Email opens the card.
  function openFromRow(e) {
    if (e.target.closest(".contact-trio")) return;
    const row = e.target.closest(".list-row[data-id]");
    if (row) openCard(row.dataset.id);
  }

  listEl.addEventListener("click", openFromRow);

  /* ---- upcoming interviews ---- */

  const upcomingBlock = $("#siq-block-upcoming");
  const upcomingList = $("#siq-upcoming-list");
  const upcomingCount = $("#siq-upcoming-count");
  const UPCOMING_SHOWN = 5;

  function renderUpcoming() {
    const all = upcomingCandidates();
    upcomingBlock.hidden = all.length === 0;
    upcomingCount.textContent = all.length ? String(all.length) : "";
    upcomingList.innerHTML = "";
    all.slice(0, UPCOMING_SHOWN).forEach(({ c, s }) => {
      const { time, ampm } = clockParts(s.at);
      const row = document.createElement("div");
      row.className = `list-row up-row is-tappable is-${s.key}`;
      row.dataset.id = c.id;
      const rel = s.rel;
      row.innerHTML = `
        <button type="button" class="row-main" data-open aria-haspopup="dialog">
          <span class="up-time" aria-hidden="true">
            <span class="up-clock">${escapeHtml(time)}</span>
            <span class="up-ampm">${escapeHtml(ampm)}</span>
            <span class="up-day">${escapeHtml(dayLabel(s.at))}</span>
          </span>
          <span class="row-info">
            <span class="row-top"><span class="row-name">${escapeHtml(c.name)}</span></span>
            <span class="row-meta"><span class="up-rel">${escapeHtml(rel)}</span> · ${escapeHtml(STATUS_LABELS[statusOf(c)] || "")}</span>
            <span class="visually-hidden">${escapeHtml(s.long)}</span>
          </span>
        </button>
        ${trio(c, "sm")}
        <span class="row-chevron" aria-hidden="true">${ICONS.chevron}</span>`;
      upcomingList.appendChild(row);
    });
    if (all.length > UPCOMING_SHOWN) {
      const more = document.createElement("p");
      more.className = "list-more";
      more.textContent = `+${all.length - UPCOMING_SHOWN} more — see Candidates below`;
      upcomingList.appendChild(more);
    }
  }

  upcomingList.addEventListener("click", openFromRow);

  /* ---- summary tiles ---- */

  const statsEl = $("#siq-stats");

  function renderStats() {
    const count = (k) => candidates.filter((c) => statusOf(c) === k).length;
    $("#siq-stat-upcoming").textContent = String(upcomingCandidates().length);
    $("#siq-stat-added").textContent = String(count("added"));
    $("#siq-stat-invited").textContent = String(count("invited"));
    $("#siq-stat-completed").textContent = String(count("completed"));
    statsEl.querySelectorAll("[data-stat]").forEach((b) => {
      const on = b.dataset.stat === filter;
      b.classList.toggle("is-on", on);
      if (b.dataset.stat !== "upcoming") b.setAttribute("aria-pressed", String(on));
    });
  }

  statsEl.addEventListener("click", (e) => {
    const tile = e.target.closest("[data-stat]");
    if (!tile) return;
    const which = tile.dataset.stat;
    if (which === "upcoming") {
      if (upcomingBlock.hidden) {
        toast("No upcoming interviews — new Calendly bookings appear here on their own.");
        return;
      }
      upcomingBlock.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setFilter(filter === which ? "all" : which);
    $("#siq-block-candidates").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ---- header line ---- */

  function renderHead() {
    const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    const team = teamSelect.value;
    $("#siq-dash-date").textContent = team ? `${date} · ${team}` : date;
    // Setup that still needs doing moves to the top on phones (see salesiq.css).
    root.classList.toggle("needs-results", loaded && !settings.managerEmail);
  }

  function render() {
    renderRoster();
    renderUpcoming();
    renderStats();
    renderSendbar();
    renderHead();
    if (cardId) renderCard();
  }

  function renderSendbar() {
    const pending = pendingCandidates();
    // Only under a list that shows the people it would send to.
    sendbar.hidden = pending.length === 0 || filter === "invited" || filter === "completed";
    sendAllBtn.disabled = sendingIds.size > 0;
    if (pending.length > 0) {
      sendAllLabel.textContent =
        pending.length === 1
          ? `Send questionnaire to ${pending[0].name.split(" ")[0]}`
          : `Send questionnaire to ${pending.length} new hires`;
    }
  }

  // Relative times ("starts in 12 min") move on by themselves: redrawn every
  // 30 seconds and whenever the app comes back to the front, keeping focus
  // where it was so a keyboard or screen-reader user isn't thrown out.
  function refreshTimes() {
    if (!loaded) return;
    const activeEl = document.activeElement;
    const row = activeEl && activeEl.closest ? activeEl.closest("#siq-roster-list .list-row[data-id], #siq-upcoming-list .list-row[data-id]") : null;
    const part = !row ? null
      : activeEl.matches("[data-contact]") ? `[data-contact="${activeEl.dataset.contact}"]`
      : activeEl.matches(".row-main") ? ".row-main" : null;
    const restore = row && part ? `#${row.parentElement.id} .list-row[data-id="${CSS.escape(row.dataset.id)}"] ${part}` : null;
    renderRoster();
    renderUpcoming();
    renderStats();
    renderSendbar();
    renderHead();
    refreshCardTime();
    renderStatus();
    if (restore) {
      const el = document.querySelector(restore);
      if (el) el.focus({ preventScroll: true });
    }
  }
  setInterval(() => { if (!document.hidden && active) refreshTimes(); }, 30 * 1000);

  // Message / Call / Email drafts are written at the moment of the tap, so a
  // row drawn before the interview still asks "are you able to join?" after.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest(".siq a.contact-btn[data-contact]");
    if (!a) return;
    const host = a.closest("[data-id]");
    const c = candidates.find((x) => x.id === (host ? host.dataset.id : cardId));
    const fresh = c && contactHref(a.dataset.contact, c);
    if (fresh) a.setAttribute("href", fresh);
  }, true);

  /* ---------------- candidate card ---------------- */

  const cardBackdrop = $("#siq-card-backdrop");
  const cardBody = $("#siq-card-body");
  let cardId = null;
  let cardReturnFocus = null;

  const sameEmail = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

  function reportFor(c) {
    return reports.find((r) => !r.retake && (r.candidateId === c.id || sameEmail(r.email, c.email))) || null;
  }

  function refreshCardTime() {
    const c = cardId && candidates.find((x) => x.id === cardId);
    const el = cardBody.querySelector(".cc-when");
    const s = c && interviewState(c);
    if (!el || !s) return;
    el.className = `cc-when ${s.cls}`;
    el.lastElementChild.textContent = s.long;
  }

  function renderCard() {
    const c = candidates.find((x) => x.id === cardId);
    if (!c) {
      closeCard();
      return;
    }
    // A sync can redraw the card while it's in use: put focus back on the
    // same control rather than letting it drop out of the dialog.
    const f = document.activeElement;
    const refocus = f && cardBody.contains(f)
      ? (f.dataset.act ? `.cc-group [data-act="${f.dataset.act}"]` : f.dataset.contact ? `[data-contact="${f.dataset.contact}"]` : null)
      : null;
    const key = statusOf(c);
    const s = interviewState(c);
    const sending = sendingIds.has(c.id);
    const added = c.added ? new Date(c.added).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
    const source = c.source === "calendly" ? "Calendly booking" : c.source === "pipeline" ? "From your pipeline" : "";
    let scoreRow = "";
    if (key === "completed" && typeof c.score === "number") {
      const r = reportFor(c);
      const bits = [`${c.score}/100`];
      if (r && r.tier) bits.push(r.tier);
      if (c.durationSec) bits.push(`took ${formatDuration(c.durationSec)}`);
      scoreRow = `<div class="cc-field"><span class="cc-field-label">Score</span><span class="cc-field-value">${escapeHtml(bits.join(" · "))}</span></div>`;
    }
    const inviteLabel = sending ? "Sending…" : key === "invited" ? "Send questionnaire again" : "Send questionnaire";

    cardBody.innerHTML = `
      <div class="cc-head">
        <div class="cc-avatar" aria-hidden="true">${escapeHtml(initials(c.name)) || "?"}</div>
        <h3 class="cc-name" id="siq-card-name">${escapeHtml(c.name)}</h3>
        <div class="cc-chips">
          <span class="status-chip status-${key}">${escapeHtml(statusText(c))}</span>
        </div>
        ${s ? `<span class="cc-when ${s.cls}">${ICONS.cal}<span>${escapeHtml(s.long)}</span></span>` : ""}
      </div>
      ${trio(c, "lg")}
      <div class="cc-group">
        <div class="cc-field"><span class="cc-field-label">Email</span><span class="cc-field-value">${escapeHtml(c.email)}</span></div>
        <div class="cc-field"><span class="cc-field-label">Phone</span>${
          c.phone
            ? `<span class="cc-field-value">${escapeHtml(c.phone)}</span>`
            : `<span class="cc-field-value is-empty">None yet — <button type="button" class="text-btn" data-act="edit">Add a phone number</button></span>`
        }</div>
        ${scoreRow}
        ${added ? `<div class="cc-field"><span class="cc-field-label">Added</span><span class="cc-field-value">${escapeHtml([added, source].filter(Boolean).join(" · "))}</span></div>` : ""}
      </div>
      <div class="cc-group">
        ${key !== "completed" ? `
        <button type="button" class="menu-item" data-act="invite" ${sending ? "disabled" : ""}>
          <span class="menu-text"><span class="menu-icon">${ICONS.send}</span>${inviteLabel}</span>
        </button>
        <button type="button" class="menu-item" data-act="start">
          <span class="menu-text"><span class="menu-icon">${ICONS.play}</span>Run assessment on this device</span>
        </button>
        <button type="button" class="menu-item" data-act="copy">
          <span class="menu-text"><span class="menu-icon">${ICONS.link}</span>Copy their questionnaire link</span>
        </button>` : ""}
        <button type="button" class="menu-item" data-act="edit">
          <span class="menu-text"><span class="menu-icon">${ICONS.edit}</span>Edit details</span>
        </button>
        <button type="button" class="menu-item is-danger" data-act="remove">
          <span class="menu-text"><span class="menu-icon">${ICONS.trash}</span>Remove from list</span>
        </button>
      </div>`;
    cardBody.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => handleAction(btn.dataset.act, c.id));
    });
    if (refocus) (cardBody.querySelector(refocus) || $("#siq-card-close")).focus({ preventScroll: true });
  }

  function openCard(id) {
    cardId = id;
    cardReturnFocus = document.activeElement;
    renderCard();
    if (!cardId) return;
    cardBackdrop.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => $("#siq-card-close").focus({ preventScroll: true }), 60);
  }

  function closeCard() {
    const wasOpen = !cardBackdrop.hidden;
    cardId = null;
    cardBackdrop.hidden = true;
    cardBody.innerHTML = "";
    if (wasOpen) {
      document.body.style.overflow = "";
      // Back to the row it came from — or, if that row was just removed, the list.
      const back = cardReturnFocus && document.contains(cardReturnFocus) ? cardReturnFocus : $("#siq-cand-title");
      back.focus({ preventScroll: true });
    }
    cardReturnFocus = null;
  }

  $("#siq-card-close").addEventListener("click", closeCard);
  cardBackdrop.addEventListener("click", (e) => {
    if (e.target === cardBackdrop) closeCard();
  });

  /* ---------------- completion reports ---------------- */

  const reportList = $("#siq-report-list");
  const reportEmpty = $("#siq-report-empty");
  const reportCount = $("#siq-report-count");

  function renderReports() {
    const openIds = new Set([...reportList.querySelectorAll('.report-row[aria-expanded="true"]')].map((r) => r.dataset.id));
    reportList.innerHTML = "";
    reportEmpty.hidden = reports.length > 0;
    reportCount.hidden = reports.length === 0;
    reportCount.textContent = String(reports.length);

    reports.forEach((r) => {
      const name = r.name || r.email || "Unidentified candidate";
      const whenText = r.completedAt
        ? new Date(r.completedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : "";
      const dur = r.durationSec ? formatDuration(r.durationSec) : "—";
      const score = Math.max(0, Math.min(100, Number(r.score) || 0));
      const tierKey = /^[a-z]+$/.test(r.tierKey || "") ? r.tierKey : "develop";

      const row = document.createElement("div");
      row.className = "list-row report-row expandable";
      row.dataset.id = r.id;
      row.setAttribute("tabindex", "0");
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", "false");
      row.innerHTML = `
        <span class="score-ring tier-${tierKey}" style="--q-p:${score}" role="img" aria-label="Score ${score} out of 100"><span>${score}</span></span>
        <span class="row-info">
          <span class="row-top">
            <span class="row-name">${escapeHtml(name)}</span>
            <span class="status-chip tier-${tierKey}">${escapeHtml(r.tier || "")}</span>
            ${r.retake ? `<span class="status-chip status-retake" title="Took the questionnaire again — their first score stands">Retake</span>` : ""}
          </span>
          <span class="row-meta">${escapeHtml(whenText)} &nbsp;·&nbsp; ${ICONS.clock} ${escapeHtml(dur)}</span>
        </span>
        <span class="row-chevron" aria-hidden="true">${ICONS.chevron}</span>`;

      const cats = Array.isArray(r.categories) ? r.categories : [];
      const delivered = r.emailedTo
        ? `Emailed to ${escapeHtml(r.emailedTo)}`
        : r.emailError ? `Not emailed — ${escapeHtml(r.emailError)}` : "";
      const detail = document.createElement("div");
      detail.className = "report-detail";
      detail.hidden = true;
      detail.innerHTML =
        `<p class="report-blurb">${escapeHtml((TIERS.find((t) => t.key === r.tierKey) || {}).blurb || "")}</p>` +
        cats.map((c) => `
          <div class="bd-row">
            <div class="bd-head"><span class="bd-name">${escapeHtml(c.name)}</span><span class="bd-score">${Number(c.score) || 0}/${Number(c.max) || 0}</span></div>
            <div class="bd-track"><div class="bd-fill" style="width:${Math.max(0, Math.min(100, Number(c.pct) || 0))}%"></div></div>
          </div>`).join("") +
        `<div class="report-foot">${delivered ? `<span class="report-sent">${delivered}</span>` : ""}<button type="button" class="text-btn is-danger" data-del>${ICONS.trash} Remove report</button></div>`;
      const toggle = () => {
        detail.hidden = !detail.hidden;
        row.setAttribute("aria-expanded", String(!detail.hidden));
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });

      detail.querySelector("[data-del]").addEventListener("click", async () => {
        if (!window.confirm(`Remove ${name}'s report?`)) return;
        try {
          await api(`/api/iq/reports/${encodeURIComponent(r.id)}`, { method: "DELETE" });
          reports = reports.filter((x) => x.id !== r.id);
          renderReports();
          reload();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      reportList.appendChild(row);
      reportList.appendChild(detail);
      if (openIds.has(r.id)) toggle();
    });
  }

  function setStatus(kind, msg, sticky = false) {
    uploadStatus.className = "panel-status" + (kind ? " " + kind : "");
    uploadStatus.textContent = msg;
    window.clearTimeout(statusTimer);
    if (msg && !sticky) {
      statusTimer = window.setTimeout(() => {
        uploadStatus.textContent = "";
        uploadStatus.className = "panel-status";
      }, 6000);
    }
  }

  function setNote(kind, msg) {
    sendbarNote.className = "sendbar-note" + (kind ? " " + kind : "");
    sendbarNote.textContent = msg;
    window.clearTimeout(noteTimer);
    if (msg) {
      noteTimer = window.setTimeout(() => {
        sendbarNote.textContent = "";
        sendbarNote.className = "sendbar-note";
      }, 7000);
    }
  }

  /* ---------------- row actions ---------------- */

  async function handleAction(act, id) {
    const cand = candidates.find((c) => c.id === id);
    if (!cand) return;

    if (act === "remove") {
      if (!window.confirm(`Remove ${cand.name} from the list?`)) return;
      try {
        await api(`/api/iq/candidates/${encodeURIComponent(id)}`, { method: "DELETE" });
        candidates = candidates.filter((c) => c.id !== id);
        closeCard();
        render();
        reload();
      } catch (err) {
        toast(err.message, "error");
      }
    } else if (act === "edit") {
      closeCard();
      openSheet({ candidate: cand, focusPhone: !cand.phone });
    } else if (act === "start") {
      if (needResultsEmail()) return;
      // The assessment is its own page — open it with this candidate's link,
      // same as their emailed invite. It replaces the dashboard in this tab so
      // Back can't bring the candidate to it.
      if (cand.link) window.location.replace(cand.link);
    } else if (act === "copy") {
      try {
        await navigator.clipboard.writeText(cand.link);
        toast(`Copied ${firstName(cand)}'s questionnaire link — it's theirs alone, so send it only to them.`, "ok");
      } catch (_) {
        window.prompt("Copy this questionnaire link:", cand.link);
      }
    } else if (act === "invite") {
      if (needResultsEmail() || sendingIds.has(cand.id)) return;
      if (!mail.ready) {
        openDraft(cand);
        return;
      }
      sendingIds.add(cand.id);
      if (cardId) renderCard();
      let kind, msg;
      try {
        const r = await api("/api/iq/invite", { method: "POST", body: { ids: [cand.id] } });
        if (r.needsMail) {
          mail.ready = false;
          sendingIds.delete(cand.id);
          openDraft(cand);
          return;
        }
        if (r.failed && r.failed.length) throw new Error(r.failed[0].error);
        if (!(r.sent || []).length) throw new Error("it's being sent from another device right now");
        markInvited(cand);
        kind = "ok";
        msg = `Questionnaire emailed to ${cand.email} ✓`;
      } catch (err) {
        console.error("Invite failed:", err);
        kind = "error";
        msg = err.needsResults ? err.message : `Couldn't send the invite — ${err.message}`;
      } finally {
        sendingIds.delete(cand.id);
        render();
        reload();
      }
      setNote(kind, msg);
      toast(msg, kind);
    }
  }

  /* ---------------- sending the questionnaire ---------------- */

  function markInvited(cand) {
    const fresh = candidates.find((c) => c.id === cand.id);
    if (fresh && fresh.status !== "completed") fresh.status = "invited";
  }

  // Candidates whose invite is on its way right now; they are never sent twice.
  const sendingIds = new Set();

  // Without a results address, a finished questionnaire has nowhere to be emailed.
  function needResultsEmail() {
    if (settings.managerEmail) return false;
    closeCard();
    toast("Choose your team under Results delivery first — completed questionnaires are sent there.", "error");
    teamSelect.scrollIntoView({ behavior: "smooth", block: "center" });
    teamSelect.focus({ preventScroll: true });
    return true;
  }

  // The Sales IQ invitation, word for word — for a draft on this device when
  // no mailbox is connected. The server sends the same words otherwise.
  function inviteBody(c) {
    const first = String(c.name || "").trim().split(/\s+/)[0];
    return [
      first ? `Hi ${first},` : "Hi,",
      "",
      `Thanks for your interest in joining the ${COMPANY} sales team!`,
      "",
      "As the next step in our hiring process, please complete our short",
      "Sales Talent Questionnaire — 10 quick questions, about 5 minutes:",
      "",
      c.link,
      "",
      "Answer honestly and go with your instincts. Your responses are sent",
      "directly to our hiring team, and we'll reach out about next steps.",
      "",
      "Best regards,",
      `${COMPANY} Hiring Team`,
    ].join("\n");
  }
  const INVITE_SUBJECT = `${COMPANY} — Sales Talent Questionnaire (next step)`;

  function inviteMailto(c) {
    return `mailto:${encodeURIComponent(c.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(INVITE_SUBJECT)}&body=${encodeURIComponent(inviteBody(c))}`;
  }

  // One personalized draft, opened in the device's mail app.
  function openDraft(cand) {
    window.location.href = inviteMailto(cand);
    markInvited(cand);
    render();
    api("/api/iq/mark-invited", { method: "POST", body: { ids: [cand.id] } }).then(reload).catch((err) => toast(err.message, "error"));
    setNote("ok", "Your mail app has opened with the invite — just hit send.");
  }

  // Never automatic: every path here starts from a button the manager pressed.
  async function sendTo(list) {
    list = list.filter((c) => (c.status || "added") === "added" && !sendingIds.has(c.id));
    if (!list.length || needResultsEmail()) return;

    if (!mail.ready) {
      if (list.length === 1) openDraft(list[0]);
      else openSendSheet(list);
      return;
    }

    list.forEach((c) => sendingIds.add(c.id));
    renderSendbar();
    setNote("", list.length > 1 ? `Sending ${list.length} invites…` : "Sending invite…");
    let kind, msg;
    let sent = 0;
    let skipped = 0;
    const failed = [];
    try {
      // A few at a time: each is its own email from your mailbox. Anyone sent
      // to from another device meanwhile is skipped, not emailed twice.
      let ids = list.map((c) => c.id);
      while (ids.length) {
        const r = await api("/api/iq/invite", { method: "POST", body: { ids, onlyNew: true } });
        if (r.needsMail) {
          mail.ready = false;
          const rest = list.filter((c) => ids.includes(c.id));
          rest.forEach((c) => sendingIds.delete(c.id));
          if (rest.length === 1) openDraft(rest[0]); else openSendSheet(rest);
          break;
        }
        (r.sent || []).forEach((id) => { sent++; const c = list.find((x) => x.id === id); if (c) markInvited(c); });
        (r.failed || []).forEach((f) => failed.push(f));
        (r.skipped || []).forEach(() => skipped++);
        ids = r.remaining || [];
        if (ids.length) setNote("", `Sending invites… ${sent} of ${list.length}`);
      }
      kind = failed.length ? "error" : "ok";
      msg = failed.length
        ? `Sent ${sent} of ${list.length} — retry the others from their rows.`
        : `Questionnaire sent to ${sent} candidate${sent === 1 ? "" : "s"} ✓${skipped ? ` — ${skipped} already had it from another device` : ""}`;
    } catch (err) {
      console.error("Batch send failed:", err);
      kind = "error";
      msg = err.needsResults ? err.message : sent
        ? `Sent ${sent} of ${list.length} — retry the others from their rows.`
        : `Couldn't send the invites — ${err.message}`;
    } finally {
      list.forEach((c) => sendingIds.delete(c.id));
      render();
      reload();
    }
    if (!sent && !failed.length && !mail.ready) return;
    setNote(kind, msg);
    toast(msg, kind);
  }

  sendAllBtn.addEventListener("click", () => sendTo(pendingCandidates()));

  /* ---------------- one draft per person (no mailbox connected) ---------------- */

  const sendBackdrop = $("#siq-send-backdrop");
  const sendList = $("#siq-send-list");

  function openSendSheet(list) {
    sendList.innerHTML = "";
    list.forEach((cand) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "send-item";
      btn.innerHTML = `
        <span class="q-avatar">${escapeHtml(initials(cand.name)) || "?"}</span>
        <span class="send-item-text">
          <span class="send-item-name">${escapeHtml(cand.name)}</span>
          <span class="send-item-email">${escapeHtml(cand.email)}</span>
        </span>
        <span class="send-item-state">Open email</span>`;
      btn.addEventListener("click", () => {
        openDraft(cand);
        btn.classList.add("sent");
        btn.querySelector(".send-item-state").textContent = "Opened ✓";
      });
      sendList.appendChild(btn);
    });
    sendBackdrop.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeSendSheet() {
    sendBackdrop.hidden = true;
    document.body.style.overflow = "";
  }
  $("#siq-send-done").addEventListener("click", closeSendSheet);
  sendBackdrop.addEventListener("click", (e) => {
    if (e.target === sendBackdrop) closeSendSheet();
  });

  /* ---------------- Calendly bookings ---------------- */

  const chip = $("#siq-conn-chip");
  const sub = $("#siq-conn-sub");
  const btnConnect = $("#siq-conn-connect");
  const btnSync = $("#siq-conn-sync");
  const btnCalSettings = $("#siq-conn-settings");

  function agoText(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    return m === 1 ? "1 min ago" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  function renderStatus() {
    const connected = Boolean(calendly.syncEnabled || calendly.webhook);
    btnConnect.hidden = connected;
    btnConnect.parentElement.hidden = connected;
    btnSync.hidden = !calendly.syncEnabled;
    btnCalSettings.hidden = !connected;
    // On phones a connection that needs attention moves to the top.
    root.classList.toggle("needs-connection", loaded && !connected);

    if (!connected) {
      chip.textContent = "Not connected";
      chip.className = "conn-chip";
      sub.textContent =
        "Connect Calendly in Settings and everyone who books an interview is added here automatically — you choose when to send them the questionnaire.";
      return;
    }
    if (calendly.error && calendly.syncEnabled) {
      chip.textContent = "Sync failed";
      chip.className = "conn-chip error";
      const err = String(calendly.error).trim().replace(/[.!?]?$/, ".");
      sub.textContent = calendly.webhook
        ? `Calendly didn't answer: ${err} New bookings still arrive through booking alerts.`
        : `Calendly didn't answer: ${err} Check your Calendly token in Settings.`;
      return;
    }
    chip.textContent = "Live";
    chip.className = "conn-chip live";
    const upcoming = candidates.filter((c) => !c.interviewCanceled && Date.parse(c.interviewAt || "") >= Date.now() - 3600 * 1000).length;
    const parts = [(hostTeam && hostTeam.name) || "Calendly"];
    const last = Date.parse(calendly.lastSyncAt || "");
    if (Number.isFinite(last)) parts.push(`checked ${agoText(last)}`);
    parts.push(upcoming === 1 ? "1 upcoming interview" : `${upcoming} upcoming interviews`);
    let text = parts.join(" · ");
    if (!calendly.syncEnabled) text += " — booking alerts only; add your Calendly token in Settings to sync every interview.";
    sub.textContent = text;
  }

  function goToCalendly() {
    const nav = document.querySelector('.nav-item[data-view="settings"]');
    if (nav) nav.click();
    setTimeout(() => {
      const card = $("#calendlyCard");
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      const field = $("#calendlyToken");
      if (field) { field.focus({ preventScroll: true }); field.classList.add("flash"); setTimeout(() => field.classList.remove("flash"), 2200); }
    }, 80);
  }
  btnConnect.addEventListener("click", goToCalendly);
  btnCalSettings.addEventListener("click", goToCalendly);

  let lastRefreshAt = 0;
  const REFRESH_MS = 2 * 60 * 1000;
  // Ask the server to re-read Calendly — shared with everyone else asking,
  // and never more than once a minute and a half however many are.
  async function refreshCalendly(force) {
    if (!calendly.syncEnabled) return;
    if (!force && Date.now() - lastRefreshAt < REFRESH_MS) return;
    lastRefreshAt = Date.now();
    try {
      const r = await api("/api/iq/sync", { method: "POST" });
      if (r && (r.ran || r.added)) await reload();
    } catch (_) { /* the next look will say how things stand */ }
  }

  btnSync.addEventListener("click", async () => {
    const label = btnSync.querySelector("span") || btnSync;
    btnSync.disabled = true;
    label.textContent = "Syncing…";
    try {
      await refreshCalendly(true);
      await reload();
    } finally {
      btnSync.disabled = false;
      label.textContent = "Sync now";
    }
  });

  /* ---------------- telling the manager ---------------- */

  function announce(added) {
    const title =
      added.length === 1
        ? `${added[0].name} booked an interview`
        : `${added.length} new interview bookings`;
    toast(`${title} — they're on your candidate list, ready for the questionnaire.`, "ok");
  }

  /* ---------------- toast ---------------- */

  const toastEl = $("#siq-toast");
  let toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "q-toast" + (kind ? " " + kind : "");
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 7000);
  }

  /* ---------------- a report opened from its link ---------------- */

  // #salesiq?report=<id> — the link in a results email. A "WPR1." code in its
  // place is a report link from the standalone Sales IQ app: filed here.
  // Read as soon as this script runs: the site tidies the address bar down
  // to #salesiq while it starts, long before the list has arrived.
  const readReportHash = () => {
    const m = window.location.hash.match(/^#salesiq\?report=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  let pendingReport = readReportHash();

  async function openPendingReport() {
    if (!pendingReport || !loaded) return;
    const value = pendingReport;
    pendingReport = null;
    let id = value;
    if (/WPR1\./.test(value)) {
      try {
        const r = await api("/api/iq/import-report", { method: "POST", body: { code: value } });
        await reload();
        id = r.report ? r.report.id : "";
        toast(
          r.retake
            ? `Retake filed — ${r.name} already took the questionnaire; their first score (${r.official}/100) stands.`
            : `Report added — ${r.name} scored ${r.score}/100 (${r.tier})`,
          r.retake ? "error" : "ok"
        );
      } catch (err) {
        toast(err.message || "That report link couldn't be opened.", "error");
        return;
      }
    }
    const row = reportList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) {
      if (!/WPR1\./.test(value)) toast("That report has been removed from the dashboard.", "error");
      return;
    }
    row.classList.add("q-flash");
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains("report-detail")) {
      detail.hidden = false;
      row.setAttribute("aria-expanded", "true");
    }
    setTimeout(() => row.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
  }
  window.addEventListener("hashchange", () => {
    const v = readReportHash();
    if (!v) return;
    pendingReport = v;
    history.replaceState(history.state, "", window.location.pathname + window.location.search + "#salesiq");
    openPendingReport();
  });

  /* ---------------- add/edit sheet ---------------- */

  const backdrop = $("#siq-sheet-backdrop");
  const sheetForm = $("#siq-sheet-form");
  const sheetTitle = $("#siq-sheet-title");
  const sheetSub = $("#siq-sheet-sub");
  const sheetName = $("#siq-sheet-name");
  const sheetEmail = $("#siq-sheet-email");
  const sheetPhone = $("#siq-sheet-phone");
  let editingId = null;
  let editingFrom = null;
  let editingSource = "manual";

  function openSheet({ candidate = null, prefill = null, fromResume = false, focusPhone = false } = {}) {
    editingId = candidate ? candidate.id : null;
    editingSource = fromResume ? "resume" : "manual";
    const src = candidate || prefill || { name: "", email: "", phone: "" };
    editingFrom = { name: src.name || "", email: src.email || "", phone: src.phone || "" };
    sheetName.value = src.name || "";
    sheetEmail.value = src.email || "";
    sheetPhone.value = src.phone || "";
    sheetTitle.textContent = candidate ? "Edit candidate" : "New hire";
    sheetSub.innerHTML = fromResume
      ? '<span class="from-resume">Read from the résumé ✓</span> — double-check the details, then save.'
      : "Enter the candidate's contact details.";
    sheetForm.querySelectorAll(".field").forEach((f) => f.classList.remove("invalid"));
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => (focusPhone ? sheetPhone : sheetName).focus(), 60);
  }

  function closeSheet() {
    backdrop.hidden = true;
    document.body.style.overflow = "";
    editingId = null;
  }

  sheetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = sheetName.value.trim();
    const email = sheetEmail.value.trim();
    const phone = sheetPhone.value.trim();

    const nameOk = name.length >= 2;
    const emailOk = EMAIL_RE.test(email);
    sheetName.closest(".field").classList.toggle("invalid", !nameOk);
    sheetEmail.closest(".field").classList.toggle("invalid", !emailOk);
    if (!nameOk || !emailOk) return;

    const saveBtn = $("#siq-sheet-save");
    saveBtn.disabled = true;
    try {
      if (editingId) {
        // Only what the manager changed: a sync while the sheet was open (a
        // booking filling in the phone) must not be undone by the old values.
        const edits = {};
        for (const [k, v] of Object.entries({ name, email, phone })) {
          if (v !== editingFrom[k].trim()) edits[k] = v;
        }
        if (Object.keys(edits).length) {
          await api(`/api/iq/candidates/${encodeURIComponent(editingId)}`, { method: "PATCH", body: edits });
        }
      } else {
        await api("/api/iq/candidates", { method: "POST", body: { name, email, phone, source: editingSource } });
      }
      closeSheet();
      await reload();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  $("#siq-sheet-cancel").addEventListener("click", closeSheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!backdrop.hidden) closeSheet();
    else if (!cardBackdrop.hidden) closeCard();
    else if (!sendBackdrop.hidden) closeSendSheet();
  });
  [sheetName, sheetEmail].forEach((el) =>
    el.addEventListener("input", () => el.closest(".field").classList.remove("invalid"))
  );

  tileAdd.addEventListener("click", () => openSheet());

  /* ---------------- resume upload ----------------
     Name, email and phone are read from the PDF on this device, with a copy
     of Mozilla's pdf.js — no résumé ever leaves the browser. It is fetched the
     first time a résumé is read rather than with every page. */

  const PDFJS = "/salesiq/pdf.min.js";
  const PDFJS_WORKER = "/salesiq/pdf.worker.min.js";
  let pdfjsLoading = null;
  function loadPdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsLoading) {
      pdfjsLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PDFJS;
        s.onload = () => (window.pdfjsLib ? resolve(window.pdfjsLib) : reject(new Error("PDF reader didn't load.")));
        s.onerror = () => { pdfjsLoading = null; reject(new Error("PDF reader isn't loaded yet — check your connection and try again.")); };
        document.head.appendChild(s);
      });
    }
    return pdfjsLoading;
  }

  const RESUME_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/;
  const NON_NAME_WORDS = /\b(resume|curriculum|vitae|objective|summary|profile|experience|education|skills|references|address|street|ave|avenue|blvd|suite|linkedin|github|www|http)\b/i;

  /** Groups positioned text items into visual lines (top-to-bottom). */
  function itemsToLines(textContent) {
    const rows = [];
    for (const item of textContent.items) {
      const str = (item.str || "").trim();
      if (!str) continue;
      const y = item.transform[5];
      const size = Math.hypot(item.transform[0], item.transform[1]) || 0;
      let row = rows.find((r) => Math.abs(r.y - y) < 4);
      if (!row) {
        row = { y, parts: [], size: 0 };
        rows.push(row);
      }
      row.parts.push({ x: item.transform[4], str });
      row.size = Math.max(row.size, size);
    }
    rows.sort((a, b) => b.y - a.y); // PDF y-axis points up
    return rows.map((r) => ({
      text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim(),
      size: r.size,
    }));
  }

  function looksLikeName(text) {
    if (!text || text.length > 44) return false;
    if (/[@\d]/.test(text)) return false;
    if (NON_NAME_WORDS.test(text)) return false;
    const words = text.replace(/[,.]/g, "").split(/\s+/);
    if (words.length < 2 || words.length > 5) return false;
    return words.every((w) => /^[A-ZÀ-Ž][A-Za-zÀ-ž'’.\-]*$/.test(w) || /^[A-Z]{2,}$/.test(w));
  }

  function titleCase(s) {
    return s
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function pickName(lines) {
    const top = lines.slice(0, 12);
    const found = top.filter((l) => looksLikeName(l.text));
    if (!found.length) return "";
    // prefer the largest-font candidate (resume headers are big)
    found.sort((a, b) => b.size - a.size);
    const name = found[0].text.replace(/[,.]+$/, "");
    return /^[A-Z\s'.\-]+$/.test(name) ? titleCase(name) : name;
  }

  function formatPhone(raw) {
    const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return raw.trim();
  }

  /**
   * Parses a resume PDF File and resolves {name, email, phone}.
   * Missing fields come back as "" — never rejects for missing
   * data, only for unreadable files.
   */
  async function parseResume(file) {
    const pdfjsLib = await loadPdfjs();
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;

    let lines = [];
    let fullText = "";
    const pageCount = Math.min(pdf.numPages, 2);
    for (let p = 1; p <= pageCount; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageLines = itemsToLines(content);
      if (p === 1) lines = pageLines;
      fullText += pageLines.map((l) => l.text).join("\n") + "\n";
    }

    const emailMatch = fullText.match(RESUME_EMAIL_RE);
    const phoneMatch = fullText.match(PHONE_RE);
    let name = pickName(lines);

    // fallback: derive a readable name from the email's local part
    if (!name && emailMatch) {
      const local = emailMatch[0].split("@")[0].replace(/\d+/g, "");
      const parts = local.split(/[._\-]+/).filter(Boolean);
      if (parts.length) name = titleCase(parts.join(" "));
    }

    return {
      name: name || "",
      email: emailMatch ? emailMatch[0] : "",
      phone: phoneMatch ? formatPhone(phoneMatch[0]) : "",
    };
  }

  async function handleResumeFile(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStatus("error", "Please upload a PDF file.");
      return;
    }
    tileUpload.classList.add("busy");
    setStatus("reading", `Reading ${file.name}…`, true);
    try {
      const extracted = await parseResume(file);
      setStatus("", "");
      if (!extracted.name && !extracted.email && !extracted.phone) {
        setStatus("error", "Couldn't find contact details in that PDF — add them manually.");
        openSheet({ fromResume: false });
      } else {
        openSheet({ prefill: extracted, fromResume: true });
      }
    } catch (err) {
      console.error("Resume parse failed:", err);
      setStatus("error", "Couldn't read that PDF — try another file or add the candidate manually.");
    } finally {
      tileUpload.classList.remove("busy");
      fileInput.value = "";
    }
  }

  tileUpload.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleResumeFile(fileInput.files[0]));

  ["dragover", "dragenter"].forEach((ev) =>
    tileUpload.addEventListener(ev, (e) => {
      e.preventDefault();
      tileUpload.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    tileUpload.addEventListener(ev, () => tileUpload.classList.remove("dragover"))
  );
  tileUpload.addEventListener("drop", (e) => {
    e.preventDefault();
    tileUpload.classList.remove("dragover");
    handleResumeFile(e.dataTransfer.files[0]);
  });

  /* ---------------- while the page is open ---------------- */

  const POLL_MS = 30 * 1000;
  let pollTimer = null;

  function tick(force) {
    if (!active || document.hidden) return;
    load().catch(() => {});
    refreshCalendly(force === true);
  }

  function activate() {
    if (active) return;
    active = true;
    renderHead();
    if (!loaded) load().catch((err) => toast(err.message, "error"));
    else tick(true);
    refreshCalendly(false);
    clearInterval(pollTimer);
    pollTimer = setInterval(tick, POLL_MS);
    if (loaded) openPendingReport();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    clearInterval(pollTimer);
    pollTimer = null;
    if (!cardBackdrop.hidden) closeCard();
    if (!backdrop.hidden) closeSheet();
    if (!sendBackdrop.hidden) closeSendSheet();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && active) { refreshTimes(); tick(true); }
  });
  window.addEventListener("online", () => tick(true));

  /* ---------------- for the rest of the site ---------------- */

  // "Send questionnaire" from a pipeline candidate (the Candidates page and
  // its phone card): onto the Sales IQ list and sent, from here.
  async function sendFromPipeline(pc) {
    const r = await api("/api/iq/from-pipeline", { method: "POST", body: { candidateId: pc.id } });
    etag = "";
    if (r.needsMail && r.draft) {
      window.location.href = `mailto:${encodeURIComponent(r.draft.to).replace(/%40/g, "@")}?subject=${encodeURIComponent(r.draft.subject)}&body=${encodeURIComponent(r.draft.body)}`;
      await api("/api/iq/mark-invited", { method: "POST", body: { ids: [r.id] } });
    }
    if (loaded) reload();
    return r;
  }

  // One person on the Sales IQ list, sent the questionnaire from elsewhere on
  // the site (an interview in the Interviews booked list). The same rules as
  // the card's own button: a results address first, and a draft on this
  // device when no mailbox is connected.
  async function sendInvite(id) {
    // From elsewhere on the site this page's list may be minutes old: look
    // again, so the person is found and their status is today's.
    etag = "";
    await load();
    const cand = candidates.find((c) => c.id === id);
    if (!cand) throw new Error("That candidate is no longer on the Sales IQ list.");
    if (cand.status === "completed") return { already: "completed", cand };
    if (cand.status === "invited") return { already: "invited", cand };
    if (!settings.managerEmail) {
      const e = new Error("Choose your team under Sales IQ → Results delivery first — completed questionnaires are sent there.");
      e.needsResults = true;
      throw e;
    }
    if (!mail.ready) { openDraft(cand); return { draft: true, cand }; }
    const r = await api("/api/iq/invite", { method: "POST", body: { ids: [id], onlyNew: true } });
    if (r.needsMail) { mail.ready = false; openDraft(cand); return { draft: true, cand }; }
    if (r.failed && r.failed.length) throw new Error(r.failed[0].error);
    if (!(r.sent || []).length) return { already: "invited", cand };
    markInvited(cand);
    reload();
    return { sent: true, cand };
  }

  // Straight to someone's card, from wherever they were mentioned.
  async function openCandidate(id) {
    etag = "";
    await load();
    if (candidates.some((c) => c.id === id)) openCard(id);
  }

  // Is something open that a reload would throw away?
  function busy() {
    return !backdrop.hidden || !cardBackdrop.hidden || !sendBackdrop.hidden || sendingIds.size > 0;
  }

  // Signed in to another team, or signed out: nothing of the last team's may
  // stay on screen, an answer still on its way for it is dropped, and its list
  // is not "new bookings" for the next one. `signedIn` says whether there is a
  // team to look again for.
  function reset(signedIn) {
    const wasActive = active;
    generation++;
    loading = null;
    deactivate();
    loaded = false;
    etag = "";
    knownIds = null;
    candidates = [];
    reports = [];
    settings = { team: "", managerEmail: "" };
    calendly = { syncEnabled: false, webhook: false, lastSyncAt: null, error: "" };
    mail = { ready: false, from: "", reason: "" };
    hostTeam = null;
    pendingReport = null;
    lastRefreshAt = 0;
    managerInput.value = "";
    teamSelect.value = "";
    render();
    renderReports();
    if (wasActive && signedIn) activate();
  }

  window.SalesIQ = { activate, deactivate, reload, reset, sendFromPipeline, sendInvite, openCandidate, busy };
})();
