// Scheduled function: drains every team's send queue once a minute at a
// Gmail-safe pace. Runs only on the published production deploy (30s limit);
// nothing to configure.
//
// There is no request here and so no session to take a team from, which is
// exactly the case lib/tenant.js warns about: the context has to be entered
// deliberately, once per team. A team with an empty queue costs one read and
// gets out of the way, so the budget goes to whoever actually has sending to
// do — and a team whose drain fails does not stop the next one.
import queue from '../../lib/queue.js';
import backups from '../../lib/backups.js';
import teams from '../../lib/teams.js';
import tenant from '../../lib/tenant.js';

const TOTAL_BUDGET_MS = 20000;
// A copy reads and writes the whole list once each; started any later than
// this it could run into the 30-second limit.
const BACKUP_START_BEFORE_MS = 22000;
// The smallest slice worth giving anyone. It is the send worker's own floor,
// not a number picked here: lib/queue.js will not begin a send unless it has
// SEND_TIMEOUT_MS + WRITE_RESERVE_MS left, so a shorter slice buys a run lease,
// a full database read and then nothing at all. Cutting the minute into ever
// thinner pieces as teams are added is how every team ends up sending zero.
const MIN_SLICE_MS = queue.SEND_TIMEOUT_MS + queue.WRITE_RESERVE_MS + 500;

export default async () => {
  const started = Date.now();
  try {
    const all = await teams.all();
    // Whoever is drained first gets the best of the minute, so the starting
    // point walks round the list. Without that, one busy team at the front
    // would use the whole budget every minute and the ones behind it would
    // never send at all.
    const offset = all.length ? Math.floor(Date.now() / 60000) % all.length : 0;
    const order = all.map((_, i) => all[(i + offset) % all.length]);
    for (let i = 0; i < order.length; i++) {
      const team = order[i];
      const left = TOTAL_BUDGET_MS - (Date.now() - started);
      if (left < MIN_SLICE_MS) {
        console.log(`[send-queue] out of minute after ${i} team(s); ${order.length - i} wait for the next one`);
        break;
      }
      // Whatever is left, in full. A team with nothing queued costs one read
      // and hands the rest straight on, so a busy team is never squeezed to
      // make room for an idle one — and the rotation above is what makes sure
      // a busy team at the front does not hold the minute every minute.
      try {
        const r = await tenant.run(team.id, () => queue.processQueue({ budgetMs: left }));
        if (r.processed || r.reason !== 'empty') console.log('[send-queue]', team.id, JSON.stringify(r));
      } catch (err) {
        console.error(`[send-queue] ${team.id} failed:`, err && err.stack ? err.stack : err);
      }
    }
    // The daily copy of the candidate list (lib/backups.js), one team a
    // minute in the same rotation, after the sending and only with time to
    // spare. It is apart from the drain on purpose: a copy that fails must
    // never cost a send, and a send must never wait on a copy.
    if (order.length && Date.now() - started < BACKUP_START_BEFORE_MS) {
      const team = order[0];
      try {
        const b = await tenant.run(team.id, () => backups.maybeDaily());
        if (b) console.log('[send-queue] backup', team.id, JSON.stringify(b));
      } catch (err) {
        console.error(`[send-queue] backup for ${team.id} failed:`, err && err.stack ? err.stack : err);
      }
    }
  } catch (err) {
    console.error('[send-queue] failed:', err && err.stack ? err.stack : err);
  }
  return new Response('ok');
};

export const config = { schedule: '* * * * *' };
