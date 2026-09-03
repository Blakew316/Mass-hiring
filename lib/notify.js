// Phone push notifications via ntfy.sh — install the free ntfy app
// (iOS/Android), subscribe to a topic, and pushes arrive on the phone.
async function pushToPhone(settings, { title, message, priority = 'high', tags = 'calendar' }) {
  const topic = (settings.ntfyTopic || process.env.NTFY_TOPIC || '').trim();
  if (!topic) return { sent: false, reason: 'No ntfy topic configured in Settings.' };
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: tags },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy push failed (${res.status})`);
  return { sent: true };
}

module.exports = { pushToPhone };
