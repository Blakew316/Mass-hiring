# Making the site quick at 33,000 candidates

This is the plan the speed work follows, written down so it survives the
machine it was worked out on. Every item was measured and prototyped on a
copy of the site holding a team the size of the live one (32,667 people);
the numbers are from that work. Implement in the order given, each stage
tested (tests/run.js) and measured (tests/perf/bench.js) before it ships.

## Where the time goes (baseline)

- `GET /api/state` sends the whole list on every changed poll: ~24 MB of JSON,
  ~3 MB gzipped. The server builds it in ~1.7 s: the payload is stringified
  twice (body, and an ETag copy through a replacer), 24 MB are sha1'd and
  gzipped, `textPriority()` scores everyone (~230 ms), and `store.load()`
  downloads and parses the 20 MB team document. An *unchanged* poll (304)
  still costs ~1.2–2 s, because the whole payload is built to compute the tag.
- Of the 24 MB: 9 MB are repeated key names; default values
  (`emailBounced:false`, `textCount:0`, …) ~1.7 MB; `notes` 2.4 MB; one
  repeated `lastSubject` 1.3 MB; `texting.priority` 2.3 MB.
- Every read-only API route (open a thread, preview, settings bits) loads and
  parses the whole document; many write routes rewrite the whole 20 MB even
  when nothing changed (text reply, a PATCH that changes nothing, relay
  receipts seen before, reply checks that found nothing, Calendly syncs).
- The state's tag changes with nobody touching anything: follow-up-due and
  texting-rank thresholds are measured against the current second, so ~1 in 5
  idle polls is a full 3 MB download plus ~2 s of phone CPU.
- Phone (4x CPU, 4G): cold load ~7.5–10 s to a usable dashboard, warm ~5 s;
  first open of Candidates ~1–2 s (`renderViews()` recounts all 33k people
  ~25 times for the pills and menus on every render); search ~1–2 s; a poll
  that brings one change ~5 s with ~1–2 s of main-thread freeze; the bell
  sheet renders every unread reply at once (~2 s); `timeAgo()` builds a new
  `Intl.DateTimeFormat` per call (the minute tick could freeze ~0.9 s).
- Boot is serial: `/api/auth/status`, then `/api/state`. A render-blocking
  Google Fonts stylesheet delays first paint; a 432 KB attachment thumbnail is
  fetched on every launch; the logo is a 136 KB PNG shown at 170 px.

## Stage A — server foundations (app.js, lib/, netlify/src)

1. **One per-instance cache of the stored document, keyed by its ETag** — the
   only cache layer. `lib/storage.js` keeps the text of the last version of
   `db` it read or wrote (scoped key + ETag, a few entries). On Netlify Blobs
   every read is a conditional `getWithMetadata(key, { type: 'text', etag })`:
   a 304 reuses the held text, a 200 replaces it, a 404 drops it; a body-less
   answer with nothing held is a storage error, never an empty list. Writes
   drop the entry first and keep the written text under the confirmed ETag.
   The local-file backend behaves the same (compare the file text with the
   held copy; its ETag stays sha1 of the text). `setJson`, `del`, `purgeTeam`
   drop entries.
2. **`store.read()`**: one shared, deep-frozen copy per (scoped key, ETag) for
   read-only routes; `save()` refuses a frozen copy. `store.versionOf(db)`.
   Switch every route that only reads (audit the helpers it calls for
   mutation; test in strict mode, because the files are sloppy-mode and a
   write to a frozen object is silently ignored there). Routes that send
   email/texts, enqueue, or mutate keep `load()`/`update()` exactly.
