// WAJID SMC CORE — market configuration.
//
// Every detector parameter lives here with its source annotated.
// Sources:
//   KB       — Wajid Master Trading Knowledge Base (authoritative).
//   REPO     — value already present in the existing repository.
//   PROVISIONAL — no KB/repo value exists. The value is a clearly-labelled
//   engineering placeholder ONLY so the pipeline is testable. It is NOT
//   owner-approved. A1 (TP basis) and A6–A8 (detector thresholds) remain OPEN
//   until Wajid freezes them from labelled chart examples.
//
// FINAL TIMEFRAMES (owner instruction 2026-11-07, supersedes all earlier
// timeframe decisions — flag in every delivery):
//   GOLD: 5M and 15M ONLY. XAU 1H is NO LONGER a signal timeframe.
//   BTC:  15M, 30M and 1H ONLY. BTC 45M is REMOVED (A5 is now moot).
//   4H remains out of scope as a signal timeframe.
// The old 1M signal system is retired completely.

export const SMC_RULE_VERSION = 'smc-v1';
export const LIVE_SIGNALS_DEFAULT = false;

export const MARKETS = {
  btc: {
    market: 'btc',
    label: 'BTC',
    symbol: 'BTCUSDT',
    displaySymbol: 'BTCUSD',
    provider: 'Bitget',
    providerNote: 'Bitget V3 public market data, SPOT BTCUSDT, no API key. Verified live 2026-11-07.',
    intervals: ['15min', '30min', '1H'],
    // Next-higher timeframe used for HTF context (null = no higher TF in scope).
    htf: { '15min': '30min', '30min': '1H', '1H': null },
    priceDecimals: 2,
    spread: 0, // BTC spot spread is negligible at this scale; backtests use slippage instead.
    slippage: 0.0005, // 0.05% per fill, backtest assumption — documented, not measured.
  },
  xau: {
    market: 'xau',
    label: 'GOLD',
    symbol: 'XAU/USD',
    displaySymbol: 'XAUUSD',
    provider: 'Twelve Data',
    providerNote:
      'Existing verified Gold source, reused unchanged. LICENSING LIMITATION: ' +
      'Twelve Data Basic is internal non-display only and is NOT confirmed ' +
      'permitted for production Telegram signals. See final report.',
    intervals: ['5min', '15min'],
    htf: { '5min': '15min', '15min': null },
    priceDecimals: 2,
    spread: 0.35, // XAU/USD typical spread in price points, backtest assumption.
    slippage: 0.15,
  },
};

export const INTERVAL_SECONDS = {
  '5min': 300,
  '15min': 900,
  '30min': 1800,
  '1H': 3600,
};

export const BITGET_INTERVAL = { '15min': '15m', '30min': '30m', '1H': '1H' };

// Detector parameters. See header for source rules.
export const SMC_PARAMS = {
  // Pivot strength for swing highs/lows. Source: REPO (strategy.js pivotStrength 3).
  pivotStrength: 3,
  // ATR length. Source: REPO (strategy.js atrLength 14).
  atrLength: 14,
  // Minimum candles required before any signal. Source: REPO (analyze needs >= 40; SMC needs more structure — 120).
  minCandles: 120,
  // Maximum candles analysed per run. Source: REPO (CONFIG.outputSize 300).
  maxCandles: 300,
  // Displacement candle: minimum body as a fraction of range.
  // Source: REPO (strategy.js displacement detection uses body >= 0.55).
  minDisplacementBody: 0.55,
  // ERC / strong displacement: close position within the candle's directional
  // range. Source: KB §8 — "~80% close within the candle's directional range
  // can be used as a reference for strong displacement".
  ercClosePos: 0.8,
  // Reaction candle (retest confirmation): minimum body fraction.
  // Source: REPO (strategy.js minReactionBody 0.35).
  minReactionBody: 0.35,
  // Reaction candle: close must be in the strong part of the range.
  // Source: REPO (strategy.js reactionQuality closeStrong 0.60 / 0.40).
  reactionClosePos: 0.6,
  // Sweep: price must exceed the liquidity level by this fraction of ATR.
  // Source: PROVISIONAL (no KB/repo value). A6 open.
  sweepExcursionAtr: 0.1,
  // Sweep: the level must be reclaimed (close back across it) within this
  // many bars. Source: PROVISIONAL (no KB/repo value). A6 open.
  sweepReclaimBars: 3,
  // Equal highs/lows: two swing extremes count as "equal" when they differ
  // by no more than this fraction of ATR. Source: PROVISIONAL. A6 open.
  equalLevelAtr: 0.15,
  // FVG: minimum gap size as a fraction of ATR.
  // Source: PROVISIONAL (no KB/repo value). A7 open.
  minFvgAtr: 0.25,
  // Order-block stop buffer beyond the OB edge, as a fraction of ATR.
  // Source: PROVISIONAL (no KB/repo value). A7 open.
  obBufferAtr: 0.1,
  // Maximum bars between the sweep and the BOS confirmation.
  // Source: PROVISIONAL (no KB/repo value). A6 open.
  maxSweepToBosBars: 20,
  // Maximum bars between BOS and the OB/FVG retest.
  // Source: PROVISIONAL (no KB/repo value). A6 open.
  maxBosToRetestBars: 30,
  // Stop-loss distance limits, XAU (price points).
  // Source: REPO (strategy.js minStopPoints 4, maxStopPoints 10).
  xauMinStopPoints: 4,
  xauMaxStopPoints: 10,
  // Stop-loss distance limits, BTC, as multiples of ATR.
  // Source: PROVISIONAL (BTC price scale differs from XAU; no repo value). A6 open.
  btcMinStopAtr: 0.5,
  btcMaxStopAtr: 3,
  // TP levels as R multiples of the entry→SL risk.
  // Source: PROVISIONAL pending A1. The repo's v4 engine used rr [1,2,3,4]
  // (REPO) and the KB names 1:2 as the BTC backtesting benchmark (KB §14).
  // These are NOT owner-approved TP rules. A1 remains OPEN.
  tpMultiples: [1, 2, 3, 4],
};

// All provisional values, for the final report. Keep in sync with SMC_PARAMS.
export const PROVISIONAL_PARAMS = [
  { name: 'sweepExcursionAtr', value: 0.1, note: 'Sweep must exceed level by 0.1×ATR' },
  { name: 'sweepReclaimBars', value: 3, note: 'Level reclaimed within 3 bars' },
  { name: 'equalLevelAtr', value: 0.15, note: 'Equal highs/lows within 0.15×ATR' },
  { name: 'minFvgAtr', value: 0.25, note: 'FVG minimum size 0.25×ATR' },
  { name: 'obBufferAtr', value: 0.1, note: 'SL buffer beyond OB edge 0.1×ATR' },
  { name: 'maxSweepToBosBars', value: 20, note: 'Sweep → BOS within 20 bars' },
  { name: 'maxBosToRetestBars', value: 30, note: 'BOS → retest within 30 bars' },
  { name: 'btcMinStopAtr', value: 0.5, note: 'BTC min stop 0.5×ATR' },
  { name: 'btcMaxStopAtr', value: 3, note: 'BTC max stop 3×ATR' },
  { name: 'tpMultiples', value: [1, 2, 3, 4], note: 'TP1–TP4 at 1R/2R/3R/4R — A1 OPEN, not owner-approved' },
];

export function marketConfig(market) {
  const cfg = MARKETS[market];
  if (!cfg) throw new Error('Unknown market: ' + String(market));
  return cfg;
}

export function htfInterval(market, interval) {
  return MARKETS[market]?.htf?.[interval] ?? null;
}
