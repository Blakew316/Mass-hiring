/**
 * Pure pay math and team-config helpers for the Agent Pay Estimator.
 *
 * No DOM access here, so every function can be unit-tested in Node
 * (see tests/calc.test.js). All money values are whole dollars.
 */
(function (root) {
  'use strict';

  var MAX_NUMBER = 10000000;

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function count(v) {
    return Math.max(0, Math.floor(num(v)));
  }

  /**
   * Best-paying tier reached plus the next tier that pays more.
   * Tiers are [threshold, amount] pairs sorted by threshold. Taking the best
   * amount (not the last threshold) means an extra deal can never lower pay,
   * even if a manager enters non-increasing amounts.
   */
  function tierFor(tiers, n) {
    var hit = null, next = null;
    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      if (n >= t[0]) { if (!hit || t[1] >= hit[1]) hit = t; }
      else if (!next && t[1] > (hit ? hit[1] : 0)) next = t;
    }
    return { hit: hit, next: next, amount: hit ? hit[1] : 0 };
  }

  /**
   * The bonus ladder that actually applies. Ramp-up pays whichever is larger of
   * the ramp tier and the standard tier at each deal count, so a ramp rep at
   * 20 deals still gets the standard 20-deal bonus. Steps that don't raise pay
   * are dropped.
   */
  function effectiveTiers(cfg, ramp) {
    var lists = ramp ? [cfg.rampTiers, cfg.monthlyTiers] : [cfg.monthlyTiers];
    var marks = [];
    lists.forEach(function (l) { l.forEach(function (t) { if (marks.indexOf(t[0]) < 0) marks.push(t[0]); }); });
    marks.sort(function (a, b) { return a - b; });
    var out = [], best = 0;
    marks.forEach(function (m) {
      var amt = 0;
      lists.forEach(function (l) { amt = Math.max(amt, tierFor(l, m).amount); });
      if (amt > best) { out.push([m, amt]); best = amt; }
    });
    return out;
  }

  /** Statement volume bonus for one deal with a statement of `volume` per month. */
  function statementBonus(s, volume) {
    var v = num(volume);
    if (v >= s.topMin) return s.topBase + Math.floor((v - s.topMin) / s.step) * s.stepBonus;
    if (v >= s.midMin) return s.mid;
    if (v >= s.lowMin) return s.low;
    return 0;
  }

  /**
   * One month of upfront pay.
   * inp: { deals, pricing: 'traditional'|'cash', stmtDeals, stmtVolume, equipProfit }
   * Sub-counts are capped at `deals` so the breakdown can never exceed the deal count.
   */
  function monthEstimate(cfg, inp, ramp) {
    var deals = count(inp.deals);
    var stmt = Math.min(count(inp.stmtDeals), deals);
    var key = inp.pricing === 'cash' ? 'cash' : 'traditional';

    var base = deals * cfg.upfront[key];
    var commission = ramp ? base * cfg.rampCommissionMultiplier : base;
    var tier = tierFor(effectiveTiers(cfg, ramp), deals);
    var statementEach = statementBonus(cfg.statement, inp.stmtVolume);
    var statement = stmt * statementEach;
    var equipment = Math.round(Math.max(0, num(inp.equipProfit)) * cfg.equipmentShare / 100);

    return {
      deals: deals,
      stmtDeals: stmt,
      base: base,
      commission: commission,
      commissionFirst: base,
      commissionSecond: commission - base,
      tier: tier,
      bonus: tier.amount,
      statementEach: statementEach,
      statement: statement,
      equipment: equipment,
      total: commission + tier.amount + statement + equipment
    };
  }

  /** Ramp-up signing bonuses: the 30-day Fast Start and the 25-deal bonus. They stack. */
  function ninetyDay(cfg, deals30, deals90) {
    var d30 = count(deals30), d90 = Math.max(count(deals90), d30);
    var fast30 = d30 >= cfg.fastStart30.deals ? cfg.fastStart30.bonus : 0;
    var signing = d90 >= cfg.signing.deals ? cfg.signing.bonus : 0;
    return { deals30: d30, deals90: d90, fast30: fast30, signing: signing, total: fast30 + signing };
  }

  /**
   * Fewest deals per month whose estimated pay reaches `goal`.
   * `inp` is the agent's deal mix (pricing, small/lead/statement deals); `other`
   * is income already counted toward the goal (e.g. current residuals).
   * Returns null when the goal needs more than `max` deals.
   */
  function dealsForGoal(cfg, inp, ramp, goal, other, max) {
    var need = num(goal) - num(other);
    var limit = max || 200;
    if (need <= 0) return { deals: 0, estimate: monthEstimate(cfg, Object.assign({}, inp, { deals: 0 }), ramp) };
    for (var d = 1; d <= limit; d++) {
      var r = monthEstimate(cfg, Object.assign({}, inp, { deals: d }), ramp);
      if (r.total >= need) return { deals: d, estimate: r };
    }
    return null;
  }

  /** Estimated monthly residual for one merchant. */
  function residualPerMerchant(cfg, volume, bps) {
    return num(volume) * num(bps) / 10000 * cfg.residual.share / 100;
  }

  /**
   * Month-by-month residual projection at a steady deal pace.
   * o: { dealsPerMonth, perMerchant, attrition (% per month), months, monthlyUpfront }
   * Residuals for a month's book are paid the following month, starting at
   * cfg.residual.firstPayMonth. Vesting = `vesting.months` consecutive
   * months with total comp >= vesting.comp and book >= vesting.accounts.
   */
  function projectResiduals(cfg, o) {
    var rows = [];
    var book = 0, cum = 0, streak = 0, vestedAt = 0;
    var pace = count(o.dealsPerMonth);
    var keep = 1 - Math.min(100, Math.max(0, num(o.attrition))) / 100;
    for (var m = 1; m <= o.months; m++) {
      var prevBook = book;
      book = book * keep + pace;
      var eligible = m >= cfg.residual.firstPayMonth;
      var paid = eligible ? prevBook * num(o.perMerchant) : 0;
      cum += paid;
      var comp = paid + num(o.monthlyUpfront);
      if (!vestedAt) {
        streak = comp >= cfg.vesting.comp && book >= cfg.vesting.accounts ? streak + 1 : 0;
        if (streak >= cfg.vesting.months) vestedAt = m;
      }
      rows.push({ m: m, book: book, paid: paid, cum: cum, comp: comp });
    }
    return { rows: rows, vestedAt: vestedAt };
  }

  // ---------- team config: merge, sanitize, diff ----------

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function cleanTiers(v, fallback) {
    if (!Array.isArray(v)) return clone(fallback);
    var out = [];
    for (var i = 0; i < v.length && out.length < 12; i++) {
      var p = v[i];
      if (!Array.isArray(p) || p.length !== 2) continue;
      var a = count(p[0]), b = count(p[1]);
      if (a > 0 && a <= 1000 && b <= MAX_NUMBER) out.push([a, b]);
    }
    out.sort(function (x, y) { return x[0] - y[0]; });
    // drop duplicate thresholds, keeping the last one entered
    var dedup = [];
    out.forEach(function (p) {
      if (dedup.length && dedup[dedup.length - 1][0] === p[0]) dedup[dedup.length - 1] = p;
      else dedup.push(p);
    });
    return dedup;
  }

  /**
   * Overlay untrusted `over` (from a share link or team file) onto `defaults`.
   * Only keys that exist in defaults survive, each coerced to the default's type,
   * so a crafted link can't inject markup or unexpected fields.
   */
  function mergeConfig(defaults, over) {
    var out = {};
    Object.keys(defaults).forEach(function (k) {
      var d = defaults[k], v = isObj(over) ? over[k] : undefined;
      if (Array.isArray(d)) out[k] = v === undefined ? clone(d) : cleanTiers(v, d);
      else if (isObj(d)) out[k] = mergeConfig(d, v);
      else if (typeof d === 'number') {
        var n = Number(v);
        out[k] = v === undefined || v === '' || !Number.isFinite(n) ? d : Math.min(MAX_NUMBER, Math.max(0, n));
      } else if (typeof d === 'boolean') out[k] = v === undefined ? d : v === true;
      else out[k] = typeof v === 'string' ? v.slice(0, k === 'note' ? 280 : 60) : d;
    });
    return out;
  }

  /**
   * Apply team overrides. Only the `team` block
   * (name, note, contact details) is honored; pay always comes from the
   * company defaults, so a hand-edited link can't change anyone's numbers.
   */
  function mergeTeam(defaults, over) {
    return mergeConfig(defaults, { team: isObj(over) ? over.team : undefined });
  }

  /**
   * Team block for a team listed in `teams` (js/teams.js). Team and director
   * names always come from the list. `o` (from a link or Team setup) may fill
   * in title, note, phone and email, but phone/email already in the list win,
   * so a link can't swap in someone else's number once it's official.
   */
  function teamBlock(teams, defaults, slug, o) {
    var t = teams[slug];
    o = isObj(o) ? o : {};
    var str = function (k) { return typeof o[k] === 'string' ? o[k].trim() : ''; };
    return {
      name: t.name,
      manager: t.director,
      title: '',
      note: str('note') || defaults.team.note,
      contactName: t.director,
      contactTitle: str('contactTitle') || defaults.team.contactTitle,
      contactPhone: t.phone || str('contactPhone'),
      contactEmail: t.email || str('contactEmail')
    };
  }

  var api = {
    tierFor: tierFor,
    effectiveTiers: effectiveTiers,
    dealsForGoal: dealsForGoal,
    statementBonus: statementBonus,
    monthEstimate: monthEstimate,
    ninetyDay: ninetyDay,
    residualPerMerchant: residualPerMerchant,
    projectResiduals: projectResiduals,
    mergeConfig: mergeConfig,
    mergeTeam: mergeTeam,
    teamBlock: teamBlock
  };
  root.PayCalc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
