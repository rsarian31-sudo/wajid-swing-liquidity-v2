// Gold market data API — SMC v1 (Gold 5M/15M only).
// The old 1M signal system is retired: ALLOWED is 5min/15min only.
// The old v4 engine (src/strategy.js) is NOT used here anymore.
// Gold feed is Twelve Data ONLY. The Yahoo Finance fallback and the XAUS
// fallback (which synthesised OHLC candles from sampled spot prices) have
// been removed. On a Twelve Data failure this returns 503 with diagnostics
// and NO candles — it never silently switches provider and never fabricates
// data. The pipeline HALTs new signals for the market until recovery.
// LICENSING LIMITATION: Twelve Data Basic is internal non-display only and
// is NOT confirmed permitted for production Telegram signals. See README /
// final report. Do not claim otherwise.
import { analyzeSmc } from '../../src/smc-core.js';
import { htfInterval, INTERVAL_SECONDS, SMC_RULE_VERSION } from '../../src/smc-config.js';
import { validateCandles, splitClosed } from '../../src/feed-health.js';
import { dedupeSmcTrades } from '../../src/trade-manager.js';
import { getAuthUser, hasActiveSubscription } from '../../auth.js';
const ALLOWED = new Set(['5min', '15min']);
const FEED_CACHE = new Map();
const FEED_CACHE_TTL_MS = 15000;

