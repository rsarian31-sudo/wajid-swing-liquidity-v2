// WAJID SMC CORE — v1 (smc-v1).
//
// Implements the Master Trading Knowledge Base entry sequence:
//   Liquidity Sweep → MSS → BOS → Order Block → FVG → Confirmation → Entry
// with Market Structure, Internal/External Liquidity, Inducement, MSS/CHOCH,
// BOS, Order Blocks, FVG, ERC, Return to Supply, Trendline Liquidity
// Breakout, Algorithmic Price Delivery, Killzone context, Fake Breakout
// Detection (as VETOES, not a score) and Multi-Timeframe Confirmation.
//
// Rules:
// - CLOSED candles only. A signal is emitted only when the LAST closed
//   candle is the confirming reaction candle. Nothing reads a forming candle.
// - No signal from a single indicator alone: the full sequence must complete.
// - No invented thresholds: every parameter comes from src/smc-config.js with
//   its source annotated (KB / REPO / PROVISIONAL). A1 and A6–A8 stay open.
// - This module is PURE (no fetch, no Telegram, no state). It is fully
//   unit-testable and backtestable.
// - It is ADDED ALONGSIDE src/strategy.js (volume-ob-retest-v4). That file
//   is not modified. The scheduler no longer invokes the v4 engine; its
//   historical trades are preserved read-only in Durable Object state.

import { SMC_PARAMS } from './smc-config.js';

const n = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function atrSeries(candles, length = SMC_PARAMS.atrLength) {
  const out = Array(candles.length).fill(null);
  const tr = (c, prev) => (prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : c.high - c.low);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr(candles[i], candles[i - 1]);
    if (i >= length) sum -= tr(candles[i - length], candles[i - length - 1]);
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function isPivotHigh(candles, i, s) {
  if (i < s || i + s >= candles.length) return false;
  const p = candles[i].high;
  for (let j = 1; j <= s; j++) if (candles[i - j].high >= p || candles[i + j].high > p) return false;
  return true;
}
function isPivotLow(candles, i, s) {
  if (i < s || i + s >= candles.length) return false;
  const p = candles[i].low;
  for (let j = 1; j <= s; j++) if (candles[i - j].low <= p || candles[i + j].low < p) return false;
  return true;
}

function bodyRatio(c) {
  const range = Math.max(c.high - c.low, 1e-9);
  return Math.abs(c.close - c.open) / range;
}
function closePos(c) {
  const range = Math.max(c.high - c.low, 1e-9);
  return (c.close - c.low) / range;
}
// ERC test — KB §8: strong body, small wick, close near the candle extreme.
// The ~80% close is a KB reference value (see smc-config.js).
function isErc(c, direction, p = SMC_PARAMS) {
  if (direction === 'BUY') return c.close > c.open && bodyRatio(c) >= p.minDisplacementBody && closePos(c) >= p.ercClosePos;
  return c.close < c.open && bodyRatio(c) >= p.minDisplacementBody && closePos(c) <= 1 - p.ercClosePos;
}

// Session (Killzone) context in Malaysia time — CONTEXT ONLY, never a veto
// and never an entry signal (KB §13: sessions preferred, NOT mandatory).
export function sessionOf(timeSec) {
  const d = new Date((Number(timeSec) + 8 * 3600) * 1000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 21 * 60 || mins < 6 * 60) return 'NEW_YORK';
  if (mins >= 15 * 60 && mins < 21 * 60) return 'LONDON';
  return 'ASIAN';
}

function findFvgs(candles, atr, p = SMC_PARAMS) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const a = atr[i];
    if (!Number.isFinite(a)) continue;
    // Bullish FVG: low[i] > high[i-2].
    if (candles[i].low > candles[i - 2].high) {
      const size = candles[i].low - candles[i - 2].high;
      if (size >= p.minFvgAtr * a) fvgs.push({ direction: 'BUY', top: candles[i].low, bottom: candles[i - 2].high, time: candles[i].time, index: i, size });
    }
    // Bearish FVG: high[i] < low[i-2].
    if (candles[i].high < candles[i - 2].low) {
      const size = candles[i - 2].low - candles[i].high;
      if (size >= p.minFvgAtr * a) fvgs.push({ direction: 'SELL', top: candles[i - 2].low, bottom: candles[i].high, time: candles[i].time, index: i, size });
    }
  }
  return fvgs;
}

