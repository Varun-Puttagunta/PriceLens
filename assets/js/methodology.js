/** Methodology page — the live figures, so the prose can't drift from the code. */
(function () {
  'use strict';
  var PL = window.PriceLens;
  var engine = PL.engine, data = PL.data, fmt = PL.app.fmt;
  var $ = function (id) { return document.getElementById(id); };

  var fit = engine.fitMarketModel(data.sales, data.meta.generatedAt);
  var poolPsf = engine.util.median(data.sales.map(function (s) { return s.soldPrice / s.sqft; }));
  var poolPrice = engine.util.median(data.sales.map(function (s) { return s.soldPrice; }));
  var dollars = function (c) { return poolPrice * (Math.exp(c) - 1); };

  $('fit-meta').textContent = fit.fitted
    ? fmt.int(fit.n) + ' closed sales · R² ' + fit.r2.toFixed(3) + ' · as of ' + fmt.date(data.meta.generatedAt)
    : 'Market too thin to fit';

  var rows = [
    ['Market drift', fmt.signedPct(fit.annualRate, 1) + ' / yr', 1],
    ['Size elasticity', fit.rates.logSqft.toFixed(2) + ' (≈ $' + Math.round(fit.rates.logSqft * poolPsf) + '/sqft marginal)', 1],
    ['One bedroom', fmt.money(dollars(fit.rates.beds)), dollars(fit.rates.beds)],
    ['One full bathroom', fmt.money(dollars(fit.rates.baths)), dollars(fit.rates.baths)],
    ['One garage bay', fmt.money(dollars(fit.rates.garage)), dollars(fit.rates.garage)],
    ['1,000 sqft of lot', fmt.money(dollars(fit.rates.lotK)), dollars(fit.rates.lotK)],
    ['A decade newer', fmt.money(dollars(fit.rates.decade)), dollars(fit.rates.decade)],
    ['One condition grade', fmt.money(dollars(fit.rates.condition)), dollars(fit.rates.condition)],
    ['A pool', fmt.money(dollars(fit.rates.pool)), dollars(fit.rates.pool)],
    ['A greenbelt lot', fmt.money(dollars(fit.rates.greenbelt)), dollars(fit.rates.greenbelt)]
  ];
  $('fit-rates').innerHTML = rows
    .filter(function (r) { return Math.abs(r[2]) >= 1; })
    .map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; })
    .join('');

  var bt = engine.backtest(data.sales);
  $('m-median').textContent = fmt.pct(bt.medianAbsError, 1);
  $('m-coverage').textContent = Math.round(bt.rangeHitRate * 100) + '%';
})();
