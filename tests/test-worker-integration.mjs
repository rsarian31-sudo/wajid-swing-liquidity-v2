// Integration tests for the SMC worker pipelines (paper mode, mocked I/O).
// Run: node --test tests/test-worker-integration.mjs   (Node >= 20)
// No real network, no Telegram, no Cloudflare: fetch and the Durable
// Object namespace are mocked in-memory. LIVE_SIGNALS_ENABLED is unset,
// so the pipelines must run in PAPER mode and never call Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
const { default: worker } = await import('../worker.js');

// --- textbook BUY series (same construction as tests/test-smc.mjs) ---
function C(time, open, high, low, close, volume = 100) {
  return { time, open, high, low, close, volume };
}
function textbookBuy() {
  const out = [];
  let t = 0;
  const leg = (closes, wiggle = 0.15) => {
    for (const close of closes) {
      const open = out.length ? out.at(-1).close : close;
      const high = Math.max(open, close) + wiggle;
      const low = Math.min(open, close) - wiggle;
      out.push(C(t++ * 300, open, high, low, close));
    }
  };
  let p = 108;
  for (let i = 0; i < 95; i++) { p -= 0.045; leg([p], 0.06); }
  leg([104.6, 105.2, 105.9, 106.5, 107.0]);
  leg([106.2, 105.3, 104.4, 103.4, 102.4, 101.4, 100.6, 100.0]);
  leg([100.9, 101.8, 102.7, 103.6, 104.0]);
  leg([103.2, 102.3, 101.4, 100.6, 99.9, 98.4, 99.6, 100.4]);
  leg([101.8, 103.4, 105.2, 107.3, 108.0]);
  leg([107.2, 106.1, 104.8, 103.2, 101.6, 99.6]);
  leg([102.5], 0.2);
  return out;
}
// Synthetic BTC candles: aligned, contiguous, no forced setup.
function btcWalk(n, intervalSec, startPrice = 80000) {
  let s = 7, price = startPrice;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor((now - n * intervalSec) / intervalSec) * intervalSec;
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    price = Math.max(1000, price + (rnd() - 0.5) * 120);
    out.push({ time: base + i * intervalSec, open, high: Math.max(open, price) + rnd() * 20, low: Math.min(open, price) - rnd() * 20, close: price, volume: 10 });
  }
  return out;
}

// --- in-memory Durable Object namespace mock ---
function makeNamespace() {
  const store = new Map();
  return {
    idFromName: (name) => ({ __mockId: name }),
    get: (id) => {
      const name = id.__mockId;
      if (!store.has(name)) store.set(name, { intervals: {}, telegram: {}, schedulerLocks: {} });
      return {
        fetch: async (url, init = {}) => {
          const u = new URL(url);
          const state = store.get(name);
          if (init.method === 'POST' && u.pathname === '/replace') {
            store.set(name, JSON.parse(init.body));
            return Response.json(store.get(name));
          }
          if (init.method === 'POST' && u.pathname === '/lock') return new Response('{}', { status: 200 });
          if (init.method === 'POST' && u.pathname === '/unlock') return new Response('{}', { status: 200 });
          return Response.json(state);
        },
      };
    },
    _store: store,
  };
}

function makeFetch({ goldCandles = null, goldCandles15 = null, goldOk = true, btcCandles = null } = {}) {
  const telegramCalls = [];
  const calls = { telegram: telegramCalls, twelveData: 0, bitget: 0 };
  const fetchMock = async (url, init) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      telegramCalls.push(u);
      return Response.json({ ok: true, result: { message_id: 123 } });
    }
    if (u.includes('api.twelvedata.com')) {
      calls.twelveData++;
      if (!goldOk) return Response.json({ status: 'error', code: 500, message: 'simulated provider failure' }, { status: 500 });
      // Twelve Data returns different candles per interval in reality;
      // the mock does the same (5min = textbook setup, 15min = HTF uptrend).
      const interval = new URL(u).searchParams.get('interval');
      const series = interval === '15min' ? (goldCandles15 || goldCandles || []) : (goldCandles || []);
      const values = series.map(c => ({
        datetime: new Date(c.time * 1000).toISOString().replace('T', ' ').slice(0, 19),
        open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: String(c.volume || 0),
      }));
      return Response.json({ status: 'ok', values });
    }
    if (u.includes('api.bitget.com')) {
      calls.bitget++;
      if (u.includes('/market/candles')) {
        const params = new URL(u).searchParams;
        const interval = params.get('interval');
        const seconds = { '15m': 900, '30m': 1800, '1H': 3600 }[interval];
        const rows = (btcCandles?.[interval] || btcWalk(200, seconds)).map(c => [String(c.time * 1000), String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume || 0), '0']);
        return Response.json({ code: '00000', msg: 'success', data: rows });
      }
      if (u.includes('/market/tickers')) {
        return Response.json({ code: '00000', msg: 'success', data: [{ symbol: 'BTCUSDT', lastPrice: '80000', bid1Price: '79990', ask1Price: '80010' }] });
      }
      return Response.json({ code: '00000', msg: 'success', data: [] });
    }
    // Google News RSS and anything else: fail closed, pipeline must cope.
    return new Response('mock: no upstream', { status: 500 });
  };
  return { fetchMock, calls };
}

