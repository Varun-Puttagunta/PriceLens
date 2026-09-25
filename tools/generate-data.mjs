/**
 * Generates assets/js/data.js — the synthetic market book the demo runs on.
 *
 * Sales are drawn from a hedonic model (submarket $/sqft × market index × feature
 * contributions × noise). The valuation engine in assets/js/engine.js approximates
 * that model with different constants, so backtest error lands where a real CMA
 * lands (~4–6% median) instead of at zero.
 *
 * Deterministic: same seed in, same file out. Re-run with `npm run data`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'js', 'data.js');

const PORTFOLIO_COUNT = 36;
const PORTFOLIO_VOLUME = 21_800_000;
const MARKET_SALES = 620; // background comps, on top of the 36 portfolio sales
// The firm's listings start a year into the window. A comp search run on the
// first of them still needs twelve months of closed sales behind it, exactly as
// it would against a real MLS.
const HISTORY_MONTHS = 12;

/* ---------------------------------------------------------------- rng ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260925);
const uniform = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
function gauss(mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------ submarkets -- */
// basePsf is the submarket's $/sqft for a 2,600 sqft benchmark home at index 1.00.
const SUBMARKETS = [
  { name: 'Frisco',      basePsf: 268, lat: 33.1507, lng: -96.8236, weight: 0.24, streets: ['Rockbrook', 'Lebanon Ridge', 'Panther Creek', 'Shaddock Park', 'Cobblestone'] },
  { name: 'Prosper',     basePsf: 281, lat: 33.2362, lng: -96.8011, weight: 0.11, streets: ['Whitley Place', 'Star Trail', 'Windsong Ranch', 'Lakes of La Cima'] },
  { name: 'Plano',       basePsf: 254, lat: 33.0198, lng: -96.6989, weight: 0.21, streets: ['Willow Bend', 'Deerfield', 'Hunters Glen', 'Legacy Trail', 'Kings Ridge'] },
  { name: 'Allen',       basePsf: 243, lat: 33.1032, lng: -96.6706, weight: 0.16, streets: ['Twin Creeks', 'Bethany Lakes', 'Cottonwood Bend', 'Watters Branch'] },
  { name: 'McKinney',    basePsf: 231, lat: 33.1972, lng: -96.6153, weight: 0.18, streets: ['Stonebridge Ranch', 'Craig Ranch', 'Adriatica', 'Eldorado Heights'] },
  { name: 'Little Elm',  basePsf: 213, lat: 33.1626, lng: -96.9375, weight: 0.10, streets: ['Frisco Hills', 'Sunset Pointe', 'Paloma Creek', 'Lakeside Estates'] },
];
function drawSubmarket() {
  let r = rnd(), acc = 0;
  for (const s of SUBMARKETS) { acc += s.weight; if (r <= acc) return s; }
  return SUBMARKETS[SUBMARKETS.length - 1];
}

/* ---------------------------------------------------------- market index -- */
// Month 0 = 2024-01. The index is normalised so the final month == 1.000,
// which makes basePsf above read as "today's price".
const FIRST_YEAR = 2024, FIRST_MONTH = 0, MONTHS = 33;   // 2024-01 .. 2026-09
const rawIndex = (m) => {
  const trend = 1 + 0.00315 * m;                       // ~3.8%/yr appreciation
  const cal = (FIRST_MONTH + m) % 12;                  // 0 = Jan
  const seasonal = 1 + 0.0125 * Math.cos(((cal - 4) / 12) * 2 * Math.PI); // peaks May–Jun
  return trend * seasonal;
};
const NORM = rawIndex(MONTHS - 1);
const marketIndex = (m) => rawIndex(m) / NORM;

function monthToDate(m, dayOfMonth) {
  const y = FIRST_YEAR + Math.floor((FIRST_MONTH + m) / 12);
  const mo = (FIRST_MONTH + m) % 12;
  const d = new Date(Date.UTC(y, mo, dayOfMonth));
  return d.toISOString().slice(0, 10);
}
const monthKey = (m) => monthToDate(m, 1).slice(0, 7);

