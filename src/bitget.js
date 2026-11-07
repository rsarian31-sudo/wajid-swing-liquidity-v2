// Bitget V3 public market data adapter — BTC SPOT BTCUSDT only.
// Verified live 2026-11-07 from this environment:
//   GET /api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=15m
//     → code "00000", rows [timestampMs, open, high, low, close, baseVol, quoteVol],
//       timestamps interval-aligned, closes chain into next opens.
//   GET /api/v3/market/tickers?category=SPOT&symbol=BTCUSDT
//     → lastPrice, bid1Price, ask1Price, 24h high/low/volume.
//   GET /api/v3/market/history-candles (same params, >90 days, 90-day max range)
//     → code "00000".
//   GET /api/v3/market/time → serverTime (ms).
// Rate limit: 20/sec/IP (docs). No API key. Public data is free.
// WebSocket: NOT verified. Two attempts from this environment (candle15m and
// ticker channels on wss://ws.bitget.com/v2/ws/public) produced no message /
// a connection error, and Cloudflare Workers free cannot hold a long-lived
// outbound WebSocket for 24/7 streaming anyway. The system therefore uses
// 1-minute cron polling over REST. Do NOT claim WebSocket streaming works.

import { BITGET_INTERVAL } from './smc-config.js';
import { splitClosed } from './feed-health.js';

const BASE = 'https://api.bitget.com';
const TICKER_TTL_MS = 20_000;
const CANDLES_TTL_MS = 20_000;
const tickerCache = new Map();
const candlesCache = new Map();

async function bitgetGet(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.code !== '00000' || !Array.isArray(data?.data)) {
    throw new Error(
      `Bitget ${path} failed: HTTP ${res.status} code=${data?.code ?? 'n/a'} msg=${String(data?.msg ?? res.statusText ?? '').slice(0, 160)}`
    );
  }
  return data.data;
}

function parseRows(rows) {
  return rows
    .map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] || 0),
    }))
    .filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

// Fetch closed BTC candles for one interval. Returns { closed, current, provider, fetchedAt }.
// The forming candle is NEVER included in `closed`.
export async function fetchBitgetCandles(interval, limit = 300, opts = {}) {
  const bitgetInterval = BITGET_INTERVAL[interval];
  if (!bitgetInterval) throw new Error('Bitget: unsupported interval ' + String(interval));
  const seconds = { '15min': 900, '30min': 1800, '1H': 3600 }[interval];
  const endTimeMs = Number(opts.endTimeMs) || null;
  const cacheKey = interval + ':' + limit + (endTimeMs ? ':' + endTimeMs : '');
  const cached = endTimeMs ? null : candlesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CANDLES_TTL_MS) return cached.value;

  const rows = await bitgetGet('/api/v3/market/candles', {
    category: 'SPOT',
    symbol: 'BTCUSDT',
    interval: bitgetInterval,
    type: 'market',
    limit: Math.min(1000, Math.max(1, limit)),
    ...(endTimeMs ? { endTime: endTimeMs } : {}),
  });
  const all = parseRows(rows);
  const { closed, current } = splitClosed(all, seconds);
  const value = { closed, current, provider: 'Bitget', fetchedAt: Date.now() };
  candlesCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// Historical candles older than 90 days (history-candles endpoint, 90-day max range).
export async function fetchBitgetHistoryCandles(interval, startTimeMs, endTimeMs, limit = 100) {
  const bitgetInterval = BITGET_INTERVAL[interval];
  if (!bitgetInterval) throw new Error('Bitget: unsupported interval ' + String(interval));
  const rows = await bitgetGet('/api/v3/market/history-candles', {
    category: 'SPOT',
    symbol: 'BTCUSDT',
    interval: bitgetInterval,
    type: 'market',
    startTime: startTimeMs,
    endTime: endTimeMs,
    limit: Math.min(100, Math.max(1, limit)),
  });
  return parseRows(rows);
}

export async function fetchBitgetTicker() {
  const cached = tickerCache.get('BTCUSDT');
  if (cached && Date.now() - cached.at < TICKER_TTL_MS) return cached.value;
  const data = await bitgetGet('/api/v3/market/tickers', { category: 'SPOT', symbol: 'BTCUSDT' });
  const t = data[0] || {};
  const value = {
    symbol: 'BTCUSDT',
    last: Number(t.lastPrice),
    bid: Number(t.bid1Price),
    ask: Number(t.ask1Price),
    high24h: Number(t.highPrice24h),
    low24h: Number(t.lowPrice24h),
    volume24h: Number(t.volume24h),
    ts: Number(t.ts) || Date.now(),
  };
  if (!Number.isFinite(value.last) || value.last <= 0) throw new Error('Bitget ticker returned no usable last price');
  tickerCache.set('BTCUSDT', { at: Date.now(), value });
  return value;
}

export async function fetchBitgetServerTime() {
  const res = await fetch(BASE + '/api/v3/market/time', { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.code !== '00000') throw new Error('Bitget server time failed');
  return { serverTimeMs: Number(data.data.serverTime), fetchedAt: Date.now() };
}
