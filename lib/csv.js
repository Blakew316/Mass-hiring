// Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas,
// escaped quotes, and both \n and \r\n line endings).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop fully-empty trailing rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Guess which imported column maps to which candidate field, by header name.
function guessMapping(headers) {
  const map = {};
  const find = (...needles) =>
    headers.findIndex((h) => {
      const s = String(h || '').toLowerCase().replace(/[^a-z]/g, '');
      return needles.some((n) => s.includes(n));
    });
  map.email = find('email', 'mail');
  map.name = find('fullname', 'name');
  map.firstName = find('firstname', 'first');
  map.lastName = find('lastname', 'last', 'surname');
  map.role = find('role', 'title', 'position', 'job');
  map.company = find('company', 'employer', 'organization', 'org');
  map.phone = find('phone', 'mobile', 'cell');
  map.notes = find('notes', 'comment');
  // "name" matcher can accidentally hit "first name"/"last name" columns.
  if (map.name === map.firstName || map.name === map.lastName) map.name = -1;
  return map;
}

module.exports = { parseCsv, guessMapping };
