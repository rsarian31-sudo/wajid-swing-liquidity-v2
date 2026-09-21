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
  ruleVersion: 'volume-ob-retest-v1',
  pivotStrength: 3,
  atrLength: 14,
  supertrendMultiplier: 3,
  minVolumePercent: 55,
  minReactionBody: 0.35,
  maxRetestBars: 12,
  maxZones: 12,
  rr: [1, 2, 3, 4]
};

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

function reactionQuality(c, direction) {
  const range = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open) / range;
  const closePos = (c.close - c.low) / range;
  const bullish = direction === 'BUY';
  const aligned = bullish ? c.close > c.open : c.close < c.open;
  const closeStrong = bullish ? closePos >= 0.60 : closePos <= 0.40;
  return { body, closePos, aligned, closeStrong, valid: aligned && closeStrong && body >= CONFIG.minReactionBody };
}

function createZones(candles, st) {
  const zones = [];
  for (let i = CONFIG.pivotStrength; i < candles.length - CONFIG.pivotStrength; i++) {
    const trend = st.trend[i];
    if (!trend) continue;
    const pivotHigh = isPivotHigh(candles, i, CONFIG.pivotStrength);
    const pivotLow = isPivotLow(candles, i, CONFIG.pivotStrength);
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
    if (strength < CONFIG.minVolumePercent) continue;

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
    while (zones.length > CONFIG.maxZones) zones.shift();
  }
  return zones;
}

function processRetests(candles, zones) {
  const signals = [];
  const working = zones.map(z => ({ ...z }));
  for (const z of working) {
    let createdIndex = candles.findIndex(c => c.time === z.createdTime);
    if (createdIndex < 0) createdIndex = candles.findIndex(c => c.time === z.pivotTime);
    if (createdIndex < 0) continue;
    const max = Math.min(candles.length - 1, createdIndex + CONFIG.maxRetestBars);

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

      const reaction = reactionQuality(c, z.direction);
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

function makeTradePlan(signal, candles) {
  if (!signal) return null;
  const i = candles.findIndex(c => c.time === signal.time);
  const c = i >= 0 ? candles[i] : null;
  const entry = n(c?.close, signal.price);
  const zone = signal.zone;
  const risk = signal.direction === 'BUY' ? entry - zone.bottom : zone.top - entry;
  const safeRisk = Math.max(risk, Math.abs(entry) * 0.00025);
  // Entry = close of the candle that creates/confirms the OB.
  // SL = the far edge of the OB box: BUY uses box bottom, SELL uses box top.
  const stopLoss = signal.direction === 'BUY' ? zone.bottom : zone.top;
  const tps = CONFIG.rr.map(r => Number((signal.direction === 'BUY' ? entry + safeRisk*r : entry - safeRisk*r).toFixed(3)));
  return { entry:Number(entry.toFixed(3)), stopLoss:Number(stopLoss.toFixed(3)), tp1:tps[0], tp2:tps[1], tp3:tps[2], tp4:tps[3], risk:Number(safeRisk.toFixed(3)), rr:'1:1 / 1:2 / 1:3 / 1:4', entryRule:'ORDER_BLOCK_CREATED_ENTRY', stopRule:'OB_BOX_EDGE' };
}

function buildAnalysis(candles) {
  if (!Array.isArray(candles) || candles.length < 40) return null;

  const st = supertrend(candles, 10, CONFIG.supertrendMultiplier);
  const zones = createZones(candles, st);
  const processed = processRetests(candles, zones);

  // The TradingView workflow treats the appearance of a valid OB box as
  // the actionable signal event. Retest information remains available as
  // metadata, but a retest is no longer required to create the signal.
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

  const latestTime = candles.at(-1)?.time;
  const latestSignal = boxSignals
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
    signals: boxSignals,
    retestSignals: processed.signals,
    latestSignal,
    confidence
  };
}

export function analyze(candles = []) {
  const result = buildAnalysis(candles);
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
    highs: candles.map((c,i)=>isPivotHigh(candles,i,CONFIG.pivotStrength)?{time:c.time,price:c.high}:null).filter(Boolean),
    lows: candles.map((c,i)=>isPivotLow(candles,i,CONFIG.pivotStrength)?{time:c.time,price:c.low}:null).filter(Boolean)
  };

  return {
    swings, liquidityLevels:[], sweeps:[], zones:result.zones,
    volumeOB:{zones:result.zones,activeZone:latestZone,signals:result.signals,retestSignals:result.retestSignals||[]},
    signal,
    tradePlan:makeTradePlan(latestSignal,candles),
    structureDirection:latestTrend,
    diagnostics:{
      atr:result.st.atr.at(-1),
      latestPrice:latest.close,
      latestSwingHigh:swings.highs.at(-1)?.price??null,
      latestSwingLow:swings.lows.at(-1)?.price??null,
      latestSweep:null,
      confirmation:latestSignal?'ORDER_BLOCK_CREATED':'WAITING_FOR_ORDER_BLOCK',
      volumeAvailable:candles.some(c=>n(c.volume,0)>0),
      volumeConfirmed:latestZone ? Math.max(latestZone.buyPercent,latestZone.sellPercent) >= CONFIG.minVolumePercent : false,
      riskFilter:{passed:!!latestSignal,rejected:false,reason:latestSignal?null:'WAIT'},
      entryRule:latestSignal?'ORDER_BLOCK_CREATION_CLOSE':null,
      entryTime:latestSignal?.time??null,
      bigMoveScore:0,
      rejection:signal.rejection,
      logic:'VOLUME_OB_CREATION_SIGNAL'
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

export function buildHistory(candles = []) {
  const result = buildAnalysis(candles);
  if (!result) return [];
  return result.signals.slice(-200).map((s, index) => {
    const plan = makeTradePlan(s,candles);
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
      entryRule:'ORDER_BLOCK_CREATION_CLOSE',zoneId:s.zoneId
    };
    const startIndex = candles.findIndex(c => Number(c.time) === Number(s.time));
    return resolveHistoricalTrade(base, candles, startIndex);
  });
}
