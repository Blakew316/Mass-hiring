/* =========================================================
   Wholesale Payments · Sales Talent Questionnaire
   The candidate's page — the Sales IQ assessment engine, now
   answering to this site rather than to an email.
   - Identity comes from the signed link (?t=…): the site says
     who it was prepared for, and the answers are filed under
     that person. Without a valid link it can't be started.
   - The run is one-way: welcome → 10 questions → complete.
     Completion is recorded, on this device and on the site,
     so reopening the link, refreshing, going back or
     finishing in a second tab all land on the completion
     screen — never a restart.
   - The candidate never sees a score. The page is sent the
     question text only; the site scores the answers when they
     arrive, and the results go to the hiring team.
   - ?preview=1 is the dashboard's preview: nothing is
     recorded, locked or sent.
   ========================================================= */

(() => {
  "use strict";

  const PROGRESS_KEY = "wpq-progress-v2";
  const DONE_KEY = "wpq-done-v1";
  const SESSION_KEY = "wpq-session-v1";
  const API = "/api/assessment/";

  const params = new URLSearchParams(window.location.search);
  const PREVIEW = params.get("preview") === "1";
  const TOKEN = (params.get("t") || "").trim();
  const RUN_KEY = PREVIEW ? "preview" : TOKEN ? "t:" + TOKEN : "none";
  // A link that says nothing about who it is for has nowhere to send the
  // answers, so it can't be started.
  const NO_ROUTE = !PREVIEW && !TOKEN;

  let QUESTIONS = [];
  let VERSION = "";

  const state = {
    screen: null,
    current: 0,
    answers: [],
    candidate: { name: "", email: "" },
    startedAt: null,
    finished: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const screens = {
    welcome: $("#screen-welcome"),
    quiz: $("#screen-quiz"),
    complete: $("#screen-complete"),
  };

  /* ---------------- storage ---------------- */

  // Progress is per run, and outlives the tab so an accidental close resumes
  // where it left off. A preview keeps its progress to the tab and never
  // touches a real candidate's record.
  const progressStore = PREVIEW ? window.sessionStorage : window.localStorage;

  function readMap(store, key) {
    try {
      const v = JSON.parse(store.getItem(key) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch (_) {
      return {};
    }
  }

  function writeEntry(store, key, value) {
    try {
      const map = readMap(store, key);
      if (value === null) delete map[RUN_KEY];
      else map[RUN_KEY] = value;
      store.setItem(key, JSON.stringify(map));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readDone() {
    if (PREVIEW) return null;
    const rec = readMap(window.localStorage, DONE_KEY)[RUN_KEY];
    return rec && Array.isArray(rec.answers) ? rec : null;
  }

  const writeDone = (rec) => !PREVIEW && writeEntry(window.localStorage, DONE_KEY, rec);

  /* ---------------- screen navigation ---------------- */

  function showScreen(name, direction = "forward") {
    const to = screens[name];
    if (!to || state.screen === name) return;
    Object.values(screens).forEach((s) =>
      s.classList.remove("is-active", "enter-forward", "enter-back")
    );
    to.classList.add("is-active", direction === "forward" ? "enter-forward" : "enter-back");
    state.screen = name;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------------- progress UI ---------------- */

  const progressFill = $("#progress-fill");
  const progressWrap = $("#progress-bar-wrap");
  const progressLabel = $("#progress-label");
  const dotsWrap = $("#progress-dots");

  function buildDots() {
    dotsWrap.innerHTML = "";
    QUESTIONS.forEach(() => dotsWrap.appendChild(document.createElement("span")));
  }

  function updateProgress() {
    const idx = state.current;
    const pct = Math.round(((idx + 1) / QUESTIONS.length) * 100);
    progressFill.style.width = pct + "%";
    progressWrap.setAttribute("aria-valuenow", String(pct));
    progressLabel.textContent = `Question ${idx + 1} of ${QUESTIONS.length}`;
    [...dotsWrap.children].forEach((dot, i) => {
      dot.className = "";
      if (state.answers[i] !== null) dot.classList.add("done");
      if (i === idx) dot.classList.add("current");
    });
  }

  /* ---------------- question rendering ---------------- */

  const questionCard = $("#question-card");
  const questionText = $("#question-text");
  const optionsWrap = $("#options");
  const btnPrev = $("#btn-prev");
  const btnNext = $("#btn-next");
  const btnStart = $("#btn-start");
  const LETTERS = ["A", "B", "C", "D"];
  let animating = false;

  function renderQuestion() {
    const q = QUESTIONS[state.current];
    if (!q) return;
    questionText.textContent = q.text;
    optionsWrap.innerHTML = "";

    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option" + (state.answers[state.current] === i ? " selected" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(state.answers[state.current] === i));
      const letter = document.createElement("span");
      letter.className = "option-letter";
      letter.textContent = LETTERS[i];
      const text = document.createElement("span");
      text.textContent = opt;
      btn.append(letter, text);
      btn.addEventListener("click", () => selectOption(i));
      optionsWrap.appendChild(btn);
    });

    btnPrev.disabled = false;
    btnNext.disabled = state.answers[state.current] === null;
    btnNext.innerHTML =
      state.current === QUESTIONS.length - 1
        ? `Complete <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : `Next <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
    updateProgress();
  }

  function selectOption(i) {
    if (state.finished || animating || state.screen !== "quiz") return;
    const at = state.current;
    state.answers[at] = i;
    [...optionsWrap.children].forEach((el, j) => {
      el.classList.toggle("selected", j === i);
      el.setAttribute("aria-checked", String(j === i));
    });
    btnNext.disabled = false;
    updateProgress();
    saveProgress();
    // brief pause so the selection state is visible, then auto-advance —
    // only if the candidate is still on the question they just answered, and
    // never off the last one: submitting takes a deliberate Complete
    setTimeout(() => {
      if (
        at < QUESTIONS.length - 1 &&
        state.screen === "quiz" && state.current === at && state.answers[at] === i
      ) advance(1);
    }, 350);
  }

  function advance(dir) {
    if (state.finished || animating || state.screen !== "quiz") return;
    if (dir > 0 && state.answers[state.current] === null) return;

    const nextIdx = state.current + dir;
    if (nextIdx < 0) {
      showScreen("welcome", "back");
      return;
    }
    if (nextIdx >= QUESTIONS.length) {
      finishQuiz();
      return;
    }

    animating = true;
    questionCard.classList.add(dir > 0 ? "leaving-fwd" : "leaving-back");
    setTimeout(() => {
      state.current = nextIdx;
      renderQuestion();
      saveProgress();
      questionCard.classList.remove("leaving-fwd", "leaving-back");
      questionCard.classList.add(dir > 0 ? "entering-fwd" : "entering-back");
      setTimeout(() => {
        questionCard.classList.remove("entering-fwd", "entering-back");
        animating = false;
      }, 420);
    }, 260);
  }

  /* ---------------- completion (terminal, score hidden) ---------------- */

  const completeMessage = $("#complete-message");
  const completeStatus = $("#complete-status");

  function setStatus(kind, text) {
    completeStatus.className = "complete-status" + (kind ? " " + kind : "");
    completeStatus.textContent = text;
  }

  function showComplete(record, returning) {
    state.finished = true;
    const first = (state.candidate.name || "").split(" ")[0];
    $("#complete-heading").textContent = returning
      ? "You've already completed this assessment"
      : first
        ? `Thank you, ${first}!`
        : "Thank you!";
    showScreen("complete", "forward");
  }

  // Another tab finished (or is finishing) this run: it sends first; this one
  // only follows up if that send hasn't landed by the next retry.
  function followUp(record) {
    reportStatus(record);
    if (!record.delivered && !record.refused) scheduleRetry(record);
  }

  function newId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return "r" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function finishQuiz() {
    if (state.finished) return;
    state.finished = true;

    // Finished in another tab while this one sat open: that submission stands.
    const already = readDone();
    if (already) {
      if (already.candidate) setKnownCandidate(already.candidate);
      showComplete(already, true);
      followUp(already);
      return;
    }

    const record = {
      id: newId(),
      completedAt: new Date().toISOString(),
      answers: state.answers.slice(),
      durationSec: state.startedAt
        ? Math.max(1, Math.round((Date.now() - state.startedAt) / 1000))
        : null,
      candidate: { ...state.candidate },
      preview: PREVIEW,
      delivered: false,
    };

    clearProgress();
    if (!PREVIEW) writeDone(record);
    showComplete(record, false);
    deliver(record);
  }

  /* ---------------- delivery ---------------- */

  const SUBMITTED =
    "Your responses have been submitted to the Wholesale Payments hiring team. We'll review them and reach out about next steps. You can close this page.";

  let delivering = false;
  let retryTimer = null;
  let retryDelay = 15000;

  function scheduleRetry(record) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => deliver(record), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5 * 60 * 1000);
  }

  // "Submitted" is only ever said once the site has confirmed it has them.
  function reportStatus(record) {
    if (record.preview) {
      completeMessage.textContent = "This was a preview of the candidate's assessment.";
      setStatus("", "Preview complete — nothing was recorded or sent.");
    } else if (record.delivered) {
      completeMessage.textContent = SUBMITTED;
      setStatus("ok", "Your responses have been delivered to the hiring team ✓");
    } else if (record.refused) {
      completeMessage.textContent =
        "Your answers are saved on this device, but this link couldn't be used to submit them. Please contact your recruiter.";
      setStatus("error", record.refused);
    } else {
      completeMessage.textContent =
        "Your responses are being submitted to the Wholesale Payments hiring team — please keep this page open until they're delivered.";
      setStatus("", "Submitting your responses…");
    }
  }

  async function deliver(record) {
    reportStatus(record);
    if (record.preview || record.delivered || record.refused) return;
    if (delivering) return;
    const stored = readDone();
    if (stored && stored.id === record.id && stored.delivered) {
      record.delivered = true;
      clearTimeout(retryTimer);
      reportStatus(record);
      return;
    }
    delivering = true;
    reportStatus(record);
    try {
      const res = await fetch(API + "submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: TOKEN, id: record.id, answers: record.answers, durationSec: record.durationSec }),
        cache: "no-store",
        keepalive: true,
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data && data.ok) {
        record.delivered = true;
        writeDone(record);
        clearTimeout(retryTimer);
        reportStatus(record);
      } else if ((res.status === 404 && data && data.invalid) || res.status === 400) {
        // A link the site doesn't accept, or answers it can't read, won't be
        // accepted on a retry either. Anything else — the site busy, a
        // conflict, a hiccup — is tried again until it goes.
        record.refused = (data && data.error) || "This link couldn't be used to submit your answers.";
        writeDone(record);
        clearTimeout(retryTimer);
        reportStatus(record);
      } else {
        throw new Error("status " + res.status);
      }
    } catch (err) {
      console.error("Result delivery failed, will retry:", err);
      setStatus(
        "",
        "Your responses are saved on this device and will be submitted automatically as soon as the connection is back — keep this page open."
      );
      scheduleRetry(record);
    } finally {
      delivering = false;
    }
  }

  window.addEventListener("online", () => {
    const record = readDone();
    if (record && !record.delivered && !record.refused) {
      retryDelay = 15000;
      deliver(record);
    }
  });

  // Closing the page before the submission lands strands it here.
  window.addEventListener("beforeunload", (e) => {
    const record = readDone();
    if (record && !record.delivered && !record.refused) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------------- persistence (resume mid-quiz) ---------------- */

  function saveProgress() {
    writeEntry(progressStore, PROGRESS_KEY, {
      current: state.current,
      answers: state.answers,
      startedAt: state.startedAt,
      version: VERSION,
    });
  }

  function loadProgress() {
    const saved = readMap(progressStore, PROGRESS_KEY)[RUN_KEY];
    if (!saved || !saved.startedAt) return false;
    // Progress against a different set of questions can't be carried over.
    if (saved.version && saved.version !== VERSION) return false;
    if (!Array.isArray(saved.answers) || saved.answers.length !== QUESTIONS.length) return false;
    state.answers = saved.answers.map((a, i) =>
      Number.isInteger(a) && a >= 0 && a < QUESTIONS[i].options.length ? a : null
    );
    state.current = Math.min(Math.max(Number(saved.current) || 0, 0), QUESTIONS.length - 1);
    state.startedAt = saved.startedAt;
    return true;
  }

  function clearProgress() {
    writeEntry(progressStore, PROGRESS_KEY, null);
  }

  /* ---------------- candidate identity (no typing needed) ---------------- */

  const preparedFor = $("#prepared-for");

  function setKnownCandidate(c) {
    state.candidate = { name: (c && c.name) || "", email: (c && c.email) || "" };
    const who = state.candidate.name || state.candidate.email;
    preparedFor.hidden = !who;
    if (who) {
      $("#prepared-name").textContent = who;
      $("#prepared-avatar").textContent = who
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join("");
    }
  }

  /* ---------------- the session: who, what, and whether it's done ---------------- */

  // Kept on the device, so a reload with no connection still opens the
  // questionnaire it was already showing.
  function cachedSession() {
    const s = readMap(window.localStorage, SESSION_KEY)[RUN_KEY];
    return s && Array.isArray(s.questions) && s.questions.length ? s : null;
  }

  function cacheSession(s) {
    if (PREVIEW) return;
    writeEntry(window.localStorage, SESSION_KEY, {
      questions: s.questions, version: s.version, candidate: s.candidate, done: s.done || null,
    });
  }

  async function fetchSession() {
    const q = PREVIEW ? "preview=1" : "t=" + encodeURIComponent(TOKEN);
    const res = await fetch(API + "session?" + q, { cache: "no-store" });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 404 && data && data.invalid) {
      const e = new Error(data.error);
      e.invalid = true;
      throw e;
    }
    if (!res.ok || !data || !Array.isArray(data.questions)) throw new Error("status " + res.status);
    return data;
  }

  function stopAtWelcome(message) {
    $("#screen-welcome .lede").textContent = message;
    $("#screen-welcome .hero-points").hidden = true;
    btnStart.hidden = true;
    showScreen("welcome", "forward");
  }

  // With the questions in hand, pick up exactly where this run stands.
  function begin(session) {
    const changed = Boolean(VERSION) && session.version !== VERSION;
    QUESTIONS = session.questions;
    VERSION = session.version || "";
    if (changed || state.answers.length !== QUESTIONS.length) {
      // A different set of questions: whatever was answered can't carry over.
      state.answers = new Array(QUESTIONS.length).fill(null);
      state.current = 0;
      state.startedAt = null;
      if (changed) clearProgress();
    }
    buildDots();
    setKnownCandidate(session.candidate || {});
    btnStart.disabled = false;

    if (session.done) {
      // Finished already — on another device, or in a browser since cleared.
      const record = { delivered: true, candidate: state.candidate };
      showComplete(record, true);
      reportStatus(record);
    } else if (loadProgress()) {
      renderQuestion();
      showScreen("quiz", "forward");
    } else {
      renderQuestion();
      showScreen("welcome", "forward");
    }
  }

  let sessionRetry = null;
  async function load() {
    clearTimeout(sessionRetry);
    const cached = PREVIEW ? null : cachedSession();
    if (cached && !QUESTIONS.length) begin(cached);
    try {
      const s = await fetchSession();
      cacheSession(s);
      if (state.finished) return;
      if (!QUESTIONS.length || s.version !== VERSION || s.done) begin(s);
      else setKnownCandidate(s.candidate || {});
    } catch (err) {
      if (err.invalid) {
        stopAtWelcome(err.message);
        return;
      }
      if (QUESTIONS.length) return;   // running from the saved copy
      // No connection and nothing saved: say so, and keep trying.
      $("#screen-welcome .lede").textContent =
        "Can't reach the hiring team's site right now. Check your connection — this page will open the questionnaire as soon as it's back.";
      showScreen("welcome", "forward");
      sessionRetry = setTimeout(load, 10000);
    }
  }
  window.addEventListener("online", () => { if (!QUESTIONS.length && !NO_ROUTE) load(); });

  /* ---------------- wiring ---------------- */

  btnStart.addEventListener("click", () => {
    if (state.finished || NO_ROUTE || !QUESTIONS.length) return;
    if (!state.startedAt) state.startedAt = Date.now();
    saveProgress();
    renderQuestion();
    showScreen("quiz", "forward");
  });

  btnPrev.addEventListener("click", () => advance(-1));
  btnNext.addEventListener("click", () => advance(1));

  document.addEventListener("keydown", (e) => {
    if (state.screen !== "quiz" || state.finished) return;
    if (e.key >= "1" && e.key <= "4") {
      const i = Number(e.key) - 1;
      if (optionsWrap.children[i]) selectOption(i);
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      // Enter on a focused button (an option, Back, Next) is that button's click
      if (e.key === "Enter" && e.target.closest && e.target.closest("button")) return;
      e.preventDefault();
      advance(1);
    } else if (e.key === "ArrowLeft") {
      advance(-1);
    }
  });

  // Finished in another tab, or restored from the back/forward cache after
  // finishing elsewhere: jump straight to the completion screen.
  function adoptExternalCompletion() {
    if (PREVIEW || state.finished) return;
    const record = readDone();
    if (!record) return;
    if (record.candidate) setKnownCandidate(record.candidate);
    showComplete(record, true);
    followUp(record);
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== DONE_KEY) return;
    if (!state.finished) return adoptExternalCompletion();
    const record = readDone();
    if (record && record.delivered) {
      clearTimeout(retryTimer);
      reportStatus(record);
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) adoptExternalCompletion();
  });

  /* ---------------- offline note + service worker ---------------- */

  const offlineNote = $("#offline-note");
  const syncOnline = () => { offlineNote.hidden = navigator.onLine; };
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);
  syncOnline();

  // Its own small worker, scoped to this page, so a reload with no signal
  // still opens it. Not the dashboard's: a candidate's phone has no use for it.
  if ("serviceWorker" in navigator && !PREVIEW) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }

  /* ---------------- init ---------------- */

  $("#preview-pill").hidden = !PREVIEW;

  const done = readDone();
  if (NO_ROUTE) {
    stopAtWelcome("This link is incomplete, so your answers would have nowhere to go. Please contact your recruiter for a new link.");
  } else if (done) {
    setKnownCandidate(done.candidate || {});
    showComplete(done, true);
    deliver(done);
  } else {
    showScreen("welcome", "forward");
    load();
  }
})();
