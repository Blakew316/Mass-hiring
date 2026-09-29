// Email reply detection, for the dashboard and for the scheduled worker.
//
// It used to live only behind POST /api/replies/check, which only an open,
// visible dashboard called — so with the app closed nobody's reply was ever
// noticed, and the phone notification that exists to say "someone wrote back"
// never came. The scheduled function (netlify/src/send-queue.mjs) now runs
// this once a minute too, and both may run at once: which replies are new is
// decided inside the store's conditional write, so a reply is announced once
// however many callers see it (the same guarantee the route always had).
//
// Which threads to read: first, the ones Gmail says have had a message from
// someone else since the last look (one search, then only those threads);
// then the oldest-checked of everyone still waiting, as before, so nothing
// depends on the search alone.
const store = require('./store');
const storage = require('./storage');
const google = require('./google');
const notify = require('./notify');

// Local, cheap: (re)classify stored replies; drop bounces/auto-replies from
// the record, fix the status, and remove feed lines that were not real replies.
function reclassifyCandidate(c) {
  const all = (c.replies || []).map((r) => ({ ...r, kind: r.kind !== undefined ? r.kind : google.classifyReply(r) }));
  const real = all.filter((r) => !r.kind);
  const bounced = all.some((r) => r.kind === 'bounce');
  c.replies = all;
  c.lastReplyAt = real.length ? real[real.length - 1].date || c.lastReplyAt : null;
  if (c.status === 'replied' && !real.length) {
    c.status = bounced ? 'bounced' : 'emailed';
    c.repliedAt = null;
    return { fixed: true };
  }
  if (c.status === 'emailed' && bounced && !real.length) { c.status = 'bounced'; return { fixed: true }; }
  return { fixed: false };
}

// Where the last successful "what changed" search got to, per team. Its own
// small record, so a minute-by-minute check does not rewrite the whole list.
const CURSOR_KEY = 'reply-cursor';
const replyPreview = (reply) => String(reply.text || reply.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 140);
const FIRST_LOOK_MS = 2 * 24 * 3600 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;

