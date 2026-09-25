/**
 * PriceLens AI — valuation & pricing engine.
 *
 * Plain ES5-compatible UMD so the same file runs in the browser off file://,
 * on a static host, and under `node --test`. No build step, no dependencies.
 *
 * The pipeline mirrors how a residential appraisal is actually built:
 *
 *   1. trend      — recover the market's monthly drift from the sales pool
 *   2. select     — score every candidate sale for comparability, keep the best
 *   3. adjust     — time-adjust, then run a line-item adjustment grid
 *   4. reconcile  — weight the adjusted comps, produce a range and a confidence grade
 *   5. strategy   — turn the value into a list price by maximising expected net proceeds
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.PriceLens = root.PriceLens || {}).engine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* =======================================================================
   * Tunables. Everything the model believes about this market lives here,
   * so it can be re-fit per market instead of hidden in the code.
   * ===================================================================== */
  var DEFAULTS = {
    maxComps: 6,
    minComps: 3,
    // Search tiers: the grid widens only when the tighter tier starves.
    tiers: [
      { radiusMiles: 1.5, maxAgeDays: 180, sizeTolerance: 0.20 },
      { radiusMiles: 3.0, maxAgeDays: 270, sizeTolerance: 0.30 },
      { radiusMiles: 6.0, maxAgeDays: 365, sizeTolerance: 0.50 },
      { radiusMiles: 12.0, maxAgeDays: 540, sizeTolerance: 0.75 }
    ],
    // Contributory value of extra living area, as a share of the pool's $/sqft.
    // Appraisal practice: never the full rate — the lot and the structure are
    // already paid for once.
    glaContributionRate: 0.42,
    landRatePerSqft: 6.0,
    bedroomValue: 7200,
    bathroomValue: 9000,     // per full bath; halves fall out of the .5 steps
    garageValue: 8000,
    ageValuePerYear: 950,
    ageCapYears: 22,
    conditionPctPerPoint: 0.035,
    poolValue: 22000,
    greenbeltValue: 14000,
    storyValue: 0,
    // Fannie Mae-style adjustment ceilings; breaching them doesn't kill a comp,
    // it downweights it and shows up in the confidence grade.
    netAdjustmentCap: 0.15,
    grossAdjustmentCap: 0.25,
    defaultMonthlyTrend: 0.0031
  };

  var STRATEGY_DEFAULTS = {
    commissionRate: 0.05,
    monthlyCarryRate: 0.0055,   // taxes + insurance + debt service + utilities
    closingDays: 32,
    domElasticity: 6.0,         // how hard the market punishes an overpriced listing
    missedWindowDays: 2.6,      // extra days per 1% over value, independent of market speed
    maxOverbid: 0.035,          // most a fresh listing clears above its own ask
    searchBandSize: 25000,      // portal filter granularity buyers actually use
    ladderLow: -0.04,
    ladderHigh: 0.10,
    ladderStep: 0.01
  };

  /* ============================================================ helpers == */
  var MS_DAY = 86400000;

  function toDate(v) { return v instanceof Date ? v : new Date(v + 'T00:00:00Z'); }
  function daysBetween(a, b) { return Math.round((toDate(a) - toDate(b)) / MS_DAY); }
  function monthsBetween(a, b) { return daysBetween(a, b) / 30.44; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function quantile(values, q) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var pos = (s.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  function mean(values) {
    if (!values.length) return 0;
    var t = 0;
    for (var i = 0; i < values.length; i++) t += values[i];
    return t / values.length;
  }

  /** Great-circle distance in statute miles. */
  function haversineMiles(aLat, aLng, bLat, bLng) {
    var R = 3958.8, rad = Math.PI / 180;
    var dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* ================================================= 1. market model fit ==
   * A hedonic regression on log(price). It does two jobs at once:
   *
   *   - the coefficient on time is the market's drift, with composition held
   *     still (a quarter heavy on Prosper new-builds is appreciation in a raw
   *     $/sqft series, and isn't here);
   *   - every other coefficient is an adjustment rate. What a bedroom, a
   *     garage bay or a condition grade is worth is measured in this market,
   *     this quarter — not carried in as a constant from somewhere else.
   *
   * Fallback rates apply only when the market is too thin to fit.
   */
  var FEATURES = [
    {
      key: 'logSqft', label: 'Living area', fallback: 0.72, bounds: [0.30, 0.95],
      get: function (p) { return Math.log(Math.max(1, p.sqft)); },
      detail: function (s, c) { return fmtSigned(s.sqft - c.sqft) + ' sqft'; }
    },
    {
      key: 'beds', label: 'Bedrooms', fallback: 0.012, bounds: [0, 0.06],
      get: function (p) { return p.beds || 0; },
      detail: function (s, c) { return fmtSigned(s.beds - c.beds) + ' bed'; }
    },
    {
      key: 'baths', label: 'Bathrooms', fallback: 0.014, bounds: [0, 0.06],
      get: function (p) { return p.baths || 0; },
      detail: function (s, c) { return fmtSigned(s.baths - c.baths) + ' bath'; }
    },
    {
      key: 'garage', label: 'Garage', fallback: 0.014, bounds: [0, 0.06],
      get: function (p) { return p.garage || 0; },
      detail: function (s, c) { return fmtSigned(s.garage - c.garage) + ' space'; }
    },
    {
      key: 'lotK', label: 'Lot size', fallback: 0.009, bounds: [0, 0.05],
      get: function (p) { return (p.lotSqft || 0) / 1000; },
      detail: function (s, c) { return fmtSigned((s.lotSqft || 0) - (c.lotSqft || 0)) + ' sqft lot'; }
    },
    {
      key: 'decade', label: 'Age / vintage', fallback: 0.016, bounds: [0, 0.09],
      get: function (p) { return ((p.yearBuilt || 2006) - 2006) / 10; },
      detail: function (s, c) { return fmtSigned(s.yearBuilt - c.yearBuilt) + ' yr built'; }
    },
    {
      key: 'condition', label: 'Condition', fallback: 0.035, bounds: [0.005, 0.08],
      get: function (p) { return (p.condition || 3) - 3; },
      detail: function (s, c) { return fmtSigned(s.condition - c.condition) + ' grade'; }
    },
    {
      key: 'pool', label: 'Pool', fallback: 0.036, bounds: [0, 0.10],
      get: function (p) { return p.pool ? 1 : 0; },
      detail: function (s, c) {
        return (s.pool ? 'subject has' : 'subject none') + ' / ' + (c.pool ? 'comp has' : 'comp none');
      }
    },
    {
      key: 'greenbelt', label: 'Greenbelt / view', fallback: 0.023, bounds: [0, 0.08],
      get: function (p) { return p.greenbelt ? 1 : 0; },
      detail: function (s, c) {
        return (s.greenbelt ? 'subject has' : 'subject none') + ' / ' + (c.greenbelt ? 'comp has' : 'comp none');
      }
    }
  ];

  /** Ridge-regularised OLS via normal equations + Gaussian elimination. */
  function ols(X, y, lambda) {
    var n = X.length, p = X[0].length, i, j, k;
    var A = [], b = [];
    for (i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
    for (k = 0; k < n; k++) {
      var row = X[k];
      for (i = 0; i < p; i++) {
        b[i] += row[i] * y[k];
        for (j = 0; j < p; j++) A[i][j] += row[i] * row[j];
      }
    }
    for (i = 1; i < p; i++) A[i][i] += (lambda || 1e-6) * n;   // never shrink the intercept

    var M = A.map(function (r, idx) { return r.concat([b[idx]]); });
    for (i = 0; i < p; i++) {
      var piv = i;
      for (k = i + 1; k < p; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;
      for (k = i + 1; k < p; k++) {
        var f = M[k][i] / M[i][i];
        for (j = i; j <= p; j++) M[k][j] -= f * M[i][j];
      }
    }
    var beta = new Array(p).fill(0);
    for (i = p - 1; i >= 0; i--) {
      var sum = M[i][p];
      for (j = i + 1; j < p; j++) sum -= M[i][j] * beta[j];
      beta[i] = sum / M[i][i];
    }
    return beta;
  }

  function fallbackModel(n) {
    var rates = {};
    FEATURES.forEach(function (f) { rates[f.key] = f.fallback; });
    return {
      monthlyRate: DEFAULTS.defaultMonthlyTrend,
      annualRate: Math.pow(1 + DEFAULTS.defaultMonthlyTrend, 12) - 1,
      r2: 0, n: n || 0, fitted: false, method: 'prior', rates: rates
    };
  }

  function fitMarketModel(sales, asOf) {
    var usable = [];
    for (var i = 0; i < sales.length; i++) {
      var s = sales[i];
      if (!s.sqft || !s.soldPrice) continue;
      if (asOf && daysBetween(asOf, s.saleDate) < 0) continue;   // never look at the future
      usable.push(s);
    }
    if (usable.length < 60) return fallbackModel(usable.length);

    var cities = [], types = [];
    usable.forEach(function (s) {
      if (cities.indexOf(s.city) === -1) cities.push(s.city);
      if (types.indexOf(s.type) === -1) types.push(s.type);
    });
    cities.sort(); types.sort();

    var t0 = monthsBetween(usable[0].saleDate, '2000-01-01');
    var X = [], y = [];
    usable.forEach(function (s) {
      var row = [1, monthsBetween(s.saleDate, '2000-01-01') - t0];
      FEATURES.forEach(function (f) { row.push(f.get(s)); });
      for (var c = 1; c < cities.length; c++) row.push(s.city === cities[c] ? 1 : 0);
      for (var t = 1; t < types.length; t++) row.push(s.type === types[t] ? 1 : 0);
      X.push(row);
      y.push(Math.log(s.soldPrice));
    });

    var beta = ols(X, y, 1e-5);
    if (!beta || !isFinite(beta[1])) return fallbackModel(usable.length);

    var yBar = mean(y), ssTot = 0, ssRes = 0, residuals = [];
    for (var r = 0; r < X.length; r++) {
      var pred = 0;
      for (var c2 = 0; c2 < beta.length; c2++) pred += beta[c2] * X[r][c2];
      residuals.push(y[r] - pred);
      ssTot += Math.pow(y[r] - yBar, 2);
      ssRes += Math.pow(y[r] - pred, 2);
    }

    // Clamp each rate into a range a human appraiser would sign off on, so one
    // odd quarter of data can never produce an absurd adjustment.
    var rates = {};
    FEATURES.forEach(function (f, idx) {
      var raw = beta[2 + idx];
      rates[f.key] = isFinite(raw) ? clamp(raw, f.bounds[0], f.bounds[1]) : f.fallback;
    });

    var monthly = clamp(Math.exp(beta[1]) - 1, -0.02, 0.02);
    return {
      monthlyRate: monthly,
      annualRate: Math.pow(1 + monthly, 12) - 1,
      r2: ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1),
      residualSd: Math.sqrt(ssRes / Math.max(1, X.length - beta.length)),
      n: usable.length,
      fitted: true,
      method: 'hedonic',
      cities: cities,
      types: types,
      rates: rates
    };
  }

  // Kept for callers that only want the drift.
  var estimateMarketTrend = fitMarketModel;

  /* ==================================================== 2. comp selection ==
   * Every candidate gets a 0–1 comparability score. The weights say what an
   * appraiser actually cares about, in order: where it is, how big it is,
   * how recently it closed.
   */
  var TYPE_FAMILY = { 'Single Family': 'detached', 'Townhome': 'attached', 'Condo': 'attached' };

  function typeAffinity(a, b) {
    if (a === b) return 1;
    if (TYPE_FAMILY[a] && TYPE_FAMILY[a] === TYPE_FAMILY[b]) return 0.72;
    return 0.34;
  }

  function scoreComp(subject, comp, asOf, tier) {
    var miles = haversineMiles(subject.lat, subject.lng, comp.lat, comp.lng);
    var age = Math.max(0, daysBetween(asOf, comp.saleDate));
    var sizeDelta = Math.abs(comp.sqft - subject.sqft) / subject.sqft;

    var parts = {
      location: Math.exp(-Math.pow(miles / (tier.radiusMiles * 0.55), 2)),
      size: Math.exp(-Math.pow(sizeDelta / 0.18, 2)),
      recency: Math.exp(-age / 165),
      rooms: Math.exp(-Math.pow(Math.abs(comp.beds - subject.beds) / 1.6, 2)) * 0.5 +
             Math.exp(-Math.pow(Math.abs(comp.baths - subject.baths) / 1.5, 2)) * 0.5,
      vintage: Math.exp(-Math.pow(Math.abs(comp.yearBuilt - subject.yearBuilt) / 18, 2)),
      type: typeAffinity(subject.type, comp.type),
      submarket: comp.city === subject.city ? 1 : 0.78
    };

    var score =
      parts.location * 0.25 +
      parts.size * 0.22 +
      parts.recency * 0.17 +
      parts.rooms * 0.11 +
      parts.vintage * 0.08 +
      parts.type * 0.10 +
      parts.submarket * 0.07;

    return { miles: miles, ageDays: age, sizeDelta: sizeDelta, parts: parts, score: score };
  }

  function selectComps(subject, sales, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    var asOf = opt.asOf || new Date().toISOString().slice(0, 10);
    var pool = [];

    for (var i = 0; i < sales.length; i++) {
      var s = sales[i];
      if (s.id === subject.id) continue;
      if (opt.excludeIds && opt.excludeIds.indexOf(s.id) !== -1) continue;
      if (daysBetween(asOf, s.saleDate) < 0) continue;   // never look at the future
      pool.push(s);
    }

    for (var t = 0; t < opt.tiers.length; t++) {
      var tier = opt.tiers[t];
      var kept = [];
      for (var j = 0; j < pool.length; j++) {
        var comp = pool[j];
        var sc = scoreComp(subject, comp, asOf, tier);
        if (sc.miles > tier.radiusMiles) continue;
        if (sc.ageDays > tier.maxAgeDays) continue;
        if (sc.sizeDelta > tier.sizeTolerance) continue;
        if (t < 2 && typeAffinity(subject.type, comp.type) < 0.7) continue;
        kept.push({ sale: comp, metrics: sc, similarity: sc.score });
      }
      if (kept.length >= opt.minComps || t === opt.tiers.length - 1) {
        kept.sort(function (a, b) { return b.similarity - a.similarity; });
        return { comps: kept.slice(0, opt.maxComps), tier: t, tierSpec: tier, poolSize: kept.length, asOf: asOf };
      }
    }
    return { comps: [], tier: -1, tierSpec: null, poolSize: 0, asOf: asOf };
  }

  /* ================================================== 3. adjustment grid ==
   * Each line adjusts the COMP toward the SUBJECT: if the subject has more of
   * something, the comp is adjusted up to answer "what would this comp have
   * sold for if it were the subject?".
   */
  function buildAdjustmentGrid(subject, comp, ctx, opt) {
    opt = opt || DEFAULTS;
    ctx = ctx || {};
    var rates = ctx.rates || fallbackModel(0).rates;
    var monthlyRate = ctx.trend ? ctx.trend.monthlyRate : DEFAULTS.defaultMonthlyTrend;

    var months = monthsBetween(ctx.asOf, comp.saleDate);
    var timeFactor = Math.pow(1 + monthlyRate, months);
    var timeAdjusted = comp.soldPrice * timeFactor;

    // Each line is a log-space rate turned into dollars against this comp's
    // own time-adjusted price. Working in log space is what keeps a 30% size
    // gap honest — a flat $/sqft rate over that distance carries real
    // curvature error, because $/sqft itself falls as homes get bigger.
    var lines = [];
    FEATURES.forEach(function (f) {
      if (f.key === 'lotK' && subject.type === 'Condo' && comp.type === 'Condo') return;
      var delta = f.get(subject) - f.get(comp);
      if (!delta) return;
      var amount = timeAdjusted * (Math.exp(rates[f.key] * delta) - 1);
      if (Math.abs(amount) < 1) return;
      lines.push({
        key: f.key,
        label: f.label,
        detail: f.detail(subject, comp),
        rate: rates[f.key],
        amount: Math.round(amount)
      });
    });

    var net = 0, gross = 0;
    for (var i = 0; i < lines.length; i++) { net += lines[i].amount; gross += Math.abs(lines[i].amount); }

    var adjustedPrice = timeAdjusted + net;
    return {
      months: months,
      timeFactor: timeFactor,
      timeAdjustment: Math.round(timeAdjusted - comp.soldPrice),
      timeAdjusted: Math.round(timeAdjusted),
      lines: lines,
      netAdjustment: Math.round(net),
      grossAdjustment: Math.round(gross),
      netPct: net / timeAdjusted,
      grossPct: gross / timeAdjusted,
      adjustedPrice: Math.round(adjustedPrice),
      adjustedPsf: adjustedPrice / subject.sqft,
      overNetCap: Math.abs(net / timeAdjusted) > opt.netAdjustmentCap,
      overGrossCap: gross / timeAdjusted > opt.grossAdjustmentCap
    };
  }

  function fmtSigned(n) {
    var r = Math.round(n * 10) / 10;
    return (r > 0 ? '+' : '') + r;
  }

  /* ===================================================== 4. reconciliation */
  function gradeConfidence(input) {
    // Five signals, each scored 0–100, then weighted. Reported as a letter so a
    // seller can read it without a statistics background.
    var sCount = clamp((input.compCount / 6) * 100, 0, 100);
    var sSimilarity = clamp((input.medianSimilarity - 0.35) / 0.45 * 100, 0, 100);
    var sSpread = clamp((1 - (input.cv - 0.02) / 0.12) * 100, 0, 100);
    var sAdjust = clamp((1 - (input.medianGross - 0.06) / 0.22) * 100, 0, 100);
    var sRecency = clamp((1 - (input.medianAgeDays - 45) / 260) * 100, 0, 100);

    var score = Math.round(
      sCount * 0.18 + sSimilarity * 0.24 + sSpread * 0.26 + sAdjust * 0.18 + sRecency * 0.14
    );
    var grade = score >= 82 ? 'A' : score >= 68 ? 'B' : score >= 52 ? 'C' : 'D';
    var blurb = {
      A: 'Tight, recent, closely matched comps. Price with conviction.',
      B: 'Solid support. Expect the market to land inside the range.',
      C: 'Comps disagree or needed heavy adjustment. Widen the range and watch first-week traffic.',
      D: 'Thin or mismatched comp set. Treat this as a starting point, not a list price.'
    }[grade];
    return {
      score: score, grade: grade, blurb: blurb,
      signals: [
        { label: 'Comp count', value: sCount, detail: input.compCount + ' closed sales' },
        { label: 'Comparability', value: sSimilarity, detail: Math.round(input.medianSimilarity * 100) + '% median match' },
        { label: 'Agreement', value: sSpread, detail: '±' + (input.cv * 100).toFixed(1) + '% dispersion' },
        { label: 'Adjustment load', value: sAdjust, detail: (input.medianGross * 100).toFixed(1) + '% median gross' },
        { label: 'Recency', value: sRecency, detail: Math.round(input.medianAgeDays) + ' days median age' }
      ]
    };
  }

  function valuate(subject, sales, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    var asOf = opt.asOf || new Date().toISOString().slice(0, 10);
    var trend = opt.trend || estimateMarketTrend(sales, asOf);

    var selection = selectComps(subject, sales, Object.assign({}, opt, { asOf: asOf }));
    if (!selection.comps.length) {
      return { ok: false, reason: 'No comparable sales found for this subject.', asOf: asOf, trend: trend, comps: [] };
    }

    // The pool's own $/sqft sets the adjustment rates, so the grid re-fits per
    // market instead of carrying one hardcoded number everywhere.
    var poolPsf = median(selection.comps.map(function (c) { return c.sale.soldPrice / c.sale.sqft; }));
    var poolPrice = median(selection.comps.map(function (c) { return c.sale.soldPrice; }));
    var rates = trend.rates || fallbackModel(0).rates;
    var ctx = { asOf: asOf, trend: trend, rates: rates, poolPsf: poolPsf, poolPrice: poolPrice };

    var comps = selection.comps.map(function (c) {
      var grid = buildAdjustmentGrid(subject, c.sale, ctx, opt);
      return { sale: c.sale, metrics: c.metrics, similarity: c.similarity, grid: grid };
    });

    // Weight by comparability, penalising comps that only got there through
    // heavy adjustment.
    var totalWeight = 0;
    comps.forEach(function (c) {
      var penalty = Math.exp(-c.grid.grossPct / 0.15);
      c.weight = Math.pow(c.similarity, 2.2) * penalty;
      totalWeight += c.weight;
    });
    comps.forEach(function (c) { c.weightShare = totalWeight ? c.weight / totalWeight : 0; });

    var estimate = 0;
    comps.forEach(function (c) { estimate += c.grid.adjustedPrice * c.weightShare; });

    var variance = 0;
    comps.forEach(function (c) { variance += c.weightShare * Math.pow(c.grid.adjustedPrice - estimate, 2); });
    var sd = Math.sqrt(variance);
    var cv = estimate ? sd / estimate : 0;

    var confidence = gradeConfidence({
      compCount: comps.length,
      medianSimilarity: median(comps.map(function (c) { return c.similarity; })),
      cv: cv,
      medianGross: median(comps.map(function (c) { return c.grid.grossPct; })),
      medianAgeDays: median(comps.map(function (c) { return c.metrics.ageDays; }))
    });

    // Range widens with comp disagreement and with low confidence. The floor
    // and the coefficients are set from the backtest, not by feel: they are
    // what makes roughly four sales in five land inside the stated band. A
    // tighter range would read better and be a lie.
    var halfWidth = clamp(cv * 0.95 + 0.032 + (100 - confidence.score) / 100 * 0.042, 0.028, 0.11);

    var psfValues = comps.map(function (c) { return c.grid.adjustedPsf; });
    var round500 = function (v) { return Math.round(v / 500) * 500; };

    return {
      ok: true,
      asOf: asOf,
      subject: subject,
      estimate: round500(estimate),
      low: round500(estimate * (1 - halfWidth)),
      high: round500(estimate * (1 + halfWidth)),
      rangePct: halfWidth,
      psf: estimate / subject.sqft,
      psfRange: [quantile(psfValues, 0.1), quantile(psfValues, 0.9)],
      poolPsf: poolPsf,
      // Marginal $/sqft implied by the fitted elasticity at this price point.
      glaRate: rates.logSqft * poolPsf,
      calibration: {
        source: trend.fitted ? 'fitted' : 'default',
        r2: trend.r2,
        n: trend.n,
        rates: rates,
        glaRate: rates.logSqft * poolPsf
      },
      dispersion: cv,
      sd: Math.round(sd),
      confidence: confidence,
      trend: trend,
      tier: selection.tier,
      tierSpec: selection.tierSpec,
      candidatePool: selection.poolSize,
      comps: comps
    };
  }

  /* ======================================================= 5. list price ==
   * Value is not a list price. This turns the estimate into a number by asking
   * one question at every candidate price: what does the seller actually net?
   */
  function expectedDaysOnMarket(overPct, baseDom, elasticity, absPenaltyDays) {
    // Two costs, because a purely multiplicative model lets a fast market
    // shrug off overpricing — in a 12-day market, +5% would read as +4 days.
    // It doesn't work like that: an overpriced listing misses the new-listing
    // surge and then waits for the market to appreciate into its number, and
    // that wait is measured in absolute days, not as a multiple of a fast market.
    var effective = Math.max(overPct, -0.05);
    var multiplicative = baseDom * Math.exp(elasticity * effective);
    var missedWindow = Math.max(0, overPct) * 100 * (absPenaltyDays || 0);
    return Math.max(4, multiplicative + missedWindow);
  }

  /**
   * What a listing actually fetches, as a share of true value, given how long
   * it sat. Week-one listings carry a small competition premium; by month three
   * the leverage has crossed the table and sits with the buyer.
   */
  function timeOnMarketPremium(dom) {
    return 1.025 - 0.075 * (1 - Math.exp(-dom / 45));
  }

  function expectedPriceCuts(dom) {
    if (dom <= 30) return 0;
    return clamp(Math.floor((dom - 30) / 28) + 1, 0, 3);
  }

  /**
   * Buyers filter portals in round bands ($25k here). A list price one dollar
   * over a band edge is invisible to every buyer whose ceiling is that edge.
   */
  function snapToSearchBand(price, bandSize) {
    var band = bandSize || STRATEGY_DEFAULTS.searchBandSize;
    var edge = Math.round(price / band) * band;
    var distanceAbove = price - edge;
    if (distanceAbove > 0 && distanceAbove <= band * 0.22) {
      return { price: edge - 100, moved: -(distanceAbove + 100), edge: edge, captured: true };
    }
    return { price: price, moved: 0, edge: edge, captured: false };
  }

  function strategy(valuation, options) {
    var opt = Object.assign({}, STRATEGY_DEFAULTS, options || {});
    var value = valuation.estimate;
    var baseDom = opt.baseDom || 24;
    var carryPerDay = value * opt.monthlyCarryRate / 30.44;

    var ladder = [];
    for (var over = opt.ladderLow; over <= opt.ladderHigh + 1e-9; over += opt.ladderStep) {
      var listPrice = Math.round(value * (1 + over) / 500) * 500;
      var dom = expectedDaysOnMarket(over, baseDom, opt.domElasticity, opt.missedWindowDays);
      var cuts = expectedPriceCuts(dom);

      // Each public price cut costs more than the cut itself — it tells every
      // watching buyer the seller is negotiable.
      var cutDrag = 1 - cuts * 0.0130;
      var intrinsic = value * timeOnMarketPremium(dom) * cutDrag;

      // And you cannot sell above your own asking price by much, which is what
      // makes underpricing expensive: the ceiling comes down with the list.
      var overbidCap = listPrice * (1 + opt.maxOverbid * Math.exp(-dom / 25));
      var expectedSale = Math.min(intrinsic, overbidCap);

      var daysToCash = dom + opt.closingDays;
      var carry = carryPerDay * daysToCash;
      var commission = expectedSale * opt.commissionRate;
      var net = expectedSale - commission - carry;

      ladder.push({
        over: over,
        listPrice: listPrice,
        dom: Math.round(dom),
        daysToCash: Math.round(daysToCash),
        priceCuts: cuts,
        expectedSale: Math.round(expectedSale),
        saleToList: expectedSale / listPrice,
        carry: Math.round(carry),
        commission: Math.round(commission),
        net: Math.round(net),
        prob30: 1 - Math.exp(-30 / dom),
        prob60: 1 - Math.exp(-60 / dom),
        prob90: 1 - Math.exp(-90 / dom)
      });
    }

    var best = ladder.reduce(function (a, b) { return b.net > a.net ? b : a; }, ladder[0]);
    var band = snapToSearchBand(best.listPrice, opt.searchBandSize);
    var naive = ladder.reduce(function (a, b) {
      return Math.abs(b.over - 0.05) < Math.abs(a.over - 0.05) ? b : a;
    }, ladder[0]);

    return {
      ladder: ladder,
      recommended: {
        listPrice: band.price,
        rawListPrice: best.listPrice,
        bandAdjustment: band.moved,
        capturedBand: band.captured,
        searchBandEdge: band.edge,
        over: best.over,
        dom: best.dom,
        daysToCash: best.daysToCash,
        expectedSale: best.expectedSale,
        net: best.net,
        prob30: best.prob30,
        prob60: best.prob60,
        prob90: best.prob90,
        priceCuts: best.priceCuts
      },
      anchorComparison: {
        label: 'Listing 5% above estimate',
        listPrice: naive.listPrice,
        dom: naive.dom,
        net: naive.net,
        netDelta: best.net - naive.net,
        domDelta: best.dom - naive.dom
      },
      assumptions: {
        commissionRate: opt.commissionRate,
        monthlyCarryRate: opt.monthlyCarryRate,
        carryPerDay: Math.round(carryPerDay),
        closingDays: opt.closingDays,
        baseDom: baseDom,
        domElasticity: opt.domElasticity,
        searchBandSize: opt.searchBandSize
      }
    };
  }

  /** Median days-on-market of the comp set — the market's current speed. */
  function baseDomFromComps(valuation, fallback) {
    if (!valuation || !valuation.comps || !valuation.comps.length) return fallback || 24;
    var doms = valuation.comps
      .map(function (c) { return c.sale.dom; })
      .filter(function (d) { return typeof d === 'number' && d > 0; });
    return doms.length ? clamp(median(doms), 6, 90) : (fallback || 24);
  }

  /* ========================================================== 6. backtest ==
   * Re-price every closed listing using only sales that had already recorded
   * by the day it went on the market. Out-of-sample by construction.
   */
  function backtest(sales, options) {
    var opt = options || {};
    var subjects = sales.filter(function (s) { return opt.filter ? opt.filter(s) : s.portfolio; });
    var results = [];

    subjects.forEach(function (s) {
      var asOf = s.listDate;
      var v = valuate(s, sales, Object.assign({}, opt.engine, { asOf: asOf, excludeIds: [s.id] }));
      if (!v.ok) return;
      var error = (v.estimate - s.soldPrice) / s.soldPrice;
      results.push({
        sale: s,
        valuation: v,
        estimate: v.estimate,
        actual: s.soldPrice,
        error: error,
        absError: Math.abs(error),
        insideRange: s.soldPrice >= v.low && s.soldPrice <= v.high
      });
    });

    var abs = results.map(function (r) { return r.absError; });
    var signed = results.map(function (r) { return r.error; });
    return {
      results: results,
      count: results.length,
      medianAbsError: median(abs),
      meanAbsError: mean(abs),
      medianSignedError: median(signed),
      within3: results.filter(function (r) { return r.absError <= 0.03; }).length / (results.length || 1),
      within5: results.filter(function (r) { return r.absError <= 0.05; }).length / (results.length || 1),
      within10: results.filter(function (r) { return r.absError <= 0.10; }).length / (results.length || 1),
      rangeHitRate: results.filter(function (r) { return r.insideRange; }).length / (results.length || 1)
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    STRATEGY_DEFAULTS: STRATEGY_DEFAULTS,
    estimateMarketTrend: estimateMarketTrend,
    fitMarketModel: fitMarketModel,
    FEATURES: FEATURES,
    selectComps: selectComps,
    buildAdjustmentGrid: buildAdjustmentGrid,
    valuate: valuate,
    strategy: strategy,
    baseDomFromComps: baseDomFromComps,
    snapToSearchBand: snapToSearchBand,
    expectedDaysOnMarket: expectedDaysOnMarket,
    timeOnMarketPremium: timeOnMarketPremium,
    ols: ols,
    backtest: backtest,
    util: {
      median: median, mean: mean, quantile: quantile, clamp: clamp,
      haversineMiles: haversineMiles, daysBetween: daysBetween, monthsBetween: monthsBetween
    }
  };
});