/* ------------------------------------------------------- property drawing -- */
const TYPES = [
  { name: 'Single Family', p: 0.78, psfAdj: 1.0,  sqft: [1780, 4650], lotMult: [0.75, 1.9],  garage: [2, 3] },
  { name: 'Townhome',      p: 0.14, psfAdj: 0.93, sqft: [1420, 2450], lotMult: [0.14, 0.26], garage: [2, 2] },
  { name: 'Condo',         p: 0.08, psfAdj: 0.88, sqft: [960, 1850],  lotMult: [0, 0],       garage: [1, 2] },
];
function drawType() {
  let r = rnd(), acc = 0;
  for (const t of TYPES) { acc += t.p; if (r <= acc) return t; }
  return TYPES[0];
}

const CONDITION_LABELS = { 1: 'Dated', 2: 'Fair', 3: 'Average', 4: 'Updated', 5: 'Renovated' };

function drawProperty(id, submarket) {
  const type = drawType();
  const sqft = Math.round(uniform(type.sqft[0], type.sqft[1]) / 10) * 10;
  const beds = type.name === 'Condo'
    ? clamp(Math.round(sqft / 620), 1, 3)
    : clamp(Math.round(sqft / 760) + (chance(0.3) ? 1 : 0), 3, 6);
  // Bath count needs variation that size alone doesn't explain — otherwise it is
  // a deterministic function of sqft, and no regression can price it separately.
  const baths = clamp(Math.round((beds * 0.62 + (sqft / 2400) + gauss(0, 0.5)) * 2) / 2, 1, 5.5);
  const garage = Math.round(uniform(type.garage[0], type.garage[1] + 0.49));
  const benchLot = type.name === 'Condo' ? 0 : Math.round(sqft * uniform(type.lotMult[0], type.lotMult[1]) + 2400);
  const lotSqft = type.name === 'Condo' ? 0 : Math.round(benchLot / 50) * 50;
  const yearBuilt = clamp(Math.round(gauss(2006, 11)), 1978, 2025);
  const condition = clamp(Math.round(gauss(yearBuilt > 2016 ? 4.1 : 3.2, 0.85)), 1, 5);
  const pool = type.name === 'Single Family' && chance(0.21);
  const greenbelt = chance(0.17);
  const stories = type.name === 'Condo' ? 1 : (sqft > 3000 ? 2 : (chance(0.45) ? 2 : 1));
  const street = pick(submarket.streets);
  const number = Math.round(uniform(100, 9900));
  const suffix = pick(['Dr', 'Ln', 'Ct', 'Trl', 'Way', 'Blvd']);

  return {
    id,
    address: `${number} ${street} ${suffix}`,
    city: submarket.name,
    lat: +(submarket.lat + gauss(0, 0.017)).toFixed(5),
    lng: +(submarket.lng + gauss(0, 0.019)).toFixed(5),
    type: type.name,
    beds, baths, sqft, lotSqft, yearBuilt, garage, stories,
    pool, greenbelt, condition,
    conditionLabel: CONDITION_LABELS[condition],
  };
}

/* ------------------------------------------------------- hedonic pricing -- */
// The "true" market value of a property at a given month. The engine never sees
// these constants — it re-estimates them from comps.
function intrinsicValue(p, m) {
  const sub = SUBMARKETS.find((s) => s.name === p.city);
  const type = TYPES.find((t) => t.name === p.type);
  const sizeAdj = Math.pow(2600 / p.sqft, 0.175);        // bigger homes, lower $/sqft
  const psf = sub.basePsf * marketIndex(m) * sizeAdj * type.psfAdj;
  let v = psf * p.sqft;
  v += (p.lotSqft - p.sqft * 1.05) * 6.4;                // land above the pad
  v += (p.garage - 2) * 8600;
  v += (p.beds - Math.round(p.sqft / 760)) * 5200;
  v += (p.baths - Math.round((p.sqft / 900) * 2) / 2) * 7400;
  v += (p.yearBuilt - 2006) * 940;
  v += (p.condition - 3) * 0.036 * (psf * p.sqft);
  v += p.pool ? 23500 : 0;
  v += p.greenbelt ? 14800 : 0;
  return v;
}