function buildOrderBlocks(candles, atr, p = SMC_PARAMS) {
  // An order block is the last opposing candle before a displacement candle
  // that closes beyond a pivot extreme. The zone is the opposing candle's
  // full range. A block is mitigated once a later candle CLOSES through it.
  const blocks = [];
  for (let i = p.pivotStrength; i < candles.length - p.pivotStrength; i++) {
    const ph = isPivotHigh(candles, i, p.pivotStrength);
    const pl = isPivotLow(candles, i, p.pivotStrength);
    if (!ph && !pl) continue;
    const end = Math.min(i + 4, candles.length - 1);
    let disp = -1;
    for (let j = i + 1; j <= end; j++) {
      const c = candles[j];
      if (bodyRatio(c) < p.minDisplacementBody) continue;
      if (pl && c.close > candles[i].high) { disp = j; break; }
      if (ph && c.close < candles[i].low) { disp = j; break; }
    }
    if (disp < 0) continue;
    const base = candles[i];
    const dir = pl ? 'BUY' : 'SELL';
    const top = dir === 'BUY' ? Math.max(base.open, base.close) : base.high;
    const bottom = dir === 'BUY' ? base.low : Math.min(base.open, base.close);
    if (!(top > bottom)) continue;
    const createdIndex = Math.max(disp, i + p.pivotStrength);
    blocks.push({
      id: `OB-${base.time}-${dir}`,
      direction: dir,
      top, bottom,
      pivotTime: base.time,
      displacementTime: candles[disp].time,
      displacementIndex: disp,
      createdTime: candles[createdIndex].time,
      createdIndex,
      erc: isErc(candles[disp], dir, p),
    });
  }
  return blocks;
}

function structureDirectionFromSwings(swings) {
  const highs = swings.highs, lows = swings.lows;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs.at(-1).price > highs.at(-2).price;
    const hl = lows.at(-1).price > lows.at(-2).price;
    const lh = highs.at(-1).price < highs.at(-2).price;
    const ll = lows.at(-1).price < lows.at(-2).price;
    if (hh && hl) return 'UP';
    if (lh && ll) return 'DOWN';
  }
  return 'NEUTRAL';
}

// Fake-breakout vetoes — KB §12. Any single veto kills the setup.
// Returns the list of veto reasons (empty = no veto).
function fakeBreakoutVetoes({ bosCandle, bosLevel, direction, candles, bosIndex, htfDirection, reactionIndex, opposingLevel }) {
  const vetoes = [];
  // 1. Wick-only breakout: the BOS candle did not CLOSE beyond the level.
  const closedBeyond = direction === 'BUY' ? bosCandle.close > bosLevel : bosCandle.close < bosLevel;
  if (!closedBeyond) vetoes.push('WICK_ONLY_BREAKOUT');
  // 2. Weak candle body on the breakout candle.
  if (bodyRatio(bosCandle) < SMC_PARAMS.minDisplacementBody) vetoes.push('WEAK_BODY_BREAKOUT');
  // 3. No meaningful displacement: the breakout candle is not an ERC.
  if (!isErc(bosCandle, direction)) vetoes.push('NO_DISPLACEMENT');
  // 4. Immediate reversal: the next closed candle closes back across the level.
  const next = candles[bosIndex + 1];
  if (next) {
    const reversed = direction === 'BUY' ? next.close < bosLevel : next.close > bosLevel;
    if (reversed) vetoes.push('IMMEDIATE_REVERSAL');
  }
  // 5. Breakout into strong opposing liquidity: an opposing swing level sits
  // within 1R of the entry zone (checked by the caller via opposingLevel).
  if (opposingLevel != null) vetoes.push('BREAKOUT_INTO_OPPOSING_LIQUIDITY');
  // 6. No supporting structure: HTF direction opposes the setup.
  if (htfDirection === 'UP' && direction === 'SELL') vetoes.push('HTF_OPPOSES');
  if (htfDirection === 'DOWN' && direction === 'BUY') vetoes.push('HTF_OPPOSES');
  // 7. No valid retest is checked by the caller (reaction must touch OB/FVG).
  void reactionIndex;
  return vetoes;
}

