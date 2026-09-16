// Volume-Trend Order Block Engine [BigBeluga] companion engine.
// Source logic supplied by the user from the TradingView open-source script.
// Keep this engine independent from the canonical Swing Liquidity strategy.

const CONFIG = {
  stLen: 50,
  stMult: 3.5,
  pivotLen: 7,
  bullVolPct: 50,
  bearVolPct: 50,
  showBullRetest: true,
  showBearRetest: true,
  deleteOnBreak: true
};

function sma(values, i, length) {
  if (i < length - 1) return null;
  let sum = 0;
  for (let j = i - length + 1; j <= i; j++) sum += values[j];
  return sum / length;
}

function pivotLow(c, i, len) {
  const p = i - len;
  if (p < len || p + len >= c.length) return null;
  for (let j = p - len; j <= p + len; j++) {
    if (j !== p && c[j].low < c[p].low) return null;
  }
  return c[p].low;
}

function pivotHigh(c, i, len) {
  const p = i - len;
  if (p < len || p + len >= c.length) return null;
  for (let j = p - len; j <= p + len; j++) {
    if (j !== p && c[j].high > c[p].high) return null;
  }
  return c[p].high;
}

function windowBuyRatio(c, i, lookbackLen) {
  let buy = 0;
  let sell = 0;
  for (let j = 0; j <= lookbackLen; j++) {
    const k = i - j;
    if (k < 0) continue;
    const v = Number(c[k].volume || 0);
    if (c[k].close >= c[k].open) buy += v;
    else sell += v;
  }
  const total = buy + sell;
  return total > 0 ? buy / total : 0.5;
}

function overlap(top, bot, activeTop, activeBot) {
  if (!Number.isFinite(activeTop) || !Number.isFinite(activeBot)) return false;
  return !(bot > activeTop || top < activeBot);
}

function buildTrend(c) {
  const rawAtr = c.map((x) => x.high - x.low);
  const atr = c.map((_, i) => sma(rawAtr, i, CONFIG.stLen));
  const upper = new Array(c.length).fill(null);
  const lower = new Array(c.length).fill(null);
  const trend = new Array(c.length).fill(null);
  const stop = new Array(c.length).fill(null);

  for (let i = 0; i < c.length; i++) {
    if (atr[i] == null) {
      trend[i] = 1;
      continue;
    }

    const src = (c[i].high + c[i].low) / 2;
    let ub = src + CONFIG.stMult * atr[i];
    let lb = src - CONFIG.stMult * atr[i];
    const prevUb = i > 0 && upper[i - 1] != null ? upper[i - 1] : 0;
    const prevLb = i > 0 && lower[i - 1] != null ? lower[i - 1] : 0;
    const prevClose = i > 0 ? c[i - 1].close : null;

    ub = ub < prevUb || prevClose < null || prevClose > prevUb ? ub : prevUb;
    lb = lb > prevLb || prevClose < prevLb ? lb : prevLb;
    upper[i] = ub;
    lower[i] = lb;

    const prevAtr = i > 0 ? atr[i - 1] : null;
    const prevStop = i > 0 ? stop[i - 1] : null;
    const prevUpper = i > 0 ? upper[i - 1] : null;
    if (prevAtr == null) trend[i] = 1;
    else if (prevStop === prevUpper) trend[i] = c[i].close > ub ? 1 : -1;
    else trend[i] = c[i].close < lb ? -1 : 1;
    stop[i] = trend[i] === 1 ? lb : ub;
  }
  return { atr, upper, lower, trend, stop };
}

export function analyzeVolumeOB(c) {
  const t = buildTrend(c);
  let active = null;
  const signals = [];
  const zones = [];

  const closeActive = (endIndex, broken = false) => {
    if (!active) return;
    active.endIndex = endIndex;
    active.endTime = c[endIndex]?.time ?? active.startTime;
    active.broken = broken;
    zones.push({ ...active });
    active = null;
  };

  const createZone = (trend, pivotIndex, i) => {
    const atr = Number(t.atr[i] || 0);
    if (!(atr > 0)) return;

    const obTop = trend === 1
      ? Math.min(c[pivotIndex].open, c[pivotIndex].close)
      : Math.max(c[pivotIndex].open, c[pivotIndex].close);
    const obBot = trend === 1 ? obTop - atr : obTop;
    const top = trend === 1 ? obTop : obTop + atr;
    const bottom = trend === 1 ? obBot : obBot;

    if (overlap(top, bottom, active?.top, active?.bottom)) return;
    if (active) closeActive(pivotIndex, false);

    const buyRatio = windowBuyRatio(c, i, CONFIG.pivotLen);
    active = {
      trend,
      top,
      bottom,
      buyRatio,
      sellRatio: 1 - buyRatio,
      split: bottom + (top - bottom) * buyRatio,
      startIndex: pivotIndex,
      startTime: c[pivotIndex]?.time ?? null,
      endIndex: null,
      endTime: null,
      broken: false
    };
  };

  for (let i = 0; i < c.length; i++) {
    const pl = pivotLow(c, i, CONFIG.pivotLen);
    const ph = pivotHigh(c, i, CONFIG.pivotLen);
    const pivotIndex = i - CONFIG.pivotLen;

    if (t.trend[i] === 1 && pl != null) createZone(1, pivotIndex, i);
    if (t.trend[i] === -1 && ph != null) createZone(-1, pivotIndex, i);

    if (active && CONFIG.deleteOnBreak) {
      const isBroken = active.trend === 1
        ? c[i].high < active.bottom
        : c[i].low > active.top;
      if (isBroken) closeActive(i, true);
    }

    const marketChange = i > 0 && t.trend[i] !== t.trend[i - 1];
    const prev = i > 0 ? c[i - 1] : null;
    const buyRetest = !!active && active.trend === 1 && CONFIG.showBullRetest && pl == null &&
      active.buyRatio >= CONFIG.bullVolPct / 100 && !marketChange && !!prev &&
      prev.low <= active.top && c[i].low > active.top;
    const sellRetest = !!active && active.trend === -1 && CONFIG.showBearRetest && ph == null &&
      active.sellRatio >= CONFIG.bearVolPct / 100 && !marketChange && !!prev &&
      prev.high >= active.bottom && c[i].high < active.bottom;

    if (buyRetest || sellRetest) {
      const direction = buyRetest ? 'BUY' : 'SELL';
      signals.push({
        direction,
        time: c[i].time,
        index: i,
        price: c[i].close,
        entry: c[i].close,
        confirmed: true,
        source: 'volume-ob',
        ob: { ...active },
        buyPercent: Math.round(active.buyRatio * 100),
        sellPercent: Math.round(active.sellRatio * 100)
      });
    }
  }

  if (active) {
    active.endIndex = c.length - 1;
    active.endTime = c.at(-1)?.time ?? active.startTime;
    zones.push({ ...active });
  }

  const latest = signals.at(-1) || null;
  return {
    config: CONFIG,
    signal: latest,
    signals,
    activeZone: active ? { ...active } : null,
    trend: t.trend.at(-1) ?? null,
    trendStop: t.stop.at(-1) ?? null,
    zones
  };
}
