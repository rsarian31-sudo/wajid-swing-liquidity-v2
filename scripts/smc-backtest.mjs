// SMC v1 historical backtest + 7-day paper simulation (no live signals).
// Usage: node scripts/smc-backtest.mjs [--days 90] [--paper-days 7]
// BTC: Bitget V3 public candles (SPOT BTCUSDT), paginated via endTime.
// Gold: getdata-finance XAUUSD 1m CSV, resampled to 5M/15M.
// Simulation is causal: signals come from scanSmcHistory (one per setup),
// each trade is then advanced candle-by-candle with advanceSmcTrade.
// COSTS (assumptions, documented — not exchange-verified fills):
//   BTC: taker fee 0.10% + slippage 0.02% per fill, two fills per trade.
//   Gold: spread $0.35 + slippage $0.10 per fill, two fills per trade.
// Costs are converted to R using each trade's risk: costR = total $ cost / risk.
// Metrics are reported per pipeline. Nothing here sends Telegram or trades.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanSmcHistory } from '../src/smc-core.js';
import { makeSmcTrade, advanceSmcTrade } from '../src/trade-manager.js';
import { fetchBitgetCandles } from '../src/bitget.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(([k, v]) => v !== undefined));
const DAYS = Math.min(30, Math.max(1, Number(args.days || 30))); // Bitget V3 /candles only serves ~last 30 days via endTime paging (verified 2026-11-07: endTime 35d ago returns []); history-candles only covers >90 days ago, so the 30-90d window is unreachable from the public API.
const PAPER_DAYS = Math.min(30, Math.max(1, Number(args['paper-days'] || 7)));

const BTC_INTERVALS = ['15min', '30min', '1H'];
const XAU_INTERVALS = ['5min', '15min'];
const SECONDS = { '5min': 300, '15min': 900, '30min': 1800, '1H': 3600 };
const BITGET_INTERVAL = { '15min': '15m', '30min': '30m', '1H': '1H' };

function resample(candles, seconds) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor(c.time / seconds) * seconds;
    if (!cur || cur.time !== b) { cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }; out.push(cur); }
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume || 0; }
  }
  return out;
}

async function fetchBtcSeries(interval, days) {
  const seconds = SECONDS[interval];
  const need = Math.ceil((days * 86400) / seconds) + 5;
  const all = [];
  let endTimeMs = Date.now();
  const seen = new Set();
  while (all.length < need) {
    const r = await fetchBitgetCandles(interval, 1000, { endTimeMs });
    const rows = [...r.closed, ...(r.current ? [r.current] : [])];
    if (!rows.length) break;
    let added = 0;
    for (const c of rows) if (!seen.has(c.time)) { seen.add(c.time); all.push(c); added++; }
    if (!added) break;
    endTimeMs = Math.min(...rows.map(c => c.time)) * 1000 - 1;
    if (rows.length < 1000) break;
    await new Promise(r => setTimeout(r, 120)); // stay far under 20/sec/IP
  }
  return all.sort((a, b) => a.time - b.time);
}

function fetchGoldSeries() {
  const CSV = '/tmp/XAUUSD_1m.csv';
  const DATA_URL = 'https://raw.githubusercontent.com/getdata-finance/xauusd-1m-ohlcv-metals-historical-data/main/XAUUSD_1m.csv';
  if (!fs.existsSync(CSV)) execFileSync('curl', ['-L', '--fail', '--silent', '--show-error', '-o', CSV, DATA_URL], { stdio: 'inherit' });
  const lines = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 6) continue;
    const time = Math.floor(new Date(p[0]).getTime() / 1000);
    const open = +p[1], high = +p[2], low = +p[3], close = +p[4], volume = +p[5];
    if ([time, open, high, low, close].every(Number.isFinite)) candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return candles.sort((a, b) => a.time - b.time);
}

function costR(market, trade) {
  // Per-fill cost: BTC 0.12% of entry price; Gold $0.45 ($0.35 spread/2 is
  // NOT halved here — the model charges spread $0.35 + slippage $0.10 per
  // fill, i.e. $0.45/fill). Two fills (entry + exit) per closed trade.
  if (market === 'btc') return (0.0012 * 2 * trade.entry) / trade.risk;
  return (0.45 * 2) / trade.risk;
}

function simulate(market, interval, candles) {
  const signals = scanSmcHistory(candles, { market });
  const trades = [];
  const signalByIndex = new Map(signals.map(s => [s.index, s]));
  const active = [];
  let maxConcurrent = 0;
  for (let i = 0; i < candles.length; i++) {
    const s = signalByIndex.get(i);
    if (s && s.tradePlan) {
      const trade = makeSmcTrade(market, interval, s.signal, s.tradePlan, { paper: true });
      active.push({ trade, openedAt: i });
      maxConcurrent = Math.max(maxConcurrent, active.length);
    }
    const candle = candles[i];
    for (let j = active.length - 1; j >= 0; j--) {
      // A trade is entered at the reaction candle's close, so it is only
      // advanced against LATER candles (same as the live pipeline) —
      // advancing against the signal candle itself would be look-ahead.
      if (active[j].openedAt === i) continue;
      const out = advanceSmcTrade(active[j].trade, [candle]);
      if (out.closed) {
        const t = out.closed;
        t.holdingCandles = i - active[j].openedAt;
        t.costR = Number(costR(market, t).toFixed(4));
        t.netRealizedR = Number((Number(t.realizedR || 0) - t.costR).toFixed(4));
        trades.push(t);
        active.splice(j, 1);
      } else {
        active[j].trade = out.active;
      }
    }
  }
  const closed = trades.filter(t => t.status === 'CLOSED');
  const open = active.map(a => a.trade);
  return { signals: signals.length, trades, closed, open, maxConcurrent };
}