/* --------------------------------------------------- listing & sale model -- */
// Given a list price relative to intrinsic value, how does the market respond?
// Overpricing costs time first, then price: listings that sit take cuts and
// settle below where a correctly-priced listing would have landed.
function simulateSale(value, listPrice, m, seedNoise) {
  const over = listPrice / value - 1;                      // +0.06 = 6% above value
  const seasonDemand = 1 + 0.10 * Math.cos((((FIRST_MONTH + m) % 12) - 4) / 12 * 2 * Math.PI);
  const baseDom = 21 / seasonDemand;
  let dom = baseDom * Math.exp(6.1 * Math.max(over, -0.04)) * Math.exp(gauss(0, 0.28));
  dom = clamp(Math.round(dom), 2, 190);

  const cuts = over <= 0.015 ? (dom > 45 && chance(0.2) ? 1 : 0)
    : clamp(Math.floor((dom - 25) / 26) + (over > 0.05 ? 1 : 0), 0, 3);

  // Buyers pay close to value; a fresh listing captures a small urgency premium,
  // a stale one concedes. Cuts cost real money on top of that.
  const freshness = clamp(1.018 - dom * 0.00042, 0.975, 1.018);
  const cutDrag = 1 - cuts * 0.0125;
  let sold = value * freshness * cutDrag * (1 + seedNoise * 0.4);
  sold = Math.min(sold, listPrice * (over > 0.02 ? 0.995 : 1.022));
  return { dom, cuts, sold };
}

// Sellers and agents don't list at $612,418 — they list on a marketing number.
function marketingPrice(raw) {
  if (raw >= 1_000_000) return Math.round(raw / 25_000) * 25_000 - 1000;
  if (raw >= 400_000) return Math.round(raw / 5_000) * 5_000 - 1000;
  return Math.round(raw / 2_500) * 2_500 - 1000;
}

/* ------------------------------------------------------------ generation -- */
const sales = [];
let idSeq = 1;

function makeSale({ portfolio, month, agentBand }) {
  const sub = drawSubmarket();
  const p = drawProperty(`PL-${String(idSeq++).padStart(4, '0')}`, sub);
  const listDay = Math.round(uniform(1, 27));
  const listDate = monthToDate(month, listDay);
  const value = intrinsicValue(p, month);
  const noise = gauss(0, 0.042);
  const trueValue = value * (1 + noise);

  // How far off the seller's list price was. PriceLens listings hug value;
  // pre-tool and background listings scatter wider and skew high.
  const over = agentBand();
  const originalList = marketingPrice(trueValue * (1 + over));
  const { dom, cuts, sold } = simulateSale(trueValue, originalList, month, noise);

  const listPrice = cuts === 0 ? originalList : marketingPrice(originalList * (1 - cuts * 0.019));
  const soldPrice = Math.round(Math.min(sold, listPrice * 1.022) / 500) * 500;
  const saleDateObj = new Date(Date.UTC(FIRST_YEAR + Math.floor((FIRST_MONTH + month) / 12), (FIRST_MONTH + month) % 12, listDay));
  saleDateObj.setUTCDate(saleDateObj.getUTCDate() + dom + Math.round(uniform(21, 38))); // DOM + close

  return {
    ...p,
    listDate,
    saleDate: saleDateObj.toISOString().slice(0, 10),
    saleMonth: month,
    originalListPrice: originalList,
    listPrice,
    soldPrice,
    dom,
    priceCuts: cuts,
    portfolio: !!portfolio,
  };
}

/* Background market comps, spread across the whole window. */
for (let i = 0; i < MARKET_SALES; i++) {
  const month = Math.floor(uniform(0, MONTHS - 0.5));
  sales.push(makeSale({
    portfolio: false,
    month,
    agentBand: () => clamp(gauss(0.031, 0.037), -0.05, 0.14),
  }));
}

/* The firm's own 36 listings, all inside the last 21 months. The tool goes
 * live 8 months into the engagement. */
const TOOL_START_MONTH = HISTORY_MONTHS + 8;
const portfolioMonths = [];
for (let i = 0; i < PORTFOLIO_COUNT; i++) {
  // 13 before the tool, 23 after — the adoption story in the data.
  portfolioMonths.push(i < 13
    ? Math.floor(uniform(HISTORY_MONTHS, TOOL_START_MONTH))
    : Math.floor(uniform(TOOL_START_MONTH, MONTHS - 0.5)));
}
portfolioMonths.sort((a, b) => a - b);

