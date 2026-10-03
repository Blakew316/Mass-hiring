// The two emails of the onboarding packet, ported from WPI Hire (src/mailer.js):
// the invitation a new hire gets, with the button into the paperwork portal,
// and the signed paperwork coming back to the company. The HTML is WPI Hire's,
// byte for byte, apart from one added row (Location) in the second. They go
// out through this app's own mailer (lib/mailer.js) — the team's connected
// Google account or App Password — with the logo carried inline, as before.
const { logoBytes } = require('./onboarding-docs');

// Brand palette sampled from the Wholesale Payments logo.
const BRAND = {
  navy: '#0b1b5e',
  navyDeep: '#071244',
  blue: '#0a8fe0',
  green: '#00c06f',
  greenSoft: '#e2f8ee',
  ink: '#1c2433',
  gray: '#5b6572',
  grayLight: '#98a1ac',
  line: '#e5e9ef',
  bg: '#f4f6f9',
  panel: '#f7f9fc',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Email sent to the company when a hire submits their signed paperwork.
function completedEmailHtml(hire, company, documents, audit, name) {
  const rows = documents
    .map(
      (d) => `
      <tr>
        <td width="26" valign="top" style="padding:7px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="width:18px;height:18px;border-radius:9px;background:${BRAND.greenSoft};color:${BRAND.green};font:700 11px/18px ${FONT};">&#10003;</td>
          </tr></table>
        </td>
        <td style="padding:7px 0 7px 4px;font:500 13.5px ${FONT};color:${BRAND.ink};">${escapeHtml(d.title)}</td>
      </tr>`
    )
    .join('');

  const detail = (label, value) =>
    value
      ? `<tr>
          <td style="padding:7px 0;border-bottom:1px solid ${BRAND.line};font:600 11px ${FONT};letter-spacing:.05em;text-transform:uppercase;color:${BRAND.grayLight};width:40%;">${escapeHtml(label)}</td>
          <td style="padding:7px 0;border-bottom:1px solid ${BRAND.line};font:500 13.5px ${FONT};color:${BRAND.ink};">${escapeHtml(value)}</td>
        </tr>`
      : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BRAND.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};">
    <tr><td align="center" style="padding:34px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid ${BRAND.line};">
        <tr><td style="padding:0;line-height:0;font-size:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="34%" style="height:4px;background:${BRAND.blue};"></td>
            <td width="33%" style="height:4px;background:${BRAND.green};"></td>
            <td width="33%" style="height:4px;background:${BRAND.navy};"></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:30px 44px 4px;">
          <img src="cid:wp-logo" width="150" alt="${escapeHtml(company.name)}" style="display:block;width:150px;height:auto;" />
        </td></tr>
        <tr><td style="padding:18px 44px 6px;">
          <h1 style="margin:0;font:700 22px/1.3 ${FONT};letter-spacing:-0.02em;color:${BRAND.navy};">Paperwork completed</h1>
          <p style="margin:8px 0 0;font:400 14.5px/1.6 ${FONT};color:${BRAND.gray};">
            <strong style="color:${BRAND.ink};">${escapeHtml(name)}</strong> has signed and submitted their new-hire paperwork.
            The completed PDFs are attached.
          </p>
        </td></tr>
        <tr><td style="padding:18px 44px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;">
            <tr><td style="padding:16px 20px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${detail('Name', name)}
                ${detail('Email', hire.email)}
                ${detail('Phone', hire.phone)}
                ${detail('Role', hire.jobTitle)}
                ${detail('Signed', `${hire.signedDate || ''} ${audit.time || ''}`.trim())}
                ${detail('Reference', audit.reference)}
                ${detail('IP address', audit.ip)}
                ${detail('Location', audit.location)}
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 44px 6px;">
          <p style="margin:0 0 6px;font:700 11px ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${BRAND.blue};">Attached</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:18px 44px 30px;">
          <p style="margin:0;font:400 12.5px/1.6 ${FONT};color:${BRAND.grayLight};">
            These documents contain sensitive personal information. Store them securely and share only with payroll and HR.
          </p>
        </td></tr>
        <tr><td style="padding:16px 44px;border-top:1px solid ${BRAND.line};background:${BRAND.panel};">
          <p style="margin:0;font:400 11.5px/1.6 ${FONT};color:${BRAND.grayLight};">
            ${escapeHtml(company.name)} · ${escapeHtml(company.address)}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function packetEmailHtml(hire, company, documents, portalLink) {
  const detailRows = [
    ['Position', hire.jobTitle],
    ['Department', hire.department],
    ['Start date', hire.startDate],
    ['Manager', hire.manager],
  ]
    .filter(([, v]) => v)
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.line};font:600 12px ${FONT};letter-spacing:.06em;text-transform:uppercase;color:${BRAND.grayLight};width:38%;">${escapeHtml(label)}</td>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.line};font:500 14px ${FONT};color:${BRAND.ink};">${escapeHtml(value)}</td>
      </tr>`
    )
    .join('');

  // List the documents the hire signs. Nothing is attached to this email —
  // they read each one in full in the portal before signing.
  const signable = documents.filter((d) => d.signable);
  const listed = signable.length ? signable : documents;

  const docRows = listed
    .map(
      (d) => `
      <tr>
        <td width="30" valign="top" style="padding:7px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="width:20px;height:20px;border-radius:10px;background:${BRAND.greenSoft};color:${BRAND.green};font:700 12px/20px ${FONT};">&#10003;</td>
          </tr></table>
        </td>
        <td style="padding:7px 0 7px 4px;font:500 14px ${FONT};color:${BRAND.ink};">${escapeHtml(d.title)}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Welcome aboard — your ${escapeHtml(company.name)} paperwork is ready to complete and sign online.</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:0;margin:0;">
    <tr><td align="center" style="padding:36px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BRAND.line};">

        <!-- Brand accent bar -->
        <tr><td style="padding:0;line-height:0;font-size:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="34%" style="height:4px;background:${BRAND.blue};"></td>
            <td width="33%" style="height:4px;background:${BRAND.green};"></td>
            <td width="33%" style="height:4px;background:${BRAND.navy};"></td>
          </tr></table>
        </td></tr>

        <!-- Logo -->
        <tr><td align="center" style="padding:38px 48px 6px;">
          <img src="cid:wp-logo" width="190" alt="${escapeHtml(company.name)}" style="display:block;width:190px;max-width:60%;height:auto;" />
        </td></tr>

        <!-- Headline -->
        <tr><td align="center" style="padding:22px 48px 4px;">
          <h1 style="margin:0;font:700 26px/1.25 ${FONT};letter-spacing:-0.02em;color:${BRAND.navy};">Welcome aboard, ${escapeHtml(hire.firstName)}.</h1>
        </td></tr>
        <tr><td align="center" style="padding:8px 56px 26px;">
          <p style="margin:0;font:400 15px/1.65 ${FONT};color:${BRAND.gray};">
            We're delighted to confirm your onboarding with <strong style="color:${BRAND.ink};font-weight:600;">${escapeHtml(company.name)}</strong> —
            your paperwork is ready to complete online. You can read every document in full before you sign,
            and we'll email you signed copies as soon as you're finished.
          </p>
        </td></tr>

        ${detailRows ? `
        <!-- Position summary -->
        <tr><td style="padding:0 48px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:12px;">
            <tr><td style="padding:18px 24px 10px;">
              <p style="margin:0 0 4px;font:700 11px ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${BRAND.blue};">Your role</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table>
            </td></tr>
          </table>
        </td></tr>` : ''}

        <!-- Documents -->
        <tr><td style="padding:22px 48px 4px;">
          <p style="margin:0 0 6px;font:700 11px ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${BRAND.blue};">${signable.length ? 'Documents to complete and sign' : 'Enclosed documents'}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${docRows}</table>
        </td></tr>

        ${portalLink ? `
        <!-- Primary action: complete paperwork online -->
        <tr><td style="padding:24px 48px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.navy};border-radius:12px;">
            <tr><td style="padding:24px 26px;" align="center">
              <p style="margin:0 0 4px;font:700 11px ${FONT};letter-spacing:.12em;text-transform:uppercase;color:#7fe0b4;">Action required</p>
              <p style="margin:0 0 16px;font:600 17px/1.4 ${FONT};color:#ffffff;">Complete and sign your paperwork online</p>
              <p style="margin:0 0 18px;font:400 13.5px/1.6 ${FONT};color:#b9c6e8;">
                Your details are already filled in — it takes about 10 minutes on your phone or computer.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr><td align="center" style="border-radius:8px;background:#ffffff;">
                  <a href="${escapeHtml(portalLink)}" style="display:inline-block;padding:14px 30px;font:700 15px ${FONT};color:${BRAND.navy};text-decoration:none;border-radius:8px;">Start my paperwork &rarr;</a>
                </td></tr>
              </table>
              <p style="margin:16px 0 0;font:400 11.5px/1.5 ${FONT};color:#8fa0c8;">
                This link is unique to you — please don't forward it.
              </p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:12px 48px 0;">
          <p style="margin:0;font:400 11.5px/1.6 ${FONT};color:${BRAND.grayLight};word-break:break-all;">
            Button not working? Copy this link into your browser:<br/>${escapeHtml(portalLink)}
          </p>
        </td></tr>` : `
        <tr><td style="padding:22px 48px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.navy};border-radius:12px;">
            <tr><td style="padding:16px 22px;">
              <p style="margin:0;font:500 13.5px/1.6 ${FONT};color:#ffffff;">
                <span style="color:#7fe0b4;font-weight:700;">Before your first day:</span>
                please review each document and return the signed acknowledgments. Questions? Simply reply to this email.
              </p>
            </td></tr>
          </table>
        </td></tr>`}

        <!-- Sign-off -->
        <tr><td style="padding:22px 48px 34px;">
          <p style="margin:0;font:400 14.5px/1.6 ${FONT};color:${BRAND.gray};">
            Warm regards,<br/>
            <span style="font-weight:600;color:${BRAND.ink};">${escapeHtml(company.hrName)}</span><br/>
            <span style="font-size:13px;color:${BRAND.grayLight};">${escapeHtml(company.name)}</span>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 48px;border-top:1px solid ${BRAND.line};background:${BRAND.panel};">
          <p style="margin:0;font:400 11.5px/1.6 ${FONT};color:${BRAND.grayLight};">
            ${escapeHtml(company.name)} · ${escapeHtml(company.address)}<br/>
            This message is confidential and intended solely for the named recipient.
          </p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Plain-text versions, sent alongside the HTML for mail clients that show
// text only.
function packetEmailText(hire, company, documents, portalLink) {
  const signable = documents.filter((d) => d.signable);
  const listed = signable.length ? signable : documents;
  const lines = [
    `Welcome aboard, ${hire.firstName}.`,
    '',
    `We're delighted to confirm your onboarding with ${company.name} — your paperwork is ready to complete online. You can read every document in full before you sign, and we'll email you signed copies as soon as you're finished.`,
  ];
  const details = [['Position', hire.jobTitle], ['Department', hire.department], ['Start date', hire.startDate], ['Manager', hire.manager]].filter(([, v]) => v);
  if (details.length) lines.push('', 'Your role', ...details.map(([k, v]) => `  ${k}: ${v}`));
  lines.push('', signable.length ? 'Documents to complete and sign' : 'Enclosed documents', ...listed.map((d) => `  ✓ ${d.title}`));
  if (portalLink) {
    lines.push('', 'Complete and sign your paperwork online — it takes about 10 minutes on your phone or computer:', portalLink, '', "This link is unique to you — please don't forward it.");
  }
  lines.push('', 'Warm regards,', company.hrName, company.name, '', `${company.name} · ${company.address}`);
  return lines.join('\n');
}

function completedEmailText(hire, company, documents, audit, name) {
  const rows = [
    ['Name', name], ['Email', hire.email], ['Phone', hire.phone], ['Role', hire.jobTitle],
    ['Signed', `${hire.signedDate || ''} ${audit.time || ''}`.trim()], ['Reference', audit.reference],
    ['IP address', audit.ip], ['Location', audit.location],
  ].filter(([, v]) => v);
  return [
    'Paperwork completed',
    '',
    `${name} has signed and submitted their new-hire paperwork. The completed PDFs are attached.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'Attached',
    ...documents.map((d) => `  ✓ ${d.title}`),
    '',
    'These documents contain sensitive personal information. Store them securely and share only with payroll and HR.',
    '',
    `${company.name} · ${company.address}`,
  ].join('\n');
}

// The logo, attached inline under the cid the HTML asks for.
function logoAttachment() {
  const bytes = logoBytes();
  return bytes ? [{ filename: 'logo.png', content: bytes, contentType: 'image/png', cid: 'wp-logo' }] : [];
}

module.exports = { BRAND, FONT, packetEmailHtml, completedEmailHtml, packetEmailText, completedEmailText, logoAttachment, escapeHtml };
