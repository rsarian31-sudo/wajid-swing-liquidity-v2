// Health endpoint — real per-market/per-timeframe state, not static JSON.
// Reports the SMC v1 pipelines (Gold 5M/15M, BTC 15M/30M/1H), each with
// feed health (HEALTHY/DEGRADED/HALTED/UNKNOWN), last feed update, last
// candle time, active/closed trade counts and the last feed error.
// 1M is retired; XAU 1H and BTC 45M are not implemented (final timeframes).
export async function onRequest({ request, env }) {
  const markets = {
    xau: { '5min': emptyBucket(), '15min': emptyBucket() },
    btc: { '15min': emptyBucket(), '30min': emptyBucket(), '1H': emptyBucket() },
  };
  let stateError = null;
  if (env.TRADE_STATE) {
    for (const [market, stubName, intervals] of [['xau', 'xauusd', ['5min', '15min']], ['btc', 'btc', ['15min', '30min', '1H']]]) {
      try {
        const stub = env.TRADE_STATE.get(env.TRADE_STATE.idFromName(stubName));
        const state = await (await stub.fetch('https://state/')).json();
        for (const interval of intervals) {
          const b = state?.smc?.[market]?.[interval];
          if (!b) continue;
          markets[market][interval] = {
            feedHealth: b.feedHealth || 'UNKNOWN',
            lastFeedUpdate: b.lastFeedUpdate || null,
            lastCandleTime: b.lastCandleTime || null,
            lastFeedError: b.lastFeedError || null,
            activeTrades: Array.isArray(b.activeTrades) ? b.activeTrades.length : 0,
            totalTrades: Array.isArray(b.trades) ? b.trades.length : 0,
            structureDirection: b.structureDirection || null,
          };
        }
      } catch (error) {
        stateError = String(error?.message || error).slice(0, 160);
      }
    }
  }
  const body = {
    ok: true,
    service: 'wajid-swing-liquidity-v2',
    ruleVersion: 'smc-v1',
    timeframes: { xau: ['5min', '15min'], btc: ['15min', '30min', '1H'] },
    liveSignalsEnabled: String(env.LIVE_SIGNALS_ENABLED || '').trim().toLowerCase() === 'true',
    markets,
    stateError,
    note: '1M retired. XAU 1H and BTC 45M are not signal timeframes (final timeframes). Gold feed: Twelve Data only (Basic licensing limitation applies — internal non-display only, not confirmed permitted for production Telegram signals). BTC feed: Bitget V3 public (SPOT BTCUSDT). WebSocket not verified; 1-minute cron polling over REST.',
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
function emptyBucket() {
  return { feedHealth: 'UNKNOWN', lastFeedUpdate: null, lastCandleTime: null, lastFeedError: null, activeTrades: 0, totalTrades: 0, structureDirection: null };
}