function metrics(closed) {
  // Win/loss/break-even are classified on GROSS realised R (actual exit
  // vs entry). Costs are real, so totalRNet/profitFactor use NET R, but a
  // break-even exit (SL moved to entry after TP1) must not be counted as
  // a loss just because fees made it slightly negative.
  const wins = closed.filter(t => Number(t.realizedR) > 0);
  const losses = closed.filter(t => Number(t.realizedR) < 0);
  const be = closed.filter(t => Number(t.realizedR) === 0);
  // Net totals must include EVERY closed trade (a break-even exit still
  // pays entry+exit fees, so its net R is slightly negative).
  const netSum = closed.reduce((a, t) => a + Number(t.netRealizedR || 0), 0);
  const grossWin = closed.filter(t => Number(t.netRealizedR) > 0).reduce((a, t) => a + Number(t.netRealizedR), 0);
  const grossLoss = Math.abs(closed.filter(t => Number(t.netRealizedR) < 0).reduce((a, t) => a + Number(t.netRealizedR), 0));
  const totalR = Number(netSum.toFixed(2));
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of closed) { equity += Number(t.netRealizedR); peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  const tp = (n) => closed.filter(t => t[`tp${n}Hit`]).length;
  return {
    totalTrades: closed.length,
    wins: wins.length, losses: losses.length, breakEven: be.length,
    winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : (wins.length ? null : 0),
    totalRNet: totalR,
    totalRGross: Number(closed.reduce((a, t) => a + Number(t.realizedR || 0), 0).toFixed(2)),
    avgRNet: closed.length ? Number((totalR / closed.length).toFixed(2)) : 0,
    maxDrawdownR: Number(maxDd.toFixed(2)),
    tp1HitRate: closed.length ? Number((tp(1) / closed.length * 100).toFixed(1)) : 0,
    tp2HitRate: closed.length ? Number((tp(2) / closed.length * 100).toFixed(1)) : 0,
    tp3HitRate: closed.length ? Number((tp(3) / closed.length * 100).toFixed(1)) : 0,
    tp4HitRate: closed.length ? Number((tp(4) / closed.length * 100).toFixed(1)) : 0,
    slFrequency: closed.length ? Number((closed.filter(t => t.result === 'SL HIT').length / closed.length * 100).toFixed(1)) : 0,
    avgHoldingCandles: closed.length ? Number((closed.reduce((a, t) => a + (t.holdingCandles || 0), 0) / closed.length).toFixed(1)) : 0,
  };
}

const results = { generatedAt: new Date().toISOString(), days: DAYS, paperDays: PAPER_DAYS, costs: { btc: 'taker 0.10% + slippage 0.02% per fill, 2 fills', xau: 'spread $0.35 + slippage $0.10 per fill, 2 fills (assumed, not exchange-verified)' }, pipelines: {}, paper: {} };
const gold1m = fetchGoldSeries();
const goldCutoff = gold1m.length ? gold1m.at(-1).time - DAYS * 86400 : 0;
const goldRecent = gold1m.filter(c => c.time >= goldCutoff);

for (const interval of XAU_INTERVALS) {
  const candles = resample(goldRecent, SECONDS[interval]);
  const { signals, closed, open, maxConcurrent } = simulate('xau', interval, candles);
  results.pipelines['xau:' + interval] = { market: 'xau', interval, candles: candles.length, from: candles[0] ? new Date(candles[0].time * 1000).toISOString() : null, to: candles.at(-1) ? new Date(candles.at(-1).time * 1000).toISOString() : null, signals, openTrades: open.length, maxConcurrent, ...metrics(closed) };
  console.log('XAU', interval, JSON.stringify(results.pipelines['xau:' + interval]));
}
for (const interval of BTC_INTERVALS) {
  const candles = await fetchBtcSeries(interval, DAYS);
  const { signals, closed, open, maxConcurrent } = simulate('btc', interval, candles);
  results.pipelines['btc:' + interval] = { market: 'btc', interval, candles: candles.length, from: candles[0] ? new Date(candles[0].time * 1000).toISOString() : null, to: candles.at(-1) ? new Date(candles.at(-1).time * 1000).toISOString() : null, signals, openTrades: open.length, maxConcurrent, ...metrics(closed) };
  console.log('BTC', interval, JSON.stringify(results.pipelines['btc:' + interval]));
}
// 7-day paper simulation (same engine, recent window only, no Telegram).
for (const interval of XAU_INTERVALS) {
  const candles = resample(gold1m.filter(c => c.time >= gold1m.at(-1).time - PAPER_DAYS * 86400), SECONDS[interval]);
  const { signals, closed, open } = simulate('xau', interval, candles);
  results.paper['xau:' + interval] = { market: 'xau', interval, candles: candles.length, signals, openTrades: open.length, ...metrics(closed) };
}
for (const interval of BTC_INTERVALS) {
  const candles = await fetchBtcSeries(interval, PAPER_DAYS);
  const { signals, closed, open } = simulate('btc', interval, candles);
  results.paper['btc:' + interval] = { market: 'btc', interval, candles: candles.length, signals, openTrades: open.length, ...metrics(closed) };
}
console.log('PAPER', JSON.stringify(results.paper, null, 2));
fs.writeFileSync(new URL('./smc-backtest-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('Wrote scripts/smc-backtest-results.json');