const portfolio = portfolioMonths.map((month) => {
  const usedTool = month >= TOOL_START_MONTH;
  const sale = makeSale({
    portfolio: true,
    month,
    agentBand: usedTool
      ? () => clamp(gauss(0.012, 0.014), -0.02, 0.05)   // tool-guided: tight, near value
      : () => clamp(gauss(0.045, 0.034), -0.02, 0.15),  // pre-tool: optimistic, scattered
  });
  sale.pricedWith = usedTool ? 'pricelens' : 'manual';
  return sale;
});

/* Calibrate the whole market so the firm's 36 sales total exactly $21.8M.
 * Scaling only the portfolio would leave it sitting off the market the engine
 * learns from, and every backtest would inherit that as bias. */
const rawTotal = portfolio.reduce((s, x) => s + x.soldPrice, 0);
const scale = PORTFOLIO_VOLUME / rawTotal;
const scalePrices = (s) => {
  const f = (v) => Math.round((v * scale) / 500) * 500;
  s.soldPrice = f(s.soldPrice);
  s.listPrice = f(s.listPrice);
  s.originalListPrice = f(s.originalListPrice);
};
sales.forEach(scalePrices);
portfolio.forEach(scalePrices);
let drift = PORTFOLIO_VOLUME - portfolio.reduce((s, x) => s + x.soldPrice, 0);
// Push the rounding remainder onto the largest sales, 500 at a time.
const bySize = [...portfolio].sort((a, b) => b.soldPrice - a.soldPrice);
let k = 0;
while (drift !== 0) {
  const step = drift > 0 ? 500 : -500;
  bySize[k % bySize.length].soldPrice += step;
  drift -= step;
  k++;
}

sales.push(...portfolio);
sales.sort((a, b) => a.saleDate.localeCompare(b.saleDate));

/* ------------------------------------------------------------- summaries -- */
const finalVolume = portfolio.reduce((s, x) => s + x.soldPrice, 0);
if (finalVolume !== PORTFOLIO_VOLUME) throw new Error(`volume mismatch: ${finalVolume}`);

const indexSeries = Array.from({ length: MONTHS }, (_, m) => ({
  month: monthKey(m),
  index: +marketIndex(m).toFixed(4),
}));

const meta = {
  generatedAt: '2026-09-25',
  marketName: 'North Dallas Collin County',
  submarkets: SUBMARKETS.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
  portfolioCount: PORTFOLIO_COUNT,
  portfolioVolume: PORTFOLIO_VOLUME,
  windowStart: monthToDate(0, 1),
  engagementStart: monthToDate(HISTORY_MONTHS, 1),
  windowEnd: monthToDate(MONTHS - 1, 28),
  toolLiveMonth: monthKey(TOOL_START_MONTH),
};

const banner = `/**
 * PriceLens AI — market dataset  (generated file, do not edit by hand)
 *
 * Produced by tools/generate-data.mjs on ${meta.generatedAt}.
 *
 * SAMPLE DATA. Every address, coordinate and transaction below is synthetic,
 * drawn from a hedonic model of the ${meta.marketName} market. Real client
 * transactions are not published. Portfolio totals are set to the engagement's
 * real headline figures (${PORTFOLIO_COUNT} properties / $${(PORTFOLIO_VOLUME / 1e6).toFixed(1)}M) so the
 * dashboard reads true at the top line.
 */`;

const body = `${banner}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.PriceLens = root.PriceLens || {}).data = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var META = ${JSON.stringify(meta, null, 2).split('\n').join('\n  ')};

  var MARKET_INDEX = ${JSON.stringify(indexSeries)};

  var SALES = ${JSON.stringify(sales, null, 1).split('\n').join('\n  ')};

  return { meta: META, sales: SALES, marketIndex: MARKET_INDEX };
});
`;

writeFileSync(OUT, body);

const psf = sales.map((s) => s.soldPrice / s.sqft);
console.log(`wrote ${OUT}`);
console.log(`  sales:            ${sales.length} (${portfolio.length} portfolio)`);
console.log(`  portfolio volume: $${finalVolume.toLocaleString()}`);
console.log(`  avg sale price:   $${Math.round(finalVolume / portfolio.length).toLocaleString()}`);
console.log(`  $/sqft range:     $${Math.round(Math.min(...psf))}–$${Math.round(Math.max(...psf))}`);
console.log(`  median DOM:       ${sales.map((s) => s.dom).sort((a, b) => a - b)[Math.floor(sales.length / 2)]}`);
