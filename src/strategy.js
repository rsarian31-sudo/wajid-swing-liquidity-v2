// Wajid Swing Liquidity — Volume-Trend Order Block Retest Engine
// Signal rule:
// 1) Create a trend-aligned Order Block.
// 2) Wait for price to return into the active box.
// 3) Require a closed reaction candle in the box direction.
// 4) Emit one signal per box on the first valid retest.
// This is a clean implementation of the observed Box -> Retest -> Reaction rule.
// It does not use the previous SD / sweep / BOS / MSS / FVG engines.

export const CONFIG = {
  outputSize: 300,
  ruleVersion: 'volume-ob-creation-v2',
  pivotStrength: 3,
  atrLength: 14,
  supertrendMultiplier: 3,
  minVolumePercent: 55,
  minReactionBody: 0.35,
  maxRetestBars: 12,
  maxZones: 12,
  rr: [1, 2, 3, 4],
  minStopPoints: 1.8,
  maxStopPoints: 10
};

// 1M keeps the existing behavior exactly. 5M/15M use the same OB engine,
// but require a real box retest + closed reaction before creating a trade signal.
// This prevents higher-timeframe entries from firing on the displacement candle itself.
const TIMEFRAME_CONFIG = {
  '1min': { requireRetest: false, minReactionBody: CONFIG.minReactionBody, minVolumePercent: CONFIG.minVolumePercent },
  '5min': { requireRetest: true, minReactionBody: 0.45, minVolumePercent: 58 },
  '15min': { requireRetest: true, minReactionBody: 0.55, minVolumePercent: 62 }
};

function strategyConfig(interval) {
  const tf = TIMEFRAME_CONFIG[interval] || TIMEFRAME_CONFIG['1min'];
  return { ...CONFIG, ...tf };
}

