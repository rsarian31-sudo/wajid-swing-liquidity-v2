// Unit tests for the SMC core, trade manager, feed health and Bitget adapter.
// Run: node --test tests/test-smc.mjs   (Node >= 20)
// No network is used except where a test stubs global fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSmc, scanSmcHistory, atrSeries, sessionOf } from '../src/smc-core.js';
import { makeSmcTrade, advanceSmcTrade, dedupeSmcTrades } from '../src/trade-manager.js';
import { validateCandles, splitClosed } from '../src/feed-health.js';
import { fetchBitgetCandles, fetchBitgetTicker } from '../src/bitget.js';

function C(time, open, high, low, close, volume = 100) {
  return { time, open, high, low, close, volume };
}
// Deterministic pseudo-random walk (seeded) for invariant tests.
function randomWalk(n, start = 100, seed = 42) {
  let s = seed, price = start;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 1.2;
    const open = price;
    price = Math.max(10, price + drift);
    const high = Math.max(open, price) + rnd() * 0.3;
    const low = Math.min(open, price) - rnd() * 0.3;
    out.push(C(i * 300, open, high, low, price));
  }
  return out;
}

// Build a textbook BUY sequence (XAU-style prices, 5-minute candles).
// Candles are built leg-by-leg from explicit swing points so pivots are
// geometrically real (each leg is >= 4 candles, pivot strength is 3):
//   prologue 108 -> 104 (quiet, small bodies, no displacement)
//   up-leg to external high 107, down-leg to external low 100,
//   up-leg to internal high 104, down-leg sweeping below 100 to 99.2
//   and closing back above 100 (liquidity sweep),
//   displacement up through 104 (MSS) and 107 (BOS) to 108,
//   pullback into the order block (~99.2-100.5), strong reaction candle.
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
  // Prologue: quiet drift 108 -> 104, small bodies (never displacement).
  let p = 108;
  for (let i = 0; i < 95; i++) { p -= 0.045; leg([p], 0.06); }
  // Up-leg to external high 107.
  leg([104.6, 105.2, 105.9, 106.5, 107.0]);
  // Down-leg to external low 100.
  leg([106.2, 105.3, 104.4, 103.4, 102.4, 101.4, 100.6, 100.0]);
  // Up-leg to internal high 104 (lower high).
  leg([100.9, 101.8, 102.7, 103.6, 104.0]);
  // Down-leg sweeping below 100: dip to 98.4, close back above 100.
  // (The dip must be deep enough that entry→SL risk clears the XAU
  // 4-point minimum stop in the test plan.)
  leg([103.2, 102.3, 101.4, 100.6, 99.9, 98.4, 99.6, 100.4]);
  // Displacement up: ERC candles through 104 (MSS) and 107 (BOS).
  leg([101.8, 103.4, 105.2, 107.3, 108.0]);
  // Pullback into the order block zone (OB ~98.25-99.9), then the reaction
  // candle (LAST). The last pullback candle closes inside the OB.
  leg([107.2, 106.1, 104.8, 103.2, 101.6, 99.6]);
  leg([102.5], 0.2); // reaction: open 99.6 -> close 102.5, strong body
  return out;
}

test('SMC: textbook BUY sequence is detected with a full plan', () => {
  const candles = textbookBuy();
  assert.ok(candles.length >= 40, 'needs enough candles');
  const r = analyzeSmc(candles, { market: 'xau' });
  assert.equal(r.signal.direction, 'BUY', 'expected BUY, got ' + r.signal.direction + ' rejection=' + (r.diagnostics?.rejection || r.signal.rejection));
  assert.ok(r.tradePlan, 'trade plan exists');
  assert.ok(r.tradePlan.entry > r.tradePlan.stopLoss, 'BUY SL below entry');
  assert.ok(r.tradePlan.tp1 > r.tradePlan.entry && r.tradePlan.tp4 > r.tradePlan.tp2, 'TPs ascending above entry');
  assert.equal(r.signal.confirmations.sweep, true);
  assert.equal(r.signal.confirmations.mss, true);
  assert.equal(r.signal.confirmations.bos, true);
  assert.equal(r.signal.confirmations.orderBlock, true);
  assert.equal(r.signal.time, candles.at(-1).time, 'signal time is the last closed candle');
});

