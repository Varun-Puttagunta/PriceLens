/** PriceLens AI — engagement results. Every figure here is computed from the
 *  published dataset by the same engine the pricing tool runs, so the page
 *  cannot drift away from the code. */
(function () {
  'use strict';
  var PL = window.PriceLens;
  var engine = PL.engine, data = PL.data, charts = PL.charts, fmt = PL.app.fmt;
  var util = engine.util;
  var $ = function (id) { return document.getElementById(id); };
  var text = function (id, v) { var n = $(id); if (n) n.textContent = v; };

  var book = data.sales.filter(function (s) { return s.portfolio; })
    .sort(function (a, b) { return a.saleDate.localeCompare(b.saleDate); });
  var manual = book.filter(function (s) { return s.pricedWith === 'manual'; });
  var tool = book.filter(function (s) { return s.pricedWith === 'pricelens'; });
  var avg = function (a, f) { return a.length ? a.reduce(function (s, x) { return s + f(x); }, 0) / a.length : 0; };

  var TOOL_COLOR = 'var(--series-1)';
  var MANUAL_COLOR = 'var(--series-2)';

  /* ------------------------------------------------------------ headline */
  var volume = book.reduce(function (s, x) { return s + x.soldPrice; }, 0);
  text('volume-note', book.length + ' closings between ' +
    fmt.date(book[0].saleDate) + ' and ' + fmt.date(book[book.length - 1].saleDate));
  text('k-avg', fmt.moneyCompact(volume / book.length));
  text('k-dom', Math.round(util.median(book.map(function (s) { return s.dom; }))) + ' days');
  text('k-stl', fmt.pct(avg(book, function (s) { return s.soldPrice / s.originalListPrice; }), 1));

  /* ------------------------------------------------------------ backtest */
  var bt = engine.backtest(data.sales);
  var byId = {};
  bt.results.forEach(function (r) { byId[r.sale.id] = r; });

  text('bt-median', fmt.pct(bt.medianAbsError, 1));
  text('bt-within5', Math.round(bt.within5 * 100) + '%');
  text('bt-within5-n', Math.round(bt.within5 * bt.count) + ' of ' + bt.count + ' listings');
  text('bt-within10', Math.round(bt.within10 * 100) + '%');
  text('bt-within10-n', Math.round(bt.within10 * bt.count) + ' of ' + bt.count + ' listings');
  text('bt-coverage', Math.round(bt.rangeHitRate * 100) + '%');

  /* estimate vs actual ---------------------------------------------------- */
  charts.renderLegend($('acc-legend'), [
    { name: 'Model-priced listing', color: TOOL_COLOR },
    { name: 'Manually priced listing', color: MANUAL_COLOR }
  ]);
  charts.scatter($('acc-chart'), {
    height: 300, identityLine: true, radius: 5,
    label: 'Model estimate against actual sale price for all 36 listings',
    xTitle: 'Actual sale price', yTitle: 'Model estimate',
    xFormat: charts.fmt.moneyCompact, yFormat: charts.fmt.moneyCompact,
    points: bt.results.map(function (r) {
      return {
        x: r.actual, y: r.estimate,
        color: r.sale.pricedWith === 'pricelens' ? TOOL_COLOR : MANUAL_COLOR,
        sale: r.sale, err: r.error, inside: r.insideRange
      };
    }),
    tip: function (p) {
      return '<b>' + p.sale.address + '</b><br>' +
        '<span class="tip-label">sold</span> <b>' + fmt.money(p.x) + '</b><br>' +
        '<span class="tip-label">model</span> <b>' + fmt.money(p.y) + '</b><br>' +
        '<span class="tip-label">error</span> <b>' + fmt.signedPct(p.err, 1) + '</b>';
    }
  });
  charts.renderTable($('acc-table'),
    ['Property', 'Sold', 'Model estimate', 'Error'],
    bt.results.slice().sort(function (a, b) { return b.absError - a.absError; }).map(function (r) {
      return [r.sale.address + ', ' + r.sale.city, fmt.money(r.actual), fmt.money(r.estimate), fmt.signedPct(r.error, 1)];
    }),
    'Model estimate against actual sale price for every listing');

  /* error distribution ----------------------------------------------------- */
  charts.renderLegend($('err-legend'), [{ name: 'Listings', color: 'var(--series-1)' }]);
  var errs = bt.results.map(function (r) { return r.error * 100; });
  var bound = Math.ceil(Math.max.apply(null, errs.map(Math.abs)) / 5) * 5;
  charts.histogram($('err-chart'), {
    height: 300, values: errs, bins: 10, min: -bound, max: bound,
    label: 'Distribution of valuation error across the 36 listings',
    binFormat: function (v) { return (v > 0 ? '+' : '') + v.toFixed(0) + '%'; }
  });
  text('err-note', 'Median error ' + fmt.signedPct(bt.medianSignedError, 1) +
    ' — the model runs marginally ' + (bt.medianSignedError < 0 ? 'under' : 'over') +
    ', not in one direction badly. Spread is ' + fmt.pct(bt.meanAbsError, 1) + ' on average.');
  charts.renderTable($('err-table'), ['Error band', 'Listings'],
    (function () {
      var bands = [[-Infinity, -0.10], [-0.10, -0.05], [-0.05, -0.02], [-0.02, 0.02],
        [0.02, 0.05], [0.05, 0.10], [0.10, Infinity]];
      return bands.map(function (b) {
        var n = bt.results.filter(function (r) { return r.error >= b[0] && r.error < b[1]; }).length;
        var lo = b[0] === -Infinity ? 'below −10%' : fmt.signedPct(b[0], 0);
        var hi = b[1] === Infinity ? 'above +10%' : fmt.signedPct(b[1], 0);
        return [b[0] === -Infinity ? lo : b[1] === Infinity ? hi : lo + ' to ' + hi, String(n)];
      });
    })(),
    'Count of listings in each valuation error band');

  /* the misses ------------------------------------------------------------- */
  var worst = bt.results.slice().sort(function (a, b) { return b.absError - a.absError; })[0];
  if (worst) {
    $('worst-note').innerHTML = '<strong>The worst call in the book.</strong> ' +
      worst.sale.address + ' in ' + worst.sale.city + ' — the model said ' +
      fmt.money(worst.estimate) + ', it sold for ' + fmt.money(worst.actual) + ', off by ' +
      fmt.signedPct(worst.error, 1) + '. It graded <b>' + worst.valuation.confidence.grade +
      '</b> at the time, on ' + worst.valuation.comps.length + ' comps with ' +
      Math.round(util.median(worst.valuation.comps.map(function (c) { return c.metrics.ageDays; }))) +
      ' days median age. A model that never shows you its misses is not showing you its accuracy either.';
  }

  /* ------------------------------------------------------- adoption charts */
  var ordered = book.slice();
  charts.renderLegend($('dom-legend'), [
    { name: 'Manually priced', color: MANUAL_COLOR },
    { name: 'Model priced', color: TOOL_COLOR }
  ]);
  charts.column($('dom-chart'), {
    height: 270, maxBar: 16, labelExtremes: false,
    label: 'Days on market for each listing in closing order',
    yFormat: function (v) { return Math.round(v) + 'd'; },
    tipFormat: function (v) { return Math.round(v) + ' days'; },
    data: ordered.map(function (s, i) {
      return {
        label: s.address, short: String(i + 1), value: s.dom,
        note: (s.pricedWith === 'pricelens' ? 'Model priced' : 'Manually priced') + ' · closed ' + fmt.date(s.saleDate),
        color: s.pricedWith === 'pricelens' ? TOOL_COLOR : MANUAL_COLOR
      };
    }),
    colorBy: true
  });
  text('dom-note', 'Median ' + Math.round(util.median(manual.map(function (s) { return s.dom; }))) +
    ' days before, ' + Math.round(util.median(tool.map(function (s) { return s.dom; }))) + ' days after.');
  charts.renderTable($('dom-table'), ['Property', 'Priced by', 'Closed', 'Days on market'],
    ordered.map(function (s) {
      return [s.address + ', ' + s.city, s.pricedWith === 'pricelens' ? 'Model' : 'Manual',
        fmt.date(s.saleDate), String(s.dom)];
    }),
    'Days on market for every listing');

  charts.renderLegend($('stl-legend'), [
    { name: 'Manually priced', color: MANUAL_COLOR },
    { name: 'Model priced', color: TOOL_COLOR }
  ]);
  charts.scatter($('stl-chart'), {
    height: 270, sharedScale: false, radius: 5,
    label: 'Sale price as a share of original asking price, by days on market',
    xTitle: 'Days on market', yTitle: 'Sale ÷ original ask',
    xFormat: function (v) { return Math.round(v) + 'd'; },
    yFormat: function (v) { return (v * 100).toFixed(0) + '%'; },
    points: ordered.map(function (s) {
      return {
        x: s.dom, y: s.soldPrice / s.originalListPrice,
        color: s.pricedWith === 'pricelens' ? TOOL_COLOR : MANUAL_COLOR, sale: s
      };
    }),
    tip: function (p) {
      return '<b>' + p.sale.address + '</b><br>' +
        '<span class="tip-label">asked</span> <b>' + fmt.money(p.sale.originalListPrice) + '</b><br>' +
        '<span class="tip-label">sold</span> <b>' + fmt.money(p.sale.soldPrice) + '</b><br>' +
        '<span class="tip-label">' + p.sale.dom + ' days · ' + p.sale.priceCuts + ' cut' +
        (p.sale.priceCuts === 1 ? '' : 's') + '</span>';
    }
  });
  text('stl-note', 'Listings that sat took the discount: every point below 96% spent more than a ' +
    'month on the market.');
  charts.renderTable($('stl-table'), ['Property', 'Priced by', 'Original ask', 'Sold', 'Ratio', 'Cuts'],
    ordered.map(function (s) {
      return [s.address, s.pricedWith === 'pricelens' ? 'Model' : 'Manual',
        fmt.money(s.originalListPrice), fmt.money(s.soldPrice),
        fmt.pct(s.soldPrice / s.originalListPrice, 1), String(s.priceCuts)];
    }),
    'Sale price against original asking price for every listing');

  /* comparison table ------------------------------------------------------- */
  var rows = [
    ['Listings', String(manual.length), String(tool.length), ''],
    ['Median days on market',
      Math.round(util.median(manual.map(function (s) { return s.dom; }))) + ' days',
      Math.round(util.median(tool.map(function (s) { return s.dom; }))) + ' days',
      fmt.int(util.median(tool.map(function (s) { return s.dom; })) - util.median(manual.map(function (s) { return s.dom; }))) + ' days'],
    ['Sale vs original ask',
      fmt.pct(avg(manual, function (s) { return s.soldPrice / s.originalListPrice; }), 1),
      fmt.pct(avg(tool, function (s) { return s.soldPrice / s.originalListPrice; }), 1),
      fmt.signedPct(avg(tool, function (s) { return s.soldPrice / s.originalListPrice; }) -
        avg(manual, function (s) { return s.soldPrice / s.originalListPrice; }), 1)],
    (function () {
      var a = manual.filter(function (s) { return s.priceCuts > 0; }).length / manual.length;
      var b = tool.filter(function (s) { return s.priceCuts > 0; }).length / tool.length;
      return ['Listings needing a price cut', Math.round(a * 100) + '%', Math.round(b * 100) + '%',
        fmt.signedPct(b - a, 0) + ' pts'];
    })(),
    (function () {
      var a = manual.filter(function (s) { return s.dom <= 30; }).length / manual.length;
      var b = tool.filter(function (s) { return s.dom <= 30; }).length / tool.length;
      return ['Sold within 30 days', Math.round(a * 100) + '%', Math.round(b * 100) + '%',
        fmt.signedPct(b - a, 0) + ' pts'];
    })()
  ];
  $('compare-table').innerHTML =
    '<table class="data"><thead><tr><th scope="col">Measure</th>' +
    '<th scope="col">Manually priced</th><th scope="col">Model priced</th><th scope="col">Change</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr><th scope="row">' + r[0] + '</th><td class="num">' + r[1] +
        '</td><td class="num">' + r[2] + '</td><td class="num">' + (r[3] || '—') + '</td></tr>';
    }).join('') + '</tbody></table>';

  /* ------------------------------------------------------- volume charts */
  var months = {};
  book.forEach(function (s) {
    var k = s.saleDate.slice(0, 7);
    months[k] = (months[k] || 0) + s.soldPrice;
  });
  var keys = Object.keys(months).sort();
  // Fill the gaps so a quiet month reads as zero rather than vanishing.
  var full = [];
  if (keys.length) {
    var cur = keys[0], end = keys[keys.length - 1];
    while (cur <= end) {
      full.push(cur);
      var y = +cur.slice(0, 4), m = +cur.slice(5, 7);
      m++; if (m > 12) { m = 1; y++; }
      cur = y + '-' + String(m).padStart(2, '0');
    }
  }
  charts.renderLegend($('vol-legend'), [{ name: 'Closed volume', color: 'var(--series-1)' }]);
  charts.column($('vol-chart'), {
    height: 250,
    label: 'Closed sales volume by month',
    yFormat: charts.fmt.moneyCompact, tipFormat: fmt.money,
    data: full.map(function (k) {
      var n = book.filter(function (s) { return s.saleDate.slice(0, 7) === k; }).length;
      return {
        label: fmt.monthLabel(k), short: fmt.monthShort(k), value: months[k] || 0,
        note: n === 1 ? '1 closing' : n + ' closings'
      };
    })
  });
  charts.renderTable($('vol-table'), ['Month', 'Closings', 'Volume'],
    full.map(function (k) {
      return [fmt.monthLabel(k),
        String(book.filter(function (s) { return s.saleDate.slice(0, 7) === k; }).length),
        fmt.money(months[k] || 0)];
    }),
    'Closed sales volume by month');

  var bySub = {};
  book.forEach(function (s) { bySub[s.city] = (bySub[s.city] || 0) + s.soldPrice; });
  var subRows = Object.keys(bySub).map(function (k) {
    return { label: k, value: bySub[k], count: book.filter(function (s) { return s.city === k; }).length };
  }).sort(function (a, b) { return b.value - a.value; });
  charts.bars($('sub-chart'), {
    label: 'Closed volume by submarket', rowHeight: 38, labelWidth: 92,
    valueFormat: charts.fmt.moneyCompact,
    data: subRows.map(function (r) {
      return { label: r.label, value: r.value, note: r.count + ' propert' + (r.count === 1 ? 'y' : 'ies') };
    })
  });
  charts.renderTable($('sub-table'), ['Submarket', 'Properties', 'Volume', 'Share'],
    subRows.map(function (r) {
      return [r.label, String(r.count), fmt.money(r.value), fmt.pct(r.value / volume, 1)];
    }),
    'Closed volume by submarket');

  /* -------------------------------------------------------------- the book */
  var COLUMNS = [
    { key: 'saleDate', label: 'Closed', render: function (s) { return fmt.date(s.saleDate); }, sort: function (s) { return s.saleDate; } },
    { key: 'address', label: 'Property', render: function (s) { return s.address + '<span class="sub"><br>' + s.city + ' · ' + fmt.beds(s) + '</span>'; }, sort: function (s) { return s.address; } },
    { key: 'pricedWith', label: 'Priced by', render: function (s) { return s.pricedWith === 'pricelens' ? 'Model' : 'Manual'; }, sort: function (s) { return s.pricedWith; } },
    { key: 'originalListPrice', label: 'Asked', render: function (s) { return fmt.money(s.originalListPrice); }, sort: function (s) { return s.originalListPrice; } },
    { key: 'soldPrice', label: 'Sold', render: function (s) { return fmt.money(s.soldPrice); }, sort: function (s) { return s.soldPrice; } },
    { key: 'estimate', label: 'Model said', render: function (s) { var r = byId[s.id]; return r ? fmt.money(r.estimate) : '—'; }, sort: function (s) { return byId[s.id] ? byId[s.id].estimate : 0; } },
    { key: 'error', label: 'Error', render: function (s) {
        var r = byId[s.id]; if (!r) return '—';
        var cls = r.absError <= 0.05 ? 'var(--good-ink)' : r.absError <= 0.10 ? 'var(--ink)' : 'var(--critical)';
        return '<span style="color:' + cls + '">' + fmt.signedPct(r.error, 1) + '</span>';
      }, sort: function (s) { return byId[s.id] ? byId[s.id].error : 0; } },
    { key: 'dom', label: 'Days', render: function (s) { return String(s.dom); }, sort: function (s) { return s.dom; } }
  ];
  var sortState = { key: 'saleDate', dir: 1 };

  function renderBook() {
    var col = COLUMNS.filter(function (c) { return c.key === sortState.key; })[0];
    var rows = book.slice().sort(function (a, b) {
      var va = col.sort(a), vb = col.sort(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortState.dir;
    });
    $('book-table').innerHTML =
      '<table class="data"><caption class="sr-only">Every listing with the model estimate and final sale price</caption><thead><tr>' +
      COLUMNS.map(function (c) {
        var arrow = c.key === sortState.key ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
        return '<th scope="col"><button class="btn btn--quiet btn--sm" style="border:0;background:none;padding:0;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit" data-sort="' +
          c.key + '" aria-label="Sort by ' + c.label + '">' + c.label + arrow + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      rows.map(function (s) {
        return '<tr>' + COLUMNS.map(function (c, i) {
          return i === 1 ? '<th scope="row">' + c.render(s) + '</th>' : '<td class="num">' + c.render(s) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';

    $('book-table').querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        sortState.dir = sortState.key === k ? -sortState.dir : 1;
        sortState.key = k;
        renderBook();
      });
    });
  }
  renderBook();

  $('btn-book-csv').addEventListener('click', function () {
    var head = ['Closed', 'Address', 'City', 'Beds', 'Baths', 'Sqft', 'Priced by',
      'Original ask', 'Sold', 'Model estimate', 'Error %', 'Days on market', 'Price cuts'];
    var lines = [head.join(',')];
    book.forEach(function (s) {
      var r = byId[s.id];
      lines.push([s.saleDate, '"' + s.address + '"', s.city, s.beds, s.baths, s.sqft,
        s.pricedWith === 'pricelens' ? 'Model' : 'Manual', s.originalListPrice, s.soldPrice,
        r ? r.estimate : '', r ? (r.error * 100).toFixed(2) : '', s.dom, s.priceCuts].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pricelens-portfolio.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });

  PL.app.wireTableToggles();
})();
