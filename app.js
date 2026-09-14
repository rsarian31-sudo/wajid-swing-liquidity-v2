const $ = (id) => document.getElementById(id);
let interval = '15min';
let loading = false;

const chart = LightweightCharts.createChart($('chart'), {
  width: $('chart').clientWidth,
  height: $('chart').clientHeight,
  layout: { background: { color: '#070b12' }, textColor: '#8794a6' },
  grid: { vertLines: { color: '#17212d' }, horzLines: { color: '#17212d' } },
  rightPriceScale: { borderColor: '#263342' },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#263342' },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
});

const candleSeries = chart.addCandlestickSeries({
  upColor: '#39d995', downColor: '#ff6d7e',
  borderUpColor: '#39d995', borderDownColor: '#ff6d7e',
  wickUpColor: '#39d995', wickDownColor: '#ff6d7e'
});
const swingHighSeries = chart.addLineSeries({ color: '#e3b65d', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
const swingLowSeries = chart.addLineSeries({ color: '#70a9ff', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
const entrySeries = chart.addLineSeries({ color: '#39d995', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'ENTRY' });
const stopSeries = chart.addLineSeries({ color: '#ff6d7e', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'SL' });
const tp2Series = chart.addLineSeries({ color: '#e3b65d', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'TP2' });

const fmt = (x) => Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—';
const time = (x) => x ? new Date(Number(x) * 1000).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));

function setFlat(series, data, value) {
  if (Number.isFinite(Number(value)) && data.length > 1) {
    series.setData([{ time: data[0].time, value: Number(value) }, { time: data[data.length - 1].time, value: Number(value) }]);
  } else series.setData([]);
}

function setStatus(text, live = false) {
  $('status').textContent = text;
  $('status').className = live ? 'status live' : 'status';
}

function renderHistory(history) {
  const summary = history?.summary || {};
  $('summary').innerHTML = [
    ['Trades', summary.totalTrades ?? 0, ''],
    ['Win', summary.wins ?? 0, 'win'],
    ['Loss', summary.losses ?? 0, 'loss'],
    ['Win Rate', `${summary.winRate ?? 0}%`, ''],
    ['Total R', `${fmt(summary.totalR)}R`, ''],
    ['Open', summary.open ?? 0, 'open']
  ].map(([label, value, cls]) => `<span class="${cls}">${label} <b>${esc(value)}</b></span>`).join('');

  const rows = (history?.trades || []).slice().reverse().slice(0, 50);
  $('history').innerHTML = rows.length ? rows.map((t) => {
    const resultClass = t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : 'open';
    const sideClass = t.direction === 'BUY' ? 'buy' : 'sell';
    const r = Number(t.realizedR || 0);
    return `<tr><td>${esc(time(t.signalTime))}</td><td class="${sideClass}">${esc(t.direction)}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.tp1)}</td><td>${fmt(t.tp2)}</td><td class="${resultClass}">${esc(t.result)}</td><td class="${resultClass}">${r > 0 ? '+' : ''}${fmt(r)}R</td></tr>`;
  }).join('') : '<tr><td colspan="8">No confirmed trades.</td></tr>';
}

function renderDiagnostics(q = {}) {
  const risk = q.riskFilter || {};
  $('diagnostics').innerHTML = [
    ['Latest price', fmt(q.latestPrice)],
    ['Latest swing high', fmt(q.latestSwingHigh)],
    ['Latest swing low', fmt(q.latestSwingLow)],
    ['Latest sweep', q.latestSweep || 'NONE'],
    ['Confirmation', q.confirmation || 'NONE'],
    ['Volume confirmed', q.volumeConfirmed ? 'YES' : 'NO'],
    ['Risk filter', risk.rejected ? `REJECTED · ${risk.reason || 'STOP_TOO_WIDE'}` : risk.passed ? 'PASSED' : 'WAIT']
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

async function load() {
  if (loading) return;
  loading = true;
  setStatus('LOADING');
  try {
    const response = await fetch(`/api/data?interval=${encodeURIComponent(interval)}&outputsize=300`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Server data unavailable');

    const candles = (data.candles || []).map((x) => ({
      time: Number(x.time), open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close)
    })).filter((x) => [x.time, x.open, x.high, x.low, x.close].every(Number.isFinite));

    candleSeries.setData(candles);
    swingHighSeries.setData((data.swings?.highs || []).map((x) => ({ time: Number(x.time), value: Number(x.price) })).filter((x) => Number.isFinite(x.time) && Number.isFinite(x.value)));
    swingLowSeries.setData((data.swings?.lows || []).map((x) => ({ time: Number(x.time), value: Number(x.price) })).filter((x) => Number.isFinite(x.time) && Number.isFinite(x.value)));

    const markers = (data.liquidity?.sweeps || []).map((x) => ({
      time: Number(x.time),
      position: x.type === 'BULLISH' ? 'belowBar' : 'aboveBar',
      shape: x.type === 'BULLISH' ? 'arrowUp' : 'arrowDown',
      color: x.type === 'BULLISH' ? '#39d995' : '#ff6d7e',
      text: x.type === 'BULLISH' ? 'SWEEP ↑' : 'SWEEP ↓'
    })).filter((x) => Number.isFinite(x.time)).sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);

    const signal = data.signal || {};
    $('signal').textContent = signal.direction || 'WAIT';
    $('signal').className = signal.direction === 'BUY' ? 'buy' : signal.direction === 'SELL' ? 'sell' : 'wait';
    $('signalMeta').textContent = signal.time ? `Confirmed ${time(signal.time)}` : signal.rejection || 'No active confirmed signal';
    $('prob').textContent = `${signal.probability || 0}%`;
    $('score').textContent = signal.score ?? 0;
    $('price').textContent = fmt(data.market?.price);
    $('atr').textContent = fmt(data.diagnostics?.atr);

    const plan = data.tradePlan;
    $('planState').textContent = plan ? `${plan.direction} ACTIVE` : 'No active trade';
    $('entry').textContent = plan ? fmt(plan.entry) : '—';
    $('sl').textContent = plan ? fmt(plan.stopLoss) : '—';
    $('tp1').textContent = plan ? fmt(plan.tp1) : '—';
    $('tp2').textContent = plan ? fmt(plan.tp2) : '—';
    $('tp3').textContent = plan ? fmt(plan.tp3) : '—';
    $('risk').textContent = plan ? fmt(plan.risk) : '—';

    setFlat(entrySeries, candles, plan?.entry);
    setFlat(stopSeries, candles, plan?.stopLoss);
    setFlat(tp2Series, candles, plan?.tp2);

    renderHistory(data.history);
    renderDiagnostics(data.diagnostics);
    $('status').textContent = `LIVE · ${time(data.market?.lastCandleTime)}`;
    $('status').className = 'status live';
    chart.timeScale().fitContent();
  } catch (error) {
    setStatus('ERROR');
    $('signalMeta').textContent = error?.message || 'Unable to load server data';
  } finally {
    loading = false;
  }
}

document.querySelectorAll('[data-tf]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.tf === interval) return;
    interval = button.dataset.tf;
    document.querySelectorAll('[data-tf]').forEach((x) => x.classList.remove('active'));
    button.classList.add('active');
    load();
  });
});
$('refresh').addEventListener('click', load);
window.addEventListener('resize', () => chart.applyOptions({ width: $('chart').clientWidth, height: $('chart').clientHeight }));
load();
setInterval(load, 60000);