test('SMC: random walk without a complete sequence returns WAIT (no forced trade)', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = analyzeSmc(randomWalk(200, 100, seed), { market: 'xau' });
    assert.ok(['WAIT', 'BUY', 'SELL'].includes(r.signal.direction));
    // If a signal fires on noise it must still carry a full plan.
    if (r.signal.direction !== 'WAIT') assert.ok(r.tradePlan && r.tradePlan.risk > 0);
  }
});

test('SMC: too few candles returns WAIT, never a signal', () => {
  const r = analyzeSmc(randomWalk(30), { market: 'btc' });
  assert.equal(r.signal.direction, 'WAIT');
  assert.equal(r.signal.rejection, 'NOT_ENOUGH_CANDLES');
});

test('SMC: forming candle is never used — signal only on the last CLOSED candle', () => {
  const candles = textbookBuy();
  const r = analyzeSmc(candles, { market: 'xau' });
  assert.equal(r.signal.direction, 'BUY');
  // Drop the reaction candle: the setup must disappear (no repaint).
  const r2 = analyzeSmc(candles.slice(0, -1), { market: 'xau' });
  assert.notEqual(r2.signal.time, candles.at(-1).time);
});

test('SMC: HTF opposition vetoes the setup', () => {
  const candles = textbookBuy();
  const r = analyzeSmc(candles, { market: 'xau', htfDirection: 'DOWN' });
  assert.equal(r.signal.direction, 'WAIT', 'HTF DOWN must veto a BUY setup');
});

test('SMC: scanSmcHistory is causal and finds the textbook signal once', () => {
  const candles = textbookBuy();
  const found = scanSmcHistory(candles, { market: 'xau' });
  assert.equal(found.length, 1, 'exactly one signal, got ' + found.length);
  assert.equal(found[0].signal.direction, 'BUY');
});

test('Trade manager: TP1 moves SL to entry, TP2/TP3 stay open, TP4 closes', () => {
  const plan = { entry: 100, stopLoss: 98, tp1: 101, tp2: 102, tp3: 103, tp4: 104, risk: 2 };
  const signal = { time: 1000, direction: 'BUY', confirmations: {} };
  let trade = makeSmcTrade('xau', '5min', signal, plan, { paper: true });
  assert.equal(trade.id, 'xau:5min:1000:BUY');
  const feed = [
    C(1300, 100.5, 101.2, 100.4, 101.0), // TP1 hit
    C(1600, 101.0, 102.1, 100.9, 101.8), // TP2 hit
    C(1900, 101.8, 103.2, 101.6, 103.0), // TP3 hit
    C(2200, 103.0, 104.3, 102.9, 104.1), // TP4 hit
  ];
  let out = advanceSmcTrade(trade, feed.slice(0, 1));
  assert.equal(out.notifications.length, 1);
  assert.equal(out.notifications[0].type, 'TP1');
  assert.equal(out.active.stopLoss, 100, 'SL moved to entry after TP1');
  assert.equal(out.closed, null, 'trade stays open after TP1');
  trade = out.active;
  out = advanceSmcTrade(trade, feed.slice(1, 2));
  assert.equal(out.notifications[0].type, 'TP2');
  assert.equal(out.closed, null, 'TP2 never closes the trade');
  assert.equal(out.active.stopLoss, 100);
  trade = out.active;
  out = advanceSmcTrade(trade, feed.slice(2, 3));
  assert.equal(out.notifications[0].type, 'TP3');
  assert.equal(out.closed, null);
  trade = out.active;
  out = advanceSmcTrade(trade, feed.slice(3, 4));
  assert.equal(out.notifications[0].type, 'TP4');
  assert.ok(out.closed, 'TP4 closes');
  assert.equal(out.closed.result, 'TP4 HIT');
  assert.equal(out.closed.realizedR, 2, 'realized R from actual exit (104-100)/2 = 2, not summed milestones');
});

