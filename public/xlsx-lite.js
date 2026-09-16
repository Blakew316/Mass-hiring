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

  async function inflate(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .xlsx files — export the sheet as CSV instead.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntry(bytes, e) {
    const p = e.offset;
    if (u32(bytes, p) !== 0x04034b50) throw new Error('Corrupt spreadsheet file.');
    const nameLen = u16(bytes, p + 26);
    const extraLen = u16(bytes, p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflate(raw);
    throw new Error('Unsupported spreadsheet compression — export the sheet as CSV instead.');
  }

  const xml = (u8) => new DOMParser().parseFromString(td.decode(u8), 'application/xml');
  const local = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));

  function colIndex(ref) {
    const letters = (ref.match(/^[A-Z]+/) || [''])[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // Rich-text shared strings are several <t> runs; join them.
  const textOf = (el) => local(el, 't').map((t) => t.textContent).join('');

  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = zipEntries(bytes);
    const get = async (name) => (entries[name] ? readEntry(bytes, entries[name]) : null);

    // First sheet in workbook order → its part path via the relationships.
    let sheetPath = null;
    const wb = await get('xl/workbook.xml');
    const rels = await get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = local(xml(wb), 'sheet')[0];
      const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = local(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const target = rel.getAttribute('Target') || '';
        sheetPath = target.startsWith('/') ? target.slice(1) : (target.startsWith('xl/') ? target : `xl/${target}`);
      }
    }
    if (!sheetPath || !entries[sheetPath]) sheetPath = Object.keys(entries).find((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
    if (!sheetPath) throw new Error('No worksheet found in that file.');

    const shared = [];
    const ss = await get('xl/sharedStrings.xml');
    if (ss) for (const si of local(xml(ss), 'si')) shared.push(textOf(si));

    const sheet = xml(await get(sheetPath));
    const rows = [];
    for (const r of local(sheet, 'row')) {
      const out = [];
      for (const c of local(r, 'c')) {
        const idx = colIndex(c.getAttribute('r') || '');
        const t = c.getAttribute('t') || '';
        let v = '';
        if (t === 's') { const i = Number((local(c, 'v')[0] || {}).textContent); v = shared[i] != null ? shared[i] : ''; }
        else if (t === 'inlineStr') v = textOf(c);
        else if (t === 'b') v = (local(c, 'v')[0] || {}).textContent === '1' ? 'TRUE' : 'FALSE';
        else v = (local(c, 'v')[0] || {}).textContent || '';
        while (out.length < idx) out.push('');
        out[idx] = String(v);
      }
      rows.push(out);
    }
    return rows;
  }

  window.XlsxLite = { read };
})();
