import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';
const ALLOWED=new Set(['1min','5min','15min']);
export async function onRequest({request,env,waitUntil}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  try{
    const u=new URL(request.url),interval=ALLOWED.has(u.searchParams.get('interval'))?u.searchParams.get('interval'):'15min';
    const outputsize=Math.min(500,Math.max(100,Number(u.searchParams.get('outputsize')||CONFIG.outputSize)));
    let candles=null, provider='Twelve Data', fallback=false;
    const keys=[env.TWELVE_DATA_API_KEY,env.TWELVE_DATA_API_KEY_2,env.TWELVE_DATA_API_KEY_3,env.TWELVE_DATA_API_KEY_4].map(x=>String(x||'').trim()).filter(Boolean);
    for(const key of keys){
      try{
        const p=new URLSearchParams({symbol:'XAU/USD',interval,outputsize:String(outputsize),order:'ASC',timezone:'UTC',apikey:key});
        const r=await fetch('https://api.twelvedata.com/time_series?'+p);
        const d=await r.json();
        if(!r.ok||d?.status==='error'||!Array.isArray(d?.values))continue;
        const parsed=d.values.map(x=>({time:Math.floor(Date.parse(String(x.datetime||'').replace(' ','T')+'Z')/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
        if(parsed.length){candles=parsed;provider='Twelve Data';break}
      }catch(_){}
    }
    if(!candles?.length){
      try{
        const yi=interval==='1min'?'1m':interval==='5min'?'5m':'15m';
        const y=new URL('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X');
        y.searchParams.set('range','5d');y.searchParams.set('interval',yi);y.searchParams.set('includePrePost','false');
        const yr=await fetch(y.toString(),{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'}});
        const yd=await yr.json(),q=yd?.chart?.result?.[0],v=q?.indicators?.quote?.[0]||{};
        if(q?.timestamp){
          candles=q.timestamp.map((ts,i)=>({time:Number(ts),open:Number(v.open?.[i]),high:Number(v.high?.[i]),low:Number(v.low?.[i]),close:Number(v.close?.[i]),volume:Number(v.volume?.[i]||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
          provider='Yahoo Finance';fallback=true;
        }
      }catch(_){}
    }
    if(!candles?.length){
      const xr=await fetch('https://xaus.com/api/v1/intraday?symbol=xau&hours=48',{headers:{Accept:'application/json'},cf:{cacheTtl:30,cacheEverything:true}});
      const xd=await xr.json(),points=Array.isArray(xd?.points)?xd.points:[];
      const seconds=interval==='1min'?60:interval==='5min'?300:900,buckets=new Map();
      for(const p of points){
        const raw=Number(p?.t),ts=Number.isFinite(raw)?(raw>100000000000?Math.floor(raw/1000):Math.floor(raw)):Math.floor(Date.parse(String(p?.t||''))/1000),price=Number(p?.p);
        if(!Number.isFinite(ts)||!Number.isFinite(price)||price<=0)continue;
        const b=Math.floor(ts/seconds)*seconds,old=buckets.get(b);
        if(!old)buckets.set(b,{time:b,open:price,high:price,low:price,close:price,volume:0});
        else{old.high=Math.max(old.high,price);old.low=Math.min(old.low,price);old.close=price}
      }
      candles=[...buckets.values()].sort((a,b)=>a.time-b.time);
      if(candles.length){provider='XAUS';fallback=true}
    }
    if(!candles?.length)throw Error('All XAU/USD market feeds are unavailable');
    const now=Math.floor(Date.now()/1000),seconds=interval==='1min'?60:interval==='5min'?300:900;
    const closed=candles.filter(c=>c.time+seconds<=now);
    const analysis=analyze(closed);
    const trades=buildHistory(closed).map(t=>({...t,interval}));
    const openTrades=trades.filter(t=>t.result==='OPEN');
    const completed=trades.filter(t=>t.result!=='OPEN');
    const summary={totalTrades:trades.length,wins:completed.filter(t=>t.result==='WIN').length,losses:completed.filter(t=>t.result==='LOSS').length,open:openTrades.length,totalR:trades.reduce((s,t)=>s+Number(t.realizedR||0),0)};
    summary.winRate=summary.wins+summary.losses?Number((summary.wins/(summary.wins+summary.losses)*100).toFixed(2)):0;
    // Current confirmed signal is already represented in buildHistory. Reuse the
    // resolved lifecycle record so the dashboard cannot invent a second OPEN trade.
    const activeTrades=openTrades;
    const active=activeTrades[0]||null;
    const activePlan=active?{entry:active.entry,stopLoss:active.stopLoss,tp1:active.tp1,tp2:active.tp2,tp3:active.tp3,tp4:active.tp4,risk:active.risk,entryRule:active.entryRule}:null;
    return json({success:true,strategy:{id:'volume-ob-retest',name:'Volume OB · Box Retest Reaction',symbol:'XAU/USD',interval,parameters:CONFIG},dataProvider:{name:provider,fallback},market:{symbol:'XAU/USD',interval,price:candles.at(-1)?.close,lastCandleTime:candles.at(-1)?.time,candleCount:candles.length,analysisCandleCount:closed.length},candles,swings:analysis.swings,liquidity:{levels:[],sweeps:[]},signal:analysis.signal,tradePlan:activePlan,activeTrade:active,activeTrades,diagnostics:analysis.diagnostics,news:null,volumeOB:analysis.volumeOB,history:{summary,trades}});
  }catch(e){return json({success:false,error:e?.message||'Market data error'},500)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}