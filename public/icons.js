/* Icons in the SF Symbols idiom. The defining trait of Apple's UI iconography
   is not the corner radius, it is that the glyphs are SOLID: filled
   silhouettes with negative space punched through them, not hairline outlines.
   So these are filled by default — the <svg> carries fill="currentColor" — and
   counters (a gear's bore, an envelope's flap, a calendar's rule) are holes
   cut with fill-rule="evenodd" rather than strokes drawn over the top, which
   means they show whatever is behind them and work on any tint.
   The handful that really are linear in SF — chevrons, the wifi arcs, plus and
   minus — opt into a stroke via S(), at a weight that matches the filled ones
   optically rather than the 1.7 hairline this set used to use.
   Use icon('name', size) in JS, or <span data-icon="name"></span> in HTML. */
(() => {
  // A stroked member of an otherwise filled set.
  const S = (d, w = 2.2) => `<path fill="none" stroke="currentColor" stroke-width="${w}" d="${d}"/>`;

  const P = {
    // ---- structure and navigation ----
    grid: '<rect x="2.8" y="2.8" width="8.2" height="8.2" rx="2.7"/><rect x="13" y="2.8" width="8.2" height="8.2" rx="2.7"/><rect x="2.8" y="13" width="8.2" height="8.2" rx="2.7"/><rect x="13" y="13" width="8.2" height="8.2" rx="2.7"/>',
    chevron: S('M9.5 5.2L16.3 12l-6.8 6.8', 2.5),
    plus: S('M12 4.4v15.2M4.4 12h15.2', 2.5),
    x: S('M18.4 5.6L5.6 18.4M5.6 5.6l12.8 12.8', 2.5),
    check: S('M4.6 12.6l4.9 4.9L19.4 6.7', 2.7),
    xcircle: '<path fill-rule="evenodd" d="M12 1.8a10.2 10.2 0 1 0 0 20.4 10.2 10.2 0 0 0 0-20.4zm4.2 12.8l-1.6 1.6L12 13.6l-2.6 2.6-1.6-1.6L10.4 12 7.8 9.4l1.6-1.6L12 10.4l2.6-2.6 1.6 1.6L13.6 12z"/>',
    checkcircle: '<path fill-rule="evenodd" d="M12 1.8a10.2 10.2 0 1 0 0 20.4 10.2 10.2 0 0 0 0-20.4zm5 7.1l-6.3 6.9-3.9-4 1.6-1.6 2.2 2.3 4.8-5.2z"/>',
    search: S('M10.7 4.2a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13M15.5 15.5l4.6 4.6', 2.3),
    logout: '<path d="M10.6 2.6H6.6A3.8 3.8 0 0 0 2.8 6.4v11.2a3.8 3.8 0 0 0 3.8 3.8h4a1.2 1.2 0 0 0 0-2.4h-4a1.4 1.4 0 0 1-1.4-1.4V6.4A1.4 1.4 0 0 1 6.6 5h4a1.2 1.2 0 0 0 0-2.4z"/><path d="M16.2 6.9a1.2 1.2 0 0 0-1.7 1.7l2.2 2.2H9.8a1.2 1.2 0 0 0 0 2.4h6.9l-2.2 2.2a1.2 1.2 0 0 0 1.7 1.7l4.2-4.2a1.2 1.2 0 0 0 0-1.8z"/>',
    gear: '<path fill-rule="evenodd" d="M9.81 4.83L10.09 2.18L13.91 2.18L14.19 4.83A7.5 7.5 0 0 1 15.52 5.38L17.59 3.71L20.29 6.41L18.62 8.48A7.5 7.5 0 0 1 19.17 9.81L21.82 10.09L21.82 13.91L19.17 14.19A7.5 7.5 0 0 1 18.62 15.52L20.29 17.59L17.59 20.29L15.52 18.62A7.5 7.5 0 0 1 14.19 19.17L13.91 21.82L10.09 21.82L9.81 19.17A7.5 7.5 0 0 1 8.48 18.62L6.41 20.29L3.71 17.59L5.38 15.52A7.5 7.5 0 0 1 4.83 14.19L2.18 13.91L2.18 10.09L4.83 9.81A7.5 7.5 0 0 1 5.38 8.48L3.71 6.41L6.41 3.71L8.48 5.38A7.5 7.5 0 0 1 9.81 4.83ZM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/>',

    // A notification is a bell. A speech bubble means "messages", which is a
    // different promise — the panel behind this also carries bounces and, in
    // time, anything else worth interrupting for. Dome, flared skirt, and the
    // clapper as its own shape, the way bell.fill is drawn.
    bell: '<path d="M12 1.6a1.5 1.5 0 0 1 1.5 1.5v.8a7 7 0 0 1 5.4 6.8v2.5c0 1.4.5 2.8 1.4 3.9a1.3 1.3 0 0 1-1 2.2H4.7a1.3 1.3 0 0 1-1-2.2 6.2 6.2 0 0 0 1.4-3.9v-2.5a7 7 0 0 1 5.4-6.8v-.8A1.5 1.5 0 0 1 12 1.6z"/><path d="M9.3 18.9a.6.6 0 0 0-.6.7 3.4 3.4 0 0 0 6.6 0 .6.6 0 0 0-.6-.7z"/>',

    // ---- people ----
    users: '<circle cx="9" cy="7.6" r="3.9"/><path d="M9 12.8c-3.9 0-6.9 2.5-6.9 5.9 0 1.4 1 2.2 2.4 2.2h9c1.4 0 2.4-.8 2.4-2.2 0-3.4-3-5.9-6.9-5.9z"/><circle cx="17.8" cy="8.4" r="3"/><path d="M17.8 13.2c-.6 0-1.2 0-1.7.2a8.5 8.5 0 0 1 2.6 5.5h2.6c1.2 0 1.9-.7 1.9-1.8 0-2.3-2.2-3.9-5.4-3.9z"/>',

    // ---- files and transfer ----
    doc: '<path fill-rule="evenodd" d="M13.2 2.4H7.4A3.6 3.6 0 0 0 3.8 6v12A3.6 3.6 0 0 0 7.4 21.6h9.2A3.6 3.6 0 0 0 20.2 18V9.1h-4.6a2.4 2.4 0 0 1-2.4-2.4zm1.8.6v3.7c0 .4.3.7.7.7h3.6z"/>',
    sheet: '<path fill-rule="evenodd" d="M6.4 3.2h11.2A3.6 3.6 0 0 1 21.2 6.8v10.4a3.6 3.6 0 0 1-3.6 3.6H6.4a3.6 3.6 0 0 1-3.6-3.6V6.8A3.6 3.6 0 0 1 6.4 3.2zM5 8.7h3.4V5.4H6.4A1.4 1.4 0 0 0 5 6.8zm5.6 0H19V6.8a1.4 1.4 0 0 0-1.4-1.4h-7zM5 13.7h3.4v-2.8H5zm5.6 0H19v-2.8h-8.4zM5 17.2c0 .8.6 1.4 1.4 1.4h2v-2.7H5zm5.6 1.4h7c.8 0 1.4-.6 1.4-1.4v-1.3h-8.4z"/>',
    download: '<path d="M12 2.4a1.3 1.3 0 0 0-1.3 1.3v8.9l-2.5-2.5a1.3 1.3 0 0 0-1.8 1.8l4.7 4.7a1.3 1.3 0 0 0 1.8 0l4.7-4.7a1.3 1.3 0 0 0-1.8-1.8l-2.5 2.5V3.7A1.3 1.3 0 0 0 12 2.4z"/><path d="M3.6 13.8a1.3 1.3 0 0 1 1.3 1.3v2.7a1.5 1.5 0 0 0 1.5 1.5h11.2a1.5 1.5 0 0 0 1.5-1.5v-2.7a1.3 1.3 0 0 1 2.6 0v2.7a4.1 4.1 0 0 1-4.1 4.1H6.4a4.1 4.1 0 0 1-4.1-4.1v-2.7a1.3 1.3 0 0 1 1.3-1.3z"/>',
    upload: '<path d="M12 16.6a1.3 1.3 0 0 0 1.3-1.3V6.4l2.5 2.5a1.3 1.3 0 0 0 1.8-1.8l-4.7-4.7a1.3 1.3 0 0 0-1.8 0L6.4 7.1a1.3 1.3 0 0 0 1.8 1.8l2.5-2.5v8.9a1.3 1.3 0 0 0 1.3 1.3z"/><path d="M3.6 13.8a1.3 1.3 0 0 1 1.3 1.3v2.7a1.5 1.5 0 0 0 1.5 1.5h11.2a1.5 1.5 0 0 0 1.5-1.5v-2.7a1.3 1.3 0 0 1 2.6 0v2.7a4.1 4.1 0 0 1-4.1 4.1H6.4a4.1 4.1 0 0 1-4.1-4.1v-2.7a1.3 1.3 0 0 1 1.3-1.3z"/>',
    paperclip: S('M18.8 10.6l-7.9 7.9a4.4 4.4 0 0 1-6.2-6.2l8.2-8.2a2.9 2.9 0 0 1 4.1 4.1l-8.2 8.2a1.4 1.4 0 0 1-2-2l7.5-7.5', 2.1),
    trash: '<path d="M10.4 2.2h3.2a2.2 2.2 0 0 1 2.2 2.2v1.1h4a1.1 1.1 0 0 1 0 2.2h-.6l-.9 11.7a3.3 3.3 0 0 1-3.3 3h-5.6a3.3 3.3 0 0 1-3.3-3L5.2 7.7h-.6a1.1 1.1 0 0 1 0-2.2h4V4.4a2.2 2.2 0 0 1 2.2-2.2zm3.2 3.3V4.4h-3.2v1.1z"/>',

    // ---- messaging ----
    mail: '<path fill-rule="evenodd" d="M5.4 4.6h13.2a3.7 3.7 0 0 1 3.7 3.7v7.4a3.7 3.7 0 0 1-3.7 3.7H5.4a3.7 3.7 0 0 1-3.7-3.7V8.3a3.7 3.7 0 0 1 3.7-3.7zM3.4 8.9l7.5 5c.7.5 1.5.5 2.2 0l7.5-5-1-1.6-7.6 5.1-7.6-5.1z"/>',
    send: '<path d="M21.7 2.3a1.1 1.1 0 0 0-1.2-.2L2.9 8.7a1.1 1.1 0 0 0 .1 2.1l7.1 2.1 2.1 7.1a1.1 1.1 0 0 0 2.1.1l6.6-16.6a1.1 1.1 0 0 0-.2-1.2z"/>',
    reply: '<path d="M10.6 5a1.2 1.2 0 0 0-2-.9L2.4 9.8a1.6 1.6 0 0 0 0 2.4l6.2 5.7a1.2 1.2 0 0 0 2-.9v-2.6c4.1.1 7 1.3 9.2 4.3.5.7 1.7.3 1.6-.6-.6-6.3-4.7-9.6-10.8-9.9z"/>',
    bubble: '<path d="M12 3.3c-5.3 0-9.6 3.6-9.6 8 0 2 .9 3.9 2.4 5.3l-1.3 3.7a1 1 0 0 0 1.3 1.2l4.4-1.9c.9.2 1.8.3 2.8.3 5.3 0 9.6-3.6 9.6-8s-4.3-8.6-9.6-8.6z"/>',
    eye: '<path fill-rule="evenodd" d="M12 4.8C7 4.8 3 8.6 1.5 11.3a1.4 1.4 0 0 0 0 1.4C3 15.4 7 19.2 12 19.2s9-3.8 10.5-6.5a1.4 1.4 0 0 0 0-1.4C21 8.6 17 4.8 12 4.8zm0 10.6a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8z"/>',
    calendar: '<path fill-rule="evenodd" d="M7.9 1.8A1.2 1.2 0 0 1 9.1 3v1.2h5.8V3a1.2 1.2 0 0 1 2.4 0v1.3a3.8 3.8 0 0 1 3.5 3.8v10a3.8 3.8 0 0 1-3.8 3.8H7a3.8 3.8 0 0 1-3.8-3.8v-10a3.8 3.8 0 0 1 3.5-3.8V3a1.2 1.2 0 0 1 1.2-1.2zM5.4 9.4v1.9h13.2V9.4z"/>',
    alert: '<path fill-rule="evenodd" d="M13.8 3.5a2.1 2.1 0 0 0-3.6 0L1.9 18.2A2.1 2.1 0 0 0 3.7 21.4h16.6a2.1 2.1 0 0 0 1.8-3.2zM10.9 8.6h2.2v5.7h-2.2zm0 7.4h2.2v2.2h-2.2z"/>',
    lock: '<path d="M12 2.2a4.9 4.9 0 0 0-4.9 4.9v2.5h2.6V7.1a2.3 2.3 0 0 1 4.6 0v2.5h2.6V7.1A4.9 4.9 0 0 0 12 2.2z"/><rect x="3.8" y="9.6" width="16.4" height="11.8" rx="3.6"/>',

    // A crescent: one disc with a second, offset disc taken out of it. Two arcs,
    // no subtraction — the return arc is the bite.
    moon: '<path d="M21.3 13.6a9.4 9.4 0 1 1-10.9-10.9 8.2 8.2 0 0 0 10.9 10.9z"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 .9a1.2 1.2 0 0 1 1.2 1.2v1.6a1.2 1.2 0 0 1-2.4 0V2.1A1.2 1.2 0 0 1 12 .9zm0 18.2a1.2 1.2 0 0 1 1.2 1.2v1.6a1.2 1.2 0 0 1-2.4 0v-1.6a1.2 1.2 0 0 1 1.2-1.2zM23.1 12a1.2 1.2 0 0 1-1.2 1.2h-1.6a1.2 1.2 0 0 1 0-2.4h1.6a1.2 1.2 0 0 1 1.2 1.2zM4.9 12a1.2 1.2 0 0 1-1.2 1.2H2.1a1.2 1.2 0 0 1 0-2.4h1.6A1.2 1.2 0 0 1 4.9 12zM19.9 4.1a1.2 1.2 0 0 1 0 1.7l-1.1 1.1a1.2 1.2 0 0 1-1.7-1.7l1.1-1.1a1.2 1.2 0 0 1 1.7 0zM7 16.9a1.2 1.2 0 0 1 0 1.7l-1.1 1.1a1.2 1.2 0 1 1-1.7-1.7l1.1-1.1a1.2 1.2 0 0 1 1.7 0zm12.9 2.8a1.2 1.2 0 0 1-1.7 0L17.1 18.6a1.2 1.2 0 0 1 1.7-1.7l1.1 1.1a1.2 1.2 0 0 1 0 1.7zM7 7.1a1.2 1.2 0 0 1-1.7 0L4.2 5.8a1.2 1.2 0 0 1 1.7-1.7L7 5.4A1.2 1.2 0 0 1 7 7.1z"/>',
  };

  function icon(name, size = 16, cls = '') {
    const body = P[name] || P.circle;
    return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  window.icon = icon;
  window.mountIcons = (root = document) => {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.dataset.icon, el.dataset.size ? Number(el.dataset.size) : 16);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.mountIcons());
  else window.mountIcons();
})();
