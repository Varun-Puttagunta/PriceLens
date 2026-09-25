import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = require(join(root, 'assets/js/engine.js'));
const data = require(join(root, 'assets/js/data.js'));

const AS_OF = '2026-09-25';
const subjectOf = (over = {}) => Object.assign({
  id: 'TEST-1', address: '1 Test Ln', city: 'Frisco', lat: 33.1507, lng: -96.8236,
  type: 'Single Family', beds: 4, baths: 3, sqft: 2800, lotSqft: 7500,
  yearBuilt: 2012, garage: 2, stories: 2, pool: false, greenbelt: false, condition: 3
}, over);

/* ------------------------------------------------------------- geometry -- */
test('haversine matches a known distance', () => {
  // Frisco -> Plano city centres, ~9.3 miles apart.
  const d = engine.util.haversineMiles(33.1507, -96.8236, 33.0198, -96.6989);
  assert.ok(d > 8 && d < 12, `expected ~9mi, got ${d.toFixed(2)}`);
  assert.equal(engine.util.haversineMiles(33, -96, 33, -96), 0);
});

/* -------------------------------------------------------- market model --- */
test('hedonic fit recovers a planted trend', () => {
  // Build a market with a known 0.5%/month drift and nothing else moving.
  const sales = [];
  for (let m = 0; m < 30; m++) {
    for (let i = 0; i < 6; i++) {
      const sqft = 1800 + i * 300;
      const price = Math.round(220 * sqft * Math.pow(1.005, m));
      const d = new Date(Date.UTC(2024, m, 10));
      sales.push({
        id: `S${m}-${i}`, city: 'Frisco', type: 'Single Family', lat: 33.15, lng: -96.82,
        beds: 4, baths: 3, sqft, lotSqft: 7000, yearBuilt: 2010, garage: 2,
        pool: false, greenbelt: false, condition: 3,
        saleDate: d.toISOString().slice(0, 10), soldPrice: price, dom: 20
      });
    }
  }
  const fit = engine.fitMarketModel(sales, '2026-09-01');
  assert.equal(fit.fitted, true);
  assert.ok(Math.abs(fit.monthlyRate - 0.005) < 0.001,
    `monthly rate ${fit.monthlyRate} should be ~0.005`);
  assert.ok(fit.r2 > 0.95, `r2 ${fit.r2} should be high on noiseless data`);
});

test('thin markets fall back to prior rates instead of fitting noise', () => {
  const fit = engine.fitMarketModel(data.sales.slice(0, 10), AS_OF);
  assert.equal(fit.fitted, false);
  assert.equal(fit.method, 'prior');
  assert.ok(fit.rates.logSqft > 0);
});

/* ------------------------------------------------------ comp selection --- */
test('comp selection never uses a sale that had not closed yet', () => {
  const asOf = '2025-06-01';
  const { comps } = engine.selectComps(subjectOf(), data.sales, { asOf });
  assert.ok(comps.length > 0);
  for (const c of comps) {
    assert.ok(c.sale.saleDate <= asOf, `${c.sale.saleDate} is after ${asOf}`);
  }
});

test('comp selection excludes the subject and any explicit exclusions', () => {
  const subject = data.sales.find((s) => s.portfolio);
  const other = data.sales.find((s) => s.city === subject.city && s.id !== subject.id);
  const { comps } = engine.selectComps(subject, data.sales, { asOf: AS_OF, excludeIds: [other.id] });
  const ids = comps.map((c) => c.sale.id);
  assert.ok(!ids.includes(subject.id));
  assert.ok(!ids.includes(other.id));
});

test('comps come back ordered by comparability', () => {
  const { comps } = engine.selectComps(subjectOf(), data.sales, { asOf: AS_OF });
  for (let i = 1; i < comps.length; i++) {
    assert.ok(comps[i - 1].similarity >= comps[i].similarity);
  }
});

