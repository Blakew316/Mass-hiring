/* Icons drawn in the SF Symbols idiom: a 24pt box with the glyph filling about
   20 of it, a single 1.7 stroke, round caps and joins, and generous corner
   radii. Shapes stay geometric and are kept as simple as they can be while
   still reading at 14px — SF's own house has no door, its eye has no lashes.
   Use icon('name', size) in JS, or <span data-icon="name"></span> in HTML. */
(() => {
  const P = {
    // ---- structure and navigation ----
    grid: '<rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2.4"/><rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2.4"/><rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2.4"/><rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2.4"/>',
    chevron: '<path d="M9.4 5.6L15.8 12l-6.4 6.4"/>',
    plus: '<path d="M12 4.8v14.4"/><path d="M4.8 12h14.4"/>',
    x: '<path d="M18.2 5.8L5.8 18.2"/><path d="M5.8 5.8l12.4 12.4"/>',
    check: '<path d="M4.8 12.7l4.6 4.7L19.2 6.9"/>',
    circle: '<circle cx="12" cy="12" r="9.2"/>',
    xcircle: '<circle cx="12" cy="12" r="9.2"/><path d="M14.9 9.1l-5.8 5.8"/><path d="M9.1 9.1l5.8 5.8"/>',
    checkcircle: '<circle cx="12" cy="12" r="9.2"/><path d="M7.9 12.3l2.9 2.9 5.3-5.9"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M15.7 15.7l4.5 4.5"/>',
    logout: '<path d="M9.6 20.6H6.4A2.6 2.6 0 0 1 3.8 18V6a2.6 2.6 0 0 1 2.6-2.6h3.2"/><path d="M15.9 7.6l4.4 4.4-4.4 4.4"/><path d="M20.3 12H9.4"/>',
    gear: '<path d="M9.81 4.83L10.09 2.18L13.91 2.18L14.19 4.83A7.5 7.5 0 0 1 15.52 5.38L17.59 3.71L20.29 6.41L18.62 8.48A7.5 7.5 0 0 1 19.17 9.81L21.82 10.09L21.82 13.91L19.17 14.19A7.5 7.5 0 0 1 18.62 15.52L20.29 17.59L17.59 20.29L15.52 18.62A7.5 7.5 0 0 1 14.19 19.17L13.91 21.82L10.09 21.82L9.81 19.17A7.5 7.5 0 0 1 8.48 18.62L6.41 20.29L3.71 17.59L5.38 15.52A7.5 7.5 0 0 1 4.83 14.19L2.18 13.91L2.18 10.09L4.83 9.81A7.5 7.5 0 0 1 5.38 8.48L3.71 6.41L6.41 3.71L8.48 5.38A7.5 7.5 0 0 1 9.81 4.83Z"/><circle cx="12" cy="12" r="3.2"/>',

    // ---- people ----
    users: '<circle cx="9.1" cy="8.1" r="3.4"/><path d="M3.3 20.3c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4"/><circle cx="17.5" cy="8.7" r="2.6"/><path d="M17.7 15c2.4.3 4.1 2.2 4.1 4.7"/>',

    // ---- files and transfer ----
    doc: '<path d="M13.6 2.8H7A2.4 2.4 0 0 0 4.6 5.2v13.6A2.4 2.4 0 0 0 7 21.2h10a2.4 2.4 0 0 0 2.4-2.4V8.6z"/><path d="M13.6 2.8v4.2a1.6 1.6 0 0 0 1.6 1.6h4.2"/>',
    sheet: '<rect x="3.2" y="3.8" width="17.6" height="16.4" rx="3.2"/><path d="M3.2 9.4h17.6"/><path d="M3.2 14.8h17.6"/><path d="M9.6 3.8v16.4"/>',
    download: '<path d="M20.4 14.6v3.6a2.4 2.4 0 0 1-2.4 2.4H6a2.4 2.4 0 0 1-2.4-2.4v-3.6"/><path d="M12 3.4v11.2"/><path d="M7.8 10.4L12 14.6l4.2-4.2"/>',
    upload: '<path d="M20.4 14.6v3.6a2.4 2.4 0 0 1-2.4 2.4H6a2.4 2.4 0 0 1-2.4-2.4v-3.6"/><path d="M12 14.6V3.4"/><path d="M7.8 7.6L12 3.4l4.2 4.2"/>',
    paperclip: '<path d="M18.9 10.5l-8 8a4.5 4.5 0 0 1-6.4-6.4l8.3-8.3a3 3 0 0 1 4.3 4.3l-8.3 8.3a1.5 1.5 0 0 1-2.2-2.2l7.6-7.6"/>',
    trash: '<path d="M4.4 6.6h15.2"/><path d="M9.6 6.6V5.3a2 2 0 0 1 2-2h.8a2 2 0 0 1 2 2v1.3"/><path d="M6.3 6.6l.8 12.1a2.4 2.4 0 0 0 2.4 2.3h5a2.4 2.4 0 0 0 2.4-2.3l.8-12.1"/><path d="M10.3 10.4v6.6"/><path d="M13.7 10.4v6.6"/>',

    // ---- messaging ----
    mail: '<rect x="2.6" y="4.8" width="18.8" height="14.4" rx="3.4"/><path d="M3.8 8.3l7.1 4.8c.7.4 1.5.4 2.2 0l7.1-4.8"/>',
    send: '<path d="M20.6 3.4L3.9 9.6a.8.8 0 0 0 0 1.5l6.6 2.4 2.4 6.6a.8.8 0 0 0 1.5 0z"/><path d="M20.6 3.4l-10.1 10.1"/>',
    reply: '<path d="M9.2 7L4.2 12l5 5"/><path d="M4.2 12h9.2a6.6 6.6 0 0 1 6.6 6.6"/>',
    bubble: '<path d="M12 4.3c4.6 0 8.3 3.1 8.3 7s-3.7 7-8.3 7c-.9 0-1.8-.1-2.6-.4l-4.3 2 1.2-3.6a6.6 6.6 0 0 1-2.6-5c0-3.9 3.7-7 8.3-7z"/>',
    eye: '<path d="M12 5.4C7.1 5.4 3.4 9 2 12c1.4 3 5.1 6.6 10 6.6S20.6 15 22 12c-1.4-3-5.1-6.6-10-6.6z"/><circle cx="12" cy="12" r="2.9"/>',
    calendar: '<rect x="3.2" y="4.6" width="17.6" height="16.2" rx="3.4"/><path d="M3.2 9.6h17.6"/><path d="M8 2.8v3.4"/><path d="M16 2.8v3.4"/>',
    alert: '<path d="M10.3 3.9L2.2 18.1a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.2v4.5"/><path d="M12 17.2h.01"/>',
    lock: '<rect x="4.2" y="10.4" width="15.6" height="10.6" rx="3.2"/><path d="M7.8 10.4V7.6a4.2 4.2 0 0 1 8.4 0v2.8"/>',

    // ---- the industries a candidate can come from ----
    card: '<rect x="2.6" y="5" width="18.8" height="14" rx="3.2"/><path d="M2.6 9.7h18.8"/><path d="M6.4 14.9h3.8"/>',
    sun: '<circle cx="12" cy="12" r="4.3"/><path d="M19.4 12h2.5"/><path d="M17.23 17.23L19 19"/><path d="M12 19.4v2.5"/><path d="M6.77 17.23L5 19"/><path d="M4.6 12H2.1"/><path d="M6.77 6.77L5 5"/><path d="M12 4.6V2.1"/><path d="M17.23 6.77L19 5"/>',
    shield: '<path d="M12 2.9l7.6 2.7v5.6c0 4.7-3.1 8.7-7.6 10-4.5-1.3-7.6-5.3-7.6-10V5.6z"/>',
    bug: '<ellipse cx="12" cy="13.5" rx="4.5" ry="5.9"/><path d="M12 7.6v11.8"/><path d="M8.7 8.6L6.5 5.9"/><path d="M15.3 8.6l2.2-2.7"/><path d="M7.6 11.6L3.8 10.2"/><path d="M16.4 11.6l3.8-1.4"/><path d="M7.6 16.2l-3.8 1.6"/><path d="M16.4 16.2l3.8 1.6"/>',
    car: '<path d="M4.7 11.4l1.8-3.6a2.5 2.5 0 0 1 2.2-1.4h6.6a2.5 2.5 0 0 1 2.2 1.4l1.8 3.6"/><path d="M2.9 16.5v-2.7a2.4 2.4 0 0 1 2.4-2.4h13.4a2.4 2.4 0 0 1 2.4 2.4v2.7"/><path d="M2.9 16.5h2.5"/><path d="M9.2 16.5h5.6"/><path d="M18.6 16.5h2.5"/><circle cx="7.3" cy="16.5" r="1.9"/><circle cx="16.7" cy="16.5" r="1.9"/>',
    home: '<path d="M3.2 11L12 3.6l8.8 7.4"/><path d="M5.4 9.2v9.5a1.8 1.8 0 0 0 1.8 1.8h9.6a1.8 1.8 0 0 0 1.8-1.8V9.2"/>',
    wifi: '<path d="M2.4 8.9a14.6 14.6 0 0 1 19.2 0"/><path d="M5.8 12.4a9.8 9.8 0 0 1 12.4 0"/><path d="M9.1 15.9a5 5 0 0 1 5.8 0"/><path d="M12 19.4h.01"/>',
    umbrella: '<path d="M2.7 12.3a9.3 9.3 0 0 1 18.6 0c-1.55-1.35-3.1-1.35-4.65 0-1.55-1.35-3.1-1.35-4.65 0-1.55-1.35-3.1-1.35-4.65 0-1.55-1.35-3.1-1.35-4.65 0z"/><path d="M12 12.3v5.6a2.6 2.6 0 0 0 5.2 0"/>',
    store: '<path d="M3.6 9.6l1.7-5h13.4l1.7 5a2.9 2.9 0 0 1-5.6 1 2.9 2.9 0 0 1-5.6 0 2.9 2.9 0 0 1-5.6-1z"/><path d="M5.3 11.3v7.5a1.8 1.8 0 0 0 1.8 1.8h9.8a1.8 1.8 0 0 0 1.8-1.8v-7.5"/>',
    briefcase: '<rect x="2.8" y="7.2" width="18.4" height="12.6" rx="3"/><path d="M8.6 7.2V5.8a2.2 2.2 0 0 1 2.2-2.2h2.4a2.2 2.2 0 0 1 2.2 2.2v1.4"/><path d="M2.8 12.6h18.4"/>',
    key: '<circle cx="8.2" cy="8.2" r="4"/><path d="M11.1 11.1l9 9"/><path d="M15 15l-2.2 2.2"/><path d="M17.5 17.5l-2.2 2.2"/>',
  };
  function icon(name, size = 16, cls = '') {
    const body = P[name] || P.circle;
    return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
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
