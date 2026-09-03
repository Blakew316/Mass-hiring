// Scheduled function: drains the send queue every minute at a Gmail-safe pace.
// Runs only on the published production deploy; nothing to configure.
import queue from '../../lib/queue.js';

export default async () => {
  try {
    const r = await queue.processQueue({ budgetMs: 7000 });
    if (r.processed || r.reason !== 'empty') console.log('[send-queue]', JSON.stringify(r));
  } catch (err) {
    console.error('[send-queue] failed:', err && err.stack ? err.stack : err);
  }
  return new Response('ok');
};

export const config = { schedule: '* * * * *' };
