// Which team the work in front of us belongs to.
//
// Every stored document in this app is one team's: their candidates, their
// templates, their Gmail connection, their queue. Rather than thread a team id
// through every function that touches storage -- hundreds of call sites, each
// one an opportunity to forget -- the team is held in an async context for the
// duration of a request, and lib/storage.js reads it when it builds a key.
//
// The safety property that matters: storage REFUSES to read or write a
// team-scoped key with no team in context. A missing context is a bug, and the
// only two outcomes of a bug here are "it throws" and "it silently serves one
// team another team's data". It throws.
//
// AsyncLocalStorage follows await, promise chains and timers, so everything
// downstream of run() -- including work that finishes long after run() returns
// -- sees the same team. What it does NOT follow is a callback captured before
// run() was entered; background work started outside a request (the scheduled
// queue drain) therefore enters the context explicitly, once per team.
const { AsyncLocalStorage } = require('async_hooks');

// A team id becomes part of a storage key, so it is restricted to characters
// that cannot climb out of that key's namespace. Anything else is refused at
// the door rather than sanitized, because a sanitized id no longer matches the
// one in the registry and would quietly address a different team's data.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// The team that owns everything this app stored before teams existed. It is
// named here, rather than in three places, because several modules have to ask
// the same question about it: a secret configured process-wide — an SMTP
// login, a phone-notification topic, a relay token — was configured for THAT
// team, back when it was the only one. Handing those secrets to every team
// that comes along would let a new team send mail from someone else's mailbox
// and push notifications to someone else's phone.
const LEGACY_ID = 'maverick';

const als = new AsyncLocalStorage();

// Run fn with `teamId` as the current team. Returns whatever fn returns.
function run(teamId, fn) {
  if (!validId(teamId)) throw new Error(`Invalid team id: ${JSON.stringify(teamId)}`);
  return als.run({ teamId }, fn);
}

// The current team id, or null outside any context.
function current() {
  const s = als.getStore();
  return s ? s.teamId : null;
}

function currentOrThrow(what = 'this data') {
  const id = current();
  if (!id) {
    throw new Error(`No team in context — refusing to touch ${what}. This is a bug: the request did not go through the team middleware.`);
  }
  return id;
}

// For a process that IS one team: a script, a one-off tool, a test driver
// standing in for a signed-in request. It sets the team for everything that
// follows, and run() still wins wherever it is used — which is why a server
// must never call this. On a server the whole point is that the team comes
// from the request, and a process-wide default would turn a forgotten context
// from a loud error into one team quietly reading another's data.
function adopt(teamId) {
  if (!validId(teamId)) throw new Error(`Invalid team id: ${JSON.stringify(teamId)}`);
  als.enterWith({ teamId });
}

// Is the team in context the one an environment variable was set up for?
// False outside any context too: no team means no inherited secrets.
function isLegacy() {
  return current() === LEGACY_ID;
}

module.exports = { run, current, currentOrThrow, adopt, isLegacy, validId, ID_RE, LEGACY_ID };
