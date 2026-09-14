import { onRequest as dataRequest } from './functions/api/data.js';
import { onRequest as healthRequest } from './functions/api/health.js';
import { CONFIG, analyze, buildHistory } from './src/strategy.js';
import { WajidTradeState } from './state.js';

const INTERVALS = ['5min', '15min'];
const SYMBOL = 'XAU/USD';
const DATA_URL = 'https://api.twelvedata.com/time_series';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      return dataRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }

    if (url.pathname === '/api/health') {
      return healthRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    const intervals = minute % 15 === 0 ? INTERVALS : ['5min'];
    for (const interval of intervals) {
      ctx.waitUntil(runInterval(interval, env));
    }
  }
};

async function runInterval(interval, env) {
  if (!env.TWELVE_DATA_API_KEY || !env.TRADE_STATE) return;

  const candles = await fetchClosedCandles(interval, env.TWELVE_DATA_API_KEY);
  if (candles.length < 50) return;

  const analysis = analyze(candles);
  const id = env.TRADE_STATE.idFromName('xauusd');
  const state = env.TRADE_STATE.get(id);
  const current = await getState(state);
  const bucket = current.intervals[interval] || { active: null, trades: [], lastSignalId: null, lastCandleTime: null };

  if (!bucket.trades.length) {
    const seeded = buildHistory(candles, analysis.swings, SYMBOL).filter((t) => t.result !== 'OPEN');
    if (seeded.length) bucket.trades = seeded.slice(-200);
  }

  if (bucket.active) {
    const events = advanceActiveTrade(bucket.active, candles);
    for (const event of events.notifications) await sendTelegram(env, event);
    if (events.closed) {
      bucket.trades.push(events.closed);
      bucket.trades = bucket.trades.slice(-200);
      bucket.active = null;
    } else {
      bucket.active = events.active;
    }
  }

  const signal = analysis.signal;
  const plan = analysis.tradePlan;
  const signalId = signal?.direction && signal.direction !== 'WAIT' && signal.time
    ? `${interval}:${signal.time}:${signal.direction}`
    : null;

  if (!bucket.active && signalId && bucket.lastSignalId !== signalId && plan) {
    let active = makeActiveTrade(interval, signal, plan, analysis);
    bucket.lastSignalId = signalId;
    const telegramResult = await sendTelegram(env, {
      type: 'SIGNAL',
      interval,
      trade: active,
      probability: signal.probability,
      score: signal.score
    });
    if (telegramResult?.message_id) {
      active = { ...active, telegramMessageId: telegramResult.message_id };
    }
    bucket.active = active;

    const events = advanceActiveTrade(active, candles);
    for (const event of events.notifications) await sendTelegram(env, event);
    if (events.closed) {
      bucket.trades.push(events.closed);
      bucket.trades = bucket.trades.slice(-200);
      bucket.active = null;
    } else {
      bucket.active = events.active;
    }
  }

  bucket.lastCandleTime = candles.at(-1)?.time ?? null;
  current.intervals[interval] = bucket;
  await putState(state, current);
}

async function fetchClosedCandles(interval, apiKey) {
  const params = new URLSearchParams({
    symbol: SYMBOL,
    interval,
    outputsize: String(CONFIG.outputSize),
    order: 'ASC',
    timezone: 'UTC',
    apikey: apiKey
  });
  const response = await fetch(`${DATA_URL}?${params}`);
  const data = await response.json();
  if (!response.ok || data?.status === 'error' || data?.code) {
    throw new Error(data?.message || 'Twelve Data request failed');
  }

  const seconds = interval === '5min' ? 300 : 900;
  const now = Math.floor(Date.now() / 1000);
  const candles = (data.values || []).map((x) => ({
    time: Math.floor(x.timestamp ? Number(x.timestamp) : Date.parse(String(x.datetime || '')) / 1000),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume || 0)
  })).filter((x) => [x.time, x.open, x.high, x.low, x.close].every(Number.isFinite));

  candles.sort((a, b) => a.time - b.time);
  const unique = [];
  const seen = new Set();
  for (const candle of candles) {
    if (!seen.has(candle.time)) {
      seen.add(candle.time);
      unique.push(candle);
    }
  }
  while (unique.length && unique.at(-1).time + seconds > now) unique.pop();
  return unique;
}

function makeActiveTrade(interval, signal, plan, analysis) {
  return {
    id: `${interval}:${signal.time}:${signal.direction}`,
    interval,
    direction: signal.direction,
    signalTime: signal.time,
    signalPrice: Number(signal.price.toFixed(2)),
    probability: signal.probability,
    score: signal.score,
    entry: Number(plan.entry.toFixed(2)),
    stopLoss: Number(plan.stopLoss.toFixed(2)),
    tp1: Number(plan.tp1.toFixed(2)),
    tp2: Number(plan.tp2.toFixed(2)),
    tp3: Number(plan.tp3.toFixed(2)),
    risk: Number(plan.risk.toFixed(2)),
    sweep: analysis.signal?.sweep || null,
    tp1Hit: false,
    createdAt: Date.now()
  };
}