const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function trueRange(c, prev) {
  if (!prev) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

function atrSeries(candles, length) {
  const out = Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += trueRange(candles[i], candles[i - 1]);
    if (i >= length) sum -= trueRange(candles[i - length], candles[i - length - 1]);
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function supertrend(candles, length = 10, multiplier = 3) {
  const atr = atrSeries(candles, length);
  const trend = Array(candles.length).fill(0);
  const line = Array(candles.length).fill(null);
  let upper = null, lower = null;
  for (let i = 0; i < candles.length; i++) {
    const a = atr[i];
    if (!Number.isFinite(a)) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;
    if (upper == null) upper = basicUpper;
    if (lower == null) lower = basicLower;
    upper = i > 0 && candles[i - 1].close <= upper ? Math.min(basicUpper, upper) : basicUpper;
    lower = i > 0 && candles[i - 1].close >= lower ? Math.max(basicLower, lower) : basicLower;
    if (i === 0 || trend[i - 1] === 0) trend[i] = candles[i].close >= mid ? 1 : -1;
    else if (trend[i - 1] === 1) trend[i] = candles[i].close < lower ? -1 : 1;
    else trend[i] = candles[i].close > upper ? 1 : -1;
    line[i] = trend[i] === 1 ? lower : upper;
  }
  return { atr, trend, line };
}

function isPivotHigh(candles, i, strength) {
  if (i < strength || i + strength >= candles.length) return false;
  const p = candles[i].high;
  for (let j = 1; j <= strength; j++) if (candles[i-j].high >= p || candles[i+j].high > p) return false;
  return true;
}

function isPivotLow(candles, i, strength) {
  if (i < strength || i + strength >= candles.length) return false;
  const p = candles[i].low;
  for (let j = 1; j <= strength; j++) if (candles[i-j].low <= p || candles[i+j].low < p) return false;
  return true;
}

function directionalVolume(candles, start, end) {
  let buy = 0, sell = 0;
  for (let i = start; i <= end; i++) {
    const c = candles[i];
    const range = Math.max(c.high - c.low, 1e-9);
    const vol = n(c.volume, 0);
    // Use actual volume when available; otherwise use candle range/body as a stable FX proxy.
    const weight = vol > 0 ? vol : range;
    const closeLocation = clamp((c.close - c.low) / range, 0, 1);
    buy += weight * closeLocation;
    sell += weight * (1 - closeLocation);
  }
  const total = buy + sell;
  if (!total) return { buyPercent: 50, sellPercent: 50 };
  return { buyPercent: Math.round(buy / total * 100), sellPercent: Math.round(sell / total * 100) };
}

function reactionQuality(c, direction, minBody = CONFIG.minReactionBody) {
  const range = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open) / range;
  const closePos = (c.close - c.low) / range;
  const bullish = direction === 'BUY';
  const aligned = bullish ? c.close > c.open : c.close < c.open;
  const closeStrong = bullish ? closePos >= 0.60 : closePos <= 0.40;
  return { body, closePos, aligned, closeStrong, valid: aligned && closeStrong && body >= minBody };
}

function createZones(candles, st, cfg = CONFIG) {
  const zones = [];
  for (let i = cfg.pivotStrength; i < candles.length - cfg.pivotStrength; i++) {
    const trend = st.trend[i];
    if (!trend) continue;
    const pivotHigh = isPivotHigh(candles, i, cfg.pivotStrength);
    const pivotLow = isPivotLow(candles, i, cfg.pivotStrength);
    if (!pivotHigh && !pivotLow) continue;

    // The zone is anchored to the pivot candle and the first displacement candle after it.
    const end = Math.min(i + 4, candles.length - 1);
    let displacement = -1;
    for (let j = i + 1; j <= end; j++) {
      const range = Math.max(candles[j].high - candles[j].low, 1e-9);
      const body = Math.abs(candles[j].close - candles[j].open) / range;
      if (body >= 0.55 && (trend === 1 ? candles[j].close > candles[i].high : candles[j].close < candles[i].low)) {
        displacement = j; break;
      }
    }
    if (displacement < 0) continue;

    const base = candles[i];
    const dir = trend === 1 && pivotLow ? 'BUY' : trend === -1 && pivotHigh ? 'SELL' : null;
    if (!dir) continue;

    const top = dir === 'BUY' ? Math.max(base.open, base.close) : base.high;
    const bottom = dir === 'BUY' ? base.low : Math.min(base.open, base.close);
    if (!(top > bottom)) continue;

    const vp = directionalVolume(candles, Math.max(0, i - 4), displacement);
    const strength = dir === 'BUY' ? vp.buyPercent : vp.sellPercent;
    if (strength < cfg.minVolumePercent) continue;

    const zone = {
      id: `OB-${candles[i].time}-${dir}`,
      direction: dir,
      startTime: candles[i].time,
      pivotTime: candles[i].time,
      createdTime: candles[displacement].time,
      top: Number(top.toFixed(3)),
      bottom: Number(bottom.toFixed(3)),
      split: Number((bottom + (top-bottom) * vp.buyPercent / 100).toFixed(3)),
      buyPercent: vp.buyPercent,
      sellPercent: vp.sellPercent,
      retested: false,
      broken: false,
      reactionTime: null,
      strength
    };

    const overlaps = zones.find(z => !(zone.top < z.bottom || zone.bottom > z.top));
    if (overlaps) {
      const idx = zones.indexOf(overlaps);
      zones.splice(idx, 1);
    }
    zones.push(zone);
    while (zones.length > cfg.maxZones) zones.shift();
  }
  return zones;
}

function processRetests(candles, zones, cfg = CONFIG) {
  const signals = [];
  const working = zones.map(z => ({ ...z }));
  for (const z of working) {
    let createdIndex = candles.findIndex(c => c.time === z.createdTime);
    if (createdIndex < 0) createdIndex = candles.findIndex(c => c.time === z.pivotTime);
    if (createdIndex < 0) continue;
    const max = Math.min(candles.length - 1, createdIndex + cfg.maxRetestBars);

    for (let i = createdIndex + 1; i <= max; i++) {
      const c = candles[i];
      const touched = c.low <= z.top && c.high >= z.bottom;
      if (!touched) {
        if (z.direction === 'BUY' && c.close < z.bottom) { z.broken = true; break; }
        if (z.direction === 'SELL' && c.close > z.top) { z.broken = true; break; }
        continue;
      }
      if (z.direction === 'BUY' && c.close < z.bottom) { z.broken = true; break; }
      if (z.direction === 'SELL' && c.close > z.top) { z.broken = true; break; }

      const reaction = reactionQuality(c, z.direction, cfg.minReactionBody);
      if (!reaction.valid) continue;

      z.retested = true;
      z.reactionTime = c.time;
      signals.push({
        time: c.time,
        direction: z.direction,
        price: c.close,
        zoneId: z.id,
        zone: { ...z },
        reactionBody: Number(reaction.body.toFixed(3)),
        buyPercent: z.buyPercent,
        sellPercent: z.sellPercent,
        confirmation: 'BOX_RETEST_REACTION'
      });
      break;
    }
  }
  return { zones: working, signals };
}

function makeTradePlan(signal, candles, cfg = CONFIG) {
  if (!signal) return null;
  const i = candles.findIndex(c => c.time === signal.time);
  const c = i >= 0 ? candles[i] : null;
  const entry = n(c?.close, signal.price);
  const zone = signal.zone;

  // Keep the existing OB-box SL. Only reject setups whose existing SL
  // distance is outside the requested 1.8–10 point range.
  const risk = signal.direction === 'BUY' ? entry - zone.bottom : zone.top - entry;
  const stopDistance = Math.abs(risk);
  if (!(stopDistance >= cfg.minStopPoints && stopDistance <= cfg.maxStopPoints)) return null;

  // The accepted setup's actual Entry→SL distance becomes 1R.
  // TP1–TP4 are dynamically calculated from that exact risk.
  const safeRisk = stopDistance;
  const stopLoss = signal.direction === 'BUY' ? zone.bottom : zone.top;
  const tps = cfg.rr.map(r => Number((signal.direction === 'BUY' ? entry + safeRisk*r : entry - safeRisk*r).toFixed(3)));
  return {
    entry:Number(entry.toFixed(3)),
    stopLoss:Number(stopLoss.toFixed(3)),
    tp1:tps[0],
    tp2:tps[1],
    tp3:tps[2],
    tp4:tps[3],
    risk:Number(safeRisk.toFixed(3)),
    rr:'1:1 / 1:2 / 1:3 / 1:4',
    entryRule:'ORDER_BLOCK_CREATED_ENTRY',
    stopRule:'OB_BOX_EDGE'
  };
}

function buildAnalysis(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const cfg = strategyConfig(options.interval);

  const st = supertrend(candles, 10, cfg.supertrendMultiplier);
  const zones = createZones(candles, st, cfg);
  const processed = processRetests(candles, zones, cfg);

  // 1M preserves the existing OB-creation signal behavior.
  // 5M/15M only become actionable after the price returns into the box
  // and a closed candle confirms the reaction.
  const boxSignals = processed.zones.map(z => ({
    time: z.createdTime,
    direction: z.direction,
    price: Number((candles.find(c => Number(c.time) === Number(z.createdTime))?.close ?? (z.direction === 'BUY' ? z.top : z.bottom)).toFixed(3)),
    zoneId: z.id,
    zone: { ...z },
    buyPercent: z.buyPercent,
    sellPercent: z.sellPercent,
    confirmation: 'ORDER_BLOCK_CREATED'
  })).filter(s => Number.isFinite(Number(s.time)));

  const allSignals = cfg.requireRetest ? processed.signals : boxSignals;
  // Only the requested SL-distance filter is applied here; all other
  // signal-generation conditions remain unchanged.
  const signals = allSignals.filter(s => !!makeTradePlan(s, candles, cfg));
  const latestTime = candles.at(-1)?.time;
  const latestSignal = signals
    .filter(s => Number(s.time) === Number(latestTime))
    .at(-1) || null;

  const activeZones = processed.zones.filter(z => !z.broken);
  const confidence = latestSignal
    ? clamp(
        Math.round(
          Math.max(latestSignal.buyPercent, latestSignal.sellPercent) * 0.65 +
          35
        ),
        0,
        99
      )
    : 0;

  return {
    st,
    zones: activeZones,
    signals,
    boxSignals,
    retestSignals: processed.signals,
    latestSignal,
    confidence
  };
}

export function analyze(candles = [], options = {}) {
  const cfg = strategyConfig(options.interval);
  const result = buildAnalysis(candles, options);
  const latest = candles.at(-1);
  if (!result || !latest) {
    return {
      swings:{highs:[],lows:[]}, liquidityLevels:[], sweeps:[], zones:[], volumeOB:{zones:[],activeZone:null,signals:[]},
      signal:{value:'WAIT',direction:'WAIT',probability:0,score:0,time:null,price:null,rejection:'NOT_ENOUGH_CANDLES'},
      tradePlan:null, structureDirection:null,
      diagnostics:{atr:null,latestPrice:latest?.close??null,latestSwingHigh:null,latestSwingLow:null,latestSweep:null,confirmation:'NONE',volumeAvailable:false,volumeConfirmed:false,riskFilter:{passed:false,rejected:false,reason:'NOT_ENOUGH_CANDLES'},entryRule:null,entryTime:null,bigMoveScore:0,rejection:'NOT_ENOUGH_CANDLES',logic:'VOLUME_OB_RETEST'}
    };
  }

  const latestSignal = result.latestSignal;
  const latestZone = result.zones.at(-1) || null;
  const latestTrend = result.st.trend.at(-1) === 1 ? 'UP' : result.st.trend.at(-1) === -1 ? 'DOWN' : 'WAIT';
  const signal = latestSignal ? {
    value:latestSignal.direction,
    direction:latestSignal.direction,
    probability:result.confidence,
    score:result.confidence,
    time:latestSignal.time,
    price:latestSignal.price,
    confirmationTime:latestSignal.time,
    entryTime:latestSignal.time,
    rejection:null,
    zoneId:latestSignal.zoneId
  } : {
    value:'WAIT', direction:'WAIT', probability:0, score:0, time:null, price:latest.close,
    confirmationTime:null, entryTime:null,
    rejection: latestZone ? 'WAITING_FOR_ORDER_BLOCK' : 'NO_ACTIVE_ORDER_BLOCK'
  };

  const swings = {
    highs: candles.map((c,i)=>isPivotHigh(candles,i,cfg.pivotStrength)?{time:c.time,price:c.high}:null).filter(Boolean),
    lows: candles.map((c,i)=>isPivotLow(candles,i,cfg.pivotStrength)?{time:c.time,price:c.low}:null).filter(Boolean)
  };

  const plan = makeTradePlan(latestSignal,candles,cfg);

  return {
    swings, liquidityLevels:[], sweeps:[], zones:result.zones,
    volumeOB:{zones:result.zones,activeZone:latestZone,signals:result.signals,retestSignals:result.retestSignals||[]},
    signal,
    tradePlan:plan,
    structureDirection:latestTrend,
    diagnostics:{
      atr:result.st.atr.at(-1),
      latestPrice:latest.close,
      latestSwingHigh:swings.highs.at(-1)?.price??null,
      latestSwingLow:swings.lows.at(-1)?.price??null,
      latestSweep:null,
      confirmation:latestSignal?(cfg.requireRetest?'BOX_RETEST_REACTION':'ORDER_BLOCK_CREATED'):'WAITING_FOR_ORDER_BLOCK',
      volumeAvailable:candles.some(c=>n(c.volume,0)>0),
      volumeConfirmed:latestZone ? Math.max(latestZone.buyPercent,latestZone.sellPercent) >= cfg.minVolumePercent : false,
      riskFilter:{passed:!!plan,rejected:!!latestSignal&&!plan,reason:plan?null:(latestSignal?'SL_DISTANCE_OUT_OF_RANGE':'WAIT')},
      entryRule:latestSignal?(cfg.requireRetest?'BOX_RETEST_REACTION_CLOSE':'ORDER_BLOCK_CREATION_CLOSE'):null,
      entryTime:latestSignal?.time??null,
      bigMoveScore:0,
      rejection:signal.rejection,
      logic:cfg.requireRetest?'VOLUME_OB_RETEST_REACTION':'VOLUME_OB_CREATION_SIGNAL'
    }
  };
}

function resolveHistoricalTrade(trade, candles, startIndex) {
  const levels = [trade.tp1, trade.tp2, trade.tp3, trade.tp4].map(Number);
  const sl = Number(trade.stopLoss);
  const buy = trade.direction === 'BUY';
  const hitTPs = [];
  let realizedR = 0;
  let result = 'OPEN';
  let status = 'OPEN';
  let exit = null;
  let exitTime = null;
  let reason = 'Waiting for TP3 WIN or TP4 Full TP HIT';

  for (let i = startIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    const high = Number(c.high), low = Number(c.low);

    const stopTouched = buy ? low <= sl : high >= sl;
    const newlyHit = [];
    for (let j = 0; j < levels.length; j++) {
      if (hitTPs.includes(j + 1)) continue;
      const targetTouched = buy ? high >= levels[j] : low <= levels[j];
      if (targetTouched) newlyHit.push(j + 1);
    }

    // If TP3 was already achieved, the trade has officially won.
    // A later SL must never downgrade WIN to LOSS.
    if (hitTPs.includes(3)) {
      for (const tp of newlyHit) {
        hitTPs.push(tp);
        realizedR = Math.max(realizedR, tp);
      }
      if (hitTPs.includes(4)) {
        result = 'FULL TP HIT';
        status = 'CLOSED';
        exit = levels[3];
        exitTime = c.time;
        reason = 'TP4_FULL';
        break;
      }
      result = 'WIN';
      status = 'OPEN';
      reason = 'TP3_WIN';
      continue;
    }

    // Before TP3, an SL ends the trade. If SL and TP3 are touched in the
    // same candle, keep the conservative SL-first rule.
    const reachesTP3 = newlyHit.includes(3);
    if (stopTouched && reachesTP3) {
      result = 'LOSS';
      status = 'CLOSED';
      exit = sl;
      exitTime = c.time;
      realizedR = -1;
      reason = 'SL_BEFORE_TP3';
      break;
    }

    for (const tp of newlyHit) {
      hitTPs.push(tp);
      realizedR = Math.max(realizedR, tp);
    }

    if (hitTPs.includes(4)) {
      result = 'FULL TP HIT';
      status = 'CLOSED';
      exit = levels[3];
      exitTime = c.time;
      reason = 'TP4_FULL';
      break;
    }

    if (hitTPs.includes(3)) {
      // TP3 is the official WIN milestone. Keep monitoring for TP4.
      result = 'WIN';
      status = 'OPEN';
      reason = 'TP3_WIN';
      continue;
    }

    if (stopTouched) {
      result = 'LOSS';
      status = 'CLOSED';
      exit = sl;
      exitTime = c.time;
      realizedR = -1;
      reason = 'SL_BEFORE_TP3';
      break;
    }
  }

  return {
    ...trade,
    tp1Hit: hitTPs.includes(1),
    tp2Hit: hitTPs.includes(2),
    tp3Hit: hitTPs.includes(3),
    tp4Hit: hitTPs.includes(4),
    hitTPs,
    realizedR: Number(realizedR.toFixed(2)),
    result,
    status,
    exit,
    exitTime,
    reason
  };
}

export function buildHistory(candles = [], options = {}) {
  const cfg = strategyConfig(options.interval);
  const result = buildAnalysis(candles, options);
  if (!result) return [];
  return result.signals.slice(-200).map((s, index) => {
    const plan = makeTradePlan(s,candles,cfg);
    const base = {
      id:`hist-${s.time}-${s.direction}-${index}`,
      interval:null,
      direction:s.direction,
      signalTime:s.time,
      confirmationTime:s.time,
      entry:plan?.entry??s.price,
      stopLoss:plan?.stopLoss??null,
      tp1:plan?.tp1??null,tp2:plan?.tp2??null,tp3:plan?.tp3??null,tp4:plan?.tp4??null,
      risk:plan?.risk??null,realizedR:0,
      tp1Hit:false,tp2Hit:false,tp3Hit:false,tp4Hit:false,hitTPs:[],
      result:'OPEN',status:'OPEN',exit:null,exitTime:null,reason:'Waiting for TP4 or SL',
      entryRule:cfg.requireRetest?'BOX_RETEST_REACTION_CLOSE':'ORDER_BLOCK_CREATION_CLOSE',zoneId:s.zoneId
    };
    const startIndex = candles.findIndex(c => Number(c.time) === Number(s.time));
    return resolveHistoricalTrade(base, candles, startIndex);
  });
}
