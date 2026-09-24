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

const LIMITS = { name: 60, subject: 300, email: 20000, text: 2000, count: 50 };

const KINDS = {
  email: { list: 'emailTemplates', mirror: 'template', fields: ['subject', 'body'], defaultId: 'email-main', defaultName: 'Main email' },
  text: { list: 'textTemplates', mirror: 'textTemplate', fields: ['body'], defaultId: 'text-main', defaultName: 'Main text' },
};

function kindOf(kind) {
  const k = KINDS[kind];
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
  const defaults = db.templateDefaults && typeof db.templateDefaults === 'object' ? db.templateDefaults : {};
  db.templateDefaults = { email: String(defaults.email || ''), text: String(defaults.text || '') };
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
  db[k.mirror] = { ...db[k.mirror] };   // keeps the email's attachments
  for (const f of k.fields) db[k.mirror][f] = p[f];
  // Somebody has now written this team's letter, whatever it says.
  if (kind === 'email' && db.settings) db.settings.templateSeeded = false;
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
    Object.assign(p, words(kind, { subject: 'subject' in input ? input.subject : p.subject, body: 'body' in input ? input.body : p.body }));
  }
  p.updatedAt = new Date().toISOString();
  mirrorIfDefault(db, kind, p);
  return p;
}

function remove(db, kind, id) {
  const p = find(db, kind, id);
  if (db.templateDefaults[kind] === id) {
    throw new Error('This is the default template. Make another one the default first, then delete this one.');
  }
  db[kindOf(kind).list] = listOf(db, kind).filter((x) => x.id !== id);
  return p;
}

function setDefault(db, kind, id) {
  const p = find(db, kind, id);
  db.templateDefaults[kind] = id;
  mirrorIfDefault(db, kind, p);
  return p;
}

// What the browser needs: every template, and which one is the default.
function publicView(db) {
  return { email: db.emailTemplates, text: db.textTemplates, defaults: db.templateDefaults };
}

module.exports = { normalize, create, update, remove, setDefault, publicView, find, KINDS, LIMITS };
