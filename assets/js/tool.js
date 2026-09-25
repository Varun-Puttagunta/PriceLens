/** PriceLens AI — the pricing tool. Form in, valuation and list-price strategy out. */
(function () {
  'use strict';
  var PL = window.PriceLens;
  var engine = PL.engine, data = PL.data, charts = PL.charts, fmt = PL.app.fmt;
  var AS_OF = data.meta.generatedAt;

  // Fit the market once. It depends on the sales book and the valuation date,
  // neither of which the form can change, so refitting per keystroke would be
  // the same arithmetic at ~650 rows a time.
  var FIT = engine.fitMarketModel(data.sales, AS_OF);

  var $ = function (id) { return document.getElementById(id); };
  var state = { valuation: null, strategy: null, subject: null };

  /* ------------------------------------------------------------- inputs -- */
  var CITIES = data.meta.submarkets.map(function (s) { return s.name; });

  function fillSelects() {
    $('f-city').innerHTML = CITIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    var presets = data.sales
      .filter(function (s) { return s.portfolio; })
      .sort(function (a, b) { return b.saleDate.localeCompare(a.saleDate); });
    $('preset').innerHTML = '<option value="">Custom property</option>' +
      presets.map(function (s) {
        return '<option value="' + s.id + '">' + s.address + ', ' + s.city +
          ' — ' + fmt.int(s.sqft) + ' sqft</option>';
      }).join('');
    $('as-of').textContent = fmt.date(AS_OF);
    $('pool-size').textContent = fmt.int(FIT.n);
    $('market-name').textContent = data.meta.marketName;
  }

  function readForm() {
    var city = $('f-city').value;
    var sub = data.meta.submarkets.filter(function (s) { return s.name === city; })[0] || data.meta.submarkets[0];
    return {
      id: '__subject__',
      address: state.subject && state.subject.address ? state.subject.address : 'Subject property',
      city: city,
      // A custom property has no coordinates, so it sits at the centre of its
      // submarket — which is what "somewhere in Frisco" honestly means.
      lat: state.subject && state.subject.lat != null ? state.subject.lat : sub.lat,
      lng: state.subject && state.subject.lng != null ? state.subject.lng : sub.lng,
      type: $('f-type').value,
      beds: +$('f-beds').value || 3,
      baths: +$('f-baths').value || 2,
      sqft: +$('f-sqft').value || 2000,
      lotSqft: +$('f-lot').value || 0,
      yearBuilt: +$('f-year').value || 2010,
      garage: +$('f-garage').value || 0,
      condition: +$('f-condition').value || 3,
      pool: $('f-pool').checked,
      greenbelt: $('f-greenbelt').checked
    };
  }

  function writeForm(s) {
    $('f-city').value = s.city;
    $('f-type').value = s.type;
    $('f-beds').value = s.beds;
    $('f-baths').value = s.baths;
    $('f-sqft').value = s.sqft;
    $('f-lot').value = s.lotSqft;
    $('f-year').value = s.yearBuilt;
    $('f-garage').value = s.garage;
    $('f-condition').value = s.condition;
    $('f-pool').checked = !!s.pool;
    $('f-greenbelt').checked = !!s.greenbelt;
  }

  /* ---------------------------------------------------------- rendering -- */
  function renderValuation(v) {
    $('v-estimate').textContent = fmt.money(v.estimate);
    $('v-psf').textContent = '$' + Math.round(v.psf) + ' per sqft · ' +
      'range ±' + (v.rangePct * 100).toFixed(1) + '%';
    $('v-low').textContent = fmt.money(v.low);
    $('v-high').textContent = fmt.money(v.high);
    var span = v.high - v.low;
    $('v-pin').style.left = Math.max(2, Math.min(98, span ? (v.estimate - v.low) / span * 100 : 50)) + '%';

    var g = $('v-grade');
    g.className = 'grade grade--' + v.confidence.grade;
    g.textContent = v.confidence.grade;
    $('v-grade-title').textContent = 'Confidence grade ' + v.confidence.grade;
    $('v-grade-score').textContent = v.confidence.score + ' / 100 · ' + v.comps.length + ' comps';
    $('v-blurb').textContent = v.confidence.blurb;

    $('v-signals').innerHTML = v.confidence.signals.map(function (s) {
      return '<div class="signal-row">' +
        '<span class="signal-name">' + s.label + '</span>' +
        '<span class="meter"><span class="meter__fill" style="width:' + Math.round(s.value) + '%"></span></span>' +
        '<span class="signal-detail">' + s.detail + '</span>' +
        '</div>';
    }).join('');
  }

  function renderRecommendation(v, st) {
    var r = st.recommended;
    $('r-price').textContent = fmt.money(r.listPrice);
    $('r-dom').textContent = r.dom + ' days';
    $('r-prob').textContent = Math.round(r.prob60 * 100) + '%';
    $('r-sale').textContent = fmt.money(r.expectedSale);
    $('r-net').textContent = fmt.money(r.net);

    var side = r.over > 0.004 ? 'above' : r.over < -0.004 ? 'below' : 'at';
    $('r-reason').innerHTML =
      'That is ' + (side === 'at' ? 'level with' : fmt.pct(Math.abs(r.over), 1) + ' ' + side) +
      ' the estimated value of <b>' + fmt.money(v.estimate) + '</b>. Across every asking price ' +
      'tested, this one leaves the seller with the most after commission, carrying cost and the ' +
      'discount a listing concedes once it has been sitting.';

    var pill = $('r-pill'), pillText = $('r-pill-text');
    if (r.dom <= 21) { pill.className = 'pill pill--good'; pillText.textContent = 'Fast market'; }
    else if (r.dom <= 45) { pill.className = 'pill'; pillText.textContent = 'Normal pace'; }
    else { pill.className = 'pill pill--warn'; pillText.textContent = 'Slow market'; }

    $('r-band-note').innerHTML = r.capturedBand
      ? '<strong>Priced under a search band.</strong> Buyers filter portals in ' +
        fmt.moneyCompact(st.assumptions.searchBandSize) + ' steps, so a listing at ' +
        fmt.money(r.rawListPrice) + ' is invisible to everyone whose ceiling is ' +
        fmt.money(r.searchBandEdge) + '. Dropping ' + fmt.money(Math.abs(r.bandAdjustment)) +
        ' to ' + fmt.money(r.listPrice) + ' buys that entire audience.'
      : '<strong>Already inside a search band.</strong> At ' + fmt.money(r.listPrice) +
        ' the listing sits comfortably below the ' + fmt.money(r.searchBandEdge) +
        ' filter step, so no rounding is needed to stay visible.';

    var a = st.anchorComparison;
    $('r-anchor-note').innerHTML = a.netDelta > 500
      ? '<strong>The optimistic alternative costs ' + fmt.money(a.netDelta) + '.</strong> ' +
        'Listing at ' + fmt.money(a.listPrice) + ' — the familiar "price it 5% high and leave room ' +
        'to negotiate" — projects ' + a.dom + ' days instead of ' + st.recommended.dom +
        ', and nets ' + fmt.money(a.net) + '.'
      : '<strong>Little to separate the options here.</strong> Listing at ' + fmt.money(a.listPrice) +
        ' nets ' + fmt.money(a.net) + ', within ' + fmt.money(Math.abs(a.netDelta)) +
        ' of the recommendation. In a market this fast, the asking price is not the binding constraint.';
  }

  function renderLadderCharts(st) {
    var rows = st.ladder;
    charts.renderLegend($('net-legend'), [{ name: 'Net to seller', color: 'var(--series-1)' }], 'line');
    charts.renderLegend($('dom-legend'), [{ name: 'Days on market', color: 'var(--series-2)' }], 'line');

    charts.line($('net-chart'), {
      height: 230, directLabels: false, rightPad: 16,
      label: 'Seller net proceeds across candidate asking prices',
      yFormat: charts.fmt.moneyCompact,
      tipFormat: fmt.money,
      series: [{
        name: 'Net to seller', color: 'var(--series-1)', area: true,
        points: rows.map(function (r) {
          return { y: r.net, label: 'Ask ' + fmt.money(r.listPrice), short: fmt.signedPct(r.over, 0) };
        })
      }]
    });

    charts.line($('dom-chart'), {
      height: 230, directLabels: false, rightPad: 16,
      label: 'Projected days on market across candidate asking prices',
      yFormat: function (v) { return Math.round(v) + 'd'; },
      tipFormat: function (v) { return Math.round(v) + ' days'; },
      yMin: 0,
      series: [{
        name: 'Days on market', color: 'var(--series-2)', area: true,
        points: rows.map(function (r) {
          return { y: r.dom, label: 'Ask ' + fmt.money(r.listPrice), short: fmt.signedPct(r.over, 0) };
        })
      }]
    });

    var cols = ['Asking price', 'vs value', 'Days', 'Cuts', 'Expected sale', 'Net'];
    var body = rows.map(function (r) {
      return [fmt.money(r.listPrice), fmt.signedPct(r.over, 0), String(r.dom),
        String(r.priceCuts), fmt.money(r.expectedSale), fmt.money(r.net)];
    });
    charts.renderTable($('net-table'), cols, body, 'Net proceeds at each asking price');
    charts.renderTable($('dom-table'), cols, body, 'Days on market at each asking price');
    PL.app.wireTableToggles();
  }

  function renderComps(v) {
    $('comps-sub').textContent = v.comps.length + ' of ' + v.candidatePool +
      ' candidate sales within ' + v.tierSpec.radiusMiles + ' miles and ' +
      v.tierSpec.maxAgeDays + ' days';

    $('comps-list').innerHTML = v.comps.map(function (c, i) {
      var s = c.sale, g = c.grid;
      var flags = '';
      if (g.overGrossCap) flags += '<span class="pill pill--warn" style="margin-left:.4rem">heavy adjustment</span>';

      var lines = g.lines.map(function (l) {
        return '<tr><th scope="row">' + l.label + '<span class="sub"> · ' + l.detail + '</span></th>' +
          '<td class="num">' + fmt.signedMoney(l.amount) + '</td></tr>';
      }).join('');

      return '<details class="comp">' +
        '<summary>' +
          '<span><b>' + s.address + '</b><br><span class="small muted">' + s.city + ' · ' +
            fmt.beds(s) + ' · built ' + s.yearBuilt + ' · sold ' + fmt.date(s.saleDate) + '</span></span>' +
          '<span class="small muted nowrap" style="text-align:right">sold<br><b style="color:var(--ink)">' +
            fmt.money(s.soldPrice) + '</b></span>' +
          '<span class="small muted nowrap" style="text-align:right">adjusted<br><b style="color:var(--ink)">' +
            fmt.money(g.adjustedPrice) + '</b></span>' +
        '</summary>' +
        '<div class="comp__body">' +
          '<div class="grid grid--2" style="gap:1.2rem">' +
            '<div class="table-scroll"><table class="data"><caption class="sr-only">Adjustment grid for ' + s.address + '</caption><tbody>' +
              '<tr><th scope="row">Sold price</th><td class="num">' + fmt.money(s.soldPrice) + '</td></tr>' +
              '<tr><th scope="row">Market time<span class="sub"> · ' + Math.round(g.months) + ' months at ' +
                fmt.signedPct(v.trend.monthlyRate, 2) + '/mo</span></th><td class="num">' +
                fmt.signedMoney(g.timeAdjustment) + '</td></tr>' +
              lines +
              '<tr style="border-top:1px solid var(--axis)"><th scope="row"><b>Adjusted value</b></th>' +
                '<td class="num"><b>' + fmt.money(g.adjustedPrice) + '</b></td></tr>' +
            '</tbody></table></div>' +
            '<div><dl class="kv small">' +
              '<dt>Comparability</dt><dd>' + Math.round(c.similarity * 100) + '%</dd>' +
              '<dt>Weight in estimate</dt><dd>' + Math.round(c.weightShare * 100) + '%</dd>' +
              '<dt>Distance</dt><dd>' + c.metrics.miles.toFixed(2) + ' mi</dd>' +
              '<dt>Sold</dt><dd>' + c.metrics.ageDays + ' days ago</dd>' +
              '<dt>Net adjustment</dt><dd>' + fmt.signedPct(g.netPct, 1) + '</dd>' +
              '<dt>Gross adjustment</dt><dd>' + fmt.pct(g.grossPct, 1) + '</dd>' +
              '<dt>Adjusted $/sqft</dt><dd>$' + Math.round(g.adjustedPsf) + '</dd>' +
            '</dl>' +
            (g.overGrossCap
              ? '<p class="small muted" style="margin-top:.7rem">Gross adjustment is above the 25% ' +
                'guideline, so this comp carries less weight in the reconciliation.</p>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</details>';
    }).join('');
  }

  function renderFit(v) {
    $('fit-sub').textContent = FIT.fitted
      ? 'Hedonic fit across ' + fmt.int(FIT.n) + ' sales · R² ' + FIT.r2.toFixed(3)
      : 'Market too thin to fit — using default rates';

    var price = v.comps.length ? engine.util.median(v.comps.map(function (c) { return c.sale.soldPrice; })) : 600000;
    var dollars = function (c) { return price * (Math.exp(c) - 1); };
    var rows = [
      ['Market drift', fmt.signedPct(FIT.annualRate, 1) + ' / yr', 1],
      ['Marginal living area', '$' + Math.round(v.glaRate) + ' / sqft', v.glaRate],
      ['One bedroom', fmt.money(dollars(FIT.rates.beds)), dollars(FIT.rates.beds)],
      ['One full bathroom', fmt.money(dollars(FIT.rates.baths)), dollars(FIT.rates.baths)],
      ['One garage bay', fmt.money(dollars(FIT.rates.garage)), dollars(FIT.rates.garage)],
      ['One condition grade', fmt.money(dollars(FIT.rates.condition)), dollars(FIT.rates.condition)],
      ['A pool', fmt.money(dollars(FIT.rates.pool)), dollars(FIT.rates.pool)],
      ['A greenbelt lot', fmt.money(dollars(FIT.rates.greenbelt)), dollars(FIT.rates.greenbelt)],
      ['A decade newer', fmt.money(dollars(FIT.rates.decade)), dollars(FIT.rates.decade)]
    ];
    $('fit-rates').innerHTML = rows
      .filter(function (r) { return Math.abs(r[2]) >= 1; })
      .map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; })
      .join('');
  }

  /* ------------------------------------------------------------- run it -- */
  function run() {
    var subject = readForm();
    var v = engine.valuate(subject, data.sales, {
      asOf: AS_OF,
      trend: FIT,
      excludeIds: state.subject && state.subject.id ? [state.subject.id] : []
    });

    var fail = $('no-comps');
    if (!v.ok) {
      fail.hidden = false;
      $('no-comps-detail').textContent = v.reason +
        ' Try a different submarket, or bring the size closer to what actually trades there.';
      $('valuation-card').style.opacity = '.35';
      return;
    }
    fail.hidden = true;
    $('valuation-card').style.opacity = '';

    var st = engine.strategy(v, {
      baseDom: engine.baseDomFromComps(v),
      commissionRate: (+$('f-commission').value || 0) / 100,
      monthlyCarryRate: (+$('f-carry').value || 0) / 100,
      closingDays: +$('f-closing').value || 0,
      searchBandSize: +$('f-band').value || 25000
    });

    state.valuation = v;
    state.strategy = st;

    renderValuation(v);
    renderRecommendation(v, st);
    renderLadderCharts(st);
    renderComps(v);
    renderFit(v);
  }

  var timer;
  function scheduleRun() { clearTimeout(timer); timer = setTimeout(run, 140); }

  /* -------------------------------------------------------------- export -- */
  function download(name, mime, text) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  var csvCell = function (v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function exportCsv() {
    var v = state.valuation, st = state.strategy;
    if (!v) return;
    var rows = [
      ['PriceLens AI comparative market analysis'],
      ['Valued as of', AS_OF],
      ['Subject', v.subject.address + ', ' + v.subject.city],
      ['Specification', v.subject.beds + ' bd / ' + v.subject.baths + ' ba / ' + v.subject.sqft + ' sqft'],
      ['Estimated value', v.estimate],
      ['Range low', v.low],
      ['Range high', v.high],
      ['Confidence', v.confidence.grade + ' (' + v.confidence.score + '/100)'],
      ['Recommended list price', st.recommended.listPrice],
      ['Expected days on market', st.recommended.dom],
      ['Expected net to seller', st.recommended.net],
      [],
      ['Comparable sales'],
      ['Address', 'City', 'Beds', 'Baths', 'Sqft', 'Sold date', 'Sold price',
        'Time adj', 'Net adj', 'Adjusted price', 'Comparability', 'Weight']
    ];
    v.comps.forEach(function (c) {
      rows.push([c.sale.address, c.sale.city, c.sale.beds, c.sale.baths, c.sale.sqft,
        c.sale.saleDate, c.sale.soldPrice, c.grid.timeAdjustment, c.grid.netAdjustment,
        c.grid.adjustedPrice, (c.similarity * 100).toFixed(0) + '%',
        (c.weightShare * 100).toFixed(0) + '%']);
    });
    rows.push([], ['Asking price ladder'], ['List price', 'vs value', 'Days', 'Cuts', 'Expected sale', 'Net']);
    st.ladder.forEach(function (r) {
      rows.push([r.listPrice, (r.over * 100).toFixed(1) + '%', r.dom, r.priceCuts, r.expectedSale, r.net]);
    });
    download('pricelens-cma.csv', 'text/csv;charset=utf-8',
      rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n'));
  }

  function exportJson() {
    var v = state.valuation, st = state.strategy;
    if (!v) return;
    download('pricelens-cma.json', 'application/json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      asOf: AS_OF,
      subject: v.subject,
      valuation: {
        estimate: v.estimate, low: v.low, high: v.high, psf: v.psf,
        confidence: v.confidence, dispersion: v.dispersion, calibration: v.calibration
      },
      marketFit: { annualRate: FIT.annualRate, r2: FIT.r2, n: FIT.n, rates: FIT.rates },
      comps: v.comps.map(function (c) {
        return {
          sale: c.sale, similarity: c.similarity, weight: c.weightShare,
          distanceMiles: c.metrics.miles, ageDays: c.metrics.ageDays, grid: c.grid
        };
      }),
      strategy: st
    }, null, 2));
  }

  /* --------------------------------------------------------------- wire -- */
  fillSelects();

  $('preset').addEventListener('change', function () {
    var s = data.sales.filter(function (x) { return x.id === $('preset').value; })[0];
    state.subject = s || null;
    if (s) writeForm(s);
    run();
  });

  $('subject-form').addEventListener('input', function (ev) {
    if (ev.target.id === 'preset') return;
    // Editing any field means this is no longer that listing.
    if (state.subject) { state.subject = null; $('preset').value = ''; }
    scheduleRun();
  });

  $('btn-random').addEventListener('click', function () {
    var pool = data.sales.filter(function (s) { return s.portfolio; });
    var s = pool[Math.floor(Math.random() * pool.length)];
    $('preset').value = s.id;
    state.subject = s;
    writeForm(s);
    run();
  });

  $('btn-reset').addEventListener('click', function () {
    setTimeout(function () { state.subject = null; $('preset').value = ''; run(); }, 0);
  });

  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-csv').addEventListener('click', exportCsv);
  $('btn-json').addEventListener('click', exportJson);

  // Open on a real listing so the page is useful before anyone touches a field.
  var opening = data.sales.filter(function (s) { return s.portfolio; })
    .sort(function (a, b) { return b.saleDate.localeCompare(a.saleDate); })[0];
  if (opening) { $('preset').value = opening.id; state.subject = opening; writeForm(opening); }
  run();
})();
