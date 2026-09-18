const $ = (id) => document.getElementById(id);
let interval = '15min';
let loading = false;
let historyView = 'all';
let historyData = null;

const chart = LightweightCharts.createChart($('chart'), {
  width: $('chart').clientWidth,
  height: $('chart').clientHeight,
  layout: { background: { color: '#06101a' }, textColor: '#8799aa' },
  grid: { vertLines: { color: '#102233' }, horzLines: { color: '#102233' } },
  rightPriceScale: { borderColor: '#1b3448' },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1b3448' },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
});

const candleSeries = chart.addCandlestickSeries({
  upColor: '#35dfa0', downColor: '#ff6578', borderUpColor: '#35dfa0', borderDownColor: '#ff6578',
  wickUpColor: '#35dfa0', wickDownColor: '#ff6578'
});

// Exact entry candle overlay. This does not change the strategy; it only makes
// the candle used for the current confirmed entry visually obvious on the chart.
const entryCandleSeries = chart.addCandlestickSeries({
  upColor: '#8affc8', downColor: '#ff9aaa',
  borderUpColor: '#8affc8', borderDownColor: '#ff9aaa',
  wickUpColor: '#8affc8', wickDownColor: '#ff9aaa',
  priceLineVisible: false, lastValueVisible: false
});