async function checkReplies({ budgetMs = Infinity, waiting = 20, conversing = 5, backfill = 8, changed = 40 } = {}) {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budgetMs;
  const db = await store.load();
  const g = await google.status(db.settings);
  if (!g.connected) return { ok: true, checked: 0, replies: 0, unavailable: 'Google not connected' };

  const byCheck = (a, b) => String(a.repliesCheckedAt || '').localeCompare(String(b.repliesCheckedAt || ''));
  const withThread = db.candidates.filter((c) => c.gmailThreadId);

  // Threads Gmail says have news. Any status: someone booked or marked not
  // interested can still write back, and that is still a reply.
  let changedThreads = null;
  let cursor = null;
  try {
    cursor = await storage.getJson(CURSOR_KEY).catch(() => null);
    const since = cursor && cursor.checkedAt ? new Date(cursor.checkedAt).getTime() - OVERLAP_MS : started - FIRST_LOOK_MS;
    changedThreads = await google.recentInboundThreads(db.settings, since);
  } catch { changedThreads = null; }   // no search permission, or Gmail busy: the rotation still runs
  const changedPool = changedThreads ? withThread.filter((c) => changedThreads.has(c.gmailThreadId)).sort(byCheck) : [];

  // Replies saved before the read permission existed have no text: refetch them.
  const backfillPool = withThread.filter((c) => (c.replies || []).some((r) => !r.text && !r.kind && !r.textFetched)).slice(0, backfill);
  const waitingPool = withThread.filter((c) => c.status === 'emailed').sort(byCheck).slice(0, waiting);
  const conversingPool = withThread.filter((c) => c.status === 'replied').sort(byCheck).slice(0, conversing);
  const seen = new Set();
  const pool = [...changedPool.slice(0, changed), ...backfillPool, ...waitingPool, ...conversingPool]
    .filter((c) => !seen.has(c.id) && seen.add(c.id));

  const results = {};   // id -> { gone, limited, replies }
  let scopeError = '';
  let limitedAny = false;
  for (const c of pool) {
    if (outOfTime()) break;
    try {
      const r = await google.threadReplies(db.settings, c.gmailThreadId, g.email);
      results[c.id] = { gone: false, limited: r.limited, replies: r.replies };
      if (r.limited) limitedAny = true;
    } catch (err) {
      if (err.scope) { scopeError = 'Reconnect Google (Settings) to allow reply detection.'; break; }
      // Gone is an answer; a timeout or a Gmail error is not, and the thread
      // is read again next time rather than counted as looked at.
      results[c.id] = { gone: Boolean(err.gone), failed: !err.gone, replies: [] };
    }
  }

  const now = new Date().toISOString();
  const announce = [];
  await store.update((fresh) => {
    announce.length = 0;   // the mutator re-runs on a conflict: collect afresh
    for (const [id, r] of Object.entries(results)) {
      const fc = fresh.candidates.find((x) => x.id === id);
      if (!fc || r.failed) continue;
      fc.repliesCheckedAt = now;
      if (r.gone) { fc.gmailThreadId = ''; continue; }
      const existing = new Map((fc.replies || []).map((x) => [x.id, x]));
      const before = new Set(existing.keys());
      for (const rep of r.replies) {
        const prev = existing.get(rep.id) || {};
        // textFetched: the full message was read once; if it has no readable
        // text (attachment-only), stop re-fetching it every minute.
        existing.set(rep.id, {
          ...prev, ...rep,
          text: rep.text || prev.text || '',
          snippet: rep.snippet || prev.snippet || '',
          textFetched: Boolean(prev.textFetched) || !r.limited,
        });
      }
      fc.replies = [...existing.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-10);
      const real = fc.replies.filter((x) => !x.kind);
      const newReal = real.filter((x) => !before.has(x.id));
      const bounced = fc.replies.some((x) => x.kind === 'bounce');
      if (real.length) {
        fc.lastReplyAt = real[real.length - 1].date || now;
        if (fc.status === 'emailed' || fc.status === 'bounced') { fc.status = 'replied'; fc.repliedAt = fc.repliedAt || now; }
        if (newReal.length) {
          announce.push({ c: fc, reply: newReal[newReal.length - 1] });
          // Lights the bell, and stays lit until the conversation is opened.
          fc.emailUnread = true;
        }
      } else {
        // Nothing real left (a reply re-read and found to be an auto-reply):
        // nothing to be unread about.
        if (fc.emailUnread) fc.emailUnread = false;
        if (bounced && fc.status === 'emailed') fc.status = 'bounced';
      }
    }
    // Housekeeping for everyone marked replied: bounces/auto-replies are not replies.
    const cleaned = new Set();
    for (const c of fresh.candidates) {
      if (!(c.replies || []).length) continue;
      if (reclassifyCandidate(c).fixed) cleaned.add(c.id);
    }
    if (cleaned.size) fresh.events = fresh.events.filter((e) => !(e.type === 'replied' && cleaned.has(e.candidateId)));
    // The Candidate-updates line is written with the reply itself, in the
    // same save: once the reply is stored it is no longer new, so a line
    // left for afterwards (and a run cut off at its time limit before it)
    // would never be written at all.
    for (const { c, reply } of announce) {
      const preview = replyPreview(reply);
      store.pushEvent(fresh, 'replied', `${c.name || c.email} replied${preview ? `: “${preview}${preview.length === 140 ? '…' : ''}”` : '.'}`, c.id, reply.date || null);
    }
    if (!Object.keys(results).length && !cleaned.size) return false;
  });

  // The search's window moves on only once the search reached its end and
  // every thread it named was read; otherwise the next look starts from the
  // same place and reads the rest.
  const allChangedRead = changedThreads && changedThreads.complete !== false
    && changedPool.every((c) => results[c.id] && !results[c.id].failed);
  if (allChangedRead) await storage.setJson(CURSOR_KEY, { checkedAt: new Date(started).toISOString() }).catch(() => {});

  // All at once: each is bounded, and one slow one must not hold up the rest.
  await Promise.allSettled(announce.map(({ c, reply }) => notify.pushToPhone(db.settings, {
    title: `💬 ${c.name || c.email} replied`,
    message: replyPreview(reply) || 'Check your inbox.',
    tags: 'speech_balloon',
  })));
  return {
    ok: true,
    checked: Object.keys(results).length,
    replies: announce.length,
    scopeError: scopeError || (limitedAny ? 'Reconnect Google (Settings) to see reply text in the dashboard.' : ''),
  };
}

module.exports = { checkReplies, reclassifyCandidate };
