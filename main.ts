// Token Radar v2 — a comps-fitted launch radar for token-radar-01.
//
// The program reads the sealed DefiLlama snapshot, prices every pre-token
// protocol off the tokens that already trade, and writes a ranked board, a
// static dashboard, screenshots and the judge's dossier.
//
// How a protocol is priced (nothing here names a protocol by hand):
//
//   1. The comparables are the snapshot's own live-token protocols, filtered
//      to the ones a pre-token protocol can resemble: no CEX, no bridge, no
//      liquid-staking product, no versioned pool, no wrapped or staked name.
//      This snapshot gives 92 of them.
//   2. A size curve is fitted on them by least squares in logs:
//      log10(market cap) = a + b * log10(TVL). The curve is refitted from
//      the snapshot on every run; the constants below are only the small
//      adjustments applied after the curve, not the curve itself.
//   3. The curve value is moved by the protocol's own seven-day TVL growth
//      (clamped, lightly weighted) and by how long it has run with no token
//      (older runs a little dearer). Both adjustments are bounded so the
//      curve, not the tweak, does the pricing.
//   4. The curve is tested blind before it prices anything: protocols
//      listed before 2025-01-01 fit the curve, protocols listed after it
//      are predicted, and the median miss is reported. The confidence band
//      around every implied value is that median miss, up and down.
//   5. A farm plan is costed at the band's low end: the airdrop is assumed
//      to be 7% of the implied value, shared among the farmers, who are
//      assumed to hold 2% of the protocol's TVL; the plan's gas is $32.
//      Net value decides the verdict: farm at $20 or more, thin at $0 or
//      more, skip below $0. Every assumption is printed on the dashboard,
//      so a reader can re-price the board under their own.
//
// The board ranks all 198 rankable pre-token protocols: the 40 on the
// watchlist plus the 158 below its floor that pass the same exclusions.
// Live-token protocols never enter the ranked board; they are the comps,
// shown on their own page with their market values.
//
// Run it outside the grader with:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Node 22, standard library only. Deterministic: no clock, no randomness
// except a fixed-seed shuffle for the cross-validation folds.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------- tuning
// Small bounded adjustments applied after the fitted curve. The curve
// itself is fitted from the snapshot; these only tilt it.
const GROWTH_WEIGHT = 0.15; // each point of clamped 7-day growth moves value 0.15%
const GROWTH_LOW = -60; // clamps the 7-day change, in per cent
const GROWTH_HIGH = 120;
const MATURITY_LOW = 0.9; // the youngest protocol's maturity factor
const MATURITY_HIGH = 1.1; // the oldest protocol's maturity factor
const MATURITY_DAYS = 1095; // maturity stops rising after 3 years
const AGE_WHEN_UNKNOWN = 365; // days assumed when listed_at is missing
const BLIND_CUT = '2025-01-01'; // the blind test's train/test split date
const CV_FOLDS = 5; // folds for the cross-validation check
const CV_SEED = 20261114; // fixed seed: the folds are the same every run

// Farm economics, all stated on the dashboard next to the numbers.
const AIRDROP_SHARE = 0.07; // 7% of the implied value goes to the airdrop
const FARMER_TVL_SHARE = 0.02; // active farmers are assumed to hold 2% of TVL
const GAS_BUDGET_USD = 32; // $8 setup + $16 weekly actions + $4 exit + $4 buffer
const FARM_MIN_NET_USD = 20; // farm at this net value or more
const THIN_MIN_NET_USD = 0; // thin at this net value or more, else skip

// The dossier's caps, as the kit's gate states them.
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- snapshot
interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapError('snapshot has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapError('snapshot has no watchlist');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- filters
// A name ending in a release marker is a pool of another protocol, not a
// protocol of its own.
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
// Categories that are a wrapped, staked or bridged product of a token that
// already trades, or an exchange: never a launch of their own.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function isLaunchCandidate(p: Proto): boolean {
  return hasNoToken(p) && !EXCLUDED_CATEGORIES.has(p.category ?? '') && !VERSIONED_NAME.test(p.name) && !WRAPPED_WORD.test(p.name);
}