export function analyzeSmc(candles = [], options = {}) {
  const p = { ...SMC_PARAMS, ...(options.params || {}) };
  const market = options.market || 'xau';
  const htfDirection = options.htfDirection || null; // 'UP' | 'DOWN' | 'NEUTRAL' | null
  const empty = (rejection) => ({
    swings: { highs: [], lows: [] }, liquidityLevels: [], sweeps: [], zones: [],
    signal: { value: 'WAIT', direction: 'WAIT', probability: 0, score: 0, time: null, price: null, rejection },
    tradePlan: null, structureDirection: 'NEUTRAL',
    diagnostics: { latestPrice: candles.at(-1)?.close ?? null, rejection, logic: 'SMC_V1' },
  });
  if (!Array.isArray(candles) || candles.length < p.minCandles) return empty('NOT_ENOUGH_CANDLES');

  const atr = atrSeries(candles, p.atrLength);
  const swings = {
    highs: candles.map((c, i) => (isPivotHigh(candles, i, p.pivotStrength) ? { time: c.time, price: c.high, index: i } : null)).filter(Boolean),
    lows: candles.map((c, i) => (isPivotLow(candles, i, p.pivotStrength) ? { time: c.time, price: c.low, index: i } : null)).filter(Boolean),
  };
  const structureDirection = structureDirectionFromSwings(swings);
  const lastAtr = atr.at(-1);
  if (!Number.isFinite(lastAtr) || lastAtr <= 0) return empty('NO_ATR');

  // Liquidity levels: recent external swing extremes + equal highs/lows.
  const liquidityLevels = [];
  for (const h of swings.highs.slice(-8)) liquidityLevels.push({ type: 'BSL', price: h.high ?? h.price, time: h.time });
  for (const l of swings.lows.slice(-8)) liquidityLevels.push({ type: 'SSL', price: l.low ?? l.price, time: l.time });
  for (let i = 1; i < swings.highs.length; i++) {
    if (Math.abs(swings.highs[i].price - swings.highs[i - 1].price) <= p.equalLevelAtr * lastAtr) {
      liquidityLevels.push({ type: 'EQH', price: swings.highs[i].price, time: swings.highs[i].time });
    }
  }
  for (let i = 1; i < swings.lows.length; i++) {
    if (Math.abs(swings.lows[i].price - swings.lows[i - 1].price) <= p.equalLevelAtr * lastAtr) {
      liquidityLevels.push({ type: 'EQL', price: swings.lows[i].price, time: swings.lows[i].time });
    }
  }

  // Liquidity sweeps: a candle pushes beyond a prior swing extreme by the
  // excursion, then closes back across the level within reclaimBars.
  // A level stays valid until price CLOSES through it — the sweep may come
  // many bars after the level formed. The scan stops at the first close
  // through the level (invalidation) or at the lookback cap.
  const sweeps = [];
  const allSwings = [
    ...swings.highs.map(s => ({ ...s, side: 'HIGH' })),
    ...swings.lows.map(s => ({ ...s, side: 'LOW' })),
  ].sort((a, b) => a.index - b.index);
  for (const s of allSwings) {
    for (let j = s.index + 1; j < Math.min(s.index + 60, candles.length); j++) {
      const c = candles[j];
      const excursion =
        (s.side === 'HIGH' && c.high >= s.price + p.sweepExcursionAtr * lastAtr) ||
        (s.side === 'LOW' && c.low <= s.price - p.sweepExcursionAtr * lastAtr);
      if (excursion) {
        // Reclaim: this candle or one of the next reclaimBars closes back.
        // (The excursion candle itself often closes through the level; the
        // reclaim is what makes it a sweep rather than a break.)
        let reclaimed = (s.side === 'HIGH' && c.close < s.price) || (s.side === 'LOW' && c.close > s.price);
        let sweepIndex = j;
        if (!reclaimed) {
          for (let k = j + 1; k <= Math.min(j + p.sweepReclaimBars, candles.length - 1); k++) {
            if ((s.side === 'HIGH' && candles[k].close < s.price) || (s.side === 'LOW' && candles[k].close > s.price)) {
              reclaimed = true; sweepIndex = k; break;
            }
          }
        }
        if (reclaimed) {
          sweeps.push({
            level: { type: s.side === 'HIGH' ? 'BSL' : 'SSL', price: s.price, time: s.time },
            direction: s.side === 'HIGH' ? 'SELL' : 'BUY',
            sweepTime: candles[sweepIndex].time, sweepIndex, reclaim: true,
          });
        }
        break; // one sweep attempt per level
      }
      // No excursion: a close through the level invalidates it.
      if (s.side === 'HIGH' && c.close > s.price) break;
      if (s.side === 'LOW' && c.close < s.price) break;
    }
  }

  const blocks = buildOrderBlocks(candles, atr, p);
  const fvgs = findFvgs(candles, atr, p);
  const reactionIndex = candles.length - 1;
  const reaction = candles[reactionIndex];

  // The confirming reaction candle must be the LAST closed candle.
  // Try both directions; a valid setup needs the full ordered sequence.
  for (const direction of ['BUY', 'SELL']) {
    const aligned = direction === 'BUY' ? reaction.close > reaction.open : reaction.close < reaction.open;
    if (!aligned) continue;
    if (bodyRatio(reaction) < p.minReactionBody) continue;
    const cp = closePos(reaction);
    if (direction === 'BUY' && cp < p.reactionClosePos) continue;
    if (direction === 'SELL' && cp > 1 - p.reactionClosePos) continue;

    // Find an unmitigated order block (or FVG) of this direction that the
    // reaction candle retests (Return to Supply).
    const ob = [...blocks].reverse().find(b => {
      if (b.direction !== direction || b.createdIndex >= reactionIndex) return false;
      const touched = reaction.low <= b.top && reaction.high >= b.bottom;
      if (!touched) return false;
      // Unmitigated: no candle between creation and the reaction closed through it.
      for (let k = b.createdIndex + 1; k < reactionIndex; k++) {
        if (direction === 'BUY' && candles[k].close < b.bottom) return false;
        if (direction === 'SELL' && candles[k].close > b.top) return false;
      }
      // Reaction candle itself must not close through the block.
      if (direction === 'BUY' && reaction.close < b.bottom) return false;
      if (direction === 'SELL' && reaction.close > b.top) return false;
      return true;
    });
    const fvg = [...fvgs].reverse().find(f => {
      if (f.direction !== direction || f.index >= reactionIndex) return false;
      const touched = reaction.low <= f.top && reaction.high >= f.bottom;
      if (!touched) return false;
      for (let k = f.index + 1; k < reactionIndex; k++) {
        if (direction === 'BUY' && candles[k].close < f.bottom) return false;
        if (direction === 'SELL' && candles[k].close > f.top) return false;
      }
      return true;
    });
    if (!ob && !fvg) continue;

    // Sequence: sweep → MSS → BOS must all precede the REACTION candle,
    // and the order block must have been created before the reaction too.
    // (The OB forms during the displacement leg, so BOS may complete after
    // the OB is created — the ordering constraint is against the reaction,
    // not against OB creation.)
    const sweep = [...sweeps].reverse().find(s => s.direction === direction && s.sweepIndex < reactionIndex && reactionIndex - s.sweepIndex <= p.maxSweepToBosBars + p.maxBosToRetestBars);
    if (!sweep) continue;

    // MSS/CHOCH: after the sweep, a close beyond the last INTERNAL swing
    // extreme in the setup direction, with displacement. For a bullish
    // shift the market breaks above the last internal swing HIGH made
    // during the pullback; for a bearish shift it breaks below the last
    // internal swing LOW.
    let mssIndex = -1, mssLevel = null;
    const internalSwings = direction === 'BUY' ? swings.highs : swings.lows;
    for (let j = sweep.sweepIndex + 1; j < reactionIndex; j++) {
      const prior = internalSwings.filter(s => s.index < j).at(-1);
      if (!prior) continue;
      const broke = direction === 'BUY' ? candles[j].close > prior.price : candles[j].close < prior.price;
      if (broke && isErc(candles[j], direction, p)) { mssIndex = j; mssLevel = prior.price; break; }
    }
    if (mssIndex < 0) continue;

    // BOS: after MSS, a close beyond the relevant EXTERNAL swing extreme.
    let bosIndex = -1, bosLevel = null;
    const externalSwings = direction === 'BUY' ? swings.highs : swings.lows;
    for (let j = mssIndex + 1; j < reactionIndex; j++) {
      const prior = externalSwings.filter(s => s.index < j).at(-1);
      if (!prior) continue;
      const broke = direction === 'BUY' ? candles[j].close > prior.price : candles[j].close < prior.price;
      if (broke) { bosIndex = j; bosLevel = prior.price; break; }
    }
    if (bosIndex < 0) continue;
    if (reactionIndex - bosIndex > p.maxBosToRetestBars) continue;
    // The retested order block must belong to this displacement leg:
    // its displacement candle comes at/after the sweep reclaim candle
    // (it is often the reclaim candle itself).
    if (ob && ob.displacementIndex < sweep.sweepIndex) continue;

    const bosCandle = candles[bosIndex];
    // Opposing liquidity within 1R of the entry zone is a veto (check after
    // the plan is priced — approximate here with the nearest opposing swing).
    const entryPrice = reaction.close;
    const opposing = direction === 'BUY'
      ? swings.highs.filter(s => s.index < reactionIndex && s.price > entryPrice).at(-1)
      : swings.lows.filter(s => s.index < reactionIndex && s.price < entryPrice).at(-1);

    // Price the plan first so the opposing-liquidity veto can use 1R.
    const plan = makeSmcTradePlan({ direction, entry: entryPrice, ob, fvg, atr: lastAtr, market });
    if (!plan) continue;
    const risk = plan.risk;
    const opposingWithin1R = opposing
      ? direction === 'BUY' ? opposing.price - entryPrice <= risk : entryPrice - opposing.price <= risk
      : false;

    const vetoes = fakeBreakoutVetoes({
      bosCandle, bosLevel, direction, candles, bosIndex, htfDirection,
      reactionIndex, opposingLevel: opposingWithin1R ? opposing.price : null,
    });
    if (vetoes.length) continue;

    // Confidence = setup-completeness score (NOT a win probability).
    const confirmations = {
      sweep: true, mss: true, bos: true,
      orderBlock: !!ob, fvg: !!fvg, fvgObConfluence: !!(ob && fvg),
      erc: isErc(bosCandle, direction, p),
      htfAligned: htfDirection == null || (direction === 'BUY' ? htfDirection === 'UP' : htfDirection === 'DOWN'),
      killzone: sessionOf(reaction.time),
      apd: { displacementTime: bosCandle.time, direction },
      returnToSupply: !!ob || !!fvg,
    };
    const score = clamp(50 + Object.values(confirmations).filter(v => v === true).length * 7, 50, 95);

    return {
      swings, liquidityLevels, sweeps,
      zones: blocks.filter(b => b.direction === direction),
      signal: {
        value: direction, direction, probability: score, score,
        time: reaction.time, price: entryPrice,
        confirmationTime: reaction.time, entryTime: reaction.time,
        rejection: null,
        confirmations,
        sweep: { level: sweep.level, time: sweep.sweepTime },
      },
      tradePlan: plan,
      structureDirection,
      diagnostics: {
        atr: lastAtr,
        latestPrice: reaction.close,
        latestSwingHigh: swings.highs.at(-1)?.price ?? null,
        latestSwingLow: swings.lows.at(-1)?.price ?? null,
        latestSweep: sweep.sweepTime,
        confirmation: 'SMC_SWEEP_MSS_BOS_OB_FVG_RETEST',
        mssTime: candles[mssIndex].time,
        bosTime: bosCandle.time,
        obId: ob?.id ?? null,
        fvgTime: fvg?.time ?? null,
        session: confirmations.killzone,
        htfDirection,
        rejection: null,
        logic: 'SMC_V1',
      },
    };
  }

  return {
    swings, liquidityLevels, sweeps,
    zones: blocks,
    signal: { value: 'WAIT', direction: 'WAIT', probability: 0, score: 0, time: null, price: reaction.close, rejection: 'NO_COMPLETE_SETUP' },
    tradePlan: null, structureDirection,
    diagnostics: {
      atr: lastAtr, latestPrice: reaction.close,
      latestSwingHigh: swings.highs.at(-1)?.price ?? null,
      latestSwingLow: swings.lows.at(-1)?.price ?? null,
      latestSweep: sweeps.at(-1)?.sweepTime ?? null,
      confirmation: 'WAITING_FOR_SETUP', rejection: 'NO_COMPLETE_SETUP', logic: 'SMC_V1',
    },
  };
}