3. **`GET /api/state`**: never build the payload to answer a 304. ETag =
   sha1(team : code version : `store.versionOf(db)` : hash of the timed parts
   : the small parts with `lastSeenAt`/`lastSyncAt` nulled). The code version
   (a hash of the server's own code) is in every version-keyed tag, so a
   deploy that changes a shape never gets a 304 with old content. Build the
   body once per frozen db (WeakMap), splice cached JSON for the big parts,
   keep the old body byte-identical for pages left open during a deploy.
4. **Quantised clock for display only**: follow-up due list and texting
   ranks measured from the start of the current 10-minute window (a `now`
   option on `ageDays`/`score`/`rank` in lib/priority.js; hoist the opt-out
   Set out of the per-candidate loop). Never quantise anything that enforces
   a limit (caps, pacing, `pausedUntil`, enqueue-time checks).
5. **Reply checks** write the document only when something visible changed;
   the rotation bookkeeping moves to a small team-scoped record
   (`reply-checked`), purged with the team. Dry-run the change on a copy; if
   it changes nothing visible, no write.
6. **Calendly**: `lastSyncAt`, its error and the sync lease move to a small
   record (`calendly-sync`); the document is written only when interviews or
   matched candidates change; the sync answers `{ changed, syncedAt }`;
   `lastSyncAt` is out of the state's tag.
7. **No-op writes**: PATCH and settings write only if a value differs; a text
   reply clears unread only when lit; a relay events batch is one update with
   its feed lines, and receipts already recorded change nothing; duplicate
   loads in one request removed; independent reads in parallel.
8. `netlify/src/api.mjs` warns with the size when an answer passes 4 MB.

Measured: unchanged poll 1.2–1.3 s → ~20 ms server; changed 200 ~1.7 s →
~0.55 s; thread open ~480 → ~85 ms (with a 40 ms Blobs round trip); text
reply 1.35 s → 0.21 s with no list write; relay batch 5.1 s → 1.0 s.

## Stage B — client rendering (public/app.js)

1. **One `listVersion` counter** (and `stateVersion`): bumped on every new
   state, every in-place candidate edit, every optimistic edit and its
   revert, and on sign-out/team change. Every derived cache keys on it plus
   the identity of any side object it reads (`state.salesiq`,
   `state.onboarding`, `state.texting.priority`). Over-bumping only costs a
   rebuild; under-bumping shows stale lists. Comment the rule at the counter.
2. **Candidates**: one index per list version (`candIndex`): each person's
   Sales IQ status and Onboarding stage through Maps (not object lookups
   with fresh strings), textable number, role key, and every count the pills
   and menus show, in one pass. Filters read it; search haystacks built
   lazily (warmed on focus); filtered/sorted answers cached per version;
   `Intl.Collator`; tick-all and Clear without redrawing the list; one
   selection pass; the phone pager scrolls the element that scrolls.
3. **Other pages**: the bell sheet shows 40 rows and grows on scroll; one
   cached `timeAgo` formatter (also in salesiq.js/onboarding.js); the
   conversation lists, `textableIds` and unread tallies memoised per version;
   Dashboard counts in one pass; the minute tick refreshes only visible
   `[data-ago]`; "load more" appends rows.
4. **Draw on arrival**: Texting's header and the Settings editors, previews
   and the attachment thumbnail are drawn when their page is shown, not on
   every render from any page.
5. **Optimistic status change** (`setStatus` with a pending map,
   revert-on-error, a failed save forces a full fetch next time) and
   `refreshSoon()` coalescing refreshes after clicks.
6. **Boot background requests**: the first reply check and Calendly sync wait
   ~15 s; after a Calendly sync refresh only when `changed` (keep refreshing
   when the field is absent — an older server).
7. **`refresh()` order** (keep it): record `askedAt` and `askedTeam` before
   the fetch; clear the tag; read the body; yield; drop the answer if signed
   out or the team changed; replace state; bump both counters; `setTeam`;
   `applyLocallyRead()`; `applyPendingStatus(askedAt)`; `renderAll()`;
   `refreshProfile()`; set the tag last.

Measured (phone): Candidates first open 2.0 → 0.8 s; search 1.9 → 0.4 s;
bell 2.2 → 0.15 s; text thread open 195 → 92 ms; warm load 4.7 → 2.8 s.

## Stage D — static shell (index.html head, CSS, assets, netlify.toml, sw template)

1. Drop the Google Fonts stylesheet and preconnects; where Inter is actually
   used, self-host the woff2 (latin, latin-ext; SIL OFL note) with
   `@font-face` + `font-display: swap` and an immutable Cache-Control for
   `/assets/fonts/*`. The shell then makes no third-party request at all.
2. Show 510-px logos (`logo-510.png`, `logo-dark-510.png`) where the logo is
   shown small; keep the old files (masters for the icon scripts, and old
   pages still ask for them); update PRECACHE; rebuild `public/sw.js`.
3. `loading="lazy" decoding="async"` on images not needed for the first screen.
4. Not worth it (measured): minifying into dist/, hashed filenames,
   lazy-loading Sales IQ/Onboarding, content-visibility tricks, removing
   backdrop blur.

Measured: phone cold first paint ~630 → ~420 ms; −108 KB per cold load.

## Stage C — compact list and delta sync (server + client)

- `public/wire.js`, shared by page and function (bundled by esbuild): each
  row `[shape, ...values]`, the shape marking every field absent / sent /
  default; a per-message dictionary for repeated strings; side fields (score,
  reason, why-not-textable, follow-up due) travel with the row. Generated
  decoders per shape with a fallback walker; byte-identical to
  `publicCandidate` output, key order included.
- `GET /api/state?v=2`: the state without `candidates`,
  `texting.priority`, `followUp.dueIds`, plus `cands { v, n, nb, o, rh, rn,
  t }`. `GET /api/candidates?v=2`: the full compact list (ETag `c2-<v>`).
  `POST /api/candidates/sync { v, t, nb, b, o }`: `{ same }` or the changed
  buckets (1,024 buckets by fnv1a(id), 48-bit sha1 digests; positions only
  when the order digest differs; everything if the team or bucket count
  differs or more than half changed). Versions from code version +
  `store.versionOf(db)` (+ window and opt-out list for side fields); derived
  rows in a WeakMap on the frozen db. Old `/api/state` stays byte-identical.
- Client: `refresh()` gets the slim state and syncs the list (serialized;
  delta first, full fallback; checked against digests); rebuilds
  `state.candidates`, `state.texting.priority`, `state.followUp.dueIds` so the
  rest of the page is unchanged. Page edits are overlays lifted before each
  new state (else a read can hide a seen-call that never reached the server).
  Drop answers older than the newest applied. Idle verify with backoff.
  Request timeouts (generous: 20 s sync, 90 s full list) so a stuck request
  never blocks later syncs. A new page against an old server falls back.
- Early fetch: an inline script right after `<title>`, above the first
  stylesheet, starts auth/status, state and list in parallel; boot uses each
  once, for the right team. `/wire.js` in PRECACHE.
- Any future change to the format needs new `?v=` addresses.

Measured (phone): changed poll 5.1 s / 2.6 s CPU / 3 MB → 1.7 s / 0.35 s /
15 KB; cold load 8.1 → 4.3 s; heap −35%. Full list 7.9 MB raw / 2.3 MB gzip.

## Stage E — device-kept copy (client)

- One IndexedDB record per device for one team: format version, team id,
  slim state + tag, compact list + version + digests. Written off the main
  path after a fresh state is drawn (and on pagehide).
- Painted only after `/api/auth/status` confirms the session AND the same
  team. No offline viewing.
- While painted and not yet confirmed fresh, the page is read-only (no
  writes, no sends, no status changes; an "Updating…" note); one delta sync
  makes it live.
- Cleared on sign-out, the sign-in screen, any 401, team change, and a
  format/code version change.

Expected (phone): reopen ~5 s → ~1.7 s painted, ~2 s live.