// A live-token protocol the curve may learn from: it trades, and it is the
// kind of protocol a pre-token one can resemble.
function isComparable(p: Proto): boolean {
  return (
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0 &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED_NAME.test(p.name) &&
    !WRAPPED_WORD.test(p.name)
  );
}

function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---------------------------------------------------------------- the curve
interface SizeCurve {
  intercept: number;
  slope: number;
  n: number;
  rSquared: number;
  residualSd: number;
}

// Least squares on log10(market cap) against log10(TVL).
function fitSizeCurve(comps: Proto[]): SizeCurve {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const n = comps.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - meanX) ** 2;
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i]! - meanY) ** 2;
    ssRes += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  }
  return {
    intercept,
    slope,
    n,
    rSquared: 1 - ssRes / ssTot,
    residualSd: Math.sqrt(ssRes / Math.max(1, n - 2)),
  };
}

function curveValue(curve: SizeCurve, tvlUsd: number): number {
  return 10 ** (curve.intercept + curve.slope * Math.log10(tvlUsd));
}

function growthFactor(p: Proto): number {
  const g = Math.min(GROWTH_HIGH, Math.max(GROWTH_LOW, asNumber(p.change_7d, 0)));
  return 1 + (g / 100) * GROWTH_WEIGHT;
}

function maturityFactor(age: number | null): number {
  const days = age ?? AGE_WHEN_UNKNOWN;
  const span = MATURITY_HIGH - MATURITY_LOW;
  return MATURITY_LOW + (Math.min(Math.max(days, 0), MATURITY_DAYS) / MATURITY_DAYS) * span;
}

// The whole pricing pipeline: curve, then the two bounded tilts.
function pricedValue(curve: SizeCurve, p: Proto, asOf: string): { value: number; curve: number; growth: number; maturity: number; age: number | null } {
  const age = ageInDays(asOf, p.listed_at);
  const base = curveValue(curve, p.tvl_usd);
  const growth = growthFactor(p);
  const maturity = maturityFactor(age);
  return { value: Math.max(1, Math.round(base * growth * maturity)), curve: base, growth, maturity, age };
}

// ---------------------------------------------------------------- blind test
interface BlindTest {
  cut: string;
  trainN: number;
  testN: number;
  medianMultiple: number;
  withinTwoX: number;
  rmseLog10: number;
  cvMedianMultiple: number;
  cvFolds: number;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// The curve is fitted on protocols listed before the cut and asked to price
// the ones listed after it, through the same pipeline the board uses. The
// cross-validation repeats the same question on five shuffled folds.
function blindTest(comps: Proto[], asOf: string): BlindTest {
  const dated = comps.filter((p) => p.listed_at !== null);
  const train = dated.filter((p) => p.listed_at! < BLIND_CUT);
  const test = dated.filter((p) => p.listed_at! >= BLIND_CUT);
  const curve = fitSizeCurve(train);
  const errors = test.map((p) => Math.log10(p.mcap_usd!) - Math.log10(pricedValue(curve, p, asOf).value));
  const absErrors = errors.map(Math.abs);
  const medianMultiple = 10 ** medianOf(absErrors);
  const withinTwoX = test.length === 0 ? 0 : errors.filter((e) => Math.abs(e) <= Math.log10(2)).length / test.length;
  const rmseLog10 = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / Math.max(1, errors.length));

  // Five-fold cross-validation on a fixed-seed shuffle, same pipeline.
  let state = CV_SEED;
  const nextRand = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const order = comps.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const foldErrors: number[] = [];
  for (let k = 0; k < CV_FOLDS; k++) {
    const testIdx = new Set(order.filter((_, i) => i % CV_FOLDS === k));
    const foldTrain = comps.filter((_, i) => !testIdx.has(i));
    const foldTest = comps.filter((_, i) => testIdx.has(i));
    const foldCurve = fitSizeCurve(foldTrain);
    for (const p of foldTest) foldErrors.push(Math.abs(Math.log10(p.mcap_usd!) - Math.log10(pricedValue(foldCurve, p, asOf).value)));
  }
  return {
    cut: BLIND_CUT,
    trainN: train.length,
    testN: test.length,
    medianMultiple: round4(medianMultiple),
    withinTwoX: round4(withinTwoX),
    rmseLog10: round4(rmseLog10),
    cvMedianMultiple: round4(10 ** medianOf(foldErrors)),
    cvFolds: CV_FOLDS,
  };
}

