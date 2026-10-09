/* The candidate list in its compact form, shared word for word by the page
   and the server (app.js requires this file, and the function bundle carries
   it). At 33,000 people the list as the old state sent it was 24 MB of JSON,
   most of it the same key names and the same few values over and over, and
   all of it fetched again whenever anybody changed anything.

   Here a list travels as rows, each [shape, ...values]. A shape says, field
   by field, whether the field is absent, holds the message's default for it,
   or is sent; repeated strings are sent once, in the message's dictionary,
   and referred to by number. The fields and the defaults travel with each
   message, so a page can read a list from a server newer than itself (a
   field added on the server comes through as it is). The page gets back
   exactly what publicCandidate() in app.js made — the same keys, in the same
   order, with the same values — and the texting order, the reasons and who is
   due a follow-up ride on each row, so nothing beside the list has to be sent
   whole.

   The list is kept in 1,024 buckets (fewer for a short list) by a hash of
   each person's id, and each bucket has a digest of its rows as text. The
   page sends the digests it holds; the server sends back only the buckets
   that differ. Every change the page lays over its copy is checked against
   the server's digests before it is kept, and a copy that fails a check is
   never patched: the page fetches the whole list instead.

   Any change to this format needs new ?v= addresses for the routes. */
(function (root, make) {
  const Wire = make();
  if (typeof module === 'object' && module && module.exports) module.exports = Wire;
  else root.Wire = Wire;
})(typeof self !== 'undefined' ? self : globalThis, () => {
  'use strict';

  const FORMAT = 2;
  // What a row holds for one field, by the field's letter in its shape.
  const ABSENT = '0';    // nothing: the key is not on the person
  const DEFAULT = '1';   // the message's default for the field (z)
  const RAW = '2';       // the value itself, as JSON has it
  const TEXT = '3';      // a string: a number is its place in the dictionary (w), a string is itself
  const OBJ = '4';       // an object of strings with the message's keys for the field (kl), as a list

  // How long a bucket's digest is (48 bits of sha1) and the list-wide ones.
  const DIGEST = 8;
  const LONG = 16;
  // What the page sends for a bucket it no longer trusts: never a digest
  // (a dot is not a base64url letter), so the server always sends it.
  const UNKNOWN = '.'.repeat(DIGEST);
  // How many people one part of the whole list holds at most. Netlify refuses
  // a function's answer over 6 MB, and 12,000 people is about a megabyte
  // compressed: a list of any size travels as a few parts asked for at once.
  const PART_ROWS = 12000;
  const partsFor = (n) => Math.max(1, Math.ceil((Number(n) || 0) / PART_ROWS));

  // ---------- buckets ----------
  // FNV-1a over the id's UTF-16 code units: cheap, and the same in a browser
  // and in Node, which is all it has to be.
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const bucketOf = (id, nb) => fnv1a(String(id)) % nb;
  // About sixteen people a bucket, between 16 and 1,024 buckets: a change to
  // one person then costs a bucket of a few dozen rows, and the digests the
  // page sends up stay a few kilobytes at most.
  function bucketCount(n) {
    let nb = 16;
    while (nb < 1024 && nb * 16 < n) nb *= 2;
    return nb;
  }

  // ---------- rows as text, for the digests ----------
  // One part of a row (the person, or what rides beside them) as the text
  // its digest is taken over: which fields it has, then their values. The
  // server makes it from what publicCandidate() gave, the page from what it
  // decoded; the same person is the same text on both. `strict` (the
  // server's) refuses a person with a key the field list does not have,
  // which the compact form would otherwise drop without a word.
  function partText(fields, from, to, o, strict) {
    const out = [''];
    let mask = '';
    if (o) {
      for (let i = from; i < to; i++) {
        const v = o[fields[i]];
        if (v === undefined) mask += '0';
        else { mask += '1'; out.push(v); }
      }
      if (strict && out.length - 1 !== Object.keys(o).filter((key) => o[key] !== undefined).length) {
        throw new Error(`A candidate has a field the compact list does not carry (${Object.keys(o).filter((key) => !fields.slice(from, to).includes(key)).join(', ')}).`);
      }
    } else {
      mask = '0'.repeat(to - from);
    }
    out[0] = mask;
    return JSON.stringify(out);
  }
  const candText = (fields, k, c, strict) => partText(fields, 0, k, c, strict);
  const sideText = (fields, k, s) => partText(fields, k, fields.length, s, false);
  const rowText = (fields, k, c, s) => `${candText(fields, k, c)}${sideText(fields, k, s)}\n`;

  // sha1, as base64url, cut to `len` letters. The page's crypto.subtle; the
  // server uses Node's own (app.js) and gives the same letters. A browser has
  // crypto.subtle only on https or localhost: a page opened over plain http
  // (the app on another machine on the same network) has none, cannot check
  // anything against a digest, and so only ever asks for the whole list.
  const canDigest = () => Boolean(typeof crypto !== 'undefined' && crypto && crypto.subtle && typeof TextEncoder !== 'undefined');
  async function digest(text, len) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, len);
  }

  // ---------- packing (the server) ----------
  const isPrim = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const allStrings = (o, keys) => keys.every((key) => typeof o[key] === 'string');

  // rows: [[person, side], ...]. Returns the message's f, k, z, kl, s, w, r.
  function pack(fields, k, rows) {
    const nf = fields.length;
    const val = (row, i) => (i < k ? row[0][fields[i]] : (row[1] ? row[1][fields[i]] : undefined));
    // What is most common in each field, and how often each string comes up.
    const prims = Array.from({ length: nf }, () => new Map());
    const sigs = Array.from({ length: nf }, () => new Map());
    const inner = new Map();
    for (const row of rows) {
      for (let i = 0; i < nf; i++) {
        const v = val(row, i);
        if (v === undefined) continue;
        if (isPrim(v)) { const m = prims[i]; m.set(v, (m.get(v) || 0) + 1); }
        else if (isPlain(v)) {
          const keys = Object.keys(v);
          if (!allStrings(v, keys)) continue;
          const sig = keys.join('\u0000');
          sigs[i].set(sig, (sigs[i].get(sig) || 0) + 1);
          for (const key of keys) inner.set(v[key], (inner.get(v[key]) || 0) + 1);
        }
      }
    }
    // A default is worth having only for a value most rows share: one that a
    // handful happen to share saves a few bytes and splits the rows into
    // more shapes, each of which the page has to write a decoder for.
    const common = Math.max(2, Math.ceil(rows.length / 4));
    const z = new Array(nf).fill(null);
    const hasZ = new Array(nf).fill(false);
    const kl = new Array(nf).fill(null);
    const words = new Map();
    for (let i = 0; i < nf; i++) {
      let best; let most = 0;
      for (const [v, n] of prims[i]) if (n > most) { most = n; best = v; }
      if (most >= common) { z[i] = best; hasZ[i] = true; }
      for (const [v, n] of prims[i]) if (typeof v === 'string' && !(hasZ[i] && v === z[i])) words.set(v, (words.get(v) || 0) + n);
      let sig = null; most = 0;
      for (const [s, n] of sigs[i]) if (n > most) { most = n; sig = s; }
      if (sig !== null) kl[i] = sig === '' ? [] : sig.split('\u0000');
    }
    for (const [v, n] of inner) words.set(v, (words.get(v) || 0) + n);
    // The dictionary: strings that come up more than once, the commonest
    // first so they get the shortest numbers.
    const w = [...words].filter(([v, n]) => n > 1 && v.length > 1).sort((a, b) => b[1] - a[1]).map(([v]) => v);
    const at = new Map(w.map((v, i) => [v, i]));
    const tok = (v) => { const i = at.get(v); return i === undefined ? v : i; };
    const klSig = kl.map((keys) => (keys ? keys.join('\u0000') : null));
    const shapes = new Map();
    const r = new Array(rows.length);
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n];
      const out = [0];
      let shape = '';
      for (let i = 0; i < nf; i++) {
        const v = val(row, i);
        if (v === undefined) { shape += ABSENT; continue; }
        if (hasZ[i] && v === z[i]) { shape += DEFAULT; continue; }
        if (typeof v === 'string') { shape += TEXT; out.push(tok(v)); continue; }
        if (klSig[i] !== null && isPlain(v)) {
          const keys = Object.keys(v);
          if (keys.join('\u0000') === klSig[i] && allStrings(v, keys)) { shape += OBJ; out.push(keys.map((key) => tok(v[key]))); continue; }
        }
        shape += RAW;
        out.push(v);
      }
      let si = shapes.get(shape);
      if (si === undefined) { si = shapes.size; shapes.set(shape, si); }
      out[0] = si;
      r[n] = out;
    }
    return { f: fields, k, z, kl, s: [...shapes.keys()], w, r };
  }

  // ---------- unpacking (the page) ----------
  // Each shape gets a decoder written for it — one object literal, so every
  // person of a shape is built the same way, in one go — kept for the next
  // message. A field name that cannot go in a literal as it is (__proto__
  // would set the prototype), or a page that may not compile code, is read
  // by walking the shape instead; the answer is the same.
  const made = new Map();
  let compileOk = true;

  function writeDecoder(fields, from, to, kl, shape, firstToken) {
    let j = firstToken;
    const parts = [];
    for (let i = from; i < to; i++) {
      const code = shape[i];
      if (code === ABSENT) continue;
      let expr;
      if (code === DEFAULT) expr = `z[${i}]`;
      else if (code === RAW) expr = `r[${j++}]`;
      else if (code === TEXT) expr = `(typeof (x = r[${j++}]) === 'number' ? w[x] : x)`;
      else if (code === OBJ) {
        const keys = kl[i] || [];
        expr = `(a = r[${j++}], {${keys.map((key, n) => `${JSON.stringify(key)}: (typeof (x = a[${n}]) === 'number' ? w[x] : x)`).join(', ')}})`;
      } else throw refused(`a shape has a field code (${code}) this page does not know`);
      parts.push(`${JSON.stringify(fields[i])}: ${expr}`);
    }
    return { body: parts.length ? `let x, a; return {${parts.join(', ')}};` : 'return null;', next: j };
  }
  const tokensBefore = (shape, upto) => { let n = 0; for (let i = 0; i < upto; i++) if (shape[i] === RAW || shape[i] === TEXT || shape[i] === OBJ) n++; return n; };

  function walker(fields, from, to, kl, shape, firstToken, emptyIsNull) {
    return (r, w, z) => {
      let j = firstToken;
      let out = null;
      const T = (x) => (typeof x === 'number' ? w[x] : x);
      for (let i = from; i < to; i++) {
        const code = shape[i];
        if (code === ABSENT) continue;
        let v;
        if (code === DEFAULT) v = z[i];
        else if (code === RAW) v = r[j++];
        else if (code === TEXT) v = T(r[j++]);
        else if (code === OBJ) {
          const a = r[j++];
          v = {};
          (kl[i] || []).forEach((key, n) => put(v, key, T(a[n])));
        } else throw refused(`a shape has a field code (${code}) this page does not know`);
        if (!out) out = {};
        put(out, fields[i], v);
      }
      return out || (emptyIsNull ? null : {});
    };
  }
  function put(o, key, v) {
    if (key === '__proto__') Object.defineProperty(o, key, { value: v, enumerable: true, writable: true, configurable: true });
    else o[key] = v;
  }

  function decoderFor(fields, k, kl, shape, walk) {
    const key = `${walk ? 'w' : 'c'}${fields.length}:${k}:${fields.join('\u0001')}\u0002${JSON.stringify(kl)}\u0002${shape}`;
    let d = made.get(key);
    if (d) return d;
    if (typeof shape !== 'string' || shape.length !== fields.length) throw refused('a shape does not fit the message\'s fields');
    const odd = fields.includes('__proto__') || (kl || []).some((keys) => keys && keys.includes('__proto__'));
    const sideFrom = 1 + tokensBefore(shape, k);
    if (compileOk && !odd && !walk) {
      try {
        const c = writeDecoder(fields, 0, k, kl, shape, 1);
        const s = writeDecoder(fields, k, fields.length, kl, shape, sideFrom);
        // eslint-disable-next-line no-new-func
        d = { cand: new Function('r', 'w', 'z', `'use strict'; ${c.body.replace('return null;', 'return {};')}`), side: new Function('r', 'w', 'z', `'use strict'; ${s.body}`) };
      } catch (e) {
        if (e.refused) throw e;
        compileOk = false;
      }
    }
    if (!d) d = { cand: walker(fields, 0, k, kl, shape, 1, false), side: walker(fields, k, fields.length, kl, shape, sideFrom, true) };
    if (made.size > 5000) made.clear();
    made.set(key, d);
    return d;
  }

  // A message's rows as [people], [sides], in the message's order. `walk`
  // reads every shape by walking it (the tests hold the two readers to the
  // same answer).
  function unpack(msg, { walk = false } = {}) {
    const { f, k, z, kl, s, w, r } = msg;
    if (!Array.isArray(f) || !Number.isInteger(k) || k < 0 || k > f.length || !Array.isArray(s) || !Array.isArray(w) || !Array.isArray(r) || !Array.isArray(z)) {
      throw refused('the list came in a form this page cannot read');
    }
    const decoders = s.map((shape) => decoderFor(f, k, kl || [], shape, walk));
    const cands = new Array(r.length);
    const sides = new Array(r.length);
    for (let i = 0; i < r.length; i++) {
      const row = r[i];
      const d = Array.isArray(row) ? decoders[row[0]] : null;
      if (!d) throw refused('a row names a shape the message does not have');
      try {
        cands[i] = d.cand(row, w, z);
        sides[i] = d.side(row, w, z);
      } catch {
        throw refused('a row does not fit its shape');
      }
    }
    return { cands, sides };
  }

  // ---------- the kept copy ----------
  // { t, v, nb, n, o, rh, rn, ro, f, k, ids, cands, sides, bk, d, dup }:
  // one team's list as of version v — its people and what rides beside them,
  // in the list's order, each person's bucket, and the server's digest of
  // every bucket. Never changed once made: a delta makes a new one, so a
  // copy that fails a check is still the copy it was.
  function refused(why) { const e = new Error(`The list update was refused: ${why}.`); e.refused = true; return e; }

  const sameFields = (a, msg) => a.k === msg.k && a.f.length === msg.f.length && a.f.every((name, i) => name === msg.f[i]);
  function digestsOf(str, nb) {
    if (typeof str !== 'string' || str.length !== nb * DIGEST) return null;
    const d = new Array(nb);
    for (let b = 0; b < nb; b++) d[b] = str.slice(b * DIGEST, (b + 1) * DIGEST);
    return d;
  }
  function baseChecks(msg) {
    if (!msg || msg.fmt !== FORMAT) throw refused('it is not in this page\'s format');
    if (!Number.isInteger(msg.nb) || msg.nb < 1 || msg.nb > 65535 || !Number.isInteger(msg.n) || msg.n < 0) throw refused('its counts are not counts');
    if (typeof msg.t !== 'string' || !msg.t || typeof msg.v !== 'string' || !msg.v) throw refused('it does not say whose list or which version it is');
  }

  // The whole list, as GET /api/candidates?v=2 sends it.
  const fromFull = (msg, team) => fromParts([msg], team);

  // The whole list in parts (GET /api/candidates?v=2&part=i&of=n), put back
  // together. Every part must be of the same list — team, version, counts,
  // order, digests and fields — and every part there once, so a write that
  // lands while they are on their way is refused here, not half-kept.
  async function fromParts(msgs, team) {
    if (!Array.isArray(msgs) || !msgs.length) throw refused('it came in no parts');
    const first = msgs[0];
    baseChecks(first);
    if (team && first.t !== team) throw refused('it is another team\'s list');
    if (!Array.isArray(first.f)) throw refused('the list came in a form this page cannot read');
    const of = msgs.length;
    const byPart = new Array(of);
    for (const m of msgs) {
      baseChecks(m);
      const part = of === 1 && m.part === undefined ? 0 : m.part;
      if (!Number.isInteger(part) || part < 0 || part >= of || byPart[part] || (of > 1 && m.of !== of)) throw refused('its parts do not fit together');
      for (const key of ['t', 'v', 'nb', 'n', 'o', 'rh', 'rn', 'd']) if (m[key] !== first[key]) throw refused('its parts are of different lists');
      if (!Array.isArray(m.f) || !sameFields(first, m)) throw refused('its parts are of different lists');
      byPart[part] = m;
    }
    const cands = [];
    const sides = [];
    for (const m of byPart) {
      const got = unpack(m);
      for (let i = 0; i < got.cands.length; i++) { cands.push(got.cands[i]); sides.push(got.sides[i]); }
    }
    const msg = first;
    if (cands.length !== msg.n) throw refused('it does not hold as many people as it says');
    const d = digestsOf(msg.d, msg.nb);
    if (!d) throw refused('its digests do not fit its buckets');
    const ids = cands.map((c) => c && c.id);
    const bk = new Uint16Array(ids.length);
    for (let i = 0; i < ids.length; i++) bk[i] = bucketOf(ids[i], msg.nb);
    // Without crypto.subtle (canDigest) there is nothing to check these with,
    // and the copy is never patched either: taken as it came, as the old
    // state's list always was.
    if (canDigest()) {
      if (await digest(ids.map(String).join('\n'), LONG) !== msg.o) throw refused('its order is not the order it says');
      if (await digest(d.join(''), LONG) !== msg.rh) throw refused('its digests are not the ones it says');
    }
    return {
      t: msg.t, v: msg.v, nb: msg.nb, n: msg.n, o: msg.o, rh: msg.rh, rn: msg.rn, ro: Array.isArray(msg.ro) ? msg.ro : null,
      f: msg.f, k: msg.k, ids, cands, sides, bk, d, dup: new Set(ids).size !== ids.length,
    };
  }

  // A sync's answer of changed buckets, laid over `list`. Resolves to a new
  // copy, or rejects (refused) leaving `list` exactly as it was.
  async function applyDelta(list, msg) {
    baseChecks(msg);
    if (msg.t !== list.t) throw refused('it is another team\'s list');
    if (msg.nb !== list.nb) throw refused('it is cut into different buckets');
    if (!Array.isArray(msg.f) || !sameFields(list, msg)) throw refused('its fields are not this copy\'s');
    if (list.dup) throw refused('this copy has two people under one id');
    const ch = msg.ch;
    if (!Array.isArray(ch) || !ch.length || ch.some((b) => !Number.isInteger(b) || b < 0 || b >= list.nb) || new Set(ch).size !== ch.length) throw refused('its buckets are not buckets');
    const nd = digestsOf(msg.d, ch.length);
    if (!nd) throw refused('its digests do not fit its buckets');
    const changed = new Set(ch);
    const { cands: rows, sides: rowSides } = unpack(msg);
    const rowIds = rows.map((c) => c && c.id);
    for (const id of rowIds) if (!changed.has(bucketOf(id, list.nb))) throw refused('a person in it is not in a bucket it changes');

    let ids; let cands; let sides; let bk;
    if (msg.p !== undefined) {
      // The order moved (people added or taken off): each person in the
      // changed buckets comes with their place, and everyone else keeps
      // their order around them.
      const p = msg.p;
      const n = msg.n;
      if (!Array.isArray(p) || p.length !== rows.length) throw refused('its places do not fit its rows');
      const keep = [];
      for (let i = 0; i < list.n; i++) if (!changed.has(list.bk[i])) keep.push(i);
      if (keep.length + rows.length !== n) throw refused('its count does not add up');
      const taken = new Uint8Array(n);
      for (const at of p) {
        if (!Number.isInteger(at) || at < 0 || at >= n || taken[at]) throw refused('its places are not places');
        taken[at] = 1;
      }
      ids = new Array(n); cands = new Array(n); sides = new Array(n); bk = new Uint16Array(n);
      for (let j = 0; j < rows.length; j++) { ids[p[j]] = rowIds[j]; cands[p[j]] = rows[j]; sides[p[j]] = rowSides[j]; }
      let from = 0;
      for (let i = 0; i < n; i++) {
        if (taken[i]) continue;
        const was = keep[from++];
        ids[i] = list.ids[was]; cands[i] = list.cands[was]; sides[i] = list.sides[was];
      }
      for (let i = 0; i < n; i++) bk[i] = bucketOf(ids[i], list.nb);
      if (new Set(ids).size !== n) throw refused('it would put two people under one id');
      if (await digest(ids.map(String).join('\n'), LONG) !== msg.o) throw refused('its order is not the order it says');
    } else {
      // The same people in the same order: each changed bucket holds the
      // same ids in the same places, with new values.
      if (msg.n !== list.n || msg.o !== list.o) throw refused('its order moved but it sent no places');
      ids = list.ids; bk = list.bk;
      cands = list.cands.slice(); sides = list.sides.slice();
      const wanted = new Map();
      for (let j = 0; j < rows.length; j++) {
        const b = bucketOf(rowIds[j], list.nb);
        if (!wanted.has(b)) wanted.set(b, []);
        wanted.get(b).push(j);
      }
      const seen = new Map();
      for (let i = 0; i < list.n; i++) {
        const b = bk[i];
        if (!changed.has(b)) continue;
        const got = wanted.get(b) || [];
        const at = seen.get(b) || 0;
        seen.set(b, at + 1);
        const j = got[at];
        if (j === undefined || rowIds[j] !== ids[i]) throw refused('a bucket in it does not hold the people it held');
        cands[i] = rows[j]; sides[i] = rowSides[j];
      }
      for (const b of changed) if ((seen.get(b) || 0) !== (wanted.get(b) || []).length) throw refused('a bucket in it does not hold the people it held');
    }
    const next = { ...list, v: msg.v, n: ids.length, o: msg.o, rh: msg.rh, rn: msg.rn, ro: Array.isArray(msg.ro) ? msg.ro : null, ids, cands, sides, bk, d: list.d.slice(), dup: false };
    ch.forEach((b, j) => { next.d[b] = nd[j]; });
    // Every changed bucket, as this copy now holds it, against the server's
    // digest of it; then all the digests against the server's digest of them.
    const texts = bucketTexts(next, changed);
    for (let j = 0; j < ch.length; j++) {
      if (await digest(texts.get(ch[j]) || '', DIGEST) !== nd[j]) throw refused(`bucket ${ch[j]} does not come out as the server has it`);
    }
    if (await digest(next.d.join(''), LONG) !== msg.rh) throw refused('its digests are not the ones it says');
    return next;
  }

  // The rows of the given buckets as the text their digests are taken over.
  function bucketTexts(list, buckets) {
    const parts = new Map();
    for (const b of buckets) parts.set(b, []);
    for (let i = 0; i < list.n; i++) {
      const got = parts.get(list.bk[i]);
      if (got) got.push(rowText(list.f, list.k, list.cands[i], list.sides[i]));
    }
    const out = new Map();
    for (const [b, texts] of parts) out.set(b, texts.join(''));
    return out;
  }

  // Which fields a list has, in a few letters: the digests are taken over
  // the values alone, so a copy whose fields have since been renamed (a copy
  // kept on the device across a deploy) would otherwise pass for current.
  const fieldsKey = (f, k) => `${k}.${fnv1a(f.join('\u0000')).toString(36)}`;
  // "Nothing has changed since your copy" — the same people, order and
  // digests, under a newer version, with the same fields (a server that
  // does not say which is taken at its word).
  function sameAs(list, info) {
    return Boolean(list && info && info.t === list.t && info.nb === list.nb && info.n === list.n && info.o === list.o && info.rh === list.rh
      && (info.fk === undefined || (Array.isArray(list.f) && fieldsKey(list.f, list.k) === info.fk)));
  }
  const adopt = (list, info) => ({ ...list, v: info.v, rn: info.rn, ro: Array.isArray(info.ro) ? info.ro : list.ro });

  // What a sync asks with: this copy's version and digests. A bucket in
  // `distrust` is sent as UNKNOWN, so the server sends it whatever it holds.
  function syncBody(list, distrust) {
    let b = '';
    for (let i = 0; i < list.nb; i++) b += distrust && distrust.has(i) ? UNKNOWN : list.d[i];
    return { v: list.v, t: list.t, nb: list.nb, b, o: list.o };
  }

  // ---------- the copy kept on the device ----------
  // The page keeps its copy between visits (app.js), so that opening the app
  // again costs a sync of what changed rather than the whole list. It is
  // kept in groups of eight buckets, each group a message of its own (pack),
  // with the list's order beside them as its ids: a change to one person is
  // one bucket, so it rewrites one group of a few hundred people, and a group
  // whose buckets' digests have not moved is the same text as before.
  const KEEP_BUCKETS = 8;
  const groupsFor = (nb) => Math.max(1, Math.ceil(nb / KEEP_BUCKETS));
  const groupOf = (b) => Math.floor(b / KEEP_BUCKETS);
  // What the groups are cut by, beside them: a group is the same text as
  // before when these are.
  const groupDigests = (list, g) => list.d.slice(g * KEEP_BUCKETS, (g + 1) * KEEP_BUCKETS).join('');
  function keptHead(list) {
    return { fmt: FORMAT, t: list.t, v: list.v, nb: list.nb, n: list.n, o: list.o, rh: list.rh, rn: list.rn, ro: list.ro, d: list.d.join(''), f: list.f, k: list.k };
  }
  // Who is in each group, by their place in the list.
  function keptMembers(list) {
    const out = Array.from({ length: groupsFor(list.nb) }, () => []);
    for (let i = 0; i < list.n; i++) out[groupOf(list.bk[i])].push(i);
    return out;
  }
  const keptGroup = (list, members) => pack(list.f, list.k, members.map((i) => [list.cands[i], list.sides[i]]));
  // The copy put back together from what was kept, checked as a whole list
  // is: every person once, in the group their id belongs to, in the order
  // and with the digests the head says.
  async function fromKept(head, ids, groups, team) {
    baseChecks(head);
    if (team && head.t !== team) throw refused('it is another team\'s list');
    if (!Array.isArray(head.f) || !Number.isInteger(head.k)) throw refused('the list came in a form this page cannot read');
    const d = digestsOf(head.d, head.nb);
    if (!d) throw refused('its digests do not fit its buckets');
    if (!Array.isArray(ids) || ids.length !== head.n || ids.some((id) => typeof id !== 'string' && typeof id !== 'number')) throw refused('its order is not a list of ids');
    if (!Array.isArray(groups) || groups.length !== groupsFor(head.nb)) throw refused('its groups do not fit its buckets');
    const at = new Map();
    for (let i = 0; i < ids.length; i++) at.set(ids[i], i);
    if (at.size !== ids.length) throw refused('it has two people under one id');
    const cands = new Array(head.n);
    const sides = new Array(head.n);
    let placed = 0;
    groups.forEach((msg, g) => {
      if (!msg || !Array.isArray(msg.f) || !sameFields(head, msg)) throw refused('its groups are not of its fields');
      const got = unpack(msg);
      for (let j = 0; j < got.cands.length; j++) {
        const c = got.cands[j];
        const i = c ? at.get(c.id) : undefined;
        if (i === undefined || cands[i] !== undefined || groupOf(bucketOf(c.id, head.nb)) !== g) throw refused('a person in it is not where the list has them');
        cands[i] = c; sides[i] = got.sides[j];
        placed += 1;
      }
    });
    if (placed !== head.n) throw refused('it does not hold as many people as it says');
    const bk = new Uint16Array(ids.length);
    for (let i = 0; i < ids.length; i++) bk[i] = bucketOf(ids[i], head.nb);
    if (canDigest()) {
      if (await digest(ids.map(String).join('\n'), LONG) !== head.o) throw refused('its order is not the order it says');
      if (await digest(d.join(''), LONG) !== head.rh) throw refused('its digests are not the ones it says');
    }
    return {
      t: head.t, v: head.v, nb: head.nb, n: head.n, o: head.o, rh: head.rh, rn: head.rn, ro: Array.isArray(head.ro) ? head.ro : null,
      f: head.f, k: head.k, ids, cands, sides, bk, d, dup: false,
    };
  }

  // ---------- what the page used to be sent beside the list ----------
  // The texting order: everyone with a score, best first, ties by id as the
  // server breaks them (by code unit — the server says when its own order
  // cannot be had that way, and sends it as ro instead).
  function rankOf(list) {
    const { ids, sides } = list;
    if (list.ro) {
      const at = new Map();
      for (let i = 0; i < ids.length; i++) if (sides[i] && sides[i].score !== undefined && !at.has(ids[i])) at.set(ids[i], i);
      return list.ro.map((id) => at.get(id)).filter((i) => i !== undefined);
    }
    const ranked = [];
    for (let i = 0; i < ids.length; i++) if (sides[i] && sides[i].score !== undefined) ranked.push(i);
    ranked.sort((a, b) => {
      const d = sides[b].score - sides[a].score;
      if (d) return d;
      const x = String(ids[a]); const y = String(ids[b]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return ranked;
  }
  // state.texting.priority, as /api/state sends it: { order, blocked, textable }.
  function priorityOf(list, ranked = rankOf(list)) {
    const { ids, sides } = list;
    const order = {};
    ranked.forEach((i, n) => { order[ids[i]] = { rank: n + 1, reason: sides[i].reason }; });
    const blocked = {};
    for (let i = 0; i < ids.length; i++) if (sides[i] && sides[i].blocked !== undefined) blocked[ids[i]] = sides[i].blocked;
    return { order, blocked, textable: ranked.length };
  }
  // state.followUp.dueIds.
  function dueIdsOf(list) {
    const out = [];
    for (let i = 0; i < list.ids.length; i++) if (list.sides[i] && list.sides[i].due) out.push(list.ids[i]);
    return out;
  }
  const rankDigest = (list, ranked) => digest(ranked.map((i) => String(list.ids[i])).join('\n'), LONG);

  return {
    FORMAT, DIGEST, LONG, UNKNOWN, PART_ROWS, partsFor,
    fnv1a, bucketOf, bucketCount,
    candText, sideText, rowText, canDigest, digest,
    pack, unpack, fromFull, fromParts, applyDelta, bucketTexts, sameAs, adopt, syncBody, fieldsKey,
    rankOf, priorityOf, dueIdsOf, rankDigest,
    groupsFor, groupOf, groupDigests, keptHead, keptMembers, keptGroup, fromKept,
  };
});
