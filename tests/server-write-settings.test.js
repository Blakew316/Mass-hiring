// Saving Settings (POST /api/settings): what is stored, how numbers outside
// what the app honours are clamped and explained, and that secrets go in but
// never come back out.
//
// Intentions pinned here, from the code's own comments:
//   - a typed number is never silently changed: it is stored within range and
//     the reply says what was adjusted, from what, to what, and why
//   - the email pace caps follow the sending account (free Gmail vs Workspace)
//   - passwords and keys come back masked; the page posts the mask back for
//     fields nobody touched, and that must not overwrite the real value
//   - the tracking secret, the Sales IQ token and the relay token are not
//     writable here, and the first two are never sent to the page at all
//   - one team's settings are its own
const { ok, done, crash, R } = require('./helpers');
const W = require('./server-write-helpers');

const MASK = '••••••••';

(async () => {
  const s = await W.start(55);
  await W.seed(s, [W.person(1)]);

  // ---------- plain fields ----------
  let r = await s.json('POST', '/api/settings', {
    fromName: '  Pat Example  ', calendlyUrl: 'https://calendly.com/pat-example/intro', timeZone: 'America/New_York',
    gmailSignature: false, textSunday: true, ntfyTopic: 'pat-example-alerts', lastSheetUrl: 'https://docs.google.com/spreadsheets/d/abc123',
  });
  ok(r.status === 200 && r.body.ok && Array.isArray(r.body.adjusted) && r.body.adjusted.length === 0, 'settings save, with nothing adjusted', r.body.adjusted);
  let set = (await W.stored(s)).settings;
  ok(set.fromName === 'Pat Example' && set.calendlyUrl === 'https://calendly.com/pat-example/intro' && set.timeZone === 'America/New_York'
    && set.ntfyTopic === 'pat-example-alerts' && set.lastSheetUrl === 'https://docs.google.com/spreadsheets/d/abc123', 'text settings are stored, trimmed', set);
  ok(set.gmailSignature === false && set.textSunday === true, 'switches are stored as switches', { gmailSignature: set.gmailSignature, textSunday: set.textSunday });
  ok(r.body.settings.fromName === 'Pat Example' && r.body.settings.gmailSignature === false, 'the reply carries what was saved', r.body.settings);
  let st = await W.state(s);
  ok(st.settings.fromName === 'Pat Example' && st.settings.textSunday === true && st.texting.queue.sunday === true, 'the page reads the saved settings', st.settings);

  // Only what the form names: anything else in the body is ignored.
  const secretBefore = set.trackingSecret;
  const relayBefore = set.relayToken;
  r = await s.json('POST', '/api/settings', {
    trackingSecret: 'forged-secret', salesiqToken: 'forged-salesiq-token-0000000000', relayToken: 'forged-relay-token-000000000000',
    calendlySigningKey: 'forged-key', templateSeeded: true, somethingElse: 'x', fromName: 'Pat Example',
  });
  set = (await W.stored(s)).settings;
  ok(r.status === 200 && set.trackingSecret === secretBefore && set.relayToken === relayBefore && !set.salesiqToken
    && set.calendlySigningKey === '' && set.templateSeeded === false && !('somethingElse' in set),
  'secrets that are generated, never typed, cannot be written through Settings', set);

  // ---------- numbers ----------
  r = await s.json('POST', '/api/settings', {
    dailyLimit: '5000', perMinute: '100', followUpDays: '45', maxFollowUps: '9',
    textDailyLimit: '250', textMinGap: '5', textMaxGap: '99999', textStartHour: '25', textEndHour: '0',
  });
  const adj = Object.fromEntries((r.body.adjusted || []).map((a) => [a.key, a]));
  const want = {
    dailyLimit: ['5000', '2000', 'Daily send limit'], perMinute: ['100', '60', 'Emails per minute'],
    followUpDays: ['45', '30', 'Follow up after (days)'], maxFollowUps: ['9', '5', 'Follow-ups per person'],
    textDailyLimit: ['250', '100', 'Texts per day'], textMinGap: ['5', '20', 'Shortest gap between texts'],
    textMaxGap: ['99999', '1800', 'Longest gap between texts'], textStartHour: ['25', '23', 'Start texting at'], textEndHour: ['0', '1', 'Stop texting at'],
  };
  for (const [k, [from, to, label]] of Object.entries(want)) {
    const a = adj[k];
    ok(a && a.from === from && a.to === to && a.label === label && a.reason, `${label}: ${from} is stored as ${to}, and the reply says why`, a);
  }
  ok(/Google allows/.test(adj.dailyLimit.reason) && /Apple/.test(adj.textDailyLimit.reason) && /100/.test(adj.textDailyLimit.reason), 'the reasons name the real limit', [adj.dailyLimit.reason, adj.textDailyLimit.reason]);
  set = (await W.stored(s)).settings;
  ok(Object.entries(want).every(([k, [, to]]) => set[k] === to), 'the clamped numbers are what is stored', Object.fromEntries(Object.keys(want).map((k) => [k, set[k]])));
  st = await W.state(s);
  ok(Object.entries(want).every(([k, [, to]]) => st.settings[k] === to), 'and what the page reads', Object.fromEntries(Object.keys(want).map((k) => [k, st.settings[k]])));
  ok(st.queue.dailyLimit === 2000 && st.texting.queue.dailyLimit === 100 && st.followUp.days === 30 && st.followUp.max === 5, 'the queues use the clamped numbers', { email: st.queue.dailyLimit, text: st.texting.queue.dailyLimit, followUp: st.followUp });

  r = await s.json('POST', '/api/settings', { dailyLimit: '300', perMinute: '20', followUpDays: '4', maxFollowUps: '0', textDailyLimit: '50', textMinGap: '60', textMaxGap: '120', textStartHour: '9', textEndHour: '18' });
  ok(r.body.adjusted.length === 0, 'numbers inside the range are taken as typed', r.body.adjusted);
  set = (await W.stored(s)).settings;
  ok(set.dailyLimit === '300' && set.maxFollowUps === '0' && set.textEndHour === '18', 'and stored as typed (a deliberate 0 included)', set);
  ok((await W.state(s)).followUp.max === 0, 'a deliberate 0 means no follow-ups');

  r = await s.json('POST', '/api/settings', { followUpDays: '2.6', perMinute: 'lots', dailyLimit: '' });
  const adj2 = Object.fromEntries(r.body.adjusted.map((a) => [a.key, a]));
  set = (await W.stored(s)).settings;
  ok(adj2.followUpDays && adj2.followUpDays.to === '3' && set.followUpDays === '3', 'a fraction is rounded, and the reply says so', adj2.followUpDays);
  ok(adj2.perMinute && adj2.perMinute.to === '' && set.perMinute === '', 'a word where a number belongs is cleared to the default, and the reply says so', adj2.perMinute);
  ok(!adj2.dailyLimit && set.dailyLimit === '', 'a blank number means "use the default" and is not an adjustment', { adj: adj2.dailyLimit, stored: set.dailyLimit });

  // A free Gmail account allows fewer emails a day than Workspace.
  const workspaceStatus = s.mailer.sendStatus;
  s.mailer.sendStatus = async () => ({ ready: true, from: 'pat.example@gmail.com', via: 'gmail-api', reason: '' });
  r = await s.json('POST', '/api/settings', { dailyLimit: '1500' });
  ok(r.body.adjusted.length === 1 && r.body.adjusted[0].to === '500' && (await W.stored(s)).settings.dailyLimit === '500', 'from a free Gmail account the daily limit is capped at 500', r.body.adjusted);
  s.mailer.sendStatus = workspaceStatus;

  // ---------- secrets ----------
  const secrets = { smtpPass: 'app-pass-1234-5678', googleClientSecret: 'gcs-secret-value', calendlyToken: 'cal-token-value', apolloApiKey: 'apollo-key-value' };
  r = await s.json('POST', '/api/settings', { smtpUser: 'pat.example@example.com', googleClientId: 'client-id.apps.example', ...secrets });
  set = (await W.stored(s)).settings;
  ok(Object.entries(secrets).every(([k, v]) => set[k] === v), 'secrets are stored', Object.keys(secrets).map((k) => [k, set[k] === secrets[k]]));
  ok(Object.keys(secrets).every((k) => r.body.settings[k] === MASK), 'the reply masks every secret', Object.keys(secrets).map((k) => [k, r.body.settings[k]]));
  ok(r.body.settings.smtpUser === 'pat.example@example.com' && r.body.settings.googleClientId === 'client-id.apps.example', 'names and ids that are not secret come back as saved');
  await W.relayToken(s);
  st = await W.state(s);
  ok(Object.keys(secrets).every((k) => st.settings[k] === MASK) && st.settings.relayToken === MASK, 'the page reads every secret masked', Object.keys(secrets).concat('relayToken').map((k) => [k, st.settings[k]]));
  const body = JSON.stringify(st) + JSON.stringify(r.body);
  const realRelay = (await W.stored(s)).settings.relayToken;
  const leaked = [...Object.values(secrets), realRelay, (await W.stored(s)).settings.trackingSecret].filter((v) => v && body.includes(v));
  ok(leaked.length === 0, 'no secret appears anywhere in what the page is sent', leaked.map((v) => v.slice(0, 6)));
  ok(!('trackingSecret' in st.settings) && !('salesiqToken' in st.settings) && !('calendlySigningKeys' in st.settings), 'the tracking secret, Sales IQ token and signing keys are not sent at all', Object.keys(st.settings));

  // The page posts the whole form back, masks included.
  r = await s.json('POST', '/api/settings', { fromName: 'Pat Q. Example', smtpPass: MASK, googleClientSecret: MASK, calendlyToken: MASK, apolloApiKey: MASK });
  set = (await W.stored(s)).settings;
  ok(set.fromName === 'Pat Q. Example' && Object.entries(secrets).every(([k, v]) => set[k] === v), 'posting the mask back keeps the real secret', set.fromName);
  r = await s.json('POST', '/api/settings', { apolloApiKey: '' });
  set = (await W.stored(s)).settings;
  ok(set.apolloApiKey === '' && r.body.settings.apolloApiKey === '' && set.smtpPass === secrets.smtpPass, 'clearing one secret clears that one only', { apollo: set.apolloApiKey });
  ok((await W.state(s)).apollo.configured === false, 'and the page knows it is gone');

  // ---------- a save that lifts an email queue pause ----------
  // A raised daily limit lifts the daily-limit pause at once; new mail
  // credentials lift the "not set up" pause. Nothing else lifts either.
  const emailQueue = require(R('lib/queue.js'));
  const pause = (kind) => emailQueue.updateQ((q) => { q.pausedUntil = new Date(Date.now() + 6 * 3600000).toISOString(); q.pauseKind = kind; q.note = `paused (${kind})`; });
  await pause('daily');
  ok((await W.state(s)).queue.pauseKind === 'daily', '(the email queue is paused at its daily limit)');
  await s.json('POST', '/api/settings', { fromName: 'Pat Q. Example', smtpUser: 'pat.other@example.com' });
  st = await W.state(s);
  ok(st.queue.pausedUntil && st.queue.pauseKind === 'daily', 'saving other settings leaves the daily-limit pause in place', st.queue);
  await s.json('POST', '/api/settings', { dailyLimit: '400' });
  st = await W.state(s);
  ok(!st.queue.pausedUntil && st.queue.pauseKind === '', 'changing the daily limit lifts it at once', st.queue);
  await pause('not-ready');
  await s.json('POST', '/api/settings', { dailyLimit: '450' });
  ok((await W.state(s)).queue.pauseKind === 'not-ready', 'a new daily limit does not lift a "not set up" pause');
  await s.json('POST', '/api/settings', { smtpPass: 'a-new-app-password' });
  st = await W.state(s);
  ok(!st.queue.pausedUntil && st.queue.pauseKind === '', 'new mail credentials lift it', st.queue);

  // ---------- teams ----------
  const b = await W.secondTeam(s, 'Harbor Crew', '4826');
  const aBefore = (await W.stored(s)).settings;
  r = await b.json('POST', '/api/settings', { fromName: 'Harbor Recruiting', textDailyLimit: '10', smtpPass: 'harbor-pass' });
  ok(r.status === 200, 'another team saves its own settings', r.status);
  ok(W.same((await W.stored(s)).settings, aBefore), 'without touching this team\'s');
  const bState = await W.state(s, b.json);
  ok(bState.settings.fromName === 'Harbor Recruiting' && bState.settings.smtpUser === '' && bState.settings.calendlyToken === '', 'and sees none of this team\'s', bState.settings);

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0 && s.pushes.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