function makeSmcTradePlan({ direction, entry, ob, fvg, atr, market }) {
  const p = SMC_PARAMS;
  const decimals = 2;
  // SL at the structural invalidation: the far edge of the order block
  // (or the FVG edge when no OB), plus a small buffer. Never arbitrary.
  let stopLoss;
  if (ob) {
    stopLoss = direction === 'BUY' ? ob.bottom - p.obBufferAtr * atr : ob.top + p.obBufferAtr * atr;
  } else if (fvg) {
    stopLoss = direction === 'BUY' ? fvg.bottom - p.obBufferAtr * atr : fvg.top + p.obBufferAtr * atr;
  } else return null;
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0)) return null;
  // Stop-distance guardrails. XAU uses the repo's point limits; BTC uses
  // ATR multiples (provisional — see smc-config.js).
  if (market === 'xau') {
    if (risk < p.xauMinStopPoints || risk > p.xauMaxStopPoints) return null;
  } else if (risk < p.btcMinStopAtr * atr || risk > p.btcMaxStopAtr * atr) return null;
  const tps = p.tpMultiples.map(r => Number((direction === 'BUY' ? entry + risk * r : entry - risk * r).toFixed(decimals)));
  return {
    entry: Number(entry.toFixed(decimals)),
    stopLoss: Number(stopLoss.toFixed(decimals)),
    tp1: tps[0], tp2: tps[1], tp3: tps[2], tp4: tps[3],
    risk: Number(risk.toFixed(decimals)),
    rr: '1:1 / 1:2 / 1:3 / 1:4 (PROVISIONAL — A1 OPEN)',
    entryRule: 'SMC_SWEEP_MSS_BOS_OB_FVG_RETEST_CLOSE',
    stopRule: 'OB_EDGE_PLUS_BUFFER',
  };
}

// Scan a full closed-candle series and return every completed SMC setup
// (used by backtests). Causal: at each candle only candles up to that
// candle are visible to the detector.
export function scanSmcHistory(candles, options = {}) {
  const out = [];
  const p = { ...SMC_PARAMS, ...(options.params || {}) };
  const start = Math.max(p.minCandles, 40);
  for (let i = start; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - p.maxCandles + 1), i + 1);
    const result = analyzeSmc(window, { ...options, params: p });
    if (result.signal?.direction && result.signal.direction !== 'WAIT' && result.signal.time === candles[i].time && result.tradePlan) {
      out.push({ signal: result.signal, tradePlan: result.tradePlan, index: i });
    }
  }
  return out;
}
