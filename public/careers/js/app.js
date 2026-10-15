/**
 * WPI Careers UI.
 *
 * Reads the company plan, wires the sliders and inputs to PayCalc, and renders
 * results. A team page is `?team=<slug>` (reached from /team/<slug>/) for a
 * team listed in js/teams.js, optionally with `t=<encoded>` carrying the
 * director's contact details from Team setup. Links can only change contact
 * details and the note, never pay or the team/director names. Config-derived
 * text is set with textContent, never innerHTML, because links are untrusted.
 */
(function () {
  'use strict';

  var D = window.PAY_DEFAULTS;
  var C = window.PayCalc;
  var TEAMS = window.WPI_TEAMS || {};
  var STORE_KEY = 'wp-pay-estimator:v1';

  var cfg = C.mergeConfig(D, {});
  var state = {
    period: 'ramp',
    deals: 8,
    pricing: 'cash',
    stmtDeals: 1,
    stmtVolume: 30000,
    equipProfit: 0,
    deals30: 5,
    deals90: 25,
    goalAmount: 10000,
    goalResidual: 0,
    stmtCalcVolume: 85000,
    resPace: null,          // null = follow the main slider
    resVolume: null         // null = team default
  };

  // ---------- helpers ----------
  var $ = function (id) { return document.getElementById(id); };
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n) { return usd.format(Math.round(n)); }
  function short(n) {
    if (n >= 1000) { var k = n / 1000; return '$' + (k % 1 ? k.toFixed(1) : k) + 'K'; }
    return '$' + n;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function saveInputs() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
  }
  function loadInputs() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s === 'object') {
        Object.keys(state).forEach(function (k) {
          if (s[k] === undefined) return;
          if (typeof state[k] === 'number' || state[k] === null) {
            var n = s[k] === null ? null : Number(s[k]);
            if (n === null || Number.isFinite(n)) state[k] = n === null ? null : Math.max(0, n);
          } else if (typeof state[k] === typeof s[k]) state[k] = s[k];
        });
        if (state.period !== 'ramp' && state.period !== 'standard') state.period = 'ramp';
        if (state.pricing !== 'traditional' && state.pricing !== 'cash') state.pricing = 'cash';
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- link encoding ----------
  function b64u(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    var s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function encodePlan(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'undefined') return Promise.resolve('j' + b64u(bytes));
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return 'z' + b64u(new Uint8Array(buf)); });
  }
  function decodePlan(code) {
    if (!code || code.length > 8000) return Promise.reject(new Error('bad length'));
    var bytes = unb64u(code.slice(1));
    var text;
    if (code[0] === 'j') text = Promise.resolve(new TextDecoder().decode(bytes));
    else if (code[0] === 'z' && typeof DecompressionStream !== 'undefined') {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      text = new Response(stream).text();
    } else return Promise.reject(new Error('unsupported'));
    return text.then(JSON.parse);
  }
  function baseUrl() { return location.origin + location.pathname; }

  // ---------- team pages ----------
  var LINK_KEYS = ['contactTitle', 'contactPhone', 'contactEmail', 'note'];

  function teamSlug() {
    var slug = new URLSearchParams(location.search).get('team');
    return slug && Object.prototype.hasOwnProperty.call(TEAMS, slug) ? slug : '';
  }

  function teamBlock(slug, o) { return C.teamBlock(TEAMS, D, slug, o); }

  function readLinkPlan() {
    var q = new URLSearchParams(location.search).get('t');
    return q && /^[A-Za-z0-9_-]+$/.test(q) ? decodePlan(q).catch(function () { return null; }) : Promise.resolve(null);
  }

  // ---------- rendering ----------
  function tiersFor(period) { return C.effectiveTiers(cfg, period === 'ramp'); }

  function bindText() {
    var map = {
      rampMonths: String(cfg.rampMonths),
      rampMonthsPlus: String(cfg.rampMonths + 1),
      residualShare: cfg.residual.share + '%',
      signingDeals: String(cfg.signing.deals),
      signingBonus: money(cfg.signing.bonus),
      contactFirst: contactFirst(),
      rampMult: cfg.rampCommissionMultiplier + '×'
    };
    document.querySelectorAll('[data-bind]').forEach(function (n) {
      var v = map[n.getAttribute('data-bind')];
      if (v != null) n.textContent = v;
    });

    document.title = cfg.team.name === D.team.name ? 'WPI Careers' : cfg.team.name + ' · WPI Careers';

    $('tradRate').textContent = money(cfg.upfront.traditional) + '/deal';
    $('cashRate').textContent = money(cfg.upfront.cash) + '/deal';

    var note = cfg.team.note.trim();
    $('managerNote').hidden = !note;
    $('managerNoteText').textContent = note;
    var by = (cfg.team.name + ' ' + cfg.team.title).trim();
    $('managerNoteBy').textContent = '— ' + (cfg.team.manager ? cfg.team.manager + ', ' + by : by);

    $('heroEyebrow').textContent = cfg.team.name === D.team.name
      ? 'Outside B2B sales · Wholesale Payments'
      : cfg.team.name + ' · Wholesale Payments';
    renderContact();
    renderFaq();
    $('standardsText').textContent = 'Submit daily merchant feedback by 8 PM and keep a ' + cfg.closeRate +
      '% closing ratio. Deals you generate outside appointments count toward that ratio.';
    renderRules();
  }

  // ---------- contact (Let's talk) ----------
  function contactFirst() { return cfg.team.contactName.trim().split(/\s+/)[0] || ''; }
  function phoneDigits() {
    var d = cfg.team.contactPhone.replace(/[^\d+]/g, '');
    return /^\+?\d{7,15}$/.test(d) ? d : '';
  }
  function validEmail() {
    var e = cfg.team.contactEmail.trim();
    return /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[A-Za-z]{2,}$/.test(e) ? e : '';
  }
  function renderContact() {
    var name = cfg.team.contactName.trim();
    var first = contactFirst();
    $('meetLink').hidden = !name;
    $('contactPerson').hidden = !name;
    $('contactName').textContent = name;
    $('contactRole').textContent = [cfg.team.contactTitle.trim(), cfg.team.name].filter(Boolean).join(' · ');
    $('contactInitials').textContent = name ? name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase() : '';
    var tel = phoneDigits(), mail = validEmail();
    $('contactActions').hidden = !tel && !mail;
    $('contactLines').hidden = !tel && !mail;
    $('contactCall').textContent = first ? 'Call ' + first : 'Call';
    $('contactEmail').textContent = first ? 'Email ' + first : 'Email';
    $('contactCall').hidden = !tel;
    $('contactText').hidden = !tel;
    $('contactEmail').hidden = !mail;
    if (tel) { $('contactCall').href = 'tel:' + tel; $('contactText').href = 'sms:' + tel; }
    if (mail) $('contactEmail').href = 'mailto:' + mail;
    $('contactPhoneText').textContent = tel ? cfg.team.contactPhone.trim() : '';
    $('contactEmailText').textContent = mail;
  }

  function renderFaq() {
    var who = contactFirst() || 'your sales director';
    var items = [
      ['How does daily pay work?', 'Once a merchant crosses the processing threshold (5 transactions on separate cards and $1,000 in volume), you are paid the next day.'],
      ['Are appointments guaranteed?', 'Complete the appointment certification in WPI University and you start receiving appointments, usually 2–3 a day. Availability depends on your market, and you keep access by sending feedback by 8 PM and holding a ' + cfg.closeRate + '% close rate.'],
      ['What happens after the first three months?', 'Your commission and monthly bonuses move to the standard levels. Residuals start paying in month ' + cfg.residual.firstPayMonth + ' and keep growing with your book.'],
      ['What should I ask before joining?', 'Ask ' + who + ' to walk you through the current commission schedule, your agreement terms, vesting, and how the 45× buyout is calculated.']
    ];
    // Same two-column card layout as the pay rules below it.
    var box = $('faq');
    box.textContent = '';
    var cols = [el('div', 'rules-col'), el('div', 'rules-col')];
    cols.forEach(function (c) { box.appendChild(c); });
    items.forEach(function (q, i) {
      var d = el('details');
      d.appendChild(el('summary', null, q[0]));
      d.appendChild(el('p', 'rules-answer', q[1]));
      cols[i % 2].appendChild(d);
    });
  }

  function setPct(input) {
    var min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--pct', ((Number(input.value) - min) / (max - min) * 100) + '%');
  }

  function renderTicks() {
    var slider = $('deals');
    var tiers = tiersFor(state.period);
    var top = tiers.length ? tiers[tiers.length - 1][0] : 20;
    var max = Math.max(30, Math.ceil((top + 5) / 5) * 5);
    if (Number(slider.max) !== max) { slider.max = String(max); }
    var box = $('ticks');
    box.textContent = '';
    tiers.forEach(function (t) {
      if (t[0] > max) return;
      var tick = el('span', 'tick' + (state.deals >= t[0] ? ' hit' : ''));
      tick.style.left = (t[0] / max * 100) + '%';
      tick.appendChild(el('b', null, String(t[0])));
      box.appendChild(tick);
    });
  }

  /**
   * Side-by-side Ramp-Up vs Standard table. rows: [label, rampValue, stdValue].
   * The column for the period the agent picked is highlighted, and the column
   * headers switch the period.
   */
  function renderSplit(box, totalLabel, totals, rows) {
    box.textContent = '';
    var cols = [['ramp', 'Ramp-Up', 'c-ramp'], ['standard', 'Standard', 'c-std']];
    function cell(cls, text, role) {
      var c = el('div', cls, text);
      c.setAttribute('role', role || 'cell');
      box.appendChild(c);
      return c;
    }
    cell('sp-label sp-head', '', 'columnheader');
    cols.forEach(function (c) {
      var h = cell('sp-head ' + c[2] + (state.period === c[0] ? ' on' : ''), null, 'columnheader');
      var b = el('button', 'sp-switch', c[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.period === c[0]));
      b.addEventListener('click', function () { setPeriod(c[0]); });
      h.appendChild(b);
    });
    cell('sp-label sp-total', totalLabel, 'rowheader');
    cell('sp-val sp-total c-ramp' + (state.period === 'ramp' ? ' on' : ''), money(totals[0]));
    cell('sp-val sp-total c-std' + (state.period === 'standard' ? ' on' : ''), money(totals[1]));
    rows.forEach(function (r, i) {
      var last = i === rows.length - 1 ? ' sp-last' : '';
      cell('sp-label' + last, r[0], 'rowheader');
      cell('sp-val c-ramp' + (state.period === 'ramp' ? ' on' : '') + (r[1] ? '' : ' zero') + last, money(r[1]));
      cell('sp-val c-std' + (state.period === 'standard' ? ' on' : '') + (r[2] ? '' : ' zero') + last, money(r[2]));
    });
  }

  function renderMonth() {
    var ramp = state.period === 'ramp';
    var rr = C.monthEstimate(cfg, state, true);
    var rs = C.monthEstimate(cfg, state, false);
    var r = ramp ? rr : rs;

    $('dealsOut').textContent = String(r.deals);
    var rows = [
      ['Upfront commission', rr.commission, rs.commission],
      ['Monthly bonus', rr.bonus, rs.bonus],
      ['Statement volume bonus', rr.statement, rs.statement]
    ];
    if (rr.equipment) rows.push(['Equipment sales', rr.equipment, rs.equipment]);
    renderSplit($('breakdown'), 'This month', [rr.total, rs.total], rows);

    // next tier nudge
    var nt = $('nextTier');
    nt.textContent = '';
    if (r.tier.next) {
      var need = r.tier.next[0] - r.deals;
      nt.appendChild(el('strong', null, plural(need, 'more deal')));
      nt.appendChild(document.createTextNode(' reaches the ' + r.tier.next[0] + '-deal bonus: '));
      nt.appendChild(el('strong', null, '+' + money(r.tier.next[1] - r.bonus)));
      nt.appendChild(document.createTextNode(' this month.'));
    } else if (r.tier.hit) {
      nt.appendChild(el('strong', null, 'Top bonus tier reached.'));
    }

    // ladder
    var lad = $('ladder');
    lad.textContent = '';
    tiersFor(state.period).forEach(function (t) {
      var hit = r.deals >= t[0];
      var cur = r.tier.hit && r.tier.hit[0] === t[0];
      var rung = el('div', 'rung' + (hit ? ' hit' : '') + (cur ? ' current' : ''));
      rung.appendChild(el('span', 'rung-bar'));
      rung.appendChild(el('span', 'rung-amt', short(t[1])));
      rung.appendChild(el('span', 'rung-deals', t[0] + ' deals'));
      lad.appendChild(rung);
    });


    var each = C.statementBonus(cfg.statement, state.stmtVolume);
    $('stmtHint').textContent = each ? money(each) + ' bonus per qualifying deal.' : 'Under ' + money(cfg.statement.lowMin) + ' earns no statement bonus.';

    renderTicks();
    renderGoal();
    renderStmt();
    return r;
  }

  function fixed1(n) { var t = (Math.round(n * 10) / 10).toFixed(1); return t.slice(-2) === '.0' ? t.slice(0, -2) : t; }

  function renderGoal() {
    var ramp = state.period === 'ramp';
    $('goalPeriod').textContent = ramp ? 'Ramp-Up month' : 'Standard month';
    document.querySelectorAll('#goalChips .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(Number(c.getAttribute('data-goal')) === state.goalAmount));
    });
    var res = C.dealsForGoal(cfg, state, ramp, state.goalAmount, state.goalResidual, 200);
    var stats = $('goalStats');
    stats.textContent = '';
    if (!res) {
      $('goalDeals').textContent = '200+';
      $('goalDealsUnit').textContent = 'deals';
      $('goalSub').textContent = 'That goal needs more than 200 deals this month at your current deal mix.';
      return;
    }
    var d = res.deals;
    $('goalDeals').textContent = String(d);
    $('goalDealsUnit').textContent = d === 1 ? 'deal this month' : 'deals this month';
    if (d === 0) {
      $('goalSub').textContent = 'Your residuals already cover this goal.';
      return;
    }
    var est = res.estimate;
    var sub = 'Estimated pay at ' + plural(d, 'deal') + ': ' + money(est.total);
    if (state.goalResidual > 0) sub += ' + ' + money(state.goalResidual) + ' in residuals';
    if (est.tier.hit) sub += '. That includes the ' + est.tier.hit[0] + '-deal bonus of ' + money(est.bonus);
    $('goalSub').textContent = sub + '.';

    var rate = Math.max(1, cfg.closeRate) / 100;
    var appts = Math.ceil(d / rate);
    [['Deals per week', fixed1(d / 4.33)],
     ['Appointments this month', String(appts)],
     ['Appointments per week', fixed1(appts / 4.33)],
     ['Appointments per workday', fixed1(appts / 21.7)]
    ].forEach(function (s2) {
      var box = el('div', 'stat');
      box.appendChild(el('span', null, s2[0]));
      box.appendChild(el('b', null, s2[1]));
      stats.appendChild(box);
    });
  }

  function renderStmt() {
    var key = state.pricing === 'cash' ? 'cash' : 'traditional';
    var st = cfg.statement;
    var vol = state.stmtCalcVolume;
    var bonus = C.statementBonus(st, vol);
    var commStd = cfg.upfront[key];
    var commRamp = commStd * cfg.rampCommissionMultiplier;

    if (document.activeElement !== $('stmtCalcVolume')) $('stmtCalcVolume').value = String(vol);
    var slider = $('stmtCalcSlider');
    slider.value = String(Math.min(Number(slider.max), vol));
    setPct(slider);
    document.querySelectorAll('#stmtChips .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(Number(c.getAttribute('data-volume')) === vol));
    });

    renderSplit($('stmtBreakdown'), 'This deal', [commRamp + bonus, commStd + bonus], [
      ['Upfront commission', commRamp, commStd],
      ['Statement volume bonus', bonus, bonus]
    ]);

    // next volume that pays more
    var cands = [st.lowMin, st.midMin, st.topMin];
    var k = vol >= st.topMin ? Math.floor((vol - st.topMin) / st.step) + 1 : 1;
    cands.push(st.topMin + k * st.step);
    var next = null;
    cands.sort(function (a, b) { return a - b; }).some(function (c) {
      if (c > vol && C.statementBonus(st, c) > bonus) { next = c; return true; }
      return false;
    });
    var nt = $('stmtNext');
    nt.textContent = '';
    if (next !== null) {
      nt.appendChild(el('strong', null, money(next - vol) + ' more'));
      nt.appendChild(document.createTextNode(' in monthly volume pays '));
      nt.appendChild(el('strong', null, '+' + money(C.statementBonus(st, next) - bonus)));
      nt.appendChild(document.createTextNode(' more on this deal.'));
    }

    var rows = [
      ['Under ' + short(st.lowMin), '$0', vol < st.lowMin],
      [short(st.lowMin) + ' – ' + short(st.midMin) , money(st.low), vol >= st.lowMin && vol < st.midMin],
      [short(st.midMin) + ' – ' + short(st.topMin), money(st.mid), vol >= st.midMin && vol < st.topMin],
      [short(st.topMin) + ' and up', money(st.topBase) + ' + ' + money(st.stepBonus) + ' per extra ' + short(st.step), vol >= st.topMin]
    ];
    var box = $('stmtTiers');
    box.textContent = '';
    rows.forEach(function (r) {
      var line = el('div', 'stmt-row' + (r[2] ? ' on' : ''));
      line.setAttribute('role', 'row');
      var a = el('span', null, r[0]); a.setAttribute('role', 'cell');
      var b = el('span', null, r[1]); b.setAttribute('role', 'cell');
      line.appendChild(a); line.appendChild(b);
      box.appendChild(line);
    });
  }

  function renderNinety() {
    var n = C.ninetyDay(cfg, state.deals30, state.deals90);
    var f = cfg.fastStart30, sg = cfg.signing;
    $('deals30Out').textContent = String(state.deals30);
    $('deals90Out').textContent = String(n.deals90);
    $('ninetyTotal').textContent = money(n.total);

    $('fast30Amt').textContent = money(f.bonus);
    $('fast30Desc').textContent = f.deals + ' deals in your first 30 days, each processing $1,000 and 5 transactions.';
    $('bonus30').classList.toggle('earned', n.fast30 > 0);
    $('fast30Pill').textContent = n.fast30 ? 'Earned' : plural(Math.max(0, f.deals - n.deals30), 'deal') + ' to go';
    $('fast30Pill').className = 'pill' + (n.fast30 ? ' on' : '');

    $('signingTitle').textContent = sg.deals + '-Deal Signing Bonus';
    $('signingAmt').textContent = money(sg.bonus);
    $('signingDesc').textContent = sg.deals + ' deals in your first 90 days, then 60 days to get all ' + sg.deals + ' processing ' + money(sg.minVolume) + '+. The report runs once.';
    $('bonus90').classList.toggle('earned', n.signing > 0);
    $('signingPill').textContent = n.signing ? 'Earned' : plural(Math.max(0, sg.deals - n.deals90), 'deal') + ' to go';
    $('signingPill').className = 'pill' + (n.signing ? ' on' : '');
  }

  function residualInputs() {
    return {
      pace: state.resPace === null ? state.deals : state.resPace,
      volume: state.resVolume === null ? cfg.residual.volume : state.resVolume,
      bps: cfg.residual.bps,
      attrition: cfg.residual.attrition
    };
  }

  function niceMax(v) {
    if (v <= 0) return 100;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    var steps = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (m <= steps[i]) return steps[i] * p;
    return 10 * p;
  }

  function renderResidual() {
    var ri = residualInputs();
    if (document.activeElement !== $('resPace')) $('resPace').value = String(ri.pace);
    if (document.activeElement !== $('resVolume')) $('resVolume').value = String(ri.volume);

    var per = C.residualPerMerchant(cfg, ri.volume, ri.bps);
    $('perMerchant').textContent = usd2.format(per);

    var monthlyUpfront = C.monthEstimate(cfg, Object.assign({}, state, { deals: ri.pace }), false).total;
    var proj = C.projectResiduals(cfg, { dealsPerMonth: ri.pace, perMerchant: per, attrition: ri.attrition, months: 24, monthlyUpfront: monthlyUpfront });
    var rows = proj.rows;

    var stats = $('resStats');
    stats.textContent = '';
    [['Month 12 residual', money(rows[11].paid) + '/mo'],
     ['Month 24 residual', money(rows[23].paid) + '/mo'],
     ['24-month residual total', money(rows[23].cum)],
     ['Projected vesting', proj.vestedAt ? 'Month ' + proj.vestedAt : 'Not in 24 mo']
    ].forEach(function (s) {
      var d = el('div', 'stat');
      d.appendChild(el('span', null, s[0]));
      d.appendChild(el('b', null, s[1]));
      stats.appendChild(d);
    });

    if (document.body.getAttribute('data-view') === 'growth') drawChart(rows, proj.vestedAt);
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  function drawChart(rows, vestedAt) {
    // Draw at the container's real width so labels stay at their CSS size.
    var W = Math.max(320, Math.round($('chart').clientWidth) || 640), H = W < 560 ? 240 : 300, L = 54, R = 14, T = 26, B = 30;
    var maxV = niceMax(Math.max.apply(null, rows.map(function (r) { return r.paid; })) * 1.05);
    var x = function (m) { return L + (m - 1) / (rows.length - 1) * (W - L - R); };
    var y = function (v) { return T + (1 - v / maxV) * (H - T - B); };

    var box = $('chart');
    box.textContent = '';
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet' });
    var defs = svg('defs');
    var grad = svg('linearGradient', { id: 'resFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    var s1 = svg('stop', { offset: '0%' }); s1.style.stopColor = 'var(--green)'; s1.style.stopOpacity = '0.22';
    var s2 = svg('stop', { offset: '100%' }); s2.style.stopColor = 'var(--green)'; s2.style.stopOpacity = '0';
    grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); s.appendChild(defs);

    for (var i = 0; i <= 4; i++) {
      var v = maxV * i / 4, yy = y(v);
      s.appendChild(svg('line', { class: 'grid', x1: L, x2: W - R, y1: yy, y2: yy }));
      s.appendChild(svg('text', { class: 'axis', x: L - 8, y: yy + 4, 'text-anchor': 'end' }, short(Math.round(v))));
    }
    [1, 6, 12, 18, 24].forEach(function (m) {
      s.appendChild(svg('text', { class: 'axis', x: x(m), y: H - 8, 'text-anchor': 'middle' }, 'Mo ' + m));
    });

    var line = rows.map(function (r, i) { return (i ? 'L' : 'M') + x(r.m).toFixed(1) + ' ' + y(r.paid).toFixed(1); }).join(' ');
    s.appendChild(svg('path', { class: 'area', d: line + ' L' + x(rows.length) + ' ' + y(0) + ' L' + x(1) + ' ' + y(0) + ' Z' }));
    s.appendChild(svg('path', { class: 'line', d: line }));

    if (vestedAt) {
      var vx = x(vestedAt);
      s.appendChild(svg('line', { class: 'vest', x1: vx, x2: vx, y1: T - 8, y2: H - B }));
      s.appendChild(svg('text', { class: 'vest-label', x: vx + (vestedAt > 18 ? -6 : 6), y: T - 12, 'text-anchor': vestedAt > 18 ? 'end' : 'start' }, 'Vested'));
    }
    var last = rows[rows.length - 1];
    s.appendChild(svg('circle', { class: 'dot', cx: x(last.m), cy: y(last.paid), r: 4.5 }));

    var hover = svg('line', { class: 'hover-line', x1: 0, x2: 0, y1: T, y2: H - B, visibility: 'hidden' });
    var hdot = svg('circle', { class: 'dot', r: 4.5, visibility: 'hidden' });
    s.appendChild(hover); s.appendChild(hdot);
    box.appendChild(s);

    var tip = el('div', 'tip');
    tip.hidden = true;
    box.appendChild(tip);

    function show(evt) {
      var rect = s.getBoundingClientRect();
      var px = (evt.clientX - rect.left) / rect.width * W;
      var m = Math.round((px - L) / (W - L - R) * (rows.length - 1)) + 1;
      m = Math.max(1, Math.min(rows.length, m));
      var r = rows[m - 1];
      hover.setAttribute('x1', x(m)); hover.setAttribute('x2', x(m)); hover.setAttribute('visibility', 'visible');
      hdot.setAttribute('cx', x(m)); hdot.setAttribute('cy', y(r.paid)); hdot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = 'Month ' + m + ' · ' + money(r.paid) + '/mo · ' + Math.round(r.book) + ' merchants';
      var left = x(m) / W * rect.width;
      tip.style.left = Math.max(90, Math.min(rect.width - 90, left)) + 'px';
      tip.style.top = '-34px';
    }
    function hide() { hover.setAttribute('visibility', 'hidden'); hdot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    s.addEventListener('pointermove', show);
    s.addEventListener('pointerdown', show);
    s.addEventListener('pointerleave', hide);
  }

  function renderRules() {
    var st = cfg.statement;
    var rampLadder = C.effectiveTiers(cfg, true);
    var doubledTo = cfg.rampTiers.length ? cfg.rampTiers[cfg.rampTiers.length - 1][0] : 0;
    var ladderText = function (l) { return l.map(function (t) { return t[0] + ' deals ' + short(t[1]); }).join(', '); };
    var groups = [
      ['When deals pay', [
        'Daily pay: once a merchant crosses the processing threshold, you are paid the next day.',
        'The threshold is at least 5 transactions on separate cards and $1,000 in volume.',
        'Upfront starts at ' + money(cfg.upfront.cash) + ' for cash discount deals and ' + money(cfg.upfront.traditional) + ' for traditional deals, adjusted for volume and SSOC pricing.',
        'Leases pay once funded and the Delivery & Acceptance form is in. Equipment sales pay ' + cfg.equipmentShare + '% of the sale minus equipment cost once the merchant has paid in full.'
      ]],
      ['Monthly bonuses', [
        'Only your best tier pays. Standard: ' + ladderText(cfg.monthlyTiers) + '.',
        'During ramp-up (months 1–' + cfg.rampMonths + ') the bonus is doubled up to ' + doubledTo + ' deals: ' + ladderText(cfg.rampTiers) + '. Above that, you earn the standard tier once it pays more: ' + ladderText(rampLadder.filter(function (t) { return t[0] > doubledTo; })) + '.',
        'Ramp-up bonuses and the second ramp-up commission pay in two parts: the first when accounts hit 5 transactions and $1,000, the second at 10 transactions and $5,000.',
        'Every deal in a tier must be processing $1,000 in a 30-day span within 90 days. For example, a January 8-deal bonus needs all 8 accounts processing by April 30.'
      ]],
      ['Statement volume bonus', [
        'Submit the statement with the merchant application. It must be within the last 90 days.',
        money(st.lowMin) + ' to ' + money(st.midMin - 1) + ': ' + money(st.low) + '. ' + money(st.midMin) + ' to ' + money(st.topMin - 1) + ': ' + money(st.mid) + '.',
        money(st.topMin) + ' and above: ' + money(st.topBase) + ' plus ' + money(st.stepBonus) + ' for every additional ' + money(st.step) + ' in monthly volume.'
      ]],
      ['Appointments', [
        'Complete the appointment certification in WPI University and you receive company appointments. No deal is required to unlock them.',
        'Keep a ' + cfg.closeRate + '% close rate. Deals you generate yourself also count toward it.',
        'Submit feedback on every appointment by 8 PM the same day, with the merchant name and result.'
      ]],
      ['Residuals and vesting', [
        'You earn ' + cfg.residual.share + '% of the residual on your merchants. Residuals pay on the first Friday of each month, starting month ' + cfg.residual.firstPayMonth + '.',
        'You are vested after ' + cfg.vesting.months + ' straight months with at least ' + money(cfg.vesting.comp) + ' in compensation and ' + cfg.vesting.accounts + ' processing merchant accounts.'
      ]],
      ['Deductions', [
        'Non-processing: if a merchant stops processing for 30 days (within 120 days of payment), the upfront commission, statement bonus and ramp-up bonus are deducted. They are paid back once the merchant processes again.',
        'Equipment: if a merchant has not processed for 45 days, the equipment cost is deducted until the merchant processes or the equipment is returned.',
        'Statement bonus: deducted after 60 days if the merchant doesn\'t process the statement amount.',
        'Pricing below the SSOC: the monthly minimum and monthly service fee difference ×3, plus the annual fee and early termination fee difference.'
      ]]
    ];
    var box = $('rules');
    box.textContent = '';
    // Two independent columns so opening one section never stretches its neighbour.
    var cols = [el('div', 'rules-col'), el('div', 'rules-col')];
    cols.forEach(function (c) { box.appendChild(c); });
    groups.forEach(function (g, i) {
      var d = el('details');
      d.appendChild(el('summary', null, g[0]));
      var ul = el('ul');
      g[1].forEach(function (t) { ul.appendChild(el('li', null, t)); });
      d.appendChild(ul);
      cols[i % 2].appendChild(d);
    });
  }

  function renderPeriod() {
    document.body.setAttribute('data-period', state.period);
    document.querySelectorAll('.period-opt').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-period') === state.period));
    });
  }

  function renderPricing() {
    document.querySelectorAll('.seg-opt').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-pricing') === state.pricing));
    });
  }

  function renderAll() {
    renderPeriod();
    renderPricing();
    bindText();
    renderMonth();
    renderNinety();
    renderResidual();
    ['deals', 'deals30', 'deals90', 'stmtCalcSlider'].forEach(function (id) { setPct($(id)); });
  }

  // ---------- tabs ----------
  var VIEWS = ['opportunity', 'earnings', 'growth', 'fit', 'talk'];
  function setView(v, focusTab) {
    if (VIEWS.indexOf(v) < 0) v = 'opportunity';
    var changed = document.body.getAttribute('data-view') !== v;
    document.body.setAttribute('data-view', v);
    VIEWS.forEach(function (name) {
      var on = name === v;
      $('view-' + name).hidden = !on;
      var t = $('tab-' + name);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (focusTab) $('tab-' + v).focus();
    try { history.replaceState(null, '', location.pathname + location.search + (v === 'opportunity' ? '' : '#' + v)); } catch (e) { /* sandboxed */ }
    if (changed) window.scrollTo(0, 0);
    if (v === 'growth') renderResidual();
  }
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (document.body.getAttribute('data-view') === 'growth') renderResidual(); }, 150);
  });

  function wireTabs() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
      t.addEventListener('keydown', function (e) {
        var i = VIEWS.indexOf(t.getAttribute('data-view'));
        if (e.key === 'ArrowRight') i = (i + 1) % VIEWS.length;
        else if (e.key === 'ArrowLeft') i = (i - 1 + VIEWS.length) % VIEWS.length;
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = VIEWS.length - 1;
        else return;
        e.preventDefault();
        setView(VIEWS[i], true);
      });
    });
    document.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-goto')); });
    });
    var start = /^#([a-z]+)$/.exec(location.hash);
    setView(start ? start[1] : 'opportunity');
  }

  function setPeriod(p) {
    state.period = p === 'standard' ? 'standard' : 'ramp';
    renderPeriod();
    renderMonth();
    saveInputs();
  }

  // ---------- inputs ----------
  function wire() {
    var deals = $('deals');
    deals.value = String(state.deals);
    deals.addEventListener('input', function () {
      state.deals = Number(deals.value);
      setPct(deals);
      renderMonth();
      renderResidual();
      saveInputs();
    });

    document.querySelectorAll('.period-opt').forEach(function (b) {
      b.addEventListener('click', function () { setPeriod(b.getAttribute('data-period')); });
      b.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var other = b.parentNode.querySelector('.period-opt:not([data-period="' + b.getAttribute('data-period') + '"])');
          other.focus(); other.click();
        }
      });
    });

    document.querySelectorAll('.seg-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        state.pricing = b.getAttribute('data-pricing');
        renderPricing();
        renderMonth();
        renderResidual();
        renderRules();
        saveInputs();
      });
    });

    ['stmtDeals', 'stmtVolume', 'equipProfit'].forEach(function (id) {
      var inp = $(id);
      inp.value = String(state[id]);
      inp.addEventListener('input', function () {
        var n = Number(inp.value);
        state[id] = Number.isFinite(n) ? Math.max(0, n) : 0;
        renderMonth();
        renderResidual();
        saveInputs();
      });
    });

    ['deals30', 'deals90'].forEach(function (id) {
      var inp = $(id);
      inp.value = String(state[id]);
      inp.addEventListener('input', function () {
        state[id] = Number(inp.value);
        if (id === 'deals30' && state.deals90 < state.deals30) { state.deals90 = state.deals30; $('deals90').value = String(state.deals90); setPct($('deals90')); }
        if (id === 'deals90' && state.deals30 > state.deals90) { state.deals30 = state.deals90; $('deals30').value = String(state.deals30); setPct($('deals30')); }
        setPct(inp);
        renderNinety();
        saveInputs();
      });
    });
    var goal = $('goalAmount'), goalRes = $('goalResidual');
    goal.value = String(state.goalAmount);
    goalRes.value = String(state.goalResidual);
    [[goal, 'goalAmount'], [goalRes, 'goalResidual']].forEach(function (p) {
      p[0].addEventListener('input', function () {
        var n = Number(p[0].value);
        state[p[1]] = Number.isFinite(n) ? Math.max(0, n) : 0;
        renderGoal();
        saveInputs();
      });
    });
    document.querySelectorAll('#goalChips .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.goalAmount = Number(c.getAttribute('data-goal'));
        goal.value = String(state.goalAmount);
        renderGoal();
        saveInputs();
      });
    });

    function setStmtVolume(v) {
      state.stmtCalcVolume = Math.max(0, Number.isFinite(v) ? v : 0);
      renderStmt();
      saveInputs();
    }
    $('stmtCalcVolume').addEventListener('input', function () { setStmtVolume(Number($('stmtCalcVolume').value)); });
    $('stmtCalcSlider').addEventListener('input', function () {
      setStmtVolume(Number($('stmtCalcSlider').value));
      $('stmtCalcVolume').value = String(state.stmtCalcVolume);
    });
    document.querySelectorAll('#stmtChips .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        setStmtVolume(Number(c.getAttribute('data-volume')));
        $('stmtCalcVolume').value = String(state.stmtCalcVolume);
      });
    });

    ['resPace', 'resVolume'].forEach(function (id) {
      var inp = $(id);
      inp.addEventListener('input', function () {
        if (inp.value === '') return;
        var n = Number(inp.value);
        state[id] = Number.isFinite(n) ? Math.max(0, n) : 0;
        renderResidual();
        saveInputs();
      });
    });
  }

  // ---------- team setup ----------
  /**
   * A director picks their team, then adds contact details. Details save on
   * this device (so they're there next visit) and travel in the team link.
   * Editing previews on this page without changing its URL; closing the
   * panel restores the page as it was.
   */
  var PROFILE_KEY = 'wpi-director:v1';
  var linkTimer = 0, pageCfg = null;

  function loadProfile() {
    try {
      var p = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      return p && typeof p === 'object' ? p : {};
    } catch (e) { return {}; }
  }
  function saveProfile(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
  }

  function readForm() {
    return {
      slug: $('setupTeam').value,
      contactTitle: $('setupRole').value,
      contactPhone: $('setupPhone').value,
      contactEmail: $('setupEmail').value,
      note: $('setupNote').value
    };
  }

  function fillForm(p) {
    var slug = Object.prototype.hasOwnProperty.call(TEAMS, p.slug) ? p.slug : '';
    $('setupTeam').value = slug;
    $('setupRole').value = p.contactTitle || D.team.contactTitle;
    $('setupNote').value = p.note || '';
    var t = TEAMS[slug] || {};
    $('setupName').value = t.director || '';
    // Official details from js/teams.js are shown but can't be changed here.
    $('setupPhone').value = t.phone || p.contactPhone || '';
    $('setupEmail').value = t.email || p.contactEmail || '';
    $('setupPhone').readOnly = !!t.phone;
    $('setupEmail').readOnly = !!t.email;
    $('contactGroup').hidden = !slug;
  }

  function onFormChange() {
    var p = readForm();
    $('contactGroup').hidden = !p.slug;
    if (p.slug) {
      var t = TEAMS[p.slug];
      $('setupName').value = t.director;
      cfg = C.mergeTeam(D, { team: teamBlock(p.slug, p) });
    } else {
      cfg = C.mergeConfig(D, {});
    }
    renderAll();
    $('saveStatus').textContent = saveProfile(p) ? 'Saved on this device.' : 'This browser blocked saving; your link still has everything.';
    clearTimeout(linkTimer);
    linkTimer = setTimeout(function () { updateLink(p); }, 120);
  }

  function updateLink(p) {
    $('copyStatus').textContent = '';
    var open = $('openTeamPage');
    if (!p.slug) {
      $('shareLink').value = '';
      $('copyLink').disabled = true;
      open.hidden = true;
      return Promise.resolve();
    }
    var block = teamBlock(p.slug, p), extra = {};
    LINK_KEYS.forEach(function (k) {
      var fromList = k === 'contactPhone' ? TEAMS[p.slug].phone : k === 'contactEmail' ? TEAMS[p.slug].email : '';
      var dflt = k === 'note' ? D.team.note : k === 'contactTitle' ? D.team.contactTitle : '';
      if (!fromList && block[k] && block[k] !== dflt) extra[k] = block[k];
    });
    var base = location.origin + location.pathname + 'team/' + p.slug + '/';
    var done = function (url) {
      $('shareLink').value = url;
      $('copyLink').disabled = false;
      open.href = url;
      open.hidden = false;
    };
    if (!Object.keys(extra).length) { done(base); return Promise.resolve(); }
    return encodePlan(extra).then(function (code) { done(base + '?t=' + code); });
  }

  function openSetup() {
    pageCfg = cfg;
    var saved = loadProfile();
    var here = teamSlug();
    // On a team page, start from that team; otherwise from what this device saved.
    var p = here && saved.slug !== here
      ? { slug: here, contactTitle: cfg.team.contactTitle, contactPhone: cfg.team.contactPhone, contactEmail: cfg.team.contactEmail, note: cfg.team.note === D.team.note ? '' : cfg.team.note }
      : saved;
    fillForm(p);
    $('saveStatus').textContent = saved.slug ? 'Your details are saved on this device.' : '';
    updateLink(readForm());
    var dlg = $('setup');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function wireSetup() {
    var list = $('setupTeam');
    Object.keys(TEAMS).forEach(function (slug) {
      var o = el('option', null, TEAMS[slug].name + ' · ' + TEAMS[slug].director);
      o.value = slug;
      list.appendChild(o);
    });
    ['setupTeam', 'setupRole', 'setupPhone', 'setupEmail', 'setupNote'].forEach(function (id) {
      $(id).addEventListener(id === 'setupTeam' ? 'change' : 'input', onFormChange);
    });
    $('openSetup').addEventListener('click', openSetup);
    $('applySetup').addEventListener('click', function () { $('setup').close(); });
    $('setup').addEventListener('close', function () {
      clearTimeout(linkTimer);
      if (pageCfg) { cfg = pageCfg; pageCfg = null; renderAll(); }
    });
    $('resetSetup').addEventListener('click', function () {
      try { localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
      fillForm({});
      cfg = C.mergeConfig(D, {});
      renderAll();
      updateLink(readForm());
      $('saveStatus').textContent = 'Cleared from this device.';
    });
    $('copyLink').addEventListener('click', function () {
      var inp = $('shareLink');
      var done = function () { $('copyStatus').textContent = 'Link copied. Send it to your agents.'; };
      var fallback = function () { inp.focus(); inp.select(); $('copyStatus').textContent = 'Press Ctrl+C (or ⌘C) to copy the selected link.'; };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(done, fallback);
        else fallback();
      } catch (e) { fallback(); }
    });
  }

  // ---------- click-to-play YouTube ----------
  function wireVideos() {
    document.querySelectorAll('.video').forEach(function (v) {
      var id = v.getAttribute('data-yt');
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
      v.querySelector('.video-play').addEventListener('click', function () {
        var f = document.createElement('iframe');
        f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0&playsinline=1';
        f.title = v.querySelector('.video-meta span').textContent;
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        f.allowFullscreen = true;
        v.querySelector('.video-play').replaceWith(f);
      });
    });
  }

  // ---------- home-screen app ----------
  function setupPwa() {
    // Part of the Hiring CRM here (its WPI Careers page, /careers/): the
    // CRM's own service worker serves this site, so it registers none of its
    // own, and inside the CRM's frame it offers no Home Screen install.
    if (window.top !== window) return;
    var ua = navigator.userAgent;
    var iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    var standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var dismissed = false;
    try { dismissed = localStorage.getItem('wp-install-dismissed') === '1'; } catch (e) { /* ignore */ }
    if (!iOS || !safari || standalone || dismissed) return;
    var hint = $('installHint');
    hint.hidden = false;
    $('installClose').addEventListener('click', function () {
      hint.hidden = true;
      try { localStorage.setItem('wp-install-dismissed', '1'); } catch (e) { /* ignore */ }
    });
  }

  // ---------- boot ----------
  // Team page: team and director render immediately; contact details carried
  // in the link are decoded right after.
  var slugHere = teamSlug();
  if (slugHere) cfg = C.mergeTeam(D, { team: teamBlock(slugHere) });

  loadInputs();
  wire();
  wireSetup();
  renderAll();
  wireTabs();
  wireVideos();
  setupPwa();

  if (slugHere) {
    readLinkPlan().then(function (o) {
      if (!o) return;
      cfg = C.mergeTeam(D, { team: teamBlock(slugHere, o) });
      renderAll();
    });
  }
})();
