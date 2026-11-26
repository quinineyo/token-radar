// The token radar's model, version radar-2.
//
// One snapshot of the protocol universe goes in, one ranked board comes out.
//
// The board is built on a floor and a radar sweep. The floor is the snapshot's
// watchlist: every slug on it is ranked, whatever its size. The sweep adds every
// rankable pre-token protocol below the watchlist floor, so the early rows — the
// ones this radar exists to find — are all there. A protocol is pre-token when
// its index entry records no token at all: no market cap, no CoinGecko id, no
// symbol. Protocols that already trade are kept apart and shown with the
// market's own values, never mixed into the ranked board.
//
// Implied value comes only from the snapshot's own figures, and the base
// multiple is not a magic constant: it is the market's own pricing, read from
// the snapshot's live-token protocols.
//
//   multiple   the median market-cap / TVL of the live protocols in the same
//              category (at least five of them), else the median across all
//              live protocols; clamped to [0.02, 1.5]. Centralised exchanges
//              are left out of the calibration: exchange tokens price on
//              different economics than the protocols this board ranks.
//   base       tvl_usd x multiple
//   growth     clamp(change_7d, -60, 120) per cent
//   growthMult 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   chainMult  1 + 0.02 x (min(chains, 6) - 1)          (more chains, wider reach)
//   implied    max(1, round(base x growthMult x maturityMult x chainMult))
//
// No protocol name is ever special-cased. The same function scores every row,
// and every row carries the multiple it was scored with and where that multiple
// came from, so the dashboard can show the working and the page can recompute
// any row from the snapshot figures alone.

/* ------------------------------------------------------------------ */
/* The snapshot's shape                                                */
/* ------------------------------------------------------------------ */

/** One protocol entry in the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/* ------------------------------------------------------------------ */
/* The model's constants and version                                   */
/* ------------------------------------------------------------------ */

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max: number;
  multiple_min: number;
  multiple_max: number;
  category_min_live: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_max: 6,
  multiple_min: 0.02,
  multiple_max: 1.5,
  category_min_live: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/* ------------------------------------------------------------------ */
/* The market's own pricing                                            */
/* ------------------------------------------------------------------ */

/** Where one row's base multiple came from. */
export type MultipleSource = 'category' | 'global';

/** The market's own pricing, read from the snapshot's live protocols. */
export interface Multiples {
  /** The median market-cap / TVL across all live, non-exchange protocols. */
  global: number;
  /** How many live protocols that median rests on. */
  global_n: number;
  /** Per category, the median where at least category_min_live live protocols price it. */
  categories: Record<string, { multiple: number; n: number }>;
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when it is empty. */
function middleValue(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Clamp `n` into the model's multiple range. */
function clampMultiple(n: number, model: ModelConstants): number {
  return Math.min(model.multiple_max, Math.max(model.multiple_min, n));
}

/**
 * The market's own pricing from the snapshot: the median market-cap / TVL of
 * the live protocols, per category where enough of them trade, and across all
 * of them otherwise. Centralised exchanges are left out: exchange tokens price
 * on different economics than the protocols this board ranks.
 */
export function deriveMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Multiples {
  const perCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.category === 'CEX') continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.gecko_id === null && p.symbol === null) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everyRatio.push(ratio);
    const key = p.category ?? 'Other';
    const bucket = perCategory.get(key) ?? [];
    bucket.push(ratio);
    perCategory.set(key, bucket);
  }
  everyRatio.sort((a, b) => a - b);
  const overall = middleValue(everyRatio);
  if (overall === null) {
    throw new SnapshotError('snapshot.json has no live protocol with a market cap to price from');
  }
  const categories: Record<string, { multiple: number; n: number }> = {};
  for (const [key, list] of perCategory) {
    if (list.length < model.category_min_live) continue;
    list.sort((a, b) => a - b);
    const m = middleValue(list);
    if (m === null) continue;
    categories[key] = { multiple: clampMultiple(m, model), n: list.length };
  }
  return { global: clampMultiple(overall, model), global_n: everyRatio.length, categories };
}

/** The multiple one protocol is scored with, and where it came from. */
export function multipleFor(
  p: SnapshotProtocol,
  multiples: Multiples,
): { multiple: number; source: MultipleSource; n: number } {
  const key = p.category ?? 'Other';
  const cat = multiples.categories[key];
  if (cat !== undefined) return { multiple: cat.multiple, source: 'category', n: cat.n };
  return { multiple: multiples.global, source: 'global', n: multiples.global_n };
}

/* ------------------------------------------------------------------ */
/* Scoring one protocol                                                */
/* ------------------------------------------------------------------ */

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const end = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((start - end) / DAY_MS));
}

