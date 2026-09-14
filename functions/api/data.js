import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';

const ALLOWED = new Set(['5min','15min']);
const INTERVAL_SECONDS = { '5min': 300, '15min': 900 };

function activeHistoryTrade(signal, plan, candles) {
  if (!signal || signal.direction === 'WAIT' || !plan) return null;
  const entryCandle = candles.find((c) => c.time === signal.time) || candles.at(-1);
  const sweep = signal.sweep;
  return {
    id: `${signal.time}-${signal.direction}-ACTIVE`,
    direction: signal.direction,
    signalTime: signal.time,
    swingTime: sweep?.level?.time ?? null,
    swingType: sweep?.level?.type ?? null,
    swingPrice: Number.isFinite(Number(sweep?.level?.price)) ? Number(Number(sweep.level.price).toFixed(2)) : null,
    entry: Number(Number(plan.entry).toFixed(2)),
    stopLoss: Number(Number(plan.stopLoss).toFixed(2)),
    tp1: Number(Number(plan.tp1).toFixed(2)),
    tp2: Number(Number(plan.tp2).toFixed(2)),
    tp3: Number(Number(plan.tp3).toFixed(2)),
    risk: Number(Number(plan.risk).toFixed(2)),
    realizedR: 0,
    result: 'OPEN',
    status: 'OPEN',
    exit: null,
    exitTime: null,
    reason: 'Active confirmed signal; TP2 or SL not reached yet',
    entryCandleTime: entryCandle?.time ?? signal.time
  };
}

function signalFromActive(active) {
  if (!active) return null;
  return {
    value: active.direction,
    direction: active.direction,
    probability: active.probability ?? 0,
    score: active.score ?? 0,
    time: active.signalTime,
    price: active.entry,
    sweep: active.sweep || null,
    confirmation: { confirmed: true, direction: active.direction, time: active.signalTime, price: active.entry },
    rejection: null
  };
}

function planFromActive(active) {
  if (!active) return null;
  return {
    entry: active.entry,
    stopLoss: active.stopLoss,
    tp1: active.tp1,
    tp2: active.tp2,
    tp3: active.tp3,
    risk: active.risk,
    rr: { tp1: 1, tp2: 2, tp3: 3 }
  };
}