test('worker: scheduled() runs SMC pipelines in paper mode, Gold 5M signal recorded, no Telegram calls', async () => {
  const ns = makeNamespace();
  // Textbook series is epoch-based; shift it so the last candle is now
  // (otherwise the feed validator correctly flags it STALE).
  const raw = textbookBuy();
  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosed = Math.floor(nowSec / 300) * 300 - 300; // start of the last COMPLETED 5-min candle (the candle starting at the floor boundary is still forming)
  const goldCandles = raw.map((c, i) => ({ ...c, time: lastClosed - (raw.length - 1 - i) * 300 }));
  // One trailing FORMING candle after the reaction candle: the pipeline
  // only signals on closed candles, so the reaction candle is closed only
  // once this forming candle exists (correct candle-close behaviour).
  goldCandles.push({ time: lastClosed + 300, open: 102.5, high: 102.6, low: 102.4, close: 102.5, volume: 100 });
  // 15min HTF series: a clean uptrend at XAU scale so the HTF context is
  // UP (not a veto for the 5min BUY). Aligned to 900s, last candle forming.
  const last15 = Math.floor(nowSec / 900) * 900 - 900; // start of the last completed 15-min candle
  const goldCandles15 = [];
  {
    let p = 100;
    for (let i = 0; i < 120; i++) {
      p += 0.07;
      const open = p - 0.07;
      goldCandles15.push({ time: last15 - (120 - 1 - i) * 900, open, high: p + 0.1, low: open - 0.1, close: p, volume: 100 });
    }
    goldCandles15.push({ time: last15 + 900, open: p, high: p + 0.1, low: p - 0.1, close: p, volume: 100 });
  }
  const { fetchMock, calls } = makeFetch({ goldCandles, goldCandles15 });
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const env = { TRADE_STATE: ns, TWELVE_DATA_API_KEY: 'test-key' };
    await worker.scheduled(null, env, {});
    assert.equal(calls.telegram.length, 0, 'paper mode must not call Telegram');
    assert.ok(calls.twelveData > 0, 'Gold feed was read');
    assert.ok(calls.bitget > 0, 'BTC feed was read');
    const xau = ns._store.get('xauusd');
    const b5 = xau?.smc?.xau?.['5min'];
    assert.ok(b5, 'Gold 5min bucket exists');
    assert.equal(b5.feedHealth, 'HEALTHY', 'Gold 5min feed HEALTHY, got ' + b5.feedHealth);
    assert.equal(b5.activeTrades.length, 1, 'one paper Gold trade from the textbook setup');
    assert.equal(b5.activeTrades[0].direction, 'BUY');
    assert.equal(b5.activeTrades[0].paper, true, 'trade is flagged paper');
    assert.ok(b5.lastSignalId, 'lastSignalId recorded');
    const btc = ns._store.get('btc');
    assert.ok(btc?.smc?.btc?.['15min'], 'BTC 15min bucket exists');
    assert.equal(btc.smc.btc['15min'].feedHealth, 'HEALTHY');

    // Second run: same setup must NOT duplicate the trade (dedup by id).
    await worker.scheduled(null, env, {});
    const xau2 = ns._store.get('xauusd');
    assert.equal(xau2.smc.xau['5min'].activeTrades.length, 1, 'no duplicate trade on re-run');
    assert.equal(calls.telegram.length, 0, 'still no Telegram calls');

    // /api/health reflects the pipeline state.
    const healthRes = await worker.fetch(new Request('https://test/api/health'), env, { waitUntil: () => {} });
    const health = await healthRes.json();
    assert.equal(health.ruleVersion, 'smc-v1');
    assert.equal(health.liveSignalsEnabled, false);
    assert.equal(health.markets.xau['5min'].feedHealth, 'HEALTHY');
    assert.equal(health.markets.xau['5min'].activeTrades, 1);
    assert.deepEqual(health.timeframes, { xau: ['5min', '15min'], btc: ['15min', '30min', '1H'] });

    // /api/btc-data serves Bitget candles + analysis without Telegram.
    const btcRes = await worker.fetch(new Request('https://test/api/btc-data?interval=15min'), env, { waitUntil: () => {} });
    const btcData = await btcRes.json();
    assert.equal(btcData.success, true);
    assert.equal(btcData.strategy.id, 'smc-v1');
    assert.equal(btcData.dataProvider.name, 'Bitget');
    assert.ok(Array.isArray(btcData.candles) && btcData.candles.length >= 50);
    assert.ok(['WAIT', 'BUY', 'SELL'].includes(btcData.signal.direction));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('worker: Gold feed failure HALTs the Gold pipelines and creates no trades', async () => {
  const ns = makeNamespace();
  const { fetchMock, calls } = makeFetch({ goldOk: false });
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const env = { TRADE_STATE: ns, TWELVE_DATA_API_KEY: 'test-key' };
    await worker.scheduled(null, env, {});
    assert.equal(calls.telegram.length, 0, 'no Telegram on halt');
    const xau = ns._store.get('xauusd');
    assert.equal(xau?.smc?.xau?.['5min']?.feedHealth, 'HALTED', 'Gold 5min HALTED on provider failure');
    assert.equal(xau?.smc?.xau?.['15min']?.feedHealth, 'HALTED');
    assert.equal((xau?.smc?.xau?.['5min']?.activeTrades || []).length, 0, 'no trades on halted feed');
    // BTC pipelines still ran (independent state).
    const btc = ns._store.get('btc');
    assert.equal(btc?.smc?.btc?.['15min']?.feedHealth, 'HEALTHY', 'BTC unaffected by Gold halt');
  } finally {
    globalThis.fetch = origFetch;
  }
});
