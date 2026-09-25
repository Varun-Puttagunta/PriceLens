/**
 * PriceLens AI — a small SVG chart library.
 *
 * Deliberately not a charting framework: a handful of forms, drawn to one
 * spec. Thin marks, hairline gridlines, a 2px surface gap between touching
 * fills, a 2px surface ring on overlapping dots, selective direct labels, and
 * a hover layer on everything that plots. Colors come from CSS custom
 * properties, so light and dark are two designed palettes rather than an
 * inversion.
 *
 * Every chart can render an equivalent table — the relief channel for the
 * light-mode series that sit under 3:1 against the surface, and the fallback
 * for anyone not reading color at all.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.PriceLens = root.PriceLens || {}).charts = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var SERIES_VARS = ['--series-1', '--series-2', '--series-3'];

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function seriesColor(i) { return 'var(' + SERIES_VARS[i % SERIES_VARS.length] + ')'; }

  /* ------------------------------------------------------------ scales -- */
  function niceTicks(min, max, target) {
    target = target || 5;
    if (min === max) { min = min - 1; max = max + 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / target)));
    var err = (span / target) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { ticks: ticks, min: lo, max: hi };
  }

  var fmt = {
    compact: function (n) {
      var a = Math.abs(n);
      if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
      return String(Math.round(n));
    },
    money: function (n) { return '$' + Math.round(n).toLocaleString('en-US'); },
    moneyCompact: function (n) { return '$' + fmt.compact(n); },
    pct: function (n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; },
    int: function (n) { return Math.round(n).toLocaleString('en-US'); }
  };

  /* --------------------------------------------------- mount + tooltip -- */
  function mount(container, draw) {
    if (!container) return null;
    container.classList.add('chart');
    var tip = container.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('role', 'status');
      container.appendChild(tip);
    }
    var api = {
      tip: tip,
      showTip: function (html, x, y) {
        tip.innerHTML = html;
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
        tip.classList.add('is-on');
      },
      hideTip: function () { tip.classList.remove('is-on'); }
    };

    function render() {
      var w = container.clientWidth;
      if (!w) return;
      var old = container.querySelector('svg');
      if (old) old.remove();
      api.hideTip();
      draw(container, w, api);
    }

    render();
    if (typeof ResizeObserver !== 'undefined') {
      var last = container.clientWidth, t;
      new ResizeObserver(function () {
        var w = container.clientWidth;
        if (Math.abs(w - last) < 2) return;
        last = w;
        clearTimeout(t);
        t = setTimeout(render, 90);
      }).observe(container);
    }
    // Light and dark are different palettes, so a theme flip is a re-render.
    document.addEventListener('pricelens:themechange', render);
    return api;
  }

  /**
   * Draw the category axis, thinned so nothing collides.
   *
   * Stride alone isn't enough: label widths vary ("+8%" against "+10%") and the
   * last one is right-anchored, so whether two overlap depends on the rendered
   * text, not on the spacing of their anchors. So draw the candidates, then
   * measure and drop from the right — the final label always survives, because
   * it carries the axis's endpoint.
   */
  function drawCategoryLabels(svg, n, xOf, textOf, yPos, plotW) {
    var every = Math.ceil(n / Math.max(2, Math.floor(plotW / 58)));
    var idx = [];
    for (var i = 0; i < n; i += every) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

    var nodes = idx.map(function (i) {
      var t = el('text', {
        x: xOf(i), y: yPos, class: 'axis-text',
        'text-anchor': i === n - 1 ? 'end' : 'middle'
      }, svg);
      t.textContent = textOf(i);
      return t;
    });

    var keptLeft = Infinity;
    for (var k = nodes.length - 1; k >= 0; k--) {
      var b;
      try { b = nodes[k].getBBox(); } catch (e) { break; }   // detached or hidden
      if (b.x + b.width + 6 > keptLeft) { nodes[k].remove(); continue; }
      keptLeft = b.x;
    }
  }

  /* ------------------------------------------------------------ legend -- */
  function renderLegend(host, items, shape) {
    if (!host) return;
    host.innerHTML = '';
    host.className = 'chart__legend';
    items.forEach(function (it) {
      var li = document.createElement('li');
      var sw = document.createElement('span');
      sw.className = 'chart__swatch' + (shape === 'line' ? ' chart__swatch--line' : '');
      sw.style.background = it.color;
      li.appendChild(sw);
      li.appendChild(document.createTextNode(it.name));
      host.appendChild(li);
    });
  }

  /* ------------------------------------------------------- table view --- */
  function renderTable(host, columns, rows, caption) {
    if (!host) return;
    var html = '<div class="table-scroll"><table class="data">';
    if (caption) html += '<caption class="sr-only">' + caption + '</caption>';
    html += '<thead><tr>' + columns.map(function (c) { return '<th scope="col">' + c + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>' + r.map(function (cell, i) {
        return i === 0 ? '<th scope="row">' + cell + '</th>' : '<td class="num">' + cell + '</td>';
      }).join('') + '</tr>';
    });
    host.innerHTML = html + '</tbody></table></div>';
  }

  /* =======================================================================
   * Column chart — magnitude over an ordered category (usually months).
   * ===================================================================== */
  function column(container, opts) {
    return mount(container, function (host, W, api) {
      var data = opts.data || [];
      var H = opts.height || 240;
      var pad = { t: 18, r: 8, b: 30, l: 48 };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label || 'Column chart' }, host);

      var values = data.map(function (d) { return d.value; });
      var scale = niceTicks(Math.min(0, Math.min.apply(null, values)), Math.max.apply(null, values), 4);
      var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
      var y = function (v) { return pad.t + plotH - (v - scale.min) / (scale.max - scale.min) * plotH; };
      var band = plotW / Math.max(1, data.length);
      var barW = Math.min(opts.maxBar || 24, Math.max(3, band - 2)); // 2px surface gap between neighbours

      scale.ticks.forEach(function (t) {
        el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'gridline' }, svg);
        var tx = el('text', { x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg);
        tx.textContent = (opts.yFormat || fmt.compact)(t);
      });

      var maxIdx = values.indexOf(Math.max.apply(null, values));
      data.forEach(function (d, i) {
        var cx = pad.l + band * i + band / 2;
        var top = y(Math.max(0, d.value)), bot = y(Math.min(0, d.value));
        var h = Math.max(1, bot - top);
        var r = Math.min(4, h / 2, barW / 2);
        // Rounded at the data end, square at the baseline.
        var x = cx - barW / 2;
        var path = d.value >= 0
          ? 'M' + x + ',' + bot + 'V' + (top + r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',-' + r + 'h' + (barW - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'V' + bot + 'Z'
          : 'M' + x + ',' + top + 'V' + (bot - r) + 'a' + r + ',' + r + ' 0 0 0 ' + r + ',' + r + 'h' + (barW - 2 * r) + 'a' + r + ',' + r + ' 0 0 0 ' + r + ',-' + r + 'V' + top + 'Z';
        el('path', { d: path, fill: d.color || opts.color || seriesColor(0) }, svg);

        // Generous hit target: the whole band, not the bar.
        var hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: 'transparent' }, svg);
        hit.style.cursor = 'crosshair';
        hit.addEventListener('pointerenter', function () {
          api.showTip('<span class="tip-label">' + d.label + '</span><br><b>' +
            (opts.tipFormat || opts.yFormat || fmt.compact)(d.value) + '</b>' +
            (d.note ? '<br><span class="tip-label">' + d.note + '</span>' : ''), cx, top);
        });
        hit.addEventListener('pointerleave', api.hideTip);

        if (opts.labelExtremes !== false && i === maxIdx && h > 14) {
          var lab = el('text', { x: cx, y: top - 6, 'text-anchor': 'middle', class: 'mark-label' }, svg);
          lab.textContent = (opts.yFormat || fmt.compact)(d.value);
        }
      });

      drawCategoryLabels(svg, data.length,
        function (i) { return pad.l + band * i + band / 2; },
        function (i) { return data[i].short || data[i].label; },
        H - 10, plotW);
    });
  }

  /* =======================================================================
   * Line chart — change over time, one axis, crosshair + tooltip.
   * ===================================================================== */
  function line(container, opts) {
    return mount(container, function (host, W, api) {
      var series = opts.series || [];
      var H = opts.height || 250;
      var pad = { t: 18, r: opts.rightPad || 46, b: 30, l: 52 };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label || 'Line chart' }, host);

      var all = [];
      series.forEach(function (s) { s.points.forEach(function (p) { all.push(p.y); }); });
      var scale = niceTicks(
        opts.yMin != null ? opts.yMin : Math.min.apply(null, all),
        opts.yMax != null ? opts.yMax : Math.max.apply(null, all), 4);
      var n = series[0].points.length;
      var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
      var x = function (i) { return pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
      var y = function (v) { return pad.t + plotH - (v - scale.min) / (scale.max - scale.min) * plotH; };

      scale.ticks.forEach(function (t) {
        el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'gridline' }, svg);
        var tx = el('text', { x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg);
        tx.textContent = (opts.yFormat || fmt.compact)(t);
      });
      if (opts.refValue != null) {
        el('line', {
          x1: pad.l, x2: W - pad.r, y1: y(opts.refValue), y2: y(opts.refValue),
          stroke: cssVar('--axis', '#c3c2b7'), 'stroke-width': 1, 'stroke-dasharray': '3 3'
        }, svg);
        if (opts.refLabel) {
          var rl = el('text', { x: W - pad.r + 4, y: y(opts.refValue) + 4, class: 'axis-text' }, svg);
          rl.textContent = opts.refLabel;
        }
      }

      series.forEach(function (s, si) {
        var color = s.color || seriesColor(si);
        if (s.area) {
          var ad = 'M' + x(0) + ',' + y(s.points[0].y);
          s.points.forEach(function (p, i) { if (i) ad += 'L' + x(i) + ',' + y(p.y); });
          ad += 'L' + x(n - 1) + ',' + (pad.t + plotH) + 'L' + x(0) + ',' + (pad.t + plotH) + 'Z';
          el('path', { d: ad, fill: color, 'fill-opacity': 0.10 }, svg);
        }
        var d = 'M' + x(0) + ',' + y(s.points[0].y);
        s.points.forEach(function (p, i) { if (i) d += 'L' + x(i) + ',' + y(p.y); });
        el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);

        // End marker with a surface ring so it stays legible over the line.
        var last = s.points[n - 1];
        el('circle', { cx: x(n - 1), cy: y(last.y), r: 4.5, fill: color, stroke: cssVar('--surface', '#fff'), 'stroke-width': 2 }, svg);
        if (series.length <= 4 && opts.directLabels !== false) {
          var lab = el('text', { x: x(n - 1) + 8, y: y(last.y) + 4, class: 'mark-label' }, svg);
          lab.textContent = (opts.labelFormat || opts.yFormat || fmt.compact)(last.y);
        }
      });

      // One crosshair across every series at the hovered index.
      var cross = el('line', { y1: pad.t, y2: pad.t + plotH, class: 'baseline', opacity: 0 }, svg);
      var dots = series.map(function (s, si) {
        return el('circle', { r: 4.5, fill: s.color || seriesColor(si), stroke: cssVar('--surface', '#fff'), 'stroke-width': 2, opacity: 0 }, svg);
      });
      var hit = el('rect', { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: 'transparent' }, svg);
      hit.style.cursor = 'crosshair';
      hit.addEventListener('pointermove', function (ev) {
        var box = host.getBoundingClientRect();
        var px = (ev.clientX - box.left) * (W / box.width);
        var i = Math.round(((px - pad.l) / plotW) * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
        var html = '<span class="tip-label">' + (series[0].points[i].label || '') + '</span>';
        series.forEach(function (s, si) {
          dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(s.points[i].y)); dots[si].setAttribute('opacity', 1);
          html += '<br><b>' + (opts.tipFormat || opts.yFormat || fmt.compact)(s.points[i].y) + '</b>' +
            (series.length > 1 ? ' <span class="tip-label">' + s.name + '</span>' : '');
        });
        api.showTip(html, x(i) * (box.width / W), y(series[0].points[i].y) * (box.height / H));
      });
      hit.addEventListener('pointerleave', function () {
        cross.setAttribute('opacity', 0);
        dots.forEach(function (d) { d.setAttribute('opacity', 0); });
        api.hideTip();
      });

      drawCategoryLabels(svg, n, x,
        function (i) { return series[0].points[i].short || series[0].points[i].label; },
        H - 10, plotW);
    });
  }

  /* =======================================================================
   * Scatter — two measures, one point per record, optional identity line.
   * ===================================================================== */
  function scatter(container, opts) {
    return mount(container, function (host, W, api) {
      var pts = opts.points || [];
      var H = opts.height || 300;
      var pad = { t: 18, r: 14, b: 42, l: 58 };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label || 'Scatter plot' }, host);

      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var lo = Math.min(Math.min.apply(null, xs), Math.min.apply(null, ys));
      var hi = Math.max(Math.max.apply(null, xs), Math.max.apply(null, ys));
      var sx = opts.sharedScale === false ? niceTicks(Math.min.apply(null, xs), Math.max.apply(null, xs), 4) : niceTicks(lo, hi, 4);
      var sy = opts.sharedScale === false ? niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 4) : sx;

      var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
      var X = function (v) { return pad.l + (v - sx.min) / (sx.max - sx.min) * plotW; };
      var Y = function (v) { return pad.t + plotH - (v - sy.min) / (sy.max - sy.min) * plotH; };

      sy.ticks.forEach(function (t) {
        el('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), class: 'gridline' }, svg);
        var tx = el('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg);
        tx.textContent = (opts.yFormat || fmt.compact)(t);
      });
      sx.ticks.forEach(function (t) {
        var tx = el('text', { x: X(t), y: H - 22, 'text-anchor': 'middle', class: 'axis-text' }, svg);
        tx.textContent = (opts.xFormat || fmt.compact)(t);
      });
      if (opts.identityLine) {
        el('line', {
          x1: X(Math.max(sx.min, sy.min)), y1: Y(Math.max(sx.min, sy.min)),
          x2: X(Math.min(sx.max, sy.max)), y2: Y(Math.min(sx.max, sy.max)),
          stroke: cssVar('--axis', '#c3c2b7'), 'stroke-width': 1, 'stroke-dasharray': '4 4'
        }, svg);
      }
      if (opts.xTitle) {
        var xt = el('text', { x: pad.l + plotW / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis-title' }, svg);
        xt.textContent = opts.xTitle;
      }
      if (opts.yTitle) {
        var yt = el('text', { x: 12, y: pad.t + plotH / 2, 'text-anchor': 'middle', class: 'axis-title',
          transform: 'rotate(-90 12 ' + (pad.t + plotH / 2) + ')' }, svg);
        yt.textContent = opts.yTitle;
      }

      pts.forEach(function (p) {
        var c = el('circle', {
          cx: X(p.x), cy: Y(p.y), r: opts.radius || 5,
          fill: p.color || seriesColor(0), 'fill-opacity': 0.85,
          stroke: cssVar('--surface', '#fff'), 'stroke-width': 2
        }, svg);
        c.style.cursor = 'pointer';
        var box;
        c.addEventListener('pointerenter', function () {
          box = host.getBoundingClientRect();
          c.setAttribute('r', (opts.radius || 5) + 2);
          api.showTip(opts.tip ? opts.tip(p) : '<b>' + fmt.compact(p.y) + '</b>',
            X(p.x) * (box.width / W), Y(p.y) * (box.height / H));
        });
        c.addEventListener('pointerleave', function () {
          c.setAttribute('r', opts.radius || 5);
          api.hideTip();
        });
      });
    });
  }

  /* =======================================================================
   * Horizontal bars — identity comparison, value at the tip.
   * ===================================================================== */
  function bars(container, opts) {
    return mount(container, function (host, W, api) {
      var data = opts.data || [];
      var rowH = opts.rowHeight || 34;
      var H = data.length * rowH + 18;
      var labelW = opts.labelWidth || 116;
      var pad = { t: 6, r: 58, l: labelW };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label || 'Bar chart' }, host);
      var max = Math.max.apply(null, data.map(function (d) { return Math.abs(d.value); }));
      var plotW = W - pad.l - pad.r;
      var barH = Math.min(18, rowH - 14);

      data.forEach(function (d, i) {
        var yTop = pad.t + i * rowH + (rowH - barH) / 2;
        var w = Math.max(2, Math.abs(d.value) / max * plotW);
        var r = Math.min(4, barH / 2, w / 2);
        var t = el('text', { x: labelW - 12, y: yTop + barH / 2 + 4, 'text-anchor': 'end', class: 'axis-text' }, svg);
        t.textContent = d.label;
        el('path', {
          d: 'M' + pad.l + ',' + yTop + 'h' + (w - r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
             'v' + (barH - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 -' + r + ',' + r + 'H' + pad.l + 'Z',
          fill: d.color || opts.color || seriesColor(0)
        }, svg);
        var v = el('text', { x: pad.l + w + 8, y: yTop + barH / 2 + 4, class: 'mark-label' }, svg);
        v.textContent = (opts.valueFormat || fmt.compact)(d.value);

        var hit = el('rect', { x: 0, y: pad.t + i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
        hit.addEventListener('pointerenter', function () {
          if (!d.note) return;
          var box = host.getBoundingClientRect();
          api.showTip('<span class="tip-label">' + d.label + '</span><br><b>' +
            (opts.valueFormat || fmt.compact)(d.value) + '</b><br><span class="tip-label">' + d.note + '</span>',
            (pad.l + w / 2) * (box.width / W), (yTop) * (box.height / H));
        });
        hit.addEventListener('pointerleave', api.hideTip);
      });
    });
  }

  /* =======================================================================
   * Histogram — distribution of one measure.
   * ===================================================================== */
  function histogram(container, opts) {
    var values = opts.values || [];
    var binCount = opts.bins || 10;
    var lo = opts.min != null ? opts.min : Math.min.apply(null, values);
    var hi = opts.max != null ? opts.max : Math.max.apply(null, values);
    var step = (hi - lo) / binCount || 1;
    var counts = new Array(binCount).fill(0);
    values.forEach(function (v) {
      var i = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / step)));
      counts[i]++;
    });
    var data = counts.map(function (c, i) {
      var a = lo + i * step, b = a + step;
      return {
        label: (opts.binFormat || fmt.compact)(a) + '–' + (opts.binFormat || fmt.compact)(b),
        short: (opts.binFormat || fmt.compact)(a),
        value: c,
        note: c === 1 ? '1 property' : c + ' properties'
      };
    });
    return column(container, Object.assign({}, opts, {
      data: data, yFormat: fmt.int, tipFormat: fmt.int, maxBar: 999
    }));
  }

  return {
    column: column, line: line, scatter: scatter, bars: bars, histogram: histogram,
    renderLegend: renderLegend, renderTable: renderTable,
    fmt: fmt, seriesColor: seriesColor, niceTicks: niceTicks, cssVar: cssVar
  };
});