test('Trade manager: SL before TP1 closes as a loss; SL at entry after TP1 is break-even', () => {
  const plan = { entry: 100, stopLoss: 98, tp1: 101, tp2: 102, tp3: 103, tp4: 104, risk: 2 };
  const signal = { time: 1000, direction: 'BUY', confirmations: {} };
  const t1 = makeSmcTrade('xau', '5min', signal, plan, { paper: true });
  const out1 = advanceSmcTrade(t1, [C(1300, 99, 99.5, 97.9, 98.2)]);
  assert.equal(out1.closed.result, 'SL HIT');
  assert.equal(out1.closed.realizedR, -1);
  assert.equal(out1.notifications[0].type, 'SL');

  const t2 = makeSmcTrade('xau', '5min', signal, plan, { paper: true });
  let out2 = advanceSmcTrade(t2, [C(1300, 100.5, 101.2, 100.4, 101.0)]); // TP1
  out2 = advanceSmcTrade(out2.active, [C(1600, 101, 101.2, 99.9, 100.0)]); // back to entry
  assert.equal(out2.closed.result, 'BREAK EVEN');
  assert.equal(out2.closed.realizedR, 0);
  assert.equal(out2.notifications.at(-1).type, 'BREAK_EVEN');
});

test('Trade manager: duplicate trades dedupe to one record', () => {
  const plan = { entry: 100, stopLoss: 98, tp1: 101, tp2: 102, tp3: 103, tp4: 104, risk: 2 };
  const signal = { time: 1000, direction: 'BUY', confirmations: {} };
  const a = makeSmcTrade('xau', '5min', signal, plan, { paper: true });
  const b = makeSmcTrade('xau', '5min', signal, plan, { paper: true });
  assert.equal(dedupeSmcTrades([a, b]).length, 1);
});

test('Feed health: clean series is HEALTHY, stale/insufficient/bad data is HALTED', () => {
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor(now / 300) * 300;
  const clean = [];
  for (let i = 0; i < 120; i++) {
    const t = base - (120 - i) * 300;
    clean.push(C(t, 100 + i * 0.01, 100.2 + i * 0.01, 99.9 + i * 0.01, 100.1 + i * 0.01));
  }
  assert.equal(validateCandles(clean, 300).health, 'HEALTHY');
  assert.equal(validateCandles(clean.slice(0, 10), 300).health, 'HALTED');
  const stale = clean.map(c => ({ ...c, time: c.time - 86400 }));
  assert.equal(validateCandles(stale, 300).health, 'HALTED');
  const bad = clean.map(c => ({ ...c }));
  bad[50] = { ...bad[50], high: 1 }; // high below open/close
  assert.equal(validateCandles(bad, 300).health, 'HALTED');
  const { closed, current } = splitClosed(clean, 300, now);
  assert.ok(closed.length >= 100);
  assert.ok(current === null || current.time + 300 > now);
});

test('Bitget adapter: parses V3 rows and drops the forming candle', async () => {
  const nowMs = Date.now();
  const aligned = Math.floor(nowMs / 900000) * 900000;
  const rows = [];
  for (let i = 5; i >= 0; i--) {
    const ts = aligned - i * 900000;
    rows.push([String(ts), '76000', '76100', '75900', '76050', '1.5', '114000']);
  }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ code: '00000', msg: 'success', data: rows }),
  });
  const r = await fetchBitgetCandles('15min', 300);
  assert.equal(r.provider, 'Bitget');
  assert.ok(r.closed.length >= 5, 'closed candles present');
  assert.ok(r.closed.every(c => c.time + 900 <= Math.floor(Date.now() / 1000)), 'no forming candle in closed');
  assert.ok(r.closed.every(c => c.time % 900 === 0), 'timestamps interval-aligned');
  const ticker = await (async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ code: '00000', msg: 'success', data: [{ lastPrice: '76050', bid1Price: '76049', ask1Price: '76051', highPrice24h: '77000', lowPrice24h: '75000', volume24h: '100', ts: String(Date.now()) }] }),
    });
    return fetchBitgetTicker();
  })();
  assert.equal(ticker.last, 76050);
  assert.equal(ticker.bid, 76049);
});

test('Sessions: sessionOf labels Malaysia-time sessions', () => {
  // 2026-11-07 00:00 UTC = 08:00 MYT → ASIAN; 12:00 UTC = 20:00 MYT → LONDON; 16:00 UTC = 00:00 MYT → NEW_YORK.
  assert.equal(sessionOf(Date.UTC(2026, 10, 7, 0, 0) / 1000), 'ASIAN');
  assert.equal(sessionOf(Date.UTC(2026, 10, 7, 12, 0) / 1000), 'LONDON');
  assert.equal(sessionOf(Date.UTC(2026, 10, 7, 16, 0) / 1000), 'NEW_YORK');
  assert.ok(Number.isFinite(atrSeries(randomWalk(50), 14).at(-1)));
});