/* ----------------------------------------------------- adjustment grid --- */
test('an identical comp needs no adjustment', () => {
  const subject = subjectOf();
  const comp = Object.assign({}, subject, { id: 'C1', saleDate: AS_OF, soldPrice: 700000 });
  const fit = engine.fitMarketModel(data.sales, AS_OF);
  const grid = engine.buildAdjustmentGrid(subject, comp, { asOf: AS_OF, trend: fit, rates: fit.rates });
  assert.equal(grid.lines.length, 0);
  assert.equal(grid.netAdjustment, 0);
  assert.equal(grid.adjustedPrice, 700000);
});

test('adjustments move the comp toward the subject, with the right sign', () => {
  const subject = subjectOf({ sqft: 3200, pool: true });
  const comp = Object.assign({}, subjectOf(), { id: 'C1', saleDate: AS_OF, soldPrice: 700000 });
  const fit = engine.fitMarketModel(data.sales, AS_OF);
  const grid = engine.buildAdjustmentGrid(subject, comp, { asOf: AS_OF, trend: fit, rates: fit.rates });

  const gla = grid.lines.find((l) => l.key === 'logSqft');
  const pool = grid.lines.find((l) => l.key === 'pool');
  assert.ok(gla.amount > 0, 'a larger subject adjusts the comp up');
  assert.ok(pool.amount > 0, 'a subject with a pool adjusts the comp up');
  assert.ok(grid.adjustedPrice > 700000);

  // And the mirror image adjusts down by a comparable amount.
  const mirror = engine.buildAdjustmentGrid(comp, Object.assign({}, subject, { id: 'C2', saleDate: AS_OF, soldPrice: 700000 }),
    { asOf: AS_OF, trend: fit, rates: fit.rates });
  assert.ok(mirror.adjustedPrice < 700000);
});

test('an older sale is time-adjusted upward in a rising market', () => {
  const subject = subjectOf();
  const comp = Object.assign({}, subject, { id: 'C1', saleDate: '2025-09-25', soldPrice: 700000 });
  const fit = engine.fitMarketModel(data.sales, AS_OF);
  assert.ok(fit.monthlyRate > 0, 'test market should be appreciating');
  const grid = engine.buildAdjustmentGrid(subject, comp, { asOf: AS_OF, trend: fit, rates: fit.rates });
  assert.ok(grid.timeAdjustment > 0);
  assert.ok(grid.timeAdjusted > 700000);
});

/* ---------------------------------------------------------- valuation ---- */
test('valuation returns a coherent, ordered range', () => {
  const v = engine.valuate(subjectOf(), data.sales, { asOf: AS_OF });
  assert.equal(v.ok, true);
  assert.ok(v.low < v.estimate && v.estimate < v.high);
  assert.ok(v.comps.length >= 3);
  assert.ok(v.psf > 50 && v.psf < 1000, `implausible $/sqft ${v.psf}`);
  assert.ok(['A', 'B', 'C', 'D'].includes(v.confidence.grade));
  const weight = v.comps.reduce((s, c) => s + c.weightShare, 0);
  assert.ok(Math.abs(weight - 1) < 1e-9, 'comp weights must sum to 1');
});

test('the estimate sits inside the spread of its adjusted comps', () => {
  const v = engine.valuate(subjectOf(), data.sales, { asOf: AS_OF });
  const adj = v.comps.map((c) => c.grid.adjustedPrice);
  assert.ok(v.estimate >= Math.min(...adj) && v.estimate <= Math.max(...adj));
});

test('a bigger house in the same place is worth more', () => {
  const small = engine.valuate(subjectOf({ sqft: 2200 }), data.sales, { asOf: AS_OF });
  const large = engine.valuate(subjectOf({ sqft: 3600 }), data.sales, { asOf: AS_OF });
  assert.ok(large.estimate > small.estimate);
});

test('a subject with no reachable comps fails loudly rather than guessing', () => {
  const v = engine.valuate(subjectOf({ lat: -33.8, lng: 151.2 }), data.sales, { asOf: AS_OF });
  assert.equal(v.ok, false);
  assert.ok(v.reason);
});