const swingHighSeries = chart.addLineSeries({ color: '#e4bb5d', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
const swingLowSeries = chart.addLineSeries({ color: '#4f9cff', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
const entrySeries = chart.addLineSeries({ color: '#35dfa0', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'ENTRY' });
const stopSeries = chart.addLineSeries({ color: '#ff6578', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'SL' });
const tp2Series = chart.addLineSeries({ color: '#e4bb5d', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'TP2' });

// Volume-Trend Order Block Engine overlay. Independent from Swing Liquidity.
const obTopSeries = chart.addLineSeries({ color: '#00ffcc', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, title: 'OB TOP' });
const obBottomSeries = chart.addLineSeries({ color: '#ff007f', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, title: 'OB BOTTOM' });
const obSplitSeries = chart.addLineSeries({ color: '#d7d7d7', lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, title: 'OB SPLIT' });

const fmt = (x) => Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—';
const time = (x) => x ? new Date(Number(x) * 1000).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
const tfLabel = () => interval === '5min' ? '5M' : '15M';
const tfLong = () => interval === '5min' ? '5 Minutes' : '15 Minutes';

function setFlat(series, data, value) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0 && data.length > 1) {
    series.setData([{ time: data[0].time, value: numericValue }, { time: data[data.length - 1].time, value: numericValue }]);
  } else {
    series.setData([]);
  }
}
function setZoneLine(series, candles, zone, field) {
  if (!zone || !candles.length || !Number.isFinite(Number(zone[field]))) { series.setData([]); return; }
  const start = Number(zone.startTime || candles[0].time);
  const end = Number(candles.at(-1).time);
  series.setData([{ time: start, value: Number(zone[field]) }, { time: end, value: Number(zone[field]) }]);
}
function setStatus(text, live = false) { $('status').textContent = text; $('status').className = live ? 'status live' : 'status'; }
function syncTimeframeUI() {
  document.querySelectorAll('[data-tf]').forEach((button) => button.classList.toggle('active', button.dataset.tf === interval));
  $('signalLabel').textContent = `${tfLabel()} CURRENT SIGNAL`;
  $('marketTf').textContent = tfLong();
}
function resultClass(result) { return result === 'WIN' ? 'win' : result === 'LOSS' ? 'loss' : 'open'; }
function calcStats(trades) {
  const list = trades || [], wins = list.filter(t => t.result === 'WIN').length, losses = list.filter(t => t.result === 'LOSS').length, open = list.filter(t => t.result === 'OPEN').length;
  const totalR = list.reduce((sum, t) => sum + Number(t.realizedR || 0), 0);
  return { signals: list.length, wins, losses, open, winRate: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(2)) : 0, totalR: Number(totalR.toFixed(2)) };
}
function dayKey(ts) { const d = new Date(Number(ts) * 1000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function startOfWeek(ts) { const d = new Date(Number(ts) * 1000); const day = d.getDay(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); return d; }
function weekKey(ts) { return dayKey(Math.floor(startOfWeek(ts).getTime() / 1000)); }
function formatDayLabel(key) { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString([], { weekday:'long', year:'numeric', month:'long', day:'numeric' }); }
function formatWeekLabel(key) { const [y,m,d] = key.split('-').map(Number); const start = new Date(y,m-1,d), end = new Date(start); end.setDate(start.getDate()+6); return `${start.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'})} – ${end.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'})}`; }

function renderSummary(summary) {
  $('summary').innerHTML = [
    ['Trades', summary.totalTrades ?? summary.signals ?? 0, ''], ['Win', summary.wins ?? 0, 'win'], ['Loss', summary.losses ?? 0, 'loss'],
    ['Win Rate', `${summary.winRate ?? 0}%`, ''], ['Total R', `${fmt(summary.totalR)}R`, ''], ['Open', summary.open ?? 0, 'open']
  ].map(([label,value,cls]) => `<span class="${cls}">${label} <b>${esc(value)}</b></span>`).join('');
  $('perfTrades').textContent = summary.totalTrades ?? summary.signals ?? 0; $('perfWin').textContent = summary.wins ?? 0; $('perfLoss').textContent = summary.losses ?? 0;
  $('perfRate').textContent = `${summary.winRate ?? 0}%`; $('perfR').textContent = `${fmt(summary.totalR)}R`;
}
function renderTradeRows(trades) {
  const rows = (trades || []).slice().sort((a,b) => Number(b.signalTime||0)-Number(a.signalTime||0)).slice(0,50);
  $('history').innerHTML = rows.length ? rows.map((t) => {
    const rc = resultClass(t.result), sc = t.direction === 'BUY' ? 'buy' : 'sell', r = Number(t.realizedR || 0);
    return `<tr><td>${esc(time(t.signalTime))}</td><td class="${sc}">${esc(t.direction)}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.tp1)}</td><td>${fmt(t.tp2)}</td><td class="${rc}">${esc(t.result)}</td><td class="${rc}">${r > 0 ? '+' : ''}${fmt(r)}R</td></tr>`;
  }).join('') : '<tr><td colspan="8">No confirmed trades.</td></tr>';
}
function renderDailyHistory(trades) {
  const groups = new Map();
  for (const t of trades || []) { const key = dayKey(t.signalTime); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(t); }
  const keys = [...groups.keys()].sort((a,b) => b.localeCompare(a));
  if (!keys.length) { $('historyView').innerHTML = '<div class="empty-history">No daily history available yet.</div>'; return; }
  $('historyView').innerHTML = keys.map(key => {
    const stats = calcStats(groups.get(key));
    const tradesHtml = groups.get(key).slice().sort((a,b)=>Number(b.signalTime)-Number(a.signalTime)).map(t => `<div class="daily-trade"><span>${esc(time(t.signalTime))}</span><b class="${t.direction==='BUY'?'buy':'sell'}">${esc(t.direction)}</b><span>${fmt(t.entry)}</span><strong class="${resultClass(t.result)}">${esc(t.result)}</strong><span>${Number(t.realizedR||0) > 0 ? '+' : ''}${fmt(t.realizedR)}R</span></div>`).join('');
    return `<section class="history-section"><div class="history-section-head"><div><b>${esc(formatDayLabel(key))}</b><small>${stats.signals} signal${stats.signals===1?'':'s'} · ${stats.wins}W · ${stats.losses}L</small></div><div class="day-rate">${stats.winRate}% Win Rate</div></div><div class="daily-trades">${tradesHtml}</div></section>`;
  }).join('');
}
function renderWeeklyHistory(trades) {
  const groups = new Map();
  for (const t of trades || []) { const key = weekKey(t.signalTime); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(t); }
  const keys = [...groups.keys()].sort((a,b)=>b.localeCompare(a));
  const html = `<div class="market-schedule">Market schedule: <b>Monday–Friday</b> · Saturday &amp; Sunday: <b>CLOSED</b></div>` + (keys.length ? keys.map(key => {
    const s = calcStats(groups.get(key));
    return `<section class="week-card"><div class="week-head"><div><b>Week of ${esc(formatWeekLabel(key))}</b><small>Monday-start reporting period</small></div><strong>${s.winRate}% Win Rate</strong></div><div class="week-grid"><div><span>Signals</span><b>${s.signals}</b></div><div><span>Wins</span><b class="win">${s.wins}</b></div><div><span>Losses</span><b class="loss">${s.losses}</b></div><div><span>Open</span><b class="open">${s.open}</b></div><div><span>Total R</span><b>${fmt(s.totalR)}R</b></div></div></section>`;
  }).join('') : '<div class="empty-history">No weekly history available yet.</div>');
  $('historyView').innerHTML = html;
}
function renderHistory(history) {
  historyData = history || { summary:{}, trades:[] };
  renderSummary(historyData.summary || calcStats(historyData.trades));
  if (historyView === 'daily') renderDailyHistory(historyData.trades); else if (historyView === 'weekly') renderWeeklyHistory(historyData.trades); else {
    $('historyView').innerHTML = `<div class="table-wrap"><table><thead><tr><th>TIME</th><th>SIDE</th><th>ENTRY</th><th>SL</th><th>TP1</th><th>TP2</th><th>RESULT</th><th>R</th></tr></thead><tbody id="history"><tr><td colspan="8">Loading…</td></tr></tbody></table></div>`;
    renderTradeRows(historyData.trades);
  }
}
function setHistoryView(view) {
  historyView = view;
  document.querySelectorAll('[data-history-view]').forEach((button) => button.classList.toggle('active', button.dataset.historyView === view));
  if (historyData) renderHistory(historyData);
}
function renderDiagnostics(q = {}) {
  const risk = q.riskFilter || {};
  $('diagnostics').innerHTML = [
    ['Latest price', fmt(q.latestPrice)], ['Latest swing high', fmt(q.latestSwingHigh)], ['Latest swing low', fmt(q.latestSwingLow)],
    ['Latest sweep', q.latestSweep || 'NONE'], ['Confirmation', q.confirmation || 'NONE'], ['Volume confirmed', q.volumeConfirmed ? 'YES' : 'NO'],
    ['Risk filter', risk.rejected ? `REJECTED · ${risk.reason || 'STOP_TOO_WIDE'}` : risk.passed ? 'PASSED' : 'WAIT']
  ].map(([k,v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

function markEntryCandle(candles, signal, active) {
  const entryTime = Number(active?.signalTime || signal?.time || 0);
  if (!Number.isFinite(entryTime) || !entryTime) { entryCandleSeries.setData([]); return []; }
  const candle = candles.find(c => Number(c.time) === entryTime);
  if (!candle) { entryCandleSeries.setData([]); return []; }
  entryCandleSeries.setData([candle]);
  const direction = active?.direction || signal?.direction;
  const isBuy = direction === 'BUY';
  return [{ time: entryTime, position: isBuy ? 'belowBar' : 'aboveBar', shape: isBuy ? 'arrowUp' : 'arrowDown', color: isBuy ? '#8affc8' : '#ff9aaa', text: 'ENTRY CANDLE' }];
}

function volumeOBMarkers(volumeOB) {
  return (volumeOB?.signals || []).map((x) => ({
    time: Number(x.time),
    position: x.direction === 'BUY' ? 'belowBar' : 'aboveBar',
    shape: x.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
    color: x.direction === 'BUY' ? '#00ffcc' : '#ff007f',
    text: x.direction === 'BUY' ? `OB BUY ${x.buyPercent}%` : `OB SELL ${x.sellPercent}%`
  })).filter(x => Number.isFinite(x.time));
}

async function load() {
  if (loading) return; loading = true; setStatus('LOADING');
  try {
    const response = await fetch(`/api/data?interval=${encodeURIComponent(interval)}&outputsize=300`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Server data unavailable');
    const candles = (data.candles || []).map(x => ({time:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close)})).filter(x => [x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
    candleSeries.setData(candles);
    swingHighSeries.setData((data.swings?.highs || []).map(x=>({time:Number(x.time),value:Number(x.price)})).filter(x=>Number.isFinite(x.time)&&Number.isFinite(x.value)));
    swingLowSeries.setData((data.swings?.lows || []).map(x=>({time:Number(x.time),value:Number(x.price)})).filter(x=>Number.isFinite(x.time)&&Number.isFinite(x.value)));

    const signal=data.signal||{};
    const active=data.activeTrade;
    const sweepMarkers=(data.liquidity?.sweeps||[]).map(x=>({time:Number(x.time),position:x.type==='BULLISH'?'belowBar':'aboveBar',shape:x.type==='BULLISH'?'arrowUp':'arrowDown',color:x.type==='BULLISH'?'#35dfa0':'#ff6578',text:x.type==='BULLISH'?'SWEEP ↑':'SWEEP ↓'})).filter(x=>Number.isFinite(x.time));
    const entryMarker=markEntryCandle(candles, signal, active);
    candleSeries.setMarkers([...sweepMarkers, ...entryMarker].sort((a,b)=>a.time-b.time));

    const obZone=data.volumeOB?.activeZone||null;
    setZoneLine(obTopSeries,candles,obZone,'top');
    setZoneLine(obBottomSeries,candles,obZone,'bottom');
    setZoneLine(obSplitSeries,candles,obZone,'split');

    $('signal').textContent=signal.direction||'WAIT'; $('signal').className=signal.direction==='BUY'?'buy':signal.direction==='SELL'?'sell':'wait';
    $('signalMeta').textContent=signal.confirmationTime?`Confirmed ${time(signal.confirmationTime)} · Entry ${time(signal.entryTime||signal.time)}`:signal.time?`Entry ${time(signal.entryTime||signal.time)}`:signal.rejection||'No active confirmed signal'; $('prob').textContent=`${signal.probability||0}%`; $('score').textContent=signal.score??0;
    $('price').textContent=fmt(data.market?.price); $('atr').textContent=fmt(data.diagnostics?.atr); $('marketPrice').textContent=fmt(data.market?.price); $('marketAtr').textContent=fmt(data.diagnostics?.atr); $('marketCandles').textContent=data.market?.candleCount??candles.length;

    const plan=data.tradePlan;
    const activeDirection=active?.direction||null;
    const planFields=[plan?.entry,plan?.stopLoss,plan?.tp1,plan?.tp2,plan?.tp3];
    const validPlan=Boolean(active&&activeDirection&&plan&&planFields.every(v=>Number.isFinite(Number(v))&&Number(v)>0));
    $('planState').textContent=validPlan?`${activeDirection} ACTIVE`:'No active trade';
    $('entry').textContent=validPlan?fmt(plan.entry):'—';
    $('sl').textContent=validPlan?fmt(plan.stopLoss):'—';
    $('tp1').textContent=validPlan?fmt(plan.tp1):'—';
    $('tp2').textContent=validPlan?fmt(plan.tp2):'—';
    $('tp3').textContent=validPlan?fmt(plan.tp3):'—';
    $('risk').textContent=validPlan?fmt(plan.risk):'—';
    setFlat(entrySeries,candles,validPlan?plan.entry:null);
    setFlat(stopSeries,candles,validPlan?plan.stopLoss:null);
    setFlat(tp2Series,candles,validPlan?plan.tp2:null);

    renderHistory(data.history); renderDiagnostics(data.diagnostics); syncTimeframeUI(); setStatus(`LIVE · ${time(data.market?.lastCandleTime)}`,true); chart.timeScale().fitContent();
  } catch(error) { setStatus('ERROR'); $('signalMeta').textContent=error?.message||'Unable to load server data'; }
  finally { loading=false; }
}
document.querySelectorAll('[data-tf]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.tf===interval)return;interval=button.dataset.tf;syncTimeframeUI();load();}));
document.querySelectorAll('[data-history-view]').forEach(button=>button.addEventListener('click',()=>setHistoryView(button.dataset.historyView)));
$('refresh').addEventListener('click',load);
window.addEventListener('resize',()=>chart.applyOptions({width:$('chart').clientWidth,height:$('chart').clientHeight}));
syncTimeframeUI(); load(); setInterval(load,60000);