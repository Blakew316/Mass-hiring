// Personalization: fill {{placeholders}} from a candidate record and append
// the Calendly booking link as a styled button at the end of the email.
const FALLBACKS = { firstName: 'there', fullName: 'there', role: 'professional' };

function firstNameOf(c) {
  if (c.firstName) return c.firstName;
  if (c.name) return c.name.trim().split(/\s+/)[0];
  return '';
}

function fill(text, candidate, settings) {
  const vars = {
    firstName: firstNameOf(candidate),
    lastName: candidate.lastName || (candidate.name ? candidate.name.trim().split(/\s+/).slice(1).join(' ') : ''),
    fullName: candidate.name || [candidate.firstName, candidate.lastName].filter(Boolean).join(' '),
    role: candidate.role || '',
    company: candidate.company || '',
    email: candidate.email || '',
    senderName: settings.senderName || '',
    calendlyUrl: settings.calendlyUrl || '',
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    const v = vars[key];
    if (v) return v;
    return FALLBACKS[key] || '';
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render the personalized email for one candidate: subject, html, and a
// plain-text version. The Calendly button is appended automatically when a
// booking link is configured (per the workflow: template first, link at the end).
function renderEmail(template, candidate, settings) {
  const subject = fill(template.subject, candidate, settings).replace(/\s+/g, ' ').trim();
  const bodyText = fill(template.body, candidate, settings);
  const calendly = (settings.calendlyUrl || '').trim();

  const paragraphs = escapeHtml(bodyText).split('\n').join('<br>');
  let html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.6;color:#1f2430;max-width:640px;">` +
    `<p style="margin:0;">${paragraphs}</p>`;
  let text = bodyText;

  if (calendly) {
    html +=
      `<p style="margin:24px 0 8px;">` +
      `<a href="${escapeHtml(calendly)}" ` +
      `style="display:inline-block;background:#1088e8;color:#ffffff;text-decoration:none;` +
      `padding:11px 22px;border-radius:10px;font-weight:600;font-size:15px;">` +
      `Book a time with me</a></p>` +
      `<p style="margin:0;font-size:13px;color:#7a8194;">Or copy this link: ` +
      `<a href="${escapeHtml(calendly)}" style="color:#1088e8;">${escapeHtml(calendly)}</a></p>`;
    text += `\n\nBook a time with me: ${calendly}`;
  }
  html += `</div>`;

  return { subject, html, text };
}

module.exports = { renderEmail, fill };