// ---------------------------------------------------------------- farm plans
interface FarmEconomics {
  capitalUsd: number;
  grossUsd: number;
  costUsd: number;
  netUsd: number;
  verdict: 'farm' | 'thin' | 'skip';
}

// The capital a position needs, from the protocol's own TVL.
function capitalFor(p: Proto): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 100;
}

// How long to hold, from the protocol's age: younger runs get a longer
// qualifying window.
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

// The plan's money, costed at the confidence band's low end: the airdrop
// pool is the assumed share of the low-end value, and the farmer's cut of
// it is their capital over the farmers' assumed share of TVL.
function farmEconomics(p: Proto, lowValueUsd: number): FarmEconomics {
  const capital = capitalFor(p);
  const farmerPool = FARMER_TVL_SHARE * p.tvl_usd;
  const gross = AIRDROP_SHARE * lowValueUsd * (capital / farmerPool);
  const net = gross - GAS_BUDGET_USD;
  const verdict: FarmEconomics['verdict'] = net >= FARM_MIN_NET_USD ? 'farm' : net >= THIN_MIN_NET_USD ? 'thin' : 'skip';
  return { capitalUsd: capital, grossUsd: Math.round(gross), costUsd: GAS_BUDGET_USD, netUsd: Math.round(net), verdict };
}

interface Step {
  text: string;
  cost: string;
  time: string;
}

function stepText(step: Step): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

// The one action the category calls for, in words a farmer can follow.
function coreAction(p: Proto, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} on ${chain} and leave the loan open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to the main pool of ${name} on ${chain} and leave it there.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC into ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in a market on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset of ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

// Eight steps, each an action with what it costs and how long it takes.
// The gas figures add to the plan's $32 budget: $8 to set up, $16 across
// eight weekly actions, $4 to exit, $4 of buffer.
function farmPlan(p: Proto, econ: FarmEconomics, age: number | null): Step[] {
  const chain = firstChain(p);
  const capital = econ.capitalUsd;
  const hold = holdDaysFor(age);
  const expected = econ.netUsd >= 0 ? `$${econ.netUsd} net` : `a $${-econ.netUsd} loss`;
  return [
    { text: 'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'no funds moved yet', time: '5 minutes' },
    { text: `Move $${capital} of USDC into the fresh wallet on ${chain}.`, cost: 'about $2 of gas', time: '10 minutes' },
    { text: coreAction(p, capital, chain), cost: `$${capital} of capital and about $6 of gas`, time: '15 minutes to set up' },
    { text: 'Do one qualifying action each week: a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week, $16 over eight weeks', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days, so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: 'Before you withdraw, open the protocol\u2019s own points or rewards page and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Add up the gas you have spent against the ${expected} this plan expects; if gas passes $${econ.costUsd}, stop the weekly actions.`, cost: 'nothing but the tally', time: '5 minutes' },
    { text: 'Write the wallet, the dates and every transaction in a farm log, then unwind in one withdrawal when the window closes.', cost: 'about $4 of gas to exit', time: '10 minutes' },
  ];
}

// ---------------------------------------------------------------- the board
interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  curve_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_capital_usd: number;
  expected_gross_usd: number;
  farm_cost_usd: number;
  net_usd: number;
  verdict: 'farm' | 'thin' | 'skip';
  farm_steps: string[];
}

interface CompRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  fitted_usd: number;
  multiple: number;
}

interface ModelReport {
  version: string;
  comps: number;
  intercept: number;
  slope: number;
  r_squared: number;
  residual_sd_log10: number;
  blind: BlindTest;
  band_multiple: number;
  airdrop_share: number;
  farmer_tvl_share: number;
  gas_budget_usd: number;
  farm_min_net_usd: number;
  thin_min_net_usd: number;
  growth_weight: number;
  maturity_low: number;
  maturity_high: number;
}

interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelReport;
  watchlist_size: number;
  board_size: number;
  verdicts: { farm: number; thin: number; skip: number };
  rows: BoardRow[];
  comps: CompRow[];
}

const MODEL_VERSION = 'radar-2 comps-fitted';

// Every watchlist slug, plus every other launch candidate below the floor:
// the watchlist is the floor, never the ceiling.
function buildBoard(snapshot: Snap): { rows: BoardRow[]; data: RadarData } {
  const comps = snapshot.protocols.filter(isComparable);
  const curve = fitSizeCurve(comps);
  const blind = blindTest(comps, snapshot.as_of);
  const band = blind.medianMultiple;

  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isLaunchCandidate(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const priced = pricedValue(curve, p, snapshot.as_of);
    const low = Math.max(1, Math.round(priced.value / band));
    const high = Math.round(priced.value * band);
    const econ = farmEconomics(p, low);
    return { p, priced, low, high, econ };
  });
  scored.sort((a, b) => b.priced.value - a.priced.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const rows: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.priced.age,
    token_status: 'pre-token',
    implied_value_usd: s.priced.value,
    implied_low_usd: s.low,
    implied_high_usd: s.high,
    curve_value_usd: Math.round(s.priced.curve),
    growth_multiplier: round4(s.priced.growth),
    maturity_multiplier: round4(s.priced.maturity),
    farm_capital_usd: s.econ.capitalUsd,
    expected_gross_usd: s.econ.grossUsd,
    farm_cost_usd: s.econ.costUsd,
    net_usd: s.econ.netUsd,
    verdict: s.econ.verdict,
    farm_steps: farmPlan(s.p, s.econ, s.priced.age).map(stepText),
  }));

  const compRows: CompRow[] = comps
    .map((p) => {
      const fitted = Math.round(curveValue(curve, p.tvl_usd));
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        mcap_usd: p.mcap_usd!,
        fitted_usd: fitted,
        multiple: round4(p.mcap_usd! / Math.max(1, fitted)),
      };
    })
    .sort((a, b) => b.multiple - a.multiple || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const verdicts = { farm: 0, thin: 0, skip: 0 };
  for (const r of rows) verdicts[r.verdict]++;

  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      version: MODEL_VERSION,
      comps: comps.length,
      intercept: round4(curve.intercept),
      slope: round4(curve.slope),
      r_squared: round4(curve.rSquared),
      residual_sd_log10: round4(curve.residualSd),
      blind,
      band_multiple: band,
      airdrop_share: AIRDROP_SHARE,
      farmer_tvl_share: FARMER_TVL_SHARE,
      gas_budget_usd: GAS_BUDGET_USD,
      farm_min_net_usd: FARM_MIN_NET_USD,
      thin_min_net_usd: THIN_MIN_NET_USD,
      growth_weight: GROWTH_WEIGHT,
      maturity_low: MATURITY_LOW,
      maturity_high: MATURITY_HIGH,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    verdicts,
    rows,
    comps: compRows,
  };
  return { rows, data };
}

// Why a board is not one the gate will take, or null.
function boardIssue(rows: BoardRow[], snapshot: Snap): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return 'every row shares one implied value: a board that ranks nothing';
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// ---------------------------------------------------------------- the run
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
const { rows, data } = buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(data)};\n`);

// Copy one directory's regular files into `to`, skipping dot-names.
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output
// and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const m = data.model;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${rows.length} rows scored (${data.verdicts.farm} farm, ${data.verdicts.thin} thin, ${data.verdicts.skip} skip)\n` +
    `token radar: curve fitted on ${m.comps} comps: log10(mcap) = ${m.intercept} + ${m.slope} * log10(TVL), R2 = ${m.r_squared}\n` +
    `token radar: blind test (train < ${m.blind.cut}, n=${m.blind.trainN}; test >= ${m.blind.cut}, n=${m.blind.testN}): median miss x${m.blind.medianMultiple}, ${Math.round(m.blind.withinTwoX * 100)}% within 2x; 5-fold CV median miss x${m.blind.cvMedianMultiple}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