export async function onRequest({ request, env, waitUntil }) {
  const authConfigured = !!env.DB;
  const user = authConfigured ? await getAuthUser(request, env) : null;
  if (authConfigured && !user) return json({ success: false, error: 'LOGIN_REQUIRED' }, 401);
  const subscriber = authConfigured ? hasActiveSubscription(user) : true;
  if (request.method !== 'GET') return json({ success: false, error: 'Method not allowed' }, 405);
  try {
    const u = new URL(request.url), interval = ALLOWED.has(u.searchParams.get('interval')) ? u.searchParams.get('interval') : '5min';
    const seconds = INTERVAL_SECONDS[interval];
    const outputsize = Math.min(500, Math.max(100, Number(u.searchParams.get('outputsize') || 300)));
    const cacheKey = interval + ':' + outputsize;
    const cached = FEED_CACHE.get(cacheKey);
    const feedDiagnostics = [];
    let candles = null, provider = 'Twelve Data';
    if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) {
      candles = cached.candles; provider = cached.provider;
      feedDiagnostics.push({ provider, status: 'CACHE', ageMs: Date.now() - cached.at });
    }
    const keys = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2, env.TWELVE_DATA_API_KEY_3, env.TWELVE_DATA_API_KEY_4].map(x => String(x || '').trim()).filter(Boolean);
    if (!candles?.length) {
      if (!keys.length) feedDiagnostics.push({ provider: 'Twelve Data', status: 'NO_KEY' });
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], keySlot = i + 1;
        try {
          const p = new URLSearchParams({ symbol: 'XAU/USD', interval, outputsize: String(outputsize), order: 'ASC', timezone: 'UTC', apikey: key });
          const r = await fetch('https://api.twelvedata.com/time_series?' + p, { headers: { Accept: 'application/json' } });
          const d = await r.json().catch(() => null);
          const creditsLeft = r.headers.get('api-credits-left'), creditsUsed = r.headers.get('api-credits-used');
          if (!r.ok || d?.status === 'error' || !Array.isArray(d?.values)) {
            const code = Number(d?.code || r.status);
            const status = code === 429 ? 'RATE_LIMIT' : code === 401 ? 'INVALID_KEY' : code === 403 ? 'PLAN_OR_PERMISSION' : r.status >= 500 ? 'PROVIDER_ERROR' : 'NO_DATA';
            feedDiagnostics.push({ provider: 'Twelve Data', keySlot, status, httpStatus: r.status, code: Number.isFinite(code) ? code : null, message: String(d?.message || r.statusText || 'No usable data').slice(0, 180), creditsLeft, creditsUsed });
            continue;
          }
          const parsed = d.values.map(x => ({ time: Math.floor(x.timestamp ? Number(x.timestamp) : Date.parse(String(x.datetime || '').replace(' ', 'T') + 'Z') / 1000), open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume || 0) })).filter(x => [x.time, x.open, x.high, x.low, x.close].every(Number.isFinite));
          if (parsed.length) { candles = parsed; provider = 'Twelve Data'; feedDiagnostics.push({ provider: 'Twelve Data', keySlot, status: 'OK', httpStatus: r.status, creditsLeft, creditsUsed, candles: parsed.length }); FEED_CACHE.set(cacheKey, { at: Date.now(), candles, provider }); break; }
          feedDiagnostics.push({ provider: 'Twelve Data', keySlot, status: 'EMPTY', httpStatus: r.status, creditsLeft, creditsUsed });
        } catch (error) { feedDiagnostics.push({ provider: 'Twelve Data', keySlot, status: 'NETWORK_ERROR', message: String(error?.message || error).slice(0, 180) }); }
      }
    }
    if (!candles?.length) {
      // FAIL CLOSED: no Yahoo fallback, no XAUS synthetic candles.
      const rateLimited = feedDiagnostics.some(x => x.status === 'RATE_LIMIT'), planBlocked = feedDiagnostics.some(x => x.status === 'PLAN_OR_PERMISSION'), invalidKey = feedDiagnostics.some(x => x.status === 'INVALID_KEY');
      const reason = rateLimited ? 'Twelve Data API limit reached' : planBlocked ? 'Twelve Data plan/permission does not provide usable XAU/USD data' : invalidKey ? 'Twelve Data API key is invalid' : 'Twelve Data XAU/USD feed failed';
      const detail = feedDiagnostics.map(x => x.provider + (x.keySlot ? ' #' + x.keySlot : '') + '=' + x.status + (x.httpStatus ? ' (' + x.httpStatus + ')' : '')).join(', ');
      throw Error(reason + '. Feed diagnostics: ' + detail);
    }
    const { closed, current } = splitClosed(candles, seconds);
    const validation = validateCandles(closed, seconds);
    const feedHealth = validation.health;
    if (feedHealth === 'HALTED') {
      // Do not serve analysis from bad data. The scheduler already halts
      // new signals; the UI shows HALTED with the reason.
      return json({ success: false, error: 'Gold feed HALTED: ' + validation.issues.join(', '), dataProvider: { name: provider, health: feedHealth }, diagnostics: { feed: feedDiagnostics, validation: validation.issues } }, 503);
    }
    // HTF context from the Durable Object (15min structure direction for 5min).
    let htfDirection = null, trades = [], activeTrades = [], bucket = null;
    if (env.TRADE_STATE) {
      try {
        const id = env.TRADE_STATE.idFromName('xauusd'), stub = env.TRADE_STATE.get(id), stateResponse = await stub.fetch('https://state/'), state = await stateResponse.json();
        const smc = state?.smc?.xau || {};
        const htf = htfInterval('xau', interval);
        htfDirection = htf ? smc[htf]?.structureDirection || null : null;
        bucket = smc[interval] || null;
        trades = dedupeSmcTrades([...(bucket?.trades || []), ...(bucket?.activeTrades || [])]);
        activeTrades = Array.isArray(bucket?.activeTrades) ? bucket.activeTrades : [];
      } catch (_) {}
    }
    const analysis = analyzeSmc(closed, { market: 'xau', htfDirection });
    const completed = trades.filter(t => t.status === 'CLOSED');
    const completedWins = completed.filter(t => Number(t.realizedR) > 0).length;
    const completedLosses = completed.filter(t => Number(t.realizedR) < 0).length;
    const summary = { totalTrades: trades.length, wins: completedWins, losses: completedLosses, open: activeTrades.length, totalR: Number(completed.reduce((s, t) => s + Number(t.realizedR || 0), 0).toFixed(2)) };
    summary.winRate = summary.wins + summary.losses ? Number((summary.wins / (summary.wins + summary.losses) * 100).toFixed(2)) : 0;
    const active = activeTrades[0] || null, activePlan = active ? { entry: active.entry, stopLoss: active.stopLoss, tp1: active.tp1, tp2: active.tp2, tp3: active.tp3, tp4: active.tp4, risk: active.risk, entryRule: active.entryRule } : null;
    // Realised R comes from the trade manager (actual exit price vs entry
    // and risk). TP milestones never count as realised profit while OPEN.
    function accountR(t) { return Number(t?.realizedR || 0); }
    // Trade/candle timestamps in this system are normally Unix seconds.
    // Normalize seconds and milliseconds before applying Malaysia UTC+8.
    function malaysiaDate(ms) {
      const raw = Number(ms);
      const millis = raw > 0 && raw < 1e12 ? raw * 1000 : raw;
      return new Date(millis + 480 * 60000);
    }
    function malaysiaDayKey(ms) {
      const d = malaysiaDate(ms);
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    function malaysiaWeekKey(ms) {
      const d = malaysiaDate(ms);
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    function buildAccountReport(source) {
      // Dollar account P/L is based only on fully CLOSED Gold SMC trades.
      // Open trades and TP milestones do not change the account balance.
      const closedGold = source.filter(t => (t?.interval === '5min' || t?.interval === '15min') && t?.status === 'CLOSED');
      const dayKey = malaysiaDayKey(Date.now());
      const weekKey = malaysiaWeekKey(Date.now());
      const make = (rows, period) => {
        const rs = rows.map(accountR);
        const totalR = Number(rs.reduce((a, b) => a + b, 0).toFixed(2));
        const profit = Number(rs.filter(r => r > 0).reduce((a, b) => a + b * 8, 0).toFixed(2));
        const loss = Number(rs.filter(r => r < 0).reduce((a, b) => a + b * 8, 0).toFixed(2));
        const net = Number((profit + loss).toFixed(2));
        return { period, startingBalance: 100, riskPerTrade: 8, trades: rows.length, profit, loss, net, totalR, currentBalance: Number((100 + net).toFixed(2)) };
      };
      const daily = closedGold.filter(t => malaysiaDayKey(t.exitTime || t.signalTime || t.createdAt) === dayKey);
      const weekly = closedGold.filter(t => malaysiaWeekKey(t.exitTime || t.signalTime || t.createdAt) === weekKey);
      return { daily: make(daily, 'DAILY'), weekly: make(weekly, 'WEEKLY') };
    }
    const accountReport = buildAccountReport(trades);
    if (!subscriber) {
      const publicTrades = trades.map(t => ({ id: t.id, interval: t.interval, signalTime: t.signalTime, status: t.status || 'CLOSED', result: t.status === 'CLOSED' ? t.result : 'OPEN', realizedR: Number(t.realizedR || 0), hitTPs: Array.isArray(t.hitTPs) ? t.hitTPs : [] }));
      return json({ success: true, member: { subscriptionStatus: 'inactive' }, strategy: { id: SMC_RULE_VERSION, name: 'Gold SMC · Sweep/MSS/BOS/OB/FVG', symbol: 'XAU/USD' }, market: { symbol: 'XAU/USD' }, signal: { direction: 'LOCKED' }, tradePlan: null, activeTrade: null, activeTrades: [], candles: [], swings: { highs: [], lows: [] }, liquidity: { levels: [], sweeps: [] }, diagnostics: {}, volumeOB: null, history: { summary, trades: publicTrades }, accountReport, dataProvider: { name: provider, health: feedHealth } });
    }
    return json({
      success: true,
      strategy: { id: SMC_RULE_VERSION, name: 'Gold SMC · Sweep/MSS/BOS/OB/FVG', symbol: 'XAU/USD', interval },
      dataProvider: { name: provider, health: feedHealth, lastError: feedHealth === 'HEALTHY' ? null : validation.issues.join(', ') },
      market: { symbol: 'XAU/USD', interval, price: closed.at(-1)?.close, lastCandleTime: closed.at(-1)?.time, candleCount: closed.length, analysisCandleCount: closed.length },
      candles: closed, formingCandle: current || null,
      swings: analysis.swings, liquidity: { levels: analysis.liquidityLevels, sweeps: analysis.sweeps },
      signal: analysis.signal, tradePlan: activePlan || analysis.tradePlan, activeTrade: active, activeTrades,
      diagnostics: { ...(analysis.diagnostics || {}), feed: feedDiagnostics, validation: validation.issues },
      news: null, volumeOB: null, history: { summary, trades }, accountReport,
      liveSignalsEnabled: String(env.LIVE_SIGNALS_ENABLED || '').trim().toLowerCase() === 'true',
    });
  } catch (e) { return json({ success: false, error: e?.message || 'Market data error' }, 503); }
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }); }
