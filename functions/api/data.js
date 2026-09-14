import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';

const ALLOWED = new Set(['5min','15min']);

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

    const a=analyze(unique);
    const trades=buildHistory(unique,a.swings,symbol);
    const wins=trades.filter(x=>x.result==='WIN').length;
    const losses=trades.filter(x=>x.result==='LOSS').length;
    const open=trades.filter(x=>x.result==='OPEN').length;
    const totalR=trades.reduce((s,x)=>s+Number(x.realizedR||0),0);
    const data={success:true,strategy:{id:'swing-liquidity',name:'Swing Liquidity',symbol,interval,parameters:CONFIG},market:{symbol,interval,price:unique.at(-1).close,lastCandleTime:unique.at(-1).time,candleCount:unique.length},candles:unique,swings:a.swings,liquidity:{levels:a.liquidityLevels,sweeps:a.sweeps},signal:a.signal,tradePlan:a.tradePlan,diagnostics:a.diagnostics,history:{summary:{totalTrades:trades.length,wins,losses,open,winRate:trades.length?Number((wins/trades.length*100).toFixed(2)):0,totalR:Number(totalR.toFixed(2))},trades}};
    const response=new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=30'}});
    waitUntil(cache.put(cacheKey,response.clone()));
    return new Response(response.body,{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=0, s-maxage=30, stale-while-revalidate=15','X-Wajid-Cache':'MISS'}});
  } catch(e) { return json({success:false,error:e?.message || 'Market data error'},500); }
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
