/**
 * PriceLens AI — shared page behaviour: theme, navigation, formatting helpers,
 * and the "show the numbers" toggle that sits under every chart.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.PriceLens = root.PriceLens || {}).app = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var THEME_KEY = 'pricelens.theme';

  /* ------------------------------------------------------------- theme -- */
  function storedTheme() {
    // Storage is blocked in private windows and can throw on access, so the
    // page has to render correctly when this comes back null.
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function storeTheme(v) {
    try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* preference simply won't persist */ }
  }
  function currentTheme() {
    var set = document.documentElement.getAttribute('data-theme');
    if (set) return set;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(v) {
    document.documentElement.setAttribute('data-theme', v);
    storeTheme(v);
    document.dispatchEvent(new CustomEvent('pricelens:themechange', { detail: { theme: v } }));
  }
  function initTheme() {
    var saved = storedTheme();
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  }

  /* --------------------------------------------------------- formatting -- */
  var fmt = {
    money: function (n) { return '$' + Math.round(n).toLocaleString('en-US'); },
    money0: function (n) { return '$' + Math.round(n).toLocaleString('en-US'); },
    moneyCompact: function (n) {
      var a = Math.abs(n);
      if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
      if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
      return '$' + Math.round(n);
    },
    signedMoney: function (n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); },
    pct: function (n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; },
    signedPct: function (n, d) {
      var v = n * 100;
      return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%';
    },
    int: function (n) { return Math.round(n).toLocaleString('en-US'); },
    date: function (iso) {
      var d = new Date(iso + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    },
    monthLabel: function (ym) {
      var p = ym.split('-');
      return new Date(Date.UTC(+p[0], +p[1] - 1, 1))
        .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    },
    monthShort: function (ym) {
      var p = ym.split('-');
      var d = new Date(Date.UTC(+p[0], +p[1] - 1, 1));
      var m = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      return (+p[1] === 1) ? m + " '" + String(p[0]).slice(2) : m;
    },
    beds: function (s) { return s.beds + 'bd · ' + s.baths + 'ba · ' + fmt.int(s.sqft) + ' sqft'; }
  };

  /* --------------------------------------------------------- chart block -- */
  /** Wires the "Show the numbers" toggle that gives every chart a table view. */
  function wireTableToggles(scope) {
    (scope || document).querySelectorAll('[data-table-toggle]').forEach(function (btn) {
      var target = document.getElementById(btn.getAttribute('data-table-toggle'));
      if (!target || btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', target.id);
      btn.addEventListener('click', function () {
        var open = !target.hasAttribute('hidden');
        if (open) { target.setAttribute('hidden', ''); btn.textContent = 'Show the numbers'; }
        else { target.removeAttribute('hidden'); btn.textContent = 'Hide the numbers'; }
        btn.setAttribute('aria-expanded', String(!open));
      });
    });
  }

  /* ---------------------------------------------------------------- nav -- */
  function initChrome() {
    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
    }
    var burger = document.querySelector('[data-nav-burger]');
    var links = document.querySelector('[data-nav-links]');
    if (burger && links) {
      burger.setAttribute('aria-expanded', 'false');
      burger.addEventListener('click', function () {
        var open = links.classList.toggle('is-open');
        burger.setAttribute('aria-expanded', String(open));
      });
    }
    var here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav__links a[href]').forEach(function (a) {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
    });
    document.querySelectorAll('[data-year]').forEach(function (n) { n.textContent = new Date().getFullYear(); });
    wireTableToggles();
  }

  initTheme();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initChrome);
  else initChrome();

  return {
    fmt: fmt, applyTheme: applyTheme, currentTheme: currentTheme,
    wireTableToggles: wireTableToggles
  };
});
