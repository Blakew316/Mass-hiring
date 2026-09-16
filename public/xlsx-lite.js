/* Reads the first worksheet of an .xlsx file into rows of strings, in the
   browser, with no library: an .xlsx is a zip of XML, the browser can inflate
   (DecompressionStream) and parse XML (DOMParser). Handles shared strings,
   inline strings, formula results, numbers and booleans; dates stay as the
   numbers Excel stores. Anything unusual raises a clear error so the user
   can export CSV instead. */
(() => {
  const td = new TextDecoder('utf-8');

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // Central directory → { name: { offset, method, csize, usize } }
  function zipEntries(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a spreadsheet file (no zip directory).');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const entries = {};
    for (let n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      const method = u16(bytes, p + 10);
      const csize = u32(bytes, p + 20);
      const usize = u32(bytes, p + 24);
      const nameLen = u16(bytes, p + 28);
      const extraLen = u16(bytes, p + 30);
      const commentLen = u16(bytes, p + 32);
      const offset = u32(bytes, p + 42);
      const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { offset, method, csize, usize };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  const MAX_PART = 80 * 1024 * 1024;   // a worksheet XML larger than this is not a candidate list

  async function inflate(data, limit) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .xlsx files — export the sheet as CSV instead.');
    const ds = new DecompressionStream('deflate-raw');
    const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { reader.cancel(); throw new Error('That spreadsheet is far too large to read here — export the list as CSV instead.'); }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  async function readEntry(bytes, e) {
    const p = e.offset;
    if (p + 30 > bytes.length || u32(bytes, p) !== 0x04034b50) throw new Error('Corrupt spreadsheet file.');
    if (e.usize > MAX_PART) throw new Error('That spreadsheet is far too large to read here — export the list as CSV instead.');
    const nameLen = u16(bytes, p + 26);
    const extraLen = u16(bytes, p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, Math.min(bytes.length, start + e.csize));
    if (e.method === 0) return raw;
    if (e.method === 8) return inflate(raw, MAX_PART);
    throw new Error('Unsupported spreadsheet compression — export the sheet as CSV instead.');
  }

  const xml = (u8) => new DOMParser().parseFromString(td.decode(u8), 'application/xml');
  const local = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));

  // "AB7" → 27; anything past three letters (16,384 columns) is not a list.
  function colIndex(ref) {
    const letters = (ref.match(/^[A-Z]{1,3}/) || [''])[0];
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return Math.min(n - 1, 999);
  }

  // Rich-text shared strings are several <t> runs; join them.
  const textOf = (el) => local(el, 't').map((t) => t.textContent).join('');

  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = zipEntries(bytes);
    const get = async (name) => (entries[name] ? readEntry(bytes, entries[name]) : null);

    if (!entries['xl/workbook.xml']) {
      throw new Error(entries['index.xml'] || Object.keys(entries).some((n) => /^Index\//.test(n))
        ? 'That is a Numbers document — in Numbers choose File → Export To → CSV (or Excel) and import that.'
        : entries['content.xml'] ? 'That is an OpenDocument spreadsheet — save it as .xlsx or CSV and import that.'
        : 'That file is not an Excel workbook — export the list as .xlsx or CSV.');
    }

    // Visible sheets in workbook order; the first one with rows wins.
    const candidates = [];
    const wb = await get('xl/workbook.xml');
    const rels = await get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const relList = local(xml(rels), 'Relationship');
      for (const sh of local(xml(wb), 'sheet')) {
        const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        const rel = relList.find((r) => r.getAttribute('Id') === rid);
        if (!rel) continue;
        const target = rel.getAttribute('Target') || '';
        const p = target.startsWith('/') ? target.slice(1) : (target.startsWith('xl/') ? target : `xl/${target}`);
        if (entries[p]) candidates.push({ path: p, hidden: /hidden/i.test(sh.getAttribute('state') || '') });
      }
    }
    for (const n of Object.keys(entries)) if (/^xl\/worksheets\/sheet\d*\.xml$/.test(n) && !candidates.some((c) => c.path === n)) candidates.push({ path: n, hidden: false });
    if (!candidates.length) throw new Error('No worksheet found in that file.');
    candidates.sort((a, b) => Number(a.hidden) - Number(b.hidden));

    const shared = [];
    const ss = await get('xl/sharedStrings.xml');
    if (ss) for (const si of local(xml(ss), 'si')) shared.push(textOf(si));

    const readSheet = async (path) => {
      const sheet = xml(await get(path));
      const rows = [];
      for (const r of local(sheet, 'row')) {
        const out = [];
        let next = 0;
        for (const c of local(r, 'c')) {
          const ref = c.getAttribute('r');
          const idx = ref ? colIndex(ref) : next;      // cells without a reference simply follow on
          if (idx < 0) continue;
          const t = c.getAttribute('t') || '';
          let v = '';
          if (t === 's') { const i = Number((local(c, 'v')[0] || {}).textContent); v = shared[i] != null ? shared[i] : ''; }
          else if (t === 'inlineStr') v = textOf(c);
          else if (t === 'b') v = (local(c, 'v')[0] || {}).textContent === '1' ? 'TRUE' : 'FALSE';
          else v = (local(c, 'v')[0] || {}).textContent || '';
          while (out.length < idx) out.push('');
          out[idx] = String(v);
          next = idx + 1;
        }
        rows.push(out);
        if (rows.length > 60000) break;
      }
      return rows;
    };
    for (const c of candidates) {
      const rows = await readSheet(c.path);
      if (rows.some((r) => r.some((v) => String(v).trim()))) return rows;
    }
    return [];
  }

  window.XlsxLite = { read };
})();