/** The chain-breadth multiplier: wider distribution, slightly more reach. */
export function chainMultiplier(chains: string[], model: ModelConstants): number {
  const count = Math.min(Math.max(chains.length, 1), model.chain_max);
  return 1 + model.chain_step * (count - 1);
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: Multiples,
  model: ModelConstants,
): {
  implied: number;
  multiple: number;
  source: MultipleSource;
  n: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, source, n } = multipleFor(protocol, multiples);
  const growthPct = Math.min(
    model.growth_cap,
    Math.max(model.growth_floor, numOr(protocol.change_7d, 0)),
  );
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) *
      model.maturity_range;
  const chainMult = chainMultiplier(protocol.chains, model);
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return { implied, multiple, source, n, growthPct, growthMult, maturityMult, chainMult, age };
}

/* ------------------------------------------------------------------ */
/* Which protocols the board ranks                                     */
/* ------------------------------------------------------------------ */

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols, keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Round to four decimals, for the multipliers the board and the page both show. */
const to4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  /** The base multiple this row was scored with, and where it came from. */
  multiple: number;
  multiple_source: MultipleSource;
  multiple_n: number;
  chain_multiplier: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    multiple_source: MultipleSource;
    multiple_n: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = deriveMultiples(snapshot, model);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer
  // carries (it cannot, but the board's coverage is the gate's row and is never
  // gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: every rankable pre-token protocol below the watchlist
  // floor. Never a replacement for a watchlist row: a chosen protocol stays
  // chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) {
      chosen.set(p.slug, p);
    }
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples, model);
    return { p, ...v };
  });
  scored.sort(
    (a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    multiple: s.multiple,
    multiple_source: s.source,
    multiple_n: s.n,
    chain_multiplier: to4dp(s.chainMult),
    model: {
      base_multiple: s.multiple,
      growth_pct: s.growthPct,
      growth_multiplier: to4dp(s.growthMult),
      maturity_multiplier: to4dp(s.maturityMult),
      chain_multiplier: to4dp(s.chainMult),
      multiple_source: s.source,
      multiple_n: s.n,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/* ------------------------------------------------------------------ */
/* The farm plan                                                       */
/* ------------------------------------------------------------------ */

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The category actions, as a rule table: the first rule whose keywords appear
 * in the protocol's category wins. The order is the priority, and the default
 * at the end is a plain deposit. No name is special-cased; the words are the
 * same for every protocol in the category.
 */
type ActionWriter = (name: string, amount: number, chain: string) => string;

const ACTION_RULES: Array<{ keys: string[]; write: ActionWriter }> = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    write: (name, amount, chain) =>
      `Supply $${amount} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    write: (name, amount, chain) =>
      `Provide $${amount} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    keys: ['basis'],
    write: (name, amount, chain) =>
      `Deposit $${amount} of USDC into ${name}'s basis vault on ${chain} and keep the shares.`,
  },
  {
    keys: ['bridge'],
    write: (name, amount, chain) =>
      `Bridge $${amount} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    keys: ['staking', 'restak'],
    write: (name, amount, chain) =>
      `Stake $${amount} of the chain's staking asset through ${name} and keep the receipt.`,
  },
  {
    keys: ['perpetual', 'derivative'],
    write: (name, amount, chain) =>
      `Deposit $${amount} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    keys: ['prediction'],
    write: (name, amount, chain) => `Fund $${amount} and place one market position on ${name}.`,
  },
  {
    keys: ['curator', 'allocator'],
    write: (name, amount, chain) =>
      `Deposit $${amount} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    keys: ['stable'],
    write: (name, amount, chain) =>
      `Mint or deposit $${amount} of the stable asset through ${name} on ${chain}.`,
  },
  {
    keys: ['rwa'],
    write: (name, amount, chain) =>
      `Mint $${amount} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    keys: ['insurance'],
    write: (name, amount, chain) =>
      `Buy $${amount} of cover from ${name} on ${chain} and keep the policy.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, amount: number, chain: string): string {
  const lowered = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((key) => lowered.includes(key))) return rule.write(p.name, amount, chain);
  }
  return `Deposit $${amount} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. The last step is a warning,
 * not an action: airdrops are never guaranteed, and nobody legitimate charges
 * to claim one.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const capital = stakeFor(p);
  const hold = holdFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps: FarmStep[] = [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: "Ignore any message offering a guaranteed airdrop, a paid claim link or support asking for your seed phrase: a real claim is free and only on the protocol's own page.",
      cost: 'nothing to check',
      time: '2 minutes',
    },
  ];
  return steps;
}

/* ------------------------------------------------------------------ */
/* The dashboard's data                                                */
/* ------------------------------------------------------------------ */

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  multiple_source: MultipleSource;
  multiple_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  /** Whether this row is on the snapshot's watchlist (the floor) or an early row below it. */
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  multiples: Multiples;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_value_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.multiple,
    multiple_source: row.multiple_source,
    multiple_n: row.multiple_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.chain_multiplier,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const multiples = deriveMultiples(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    multiples,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_value_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
  };
  return { board, radar };
}

/* ------------------------------------------------------------------ */
/* Reading and refusing the snapshot                                   */
/* ------------------------------------------------------------------ */

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (
      typeof p.slug !== 'string' ||
      typeof p.name !== 'string' ||
      typeof p.tvl_usd !== 'number' ||
      !Number.isFinite(p.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd:
        typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