/* ------------------------------------------------------------ strategy --- */
test('overpricing always costs days on market', () => {
  const dom = (over) => engine.expectedDaysOnMarket(over, 24, 6, 2.6);
  assert.ok(dom(0.05) > dom(0));
  assert.ok(dom(0.10) > dom(0.05));
  assert.ok(dom(0) > dom(-0.03));
  // The absolute penalty means even a fast market punishes overpricing.
  assert.ok(engine.expectedDaysOnMarket(0.06, 8, 6, 2.6) - 8 > 10);
});

test('the recommended price is the one that maximises net proceeds', () => {
  const v = engine.valuate(subjectOf(), data.sales, { asOf: AS_OF });
  const s = engine.strategy(v, { baseDom: engine.baseDomFromComps(v) });
  const bestNet = Math.max(...s.ladder.map((r) => r.net));
  assert.equal(s.recommended.net, bestNet);
  assert.ok(s.ladder.length > 8);
  // Sitting 5% high should never be the better plan in this model.
  assert.ok(s.anchorComparison.netDelta >= 0);
});

test('the ladder is monotone in days on market', () => {
  const v = engine.valuate(subjectOf(), data.sales, { asOf: AS_OF });
  const s = engine.strategy(v, { baseDom: 24 });
  for (let i = 1; i < s.ladder.length; i++) {
    assert.ok(s.ladder[i].dom >= s.ladder[i - 1].dom, 'higher asking price must not sell faster');
    assert.ok(s.ladder[i].listPrice > s.ladder[i - 1].listPrice);
  }
});

test('search-band snapping only moves a price that is just over an edge', () => {
  const band = 25000;
  assert.equal(engine.snapToSearchBand(627000, band).captured, true);
  assert.equal(engine.snapToSearchBand(627000, band).price, 624900);
  // Comfortably inside a band: left alone.
  assert.equal(engine.snapToSearchBand(638000, band).captured, false);
  assert.equal(engine.snapToSearchBand(638000, band).price, 638000);
  // Already below an edge: left alone.
  assert.equal(engine.snapToSearchBand(624000, band).captured, false);
});

/* ------------------------------------------------------------ backtest --- */
test('backtest is strictly out of sample', () => {
  const bt = engine.backtest(data.sales);
  assert.equal(bt.count, 36, 'every portfolio sale should price');
  for (const r of bt.results) {
    for (const c of r.valuation.comps) {
      assert.ok(c.sale.saleDate <= r.sale.listDate, 'comp closed after the subject listed');
      assert.notEqual(c.sale.id, r.sale.id, 'subject used as its own comp');
    }
  }
});

test('backtest accuracy stays within the numbers the site publishes', () => {
  const bt = engine.backtest(data.sales);
  assert.ok(bt.medianAbsError < 0.06, `median abs error ${(bt.medianAbsError * 100).toFixed(2)}% regressed`);
  assert.ok(bt.within10 > 0.80, `within-10% rate ${(bt.within10 * 100).toFixed(0)}% regressed`);
  assert.ok(bt.rangeHitRate > 0.70, `coverage ${(bt.rangeHitRate * 100).toFixed(0)}% regressed`);
  assert.ok(Math.abs(bt.medianSignedError) < 0.03, 'model has developed a directional bias');
});

/* ---------------------------------------------------------- dataset ------ */
test('the published portfolio headline is exactly what the data says', () => {
  const portfolio = data.sales.filter((s) => s.portfolio);
  assert.equal(portfolio.length, 36);
  assert.equal(portfolio.reduce((s, x) => s + x.soldPrice, 0), 21_800_000);
  assert.equal(data.meta.portfolioCount, 36);
  assert.equal(data.meta.portfolioVolume, 21_800_000);
});

test('every sale record is internally consistent', () => {
  for (const s of data.sales) {
    assert.ok(s.soldPrice > 0 && s.sqft > 0, `${s.id} has no price or size`);
    assert.ok(s.listDate <= s.saleDate, `${s.id} closed before it listed`);
    assert.ok(s.listPrice <= s.originalListPrice, `${s.id} raised its price`);
    assert.ok(s.dom >= 0 && s.dom <= 200);
    assert.ok(s.beds >= 1 && s.baths >= 1);
  }
});
