// Ported verbatim from WPI Hire (src/stamp-coords.js).
//
// Where each value is stamped onto the company PDFs.
//
// Coordinates are PDF points with the origin at the BOTTOM-LEFT of the page;
// `y` is the text baseline, which sits a few points above the printed rule.
// Every value below was measured off grid-overlaid renders of the real pages
// and independently pixel-verified — see the notes in each group.
//
//   kind: 'signature' | 'initials'  → draws the captured signature image
//   kind: 'paragraph'               → wraps `text` inside the region
//   anything else                   → draws values[source] as a single line

const HEALTH_ACKNOWLEDGMENT =
  'I acknowledge that I have received and reviewed the Impact Health Sharing program overview. ' +
  'I understand that Impact Health Sharing is a healthcare cost-sharing program and is NOT insurance: ' +
  'it is not ACA minimum essential coverage, payment of any medical expense is not guaranteed, and it is ' +
  'not backed by any state guaranty association. I understand that participation is entirely voluntary, ' +
  'that I enroll and pay directly with Impact Health Sharing, and that Wholesale Payments does not sponsor, ' +
  'administer, insure, or guarantee this program.';

const STAMPS = {
  'agent-agreement': [
    // Page 2 — the intro paragraph's three blanks.
    { page: 2, id: 'effectiveDate', kind: 'date', source: 'signedDate', x: 324, y: 420, maxWidth: 114 },
    { page: 2, id: 'agentName', kind: 'text', source: 'fullName', x: 88, y: 397, maxWidth: 215 },
    { page: 2, id: 'agentAddress', kind: 'text', source: 'fullAddress', x: 88, y: 371, maxWidth: 460 },

    // Page 6 — initials acknowledging §1.7(B) Exclusive Services.
    { page: 6, id: 'exclusivityInitials', kind: 'initials', x: 45, y: 425, maxWidth: 58 },

    // Page 11 — initials acknowledging Section V (non-solicit / confidentiality).
    { page: 11, id: 'nonSolicitInitials', kind: 'initials', x: 35, y: 217.5, maxWidth: 62 },

    // Page 16 — the AGENT execution block. The WHOLESALE PAYMENTS block to its
    // right is countersigned by the company and is deliberately never filled.
    { page: 16, id: 'agentAgreementSignature', kind: 'signature', x: 96, y: 133.5, maxWidth: 186 },
    { page: 16, id: 'agentPrintedName', kind: 'printed_name', source: 'fullName', x: 96, y: 111, maxWidth: 184 },
    { page: 16, id: 'agentTitle', kind: 'text', source: 'signerTitle', x: 96, y: 88.5, maxWidth: 186 },
    { page: 16, id: 'agentDate', kind: 'date', source: 'signedDate', x: 96, y: 66, maxWidth: 186 },

    // Page 18 — Schedule A "Acknowledged and Agreed".
    { page: 18, id: 'scheduleASignature', kind: 'signature', x: 108, y: 349, maxWidth: 186 },
    { page: 18, id: 'scheduleAName', kind: 'printed_name', source: 'fullName', x: 108, y: 326.5, maxWidth: 186 },
    { page: 18, id: 'scheduleADba', kind: 'text', source: 'dba', x: 364, y: 349, maxWidth: 186 },
    { page: 18, id: 'scheduleADate', kind: 'date', source: 'signedDate', x: 364, y: 326.5, maxWidth: 186 },

    // Page 21 — Agent Profile & Questionnaire.
    { page: 21, id: 'p21BusinessName', kind: 'text', source: 'businessNameOrBlank', x: 118, y: 663, maxWidth: 430 },
    { page: 21, id: 'p21BusinessAddress', kind: 'text', source: 'businessAddress', x: 166, y: 634, maxWidth: 382 },
    { page: 21, id: 'p21BusinessCity', kind: 'text', source: 'businessCity', x: 57, y: 605.5, maxWidth: 152 },
    { page: 21, id: 'p21BusinessState', kind: 'text', source: 'businessState', x: 259, y: 605.5, maxWidth: 84 },
    { page: 21, id: 'p21BusinessZip', kind: 'text', source: 'businessZip', x: 408, y: 605.5, maxWidth: 140 },
    { page: 21, id: 'p21AgentName', kind: 'printed_name', source: 'fullName', x: 67, y: 480.5, maxWidth: 480 },
    { page: 21, id: 'p21AgentAddress', kind: 'text', source: 'address', x: 122, y: 452, maxWidth: 425 },
    { page: 21, id: 'p21AgentCity', kind: 'text', source: 'city', x: 57, y: 423, maxWidth: 150 },
    { page: 21, id: 'p21AgentState', kind: 'text', source: 'state', x: 258, y: 423, maxWidth: 84 },
    { page: 21, id: 'p21AgentZip', kind: 'text', source: 'zip', x: 407, y: 423, maxWidth: 140 },
    { page: 21, id: 'p21License', kind: 'text', source: 'driversLicense', x: 128, y: 334.5, maxWidth: 175 },
    { page: 21, id: 'p21LicenseState', kind: 'text', source: 'licenseState', x: 393, y: 335.5, maxWidth: 153 },
    { page: 21, id: 'p21Phone', kind: 'text', source: 'phone', x: 114, y: 304.5, maxWidth: 139 },
    { page: 21, id: 'p21Email', kind: 'text', source: 'email', x: 309, y: 305, maxWidth: 237 },
    // Bank details are intentionally not collected online — the hire provides a
    // voided check or direct deposit form separately, so these stay blank.
  ],

  'email-policy': [
    { page: 5, id: 'emailPolicySignature', kind: 'signature', x: 58, y: 439, maxWidth: 178 },
    { page: 5, id: 'emailPolicyDate', kind: 'date', source: 'signedDate', x: 336, y: 439, maxWidth: 117 },
    { page: 5, id: 'emailPolicyName', kind: 'printed_name', source: 'fullName', x: 58, y: 395, maxWidth: 178 },
  ],

  // Landscape page, 1376 x 768 pt. The source page ships with an empty
  // acknowledgment area, so the wording is rendered in at generation time.
  'health-sharing': [
    {
      page: 9,
      id: 'healthAcknowledgmentText',
      kind: 'paragraph',
      text: HEALTH_ACKNOWLEDGMENT,
      x: 240,
      y: 520,
      maxWidth: 890,
      size: 11,
    },
    { page: 9, id: 'healthElectionLine', kind: 'text', source: 'healthElectionLabel', x: 240, y: 430, maxWidth: 890, size: 11, bold: true },
    { page: 9, id: 'healthPrintedName', kind: 'printed_name', source: 'fullName', x: 244, y: 349, maxWidth: 405, size: 12 },
    { page: 9, id: 'healthDate', kind: 'date', source: 'signedDate', x: 727, y: 349, maxWidth: 405, size: 12 },
    { page: 9, id: 'healthSharingSignature', kind: 'signature', x: 244, y: 274, maxWidth: 380 },
  ],
};

module.exports = { STAMPS };
