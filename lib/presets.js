// Saved message templates: any number of named emails and texts per team,
// kept to reuse later.
//
// One of each kind is the default: the message the send window opens with,
// and the one the sending queue falls back to. That default is not a second
// copy — it IS db.template (email) and db.textTemplate (text), the fields
// every sending path has always read. The saved entry for it only adds a
// name, and load() refreshes its words from those fields, so the two can
// never disagree and nothing that sends needed to change.
//
// Attachments stay with the team, not with a template: they go with every
// outreach email, whichever template it started from.

const crypto = require('crypto');

const LIMITS = { name: 60, subject: 300, email: 20000, text: 2000, count: 50 };

// An email's words (subject and body) as one short key.
const wordsKey = (t) => crypto.createHash('sha1').update(`${(t && t.subject) || ''}\n${(t && t.body) || ''}`).digest('hex').slice(0, 12);

// The words the default email (and the follow-up) had before each change,
// as keys: an email queued with them, or a send window left open on them,
// means "the default", and goes out with the default's words as they are
// now (lib/queue.js). 'email' | 'followUp'.
const PAST_MAX = 30;
function rememberPast(db, kind) {
  const live = kind === 'followUp' ? db.followUp : db.template;
  if (!live) return;
  const k = wordsKey(live);
  const past = (db.templatePast && Array.isArray(db.templatePast[kind]) ? db.templatePast[kind] : []).filter((x) => x !== k);
  db.templatePast = { ...(db.templatePast || {}), [kind]: [...past, k].slice(-PAST_MAX) };
}

const KINDS = {
  email: { list: 'emailTemplates', mirror: 'template', fields: ['subject', 'body'], defaultId: 'email-main', defaultName: 'Main email' },
  text: { list: 'textTemplates', mirror: 'textTemplate', fields: ['body'], defaultId: 'text-main', defaultName: 'Main text' },
};

function kindOf(kind) {
  const k = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!k) throw new Error('Unknown kind of template.');
  return k;
}