function advanceActiveTrade(active, candles) {
  const notifications = [];
  let next = { ...active };
  const start = candles.findIndex((c) => c.time >= active.signalTime);
  if (start < 0) return { active: next, closed: null, notifications };

  for (let i = start; i < candles.length; i++) {
    const candle = candles[i];
    const hitTp1 = active.direction === 'BUY' ? candle.high >= active.tp1 : candle.low <= active.tp1;
    const hitSl = active.direction === 'BUY' ? candle.low <= active.stopLoss : candle.high >= active.stopLoss;
    const hitTp2 = active.direction === 'BUY' ? candle.high >= active.tp2 : candle.low <= active.tp2;

    if (!next.tp1Hit && hitTp1) {
      next.tp1Hit = true;
      notifications.push({ type: 'TP1', interval: active.interval, trade: next, candleTime: candle.time });
    }

    if (hitSl && hitTp2) {
      return {
        active: null,
        closed: closeTrade(next, 'LOSS', -1, next.stopLoss, candle.time, 'SL and TP2 touched in same candle; conservative SL'),
        notifications: [...notifications, { type: 'LOSS', interval: active.interval, trade: next, candleTime: candle.time }]
      };
    }
    if (hitSl) {
      return {
        active: null,
        closed: closeTrade(next, 'LOSS', -1, next.stopLoss, candle.time, 'SL hit before TP2'),
        notifications: [...notifications, { type: 'LOSS', interval: active.interval, trade: next, candleTime: candle.time }]
      };
    }
    if (hitTp2) {
      return {
        active: null,
        closed: closeTrade(next, 'WIN', 2, next.tp2, candle.time, 'TP2 hit'),
        notifications: [...notifications, { type: 'WIN', interval: active.interval, trade: next, candleTime: candle.time }]
      };
    }
  }

  return { active: next, closed: null, notifications };
}

function closeTrade(trade, result, realizedR, exit, exitTime, reason) {
  return {
    id: trade.id,
    interval: trade.interval,
    direction: trade.direction,
    signalTime: trade.signalTime,
    swingTime: trade.sweep?.level?.time ?? null,
    swingType: trade.sweep?.level?.type ?? null,
    swingPrice: Number.isFinite(Number(trade.sweep?.level?.price)) ? Number(Number(trade.sweep.level.price).toFixed(2)) : null,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    tp1: trade.tp1,
    tp2: trade.tp2,
    tp3: trade.tp3,
    risk: trade.risk,
    realizedR,
    result,
    status: 'CLOSED',
    exit: Number(exit.toFixed(2)),
    exitTime,
    reason
  };
}

async function getState(stub) {
  const response = await stub.fetch('https://state/');
  return response.json();
}

async function putState(stub, state) {
  await stub.fetch('https://state/replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  });
}

async function sendTelegram(env, event) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;

  const trade = event.trade;
  const tf = event.interval === '5min' ? '5M' : '15M';
  let text = '';

  if (event.type === 'SIGNAL') {
    text = [
      '🟢 WAJID SWING LIQUIDITY',
      `XAU/USD · ${tf}`,
      '',
      `📈 SIGNAL: ${trade.direction}`,
      `🎯 Entry: ${trade.entry}`,
      `🛑 SL: ${trade.stopLoss}`,
      `1️⃣ TP1: ${trade.tp1}`,
      `2️⃣ TP2: ${trade.tp2} (WIN)`,
      `3️⃣ TP3: ${trade.tp3}`,
      `📊 Probability: ${trade.probability}%`,
      `⭐ Score: ${trade.score}`,
      '',
      '🔒 Server controlled · Non-repainting'
    ].join('\n');
  } else if (event.type === 'TP1') {
    text = `🟡 WAJID ${tf} · XAU/USD\n\nTP1 REACHED · +1R milestone\nEntry: ${trade.entry}\nTP1: ${trade.tp1}`;
  } else if (event.type === 'WIN') {
    text = `🏆 WAJID ${tf} · XAU/USD\n\n✅ WIN · TP2 reached\nEntry: ${trade.entry}\nTP2: ${trade.tp2}\nResult: +2R`;
  } else if (event.type === 'LOSS') {
    text = `🔴 WAJID ${tf} · XAU/USD\n\n❌ LOSS · SL reached\nEntry: ${trade.entry}\nSL: ${trade.stopLoss}\nResult: -1R`;
  } else {
    return false;
  }

  const payload = { chat_id: env.TELEGRAM_CHAT_ID, text };
  if (event.type !== 'SIGNAL' && Number.isFinite(Number(trade.telegramMessageId))) {
    payload.reply_parameters = {
      message_id: Number(trade.telegramMessageId),
      allow_sending_without_reply: true
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) return false;

  const data = await response.json();
  return data?.ok && data?.result ? data.result : false;
}

export { WajidTradeState };
