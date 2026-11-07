// SMC trade manager — KB §15 trade management, exact rules.
//
// TP1 HIT: record TP1, move SL to Entry (break-even), keep open.
// TP2 HIT: record TP2, keep SL at Entry, keep open.
// TP3 HIT: record TP3, keep open.
// TP4 HIT: record TP4, close successfully.
// SL HIT:  record SL, close the trade.
// - Multiple simultaneous trades allowed; every trade has an independent ID.
// - Every TP/SL event is recorded in trade.events with time and price.
// - TP2 is NEVER a completed trade.
// - Realized R is computed from the ACTUAL exit price vs entry and risk
//   ((exit - entry) / risk, signed by direction) — never by summing R
//   multiples for targets that were not exited (KB §15).
// - Same-candle TP + SL: TP milestones are evaluated before the stop within
//   a candle (status quo from the existing repo). A2 is OPEN; the audit
//   recommended SL-first, but changing the ordering is an owner decision.

export function makeSmcTrade(market, interval, signal, plan, opts = {}) {
  const id = `${market}:${interval}:${signal.time}:${signal.direction}`;
  return {
    id,
    market,
    interval,
    direction: signal.direction,
    signalTime: signal.time,
    entryTime: signal.time,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    originalStopLoss: plan.stopLoss,
    tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3, tp4: plan.tp4,
    risk: plan.risk,
    tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
    hitTPs: [],
    events: [{ type: 'SIGNAL', time: signal.time, price: plan.entry, note: 'SMC confirmed setup' }],
    realizedR: null,
    result: 'OPEN',
    status: 'OPEN',
    exit: null,
    exitTime: null,
    reason: null,
    paper: opts.paper === true,
    live: opts.paper !== true,
    confirmations: signal.confirmations || null,
    entryRule: plan.entryRule || 'SMC_SWEEP_MSS_BOS_OB_FVG_RETEST_CLOSE',
    createdAt: Date.now(),
    lastProcessedTime: signal.time - 1,
    telegramMessageIds: {},
  };
}

function closeSmcTrade(trade, result, exit, exitTime, reason) {
  const signed = trade.direction === 'BUY' ? 1 : -1;
  const realizedR = Number((((exit - trade.entry) * signed) / trade.risk).toFixed(2));
  return {
    ...trade,
    realizedR,
    result,
    status: 'CLOSED',
    exit: Number(Number(exit).toFixed(2)),
    exitTime,
    reason,
  };
}

// Advance one open trade through closed candles.
// Returns { active, closed, notifications }.
// notifications: [{ type, trade, candleTime }] where type is
// TP1 | TP2 | TP3 | TP4 | SL | BREAK_EVEN.
export function advanceSmcTrade(active, candles) {
  const notifications = [];
  const next = { ...active, hitTPs: [...(active.hitTPs || [])], events: [...(active.events || [])] };
  const lastProcessed = Number.isFinite(Number(active.lastProcessedTime))
    ? Number(active.lastProcessedTime)
    : Number(active.signalTime) - 1;
  const start = candles.findIndex(c => Number(c.time) > lastProcessed);
  if (start < 0) return { active: next, closed: null, notifications };

  for (let i = start; i < candles.length; i++) {
    const candle = candles[i];
    next.lastProcessedTime = candle.time;

    const levels = [
      ['TP1', 1, 'tp1', 'tp1Hit'],
      ['TP2', 2, 'tp2', 'tp2Hit'],
      ['TP3', 3, 'tp3', 'tp3Hit'],
      ['TP4', 4, 'tp4', 'tp4Hit'],
    ];
    for (const [label, , key, flag] of levels) {
      const hit = active.direction === 'BUY' ? candle.high >= active[key] : candle.low <= active[key];
      if (hit && !next[flag]) {
        next[flag] = true;
        next.hitTPs.push(label);
        next.events.push({ type: label, time: candle.time, price: active[key] });
        notifications.push({ type: label, trade: { ...next }, candleTime: candle.time });
        if (label === 'TP1') next.stopLoss = Number(next.entry.toFixed(2)); // break-even
        if (label === 'TP2') next.stopLoss = Number(next.entry.toFixed(2)); // stays at Entry
        if (label === 'TP4') {
          return { active: null, closed: closeSmcTrade(next, 'TP4 HIT', next.tp4, candle.time, 'TP4_FULL'), notifications };
        }
      }
    }

    // Current stop: original SL before TP1, Entry (break-even) after TP1.
    const currentStop = Number(next.stopLoss);
    const sl = active.direction === 'BUY' ? candle.low <= currentStop : candle.high >= currentStop;
    if (sl) {
      if (next.tp1Hit) {
        // Stop is Entry: break-even close (0R actual), not a loss.
        next.events.push({ type: 'BREAK_EVEN', time: candle.time, price: currentStop });
        notifications.push({ type: 'BREAK_EVEN', trade: { ...next }, candleTime: candle.time });
        return { active: null, closed: closeSmcTrade(next, 'BREAK EVEN', currentStop, candle.time, 'SL_AT_ENTRY_AFTER_TP1'), notifications };
      }
      next.events.push({ type: 'SL', time: candle.time, price: currentStop });
      notifications.push({ type: 'SL', trade: { ...next }, candleTime: candle.time });
      return { active: null, closed: closeSmcTrade(next, 'SL HIT', currentStop, candle.time, 'SL_BEFORE_TP1'), notifications };
    }
  }
  return { active: next, closed: null, notifications };
}

export function tradeKey(t) {
  return `${t.market || ''}:${t.interval || ''}:${t.signalTime || ''}:${t.direction || ''}`;
}

export function dedupeSmcTrades(trades = []) {
  const map = new Map();
  for (const trade of trades || []) {
    if (!trade?.id) continue;
    const prev = map.get(trade.id);
    if (!prev) { map.set(trade.id, trade); continue; }
    const score = t => Number(!!t.exitTime) * 4 + Number(t.status === 'CLOSED') * 2 + (Array.isArray(t.hitTPs) ? t.hitTPs.length : 0);
    if (score(trade) >= score(prev)) map.set(trade.id, trade);
  }
  return [...map.values()].sort((a, b) => Number(a.signalTime || 0) - Number(b.signalTime || 0));
}