function newId(kind) {
  return `${kind}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);

// Called by load(): every stored template tidied, a default present for each
// kind, and the default's words taken from the fields that actually send.
function normalize(db) {
  const past = db.templatePast && typeof db.templatePast === 'object' ? db.templatePast : {};
  const keys = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string').slice(-PAST_MAX) : []);
  db.templatePast = { email: keys(past.email), followUp: keys(past.followUp) };
  const defaults = db.templateDefaults && typeof db.templateDefaults === 'object' ? db.templateDefaults : {};
  db.templateDefaults = { email: String(defaults.email || ''), text: String(defaults.text || ''), followUp: typeof defaults.followUp === 'string' ? defaults.followUp : null };
  for (const [kind, k] of Object.entries(KINDS)) {
    const seen = new Set();
    const list = (Array.isArray(db[k.list]) ? db[k.list] : [])
      .filter((p) => p && typeof p === 'object' && p.id && !seen.has(p.id) && seen.add(p.id))
      .map((p) => {
        const out = { id: String(p.id), name: cleanName(p.name) || 'Untitled', updatedAt: p.updatedAt || null };
        if (kind === 'email') out.subject = clip(p.subject, LIMITS.subject);
        out.body = clip(p.body, LIMITS[kind]);
        return out;
      });
    let def = list.find((p) => p.id === db.templateDefaults[kind]);
    if (!def) {
      def = list.find((p) => p.id === k.defaultId);
      if (!def) {
        def = { id: k.defaultId, name: k.defaultName, updatedAt: null };
        list.unshift(def);
      }
      db.templateDefaults[kind] = def.id;
    }
    const live = db[k.mirror] || {};
    if (kind === 'email') def.subject = String(live.subject || '');
    def.body = String(live.body || '');
    db[k.list] = list;
  }
  followUpLink(db);
}

// The follow-up email can be one of the saved emails (templateDefaults.
// followUp, its id; '' when it is written in its own editor in Settings).
// Its words are then db.followUp — what every follow-up is sent with, queued
// or straight away — kept in step whichever editor changes them, as the
// default email is with db.template. A team that has never chosen (one from
// before it could) gets its saved email named "Follow-Up Email", if it has
// one: that is what such a template was saved for.
const FOLLOW_UP_NAME = /^\s*follow[\s-]*up(\s+e-?mail)?\s*$/i;
function followUpLink(db) {
  const emails = db.emailTemplates;
  let id = db.templateDefaults.followUp;
  if (id === null) {
    const named = emails
      .filter((p) => FOLLOW_UP_NAME.test(p.name) && p.id !== db.templateDefaults.email)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    id = '';
    if (named) { useForFollowUp(db, named); id = named.id; }
  }
  const linked = id ? emails.find((p) => p.id === id) : null;
  if (linked && linked.id !== db.templateDefaults.email) {
    const live = db.followUp || {};
    linked.subject = String(live.subject || '');
    linked.body = String(live.body || '');
  } else id = '';
  db.templateDefaults.followUp = id;
}
// A saved email's words as the follow-up, the follow-up's words before it
// remembered (an email queued with them, or a window still showing them,
// then gets these).
function useForFollowUp(db, p) {
  const was = db.followUp || {};
  if (was.subject !== p.subject || was.body !== p.body) rememberPast(db, 'followUp');
  db.followUp = { subject: p.subject, body: p.body };
}

// Choose the follow-up: a saved email by id, or '' for the one written in
// Settings (which keeps the words it has now).
function setFollowUp(db, id) {
  if (!id) { db.templateDefaults.followUp = ''; return null; }
  const p = find(db, 'email', id);
  if (db.templateDefaults.email === p.id) {
    throw new Error('That is the template your first emails go out with. Make another one the default first, then use this one for follow-ups.');
  }
  useForFollowUp(db, p);
  db.templateDefaults.followUp = p.id;
  return p;
}

function listOf(db, kind) {
  return db[kindOf(kind).list];
}

function find(db, kind, id) {
  const p = listOf(db, kind).find((x) => x.id === id);
  if (!p) throw new Error('That template no longer exists — it may have been deleted in another tab.');
  return p;
}

function assertNameFree(db, kind, name, exceptId = null) {
  if (!name) throw new Error('Give the template a name.');
  const taken = listOf(db, kind).some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new Error(`There is already a template called “${name}”.`);
}

// Copy a template's words into the fields the senders read, if it is the default.
function mirrorIfDefault(db, kind, p) {
  const k = kindOf(kind);
  if (db.templateDefaults[kind] !== p.id) return;
  const changed = k.fields.some((f) => (db[k.mirror] || {})[f] !== p[f]);
  if (changed && kind === 'email') rememberPast(db, 'email');
  db[k.mirror] = { ...db[k.mirror] };   // keeps the email's attachments
  for (const f of k.fields) db[k.mirror][f] = p[f];
  // Somebody has now written this team's letter — but only if its words
  // changed; a rename is not writing it.
  if (changed && kind === 'email' && db.settings) db.settings.templateSeeded = false;
}

function words(kind, input) {
  const out = { body: clip(input.body, LIMITS[kind]) };
  if (kind === 'email') out.subject = clip(input.subject, LIMITS.subject);
  if (!out.body.trim()) throw new Error('The message is empty.');
  if (kind === 'email' && !out.subject.trim()) throw new Error('The subject is empty.');
  return out;
}

function create(db, kind, input) {
  const list = listOf(db, kind);
  if (list.length >= LIMITS.count) throw new Error(`That is ${LIMITS.count} saved templates — delete one you no longer use first.`);
  const name = cleanName(input.name);
  assertNameFree(db, kind, name);
  const p = { id: newId(kind), name, ...words(kind, input), updatedAt: new Date().toISOString() };
  list.push(p);
  return p;
}

function update(db, kind, id, input) {
  const p = find(db, kind, id);
  if ('name' in input) {
    const name = cleanName(input.name);
    assertNameFree(db, kind, name, id);
    p.name = name;
  }
  if ('body' in input || 'subject' in input) {
    // Only what was sent is checked and trimmed; the rest stays as stored.
    const next = words(kind, { subject: 'subject' in input ? input.subject : p.subject, body: 'body' in input ? input.body : p.body });
    if ('body' in input) p.body = next.body;
    if (kind === 'email' && 'subject' in input) p.subject = next.subject;
  }
  p.updatedAt = new Date().toISOString();
  mirrorIfDefault(db, kind, p);
  if (kind === 'email' && db.templateDefaults.followUp === p.id) useForFollowUp(db, p);
  return p;
}

function remove(db, kind, id) {
  const p = find(db, kind, id);
  if (db.templateDefaults[kind] === id) {
    throw new Error('This is the default template. Make another one the default first, then delete this one.');
  }
  if (kind === 'email' && db.templateDefaults.followUp === id) {
    throw new Error('This is your follow-up email. Choose another for follow-ups in Settings first, then delete this one.');
  }
  db[kindOf(kind).list] = listOf(db, kind).filter((x) => x.id !== id);
  return p;
}

function setDefault(db, kind, id) {
  const p = find(db, kind, id);
  if (kind === 'email' && db.templateDefaults.followUp === p.id) {
    throw new Error('This is your follow-up email. Choose another for follow-ups in Settings first, then make this the default.');
  }
  db.templateDefaults[kind] = id;
  mirrorIfDefault(db, kind, p);
  return p;
}

// What the browser needs: every template, and which one is the default.
function publicView(db) {
  return { email: db.emailTemplates, text: db.textTemplates, defaults: db.templateDefaults };
}

module.exports = { normalize, create, update, remove, setDefault, setFollowUp, publicView, find, wordsKey, rememberPast, KINDS, LIMITS };
