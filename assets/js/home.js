/** PriceLens AI — homepage. Everything on this page is computed live, so the
 *  marketing claims and the engine can never drift apart. */
(function () {
  'use strict';
  var PL = window.PriceLens;
  var engine = PL.engine, data = PL.data, charts = PL.charts, fmt = PL.app.fmt;
  var AS_OF = data.meta.generatedAt;

  /* ------------------------------------------------- hero: a live valuation */
  var fit = engine.fitMarketModel(data.sales, AS_OF);

  // Show a real listing from the book that the comp set actually supports well.
  // The confidence grade is on the card either way, but leading with a property
  // the market can speak to is the honest version of a good first impression.
  var candidates = data.sales.filter(function (s) {
    return s.portfolio && s.type === 'Single Family' && s.sqft > 2200 && s.sqft < 3600;
  });
  var valuation = null, subject = candidates[0] || data.sales[0];
  candidates.forEach(function (s) {
    var v = engine.valuate(s, data.sales, { asOf: AS_OF, trend: fit, excludeIds: [s.id] });
    if (v.ok && (!valuation || v.confidence.score > valuation.confidence.score)) {
      valuation = v; subject = s;
    }
  });
  if (!valuation) valuation = engine.valuate(subject, data.sales, { asOf: AS_OF, trend: fit, excludeIds: [subject.id] });

  function text(id, v) { var n = document.getElementById(id); if (n) n.textContent = v; }

  if (valuation.ok) {
    var strat = engine.strategy(valuation, { baseDom: engine.baseDomFromComps(valuation) });

    text('hero-address', subject.address);
    text('hero-specs', subject.city + ' · ' + fmt.beds(subject) + ' · built ' + subject.yearBuilt);
    text('hero-estimate', fmt.money(valuation.estimate));
    text('hero-low', fmt.money(valuation.low));
    text('hero-high', fmt.money(valuation.high));
    text('hero-list', fmt.money(strat.recommended.listPrice));
    text('hero-dom', strat.recommended.dom + ' days');
    text('hero-comps', valuation.comps.length + ' of ' + valuation.candidatePool + ' nearby');
    text('hero-poolsize', fmt.int(fit.n));
    text('hero-grade-text', 'Confidence ' + valuation.confidence.grade);

    var pill = document.getElementById('hero-grade-pill');
    if (pill) {
      pill.className = 'pill ' + (valuation.confidence.grade === 'A' || valuation.confidence.grade === 'B'
        ? 'pill--good' : valuation.confidence.grade === 'C' ? 'pill--warn' : 'pill--crit');
    }
    // Place the estimate pin at its true position inside the range, not at the
    // midpoint — rounding makes those differ.
    var span = valuation.high - valuation.low;
    var pinPct = span ? ((valuation.estimate - valuation.low) / span) * 100 : 50;
    var pin = document.getElementById('hero-pin');
    if (pin) pin.style.left = Math.max(2, Math.min(98, pinPct)) + '%';
    var band = document.getElementById('hero-band');
    if (band) { band.style.left = '0%'; band.style.right = '0%'; }
  }

  /* --------------------------------------------- proof band: the backtest */
  var bt = engine.backtest(data.sales, { engine: { trend: null } });
  text('proof-error', fmt.pct(bt.medianAbsError, 1));
  text('proof-coverage', Math.round(bt.rangeHitRate * 100) + '%');

  /* ------------------------------------------- net proceeds by list price */
  if (valuation.ok) {
    var ladder = engine.strategy(valuation, { baseDom: engine.baseDomFromComps(valuation) });
    var rows = ladder.ladder;
    var best = rows.reduce(function (a, b) { return b.net > a.net ? b : a; }, rows[0]);

    charts.renderLegend(document.getElementById('ladder-legend'),
      [{ name: 'Seller net proceeds', color: 'var(--series-1)' }], 'line');

    charts.line(document.getElementById('ladder-chart'), {
      height: 250,
      label: 'Projected seller net proceeds across candidate asking prices',
      yFormat: function (v) { return charts.fmt.moneyCompact(v); },
      tipFormat: function (v) { return fmt.money(v); },
      directLabels: false,
      rightPad: 16,
      series: [{
        name: 'Net proceeds',
        color: 'var(--series-1)',
        area: true,
        points: rows.map(function (r) {
          return {
            y: r.net,
            label: 'Ask ' + fmt.money(r.listPrice) + ' (' + fmt.signedPct(r.over, 0) + ')',
            short: fmt.signedPct(r.over, 0)
          };
        })
      }]
    });

    var sub = document.getElementById('ladder-sub');
    if (sub) sub.textContent = subject.city + ' · ' + fmt.int(subject.sqft) + ' sqft · valued at ' + fmt.money(valuation.estimate);

    var high = rows[rows.length - 1];
    var cap = document.getElementById('ladder-caption');
    if (cap) {
      cap.innerHTML = 'Asking ' + fmt.signedPct(best.over, 0) + ' against value nets <b>' +
        fmt.money(best.net) + '</b> in about ' + best.dom + ' days. Asking ' +
        fmt.signedPct(high.over, 0) + ' nets <b>' + fmt.money(high.net) + '</b> and takes ' +
        high.dom + ' — giving up ' + fmt.money(best.net - high.net) + ' to chase a bigger number.';
    }

    charts.renderTable(document.getElementById('ladder-table'),
      ['Asking price', 'vs value', 'Days on market', 'Expected sale', 'Net proceeds'],
      rows.map(function (r) {
        return [fmt.money(r.listPrice), fmt.signedPct(r.over, 0), String(r.dom),
          fmt.money(r.expectedSale), fmt.money(r.net)];
      }),
      'Projected days on market and seller net proceeds at each candidate asking price');
  }

  /* ---------------------------------------------- fitted adjustment rates */
  var poolPsf = engine.util.median(data.sales.map(function (s) { return s.soldPrice / s.sqft; }));
  var poolPrice = engine.util.median(data.sales.map(function (s) { return s.soldPrice; }));
  var ratesHost = document.getElementById('rates-kv');
  if (ratesHost && fit.rates) {
    var dollars = function (coef) { return poolPrice * (Math.exp(coef) - 1); };
    var shown = [
      ['Marginal living area', fit.rates.logSqft * poolPsf, '$' + Math.round(fit.rates.logSqft * poolPsf) + '/sqft'],
      ['A full bathroom', dollars(fit.rates.baths), fmt.money(dollars(fit.rates.baths))],
      ['A garage bay', dollars(fit.rates.garage), fmt.money(dollars(fit.rates.garage))],
      ['One condition grade', dollars(fit.rates.condition), fmt.money(dollars(fit.rates.condition))],
      ['Market drift', 1, fmt.signedPct(fit.annualRate, 1) + '/yr']
    ];
    ratesHost.innerHTML = shown
      // A rate the regression couldn't separate from the others reads as a
      // broken number, not an insight. Leave it out.
      .filter(function (r) { return Math.abs(r[1]) >= 1; })
      .map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[2] + '</dd>'; })
      .join('');
  }

  /* ------------------------------------------------ before / after tiles */
  var portfolio = data.sales.filter(function (s) { return s.portfolio; });
  var manual = portfolio.filter(function (s) { return s.pricedWith === 'manual'; });
  var tool = portfolio.filter(function (s) { return s.pricedWith === 'pricelens'; });
  var avg = function (a, f) { return a.reduce(function (s, x) { return s + f(x); }, 0) / a.length; };

  var tiles = [
    {
      label: 'Median days on market',
      before: engine.util.median(manual.map(function (s) { return s.dom; })),
      after: engine.util.median(tool.map(function (s) { return s.dom; })),
      format: function (v) { return Math.round(v) + ' days'; },
      betterLower: true
    },
    {
      label: 'Sale price vs original ask',
      before: avg(manual, function (s) { return s.soldPrice / s.originalListPrice; }),
      after: avg(tool, function (s) { return s.soldPrice / s.originalListPrice; }),
      format: function (v) { return fmt.pct(v, 1); },
      betterLower: false
    },
    {
      label: 'Listings needing a price cut',
      before: manual.filter(function (s) { return s.priceCuts > 0; }).length / manual.length,
      after: tool.filter(function (s) { return s.priceCuts > 0; }).length / tool.length,
      format: function (v) { return Math.round(v * 100) + '%'; },
      betterLower: true
    },
    {
      label: 'Properties in each group',
      before: manual.length,
      after: tool.length,
      format: function (v) { return Math.round(v) + ' homes'; },
      plain: true
    }
  ];

  var host = document.getElementById('adoption-tiles');
  if (host) {
    host.innerHTML = tiles.map(function (t) {
      var delta = '';
      if (!t.plain) {
        var improved = t.betterLower ? t.after < t.before : t.after > t.before;
        var diff = t.betterLower
          ? t.format(t.before - t.after).replace(/^-/, '')
          : t.format(t.after - t.before).replace(/^-/, '');
        delta = '<span class="stat__delta ' + (improved ? 'stat__delta--good' : 'stat__delta--bad') + '">' +
          (improved ? '▼ ' : '▲ ') + diff + (t.betterLower ? ' lower' : ' higher') + '</span>';
      }
      return '<div class="stat">' +
        '<p class="stat__label">' + t.label + '</p>' +
        '<p class="stat__value">' + t.format(t.after) + '</p>' +
        '<p class="stat__note">' + (t.plain ? 'before the tool: ' + t.format(t.before) : 'was ' + t.format(t.before) + ' &nbsp;' + delta) + '</p>' +
        '</div>';
    }).join('');
  }
})();