async function getPersistentBucket(env, interval) {
  if (!env.TRADE_STATE) return null;
  const id = env.TRADE_STATE.idFromName('xauusd');
  const stub = env.TRADE_STATE.get(id);
  const response = await stub.fetch('https://state/');
  const state = await response.json();
  return state?.intervals?.[interval] || null;
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method !== 'GET') return json({ success:false, error:'Method not allowed' },405);
  try {
    const u = new URL(request.url);
    const symbol = 'XAU/USD';
    const interval = ALLOWED.has(u.searchParams.get('interval')) ? u.searchParams.get('interval') : '15min';
    const n = Number(u.searchParams.get('outputsize') || CONFIG.outputSize);
    const outputsize = Number.isFinite(n) ? Math.min(500, Math.max(100, Math.floor(n))) : CONFIG.outputSize;
    if (!env.TWELVE_DATA_API_KEY) return json({success:false,error:'TWELVE_DATA_API_KEY is not configured'},500);

    const cache = caches.default;
    const cacheKey = new Request('https://wajid-cache.local/data/' + interval + '/' + outputsize);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body,{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=0, s-maxage=30','X-Wajid-Cache':'HIT'}});

    const p = new URLSearchParams({symbol,interval,outputsize:String(outputsize),order:'ASC',timezone:'UTC',apikey:env.TWELVE_DATA_API_KEY});
    const r = await fetch('https://api.twelvedata.com/time_series?' + p);
    const d = await r.json();
    if (!r.ok || d?.status === 'error' || d?.code) throw Error(d?.message || 'Twelve Data request failed');
    if (!Array.isArray(d?.values)) throw Error('Twelve Data returned no values');

    const candles = d.values.map(x => ({time:Math.floor(x.timestamp ? Number(x.timestamp) : Date.parse(String(x.datetime || ''))/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume || 0)})).filter(x => [x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
    candles.sort((a,b)=>a.time-b.time);
    const unique=[]; const seen=new Set();
    for (const c of candles) if (!seen.has(c.time)) { seen.add(c.time); unique.push(c); }
    if (!unique.length) throw Error('No market candles returned');

    const now = Math.floor(Date.now() / 1000);
    const intervalSeconds = INTERVAL_SECONDS[interval];
    const closedCandles = unique.filter(c => c.time + intervalSeconds <= now);
    const analysisCandles = closedCandles.length ? closedCandles : unique.slice(0, -1);
    if (!analysisCandles.length) throw Error('Not enough completed market candles');

    const a = analyze(analysisCandles);
    const fallbackTrades = buildHistory(analysisCandles,a.swings,symbol);
    const fallbackActive = activeHistoryTrade(a.signal,a.tradePlan,analysisCandles);
    if (fallbackActive && !fallbackTrades.some((t) => t.id === fallbackActive.id || (t.signalTime === fallbackActive.signalTime && t.direction === fallbackActive.direction && t.result === 'OPEN'))) fallbackTrades.push(fallbackActive);

    const persistent = await getPersistentBucket(env, interval);
    const active = persistent?.active || null;
    const trades = persistent?.trades?.length
      ? [...persistent.trades, ...(active ? [toHistoryOpen(active)] : [])]
      : fallbackTrades;
    const visibleSignal = active ? signalFromActive(active) : a.signal;
    const visiblePlan = active ? planFromActive(active) : a.tradePlan;

    const wins=trades.filter(x=>x.result==='WIN').length;
    const losses=trades.filter(x=>x.result==='LOSS').length;
    const open=trades.filter(x=>x.result==='OPEN').length;
    const totalR=trades.reduce((s,x)=>s+Number(x.realizedR||0),0);
    const data={success:true,strategy:{id:'swing-liquidity',name:'Swing Liquidity',symbol,interval,parameters:CONFIG},market:{symbol,interval,price:unique.at(-1).close,lastCandleTime:unique.at(-1).time,candleCount:unique.length,analysisCandleCount:analysisCandles.length},candles:unique,swings:a.swings,liquidity:{levels:a.liquidityLevels,sweeps:a.sweeps},signal:visibleSignal,tradePlan:visiblePlan,diagnostics:a.diagnostics,history:{summary:{totalTrades:trades.length,wins,losses,open,winRate:(wins+losses)>0?Number((wins/(wins+losses)*100).toFixed(2)):0,totalR:Number(totalR.toFixed(2))},trades}};
    const response=new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=30'}});
    waitUntil(cache.put(cacheKey,response.clone()));
    return new Response(response.body,{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=0, s-maxage=30, stale-while-revalidate=15','X-Wajid-Cache':'MISS'}});
  } catch(e) { return json({success:false,error:e?.message || 'Market data error'},500); }
}

function toHistoryOpen(active) {
  return {
    id: active.id,
    interval: active.interval,
    direction: active.direction,
    signalTime: active.signalTime,
    swingTime: active.sweep?.level?.time ?? null,
    swingType: active.sweep?.level?.type ?? null,
    swingPrice: Number.isFinite(Number(active.sweep?.level?.price)) ? Number(Number(active.sweep.level.price).toFixed(2)) : null,
    entry: active.entry,
    stopLoss: active.stopLoss,
    tp1: active.tp1,
    tp2: active.tp2,
    tp3: active.tp3,
    risk: active.risk,
    realizedR: 0,
    result: 'OPEN',
    status: 'OPEN',
    exit: null,
    exitTime: null,
    reason: active.tp1Hit ? 'TP1 reached; TP2 and SL not reached yet' : 'Active confirmed signal; TP2 and SL not reached yet'
  };
}

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
