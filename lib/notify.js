// Phone push notifications via ntfy.sh — install the free ntfy app
// (iOS/Android), subscribe to a topic, and pushes arrive on the phone.
//
// Published as JSON rather than with Title/Tags headers: HTTP headers can
// only carry Latin-1, so an emoji or accented name in the title would make
// the request fail before it was sent.
const PRIORITY = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

async function pushToPhone(settings, { title, message, priority = 'high', tags = 'calendar' }) {
  const topic = (settings.ntfyTopic || process.env.NTFY_TOPIC || '').trim();
  if (!topic) return { sent: false, reason: 'No ntfy topic configured in Settings.' };
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      title: String(title || ''),
      message: String(message || ''),
      priority: PRIORITY[String(priority)] || Number(priority) || PRIORITY.high,
      tags: String(tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ntfy push failed (${res.status})${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  return { sent: true };
}

module.exports = { pushToPhone };
