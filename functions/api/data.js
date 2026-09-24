import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';
const ALLOWED=new Set(['1min','5min']);
const FEED_CACHE=new Map();
const FEED_CACHE_TTL_MS=15000;

export async function onRequest({request,env,waitUntil}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  try{
    const u=new URL(request.url),interval=ALLOWED.has(u.searchParams.get('interval'))?u.searchParams.get('interval'):'5min';
    const outputsize=Math.min(500,Math.max(100,Number(u.searchParams.get('outputsize')||CONFIG.outputSize)));
    const cacheKey=interval+':'+outputsize;
    const cached=FEED_CACHE.get(cacheKey);
    const feedDiagnostics=[];
    let candles=null,provider='Twelve Data',fallback=false;
    if(cached&&Date.now()-cached.at<FEED_CACHE_TTL_MS){candles=cached.candles;provider=cached.provider;fallback=cached.fallback;feedDiagnostics.push({provider:provider,status:'CACHE',ageMs:Date.now()-cached.at});}
    const keys=[env.TWELVE_DATA_API_KEY,env.TWELVE_DATA_API_KEY_2,env.TWELVE_DATA_API_KEY_3,env.TWELVE_DATA_API_KEY_4].map(x=>String(x||'').trim()).filter(Boolean);
    if(!candles?.length){
      if(!keys.length)feedDiagnostics.push({provider:'Twelve Data',status:'NO_KEY'});
      for(let i=0;i<keys.length;i++){
        const key=keys[i],keySlot=i+1;
        try{
          const p=new URLSearchParams({symbol:'XAU/USD',interval,outputsize:String(outputsize),order:'ASC',timezone:'UTC',apikey:key});
          const r=await fetch('https://api.twelvedata.com/time_series?'+p,{headers:{Accept:'application/json'}});
          const d=await r.json().catch(()=>null);
          const creditsLeft=r.headers.get('api-credits-left'),creditsUsed=r.headers.get('api-credits-used');
          if(!r.ok||d?.status==='error'||!Array.isArray(d?.values)){
            const code=Number(d?.code||r.status);
            const status=code===429?'RATE_LIMIT':code===401?'INVALID_KEY':code===403?'PLAN_OR_PERMISSION':r.status>=500?'PROVIDER_ERROR':'NO_DATA';
            feedDiagnostics.push({provider:'Twelve Data',keySlot,status,httpStatus:r.status,code:Number.isFinite(code)?code:null,message:String(d?.message||r.statusText||'No usable data').slice(0,180),creditsLeft,creditsUsed});
            continue;
          }
          const parsed=d.values.map(x=>({time:Math.floor(Date.parse(String(x.datetime||'').replace(' ','T')+'Z')/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
          if(parsed.length){candles=parsed;provider='Twelve Data';fallback=false;feedDiagnostics.push({provider:'Twelve Data',keySlot,status:'OK',httpStatus:r.status,creditsLeft,creditsUsed,candles:parsed.length});FEED_CACHE.set(cacheKey,{at:Date.now(),candles,provider,fallback});break;}
          feedDiagnostics.push({provider:'Twelve Data',keySlot,status:'EMPTY',httpStatus:r.status,creditsLeft,creditsUsed});
        }catch(error){feedDiagnostics.push({provider:'Twelve Data',keySlot,status:'NETWORK_ERROR',message:String(error?.message||error).slice(0,180)});}
      }
    }
    if(!candles?.length){
      try{
        const yi=interval==='1min'?'1m':'5m';
        const y=new URL('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X');y.searchParams.set('range','5d');y.searchParams.set('interval',yi);y.searchParams.set('includePrePost','false');
        const yr=await fetch(y.toString(),{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'}});
        const yd=await yr.json().catch(()=>null),q=yd?.chart?.result?.[0],v=q?.indicators?.quote?.[0]||{};
        if(q?.timestamp){
          candles=q.timestamp.map((ts,i)=>({time:Number(ts),open:Number(v.open?.[i]),high:Number(v.high?.[i]),low:Number(v.low?.[i]),close:Number(v.close?.[i]),volume:Number(v.volume?.[i]||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
          if(candles.length){provider='Yahoo Finance';fallback=true;feedDiagnostics.push({provider:'Yahoo Finance',status:'OK',httpStatus:yr.status,candles:candles.length});FEED_CACHE.set(cacheKey,{at:Date.now(),candles,provider,fallback});}
        }else feedDiagnostics.push({provider:'Yahoo Finance',status:'NO_DATA',httpStatus:yr.status});
      }catch(error){feedDiagnostics.push({provider:'Yahoo Finance',status:'NETWORK_ERROR',message:String(error?.message||error).slice(0,180)});}
    }
    if(!candles?.length){
      try{
        const xr=await fetch('https://xaus.com/api/v1/intraday?symbol=xau&hours=48',{headers:{Accept:'application/json'},cf:{cacheTtl:30,cacheEverything:true}});
        const xd=await xr.json().catch(()=>null),points=Array.isArray(xd?.points)?xd.points:[];
        const seconds=interval==='1min'?60:interval==='5min'?300:900,buckets=new Map();
        for(const p of points){const raw=Number(p?.t),ts=Number.isFinite(raw)?(raw>100000000000?Math.floor(raw/1000):Math.floor(raw)):Math.floor(Date.parse(String(p?.t||''))/1000),price=Number(p?.p);if(!Number.isFinite(ts)||!Number.isFinite(price)||price<=0)continue;const b=Math.floor(ts/seconds)*seconds,old=buckets.get(b);if(!old)buckets.set(b,{time:b,open:price,high:price,low:price,close:price,volume:0});else{old.high=Math.max(old.high,price);old.low=Math.min(old.low,price);old.close=price}}
        candles=[...buckets.values()].sort((a,b)=>a.time-b.time);
        if(candles.length){provider='XAUS';fallback=true;feedDiagnostics.push({provider:'XAUS',status:'OK',httpStatus:xr.status,candles:candles.length});FEED_CACHE.set(cacheKey,{at:Date.now(),candles,provider,fallback});}else feedDiagnostics.push({provider:'XAUS',status:'NO_DATA',httpStatus:xr.status});
      }catch(error){feedDiagnostics.push({provider:'XAUS',status:'NETWORK_ERROR',message:String(error?.message||error).slice(0,180)});}
    }
    if(!candles?.length){
      const rateLimited=feedDiagnostics.some(x=>x.status==='RATE_LIMIT'),planBlocked=feedDiagnostics.some(x=>x.status==='PLAN_OR_PERMISSION'),invalidKey=feedDiagnostics.some(x=>x.status==='INVALID_KEY');
      const reason=rateLimited?'Twelve Data API limit reached':planBlocked?'Twelve Data plan/permission does not provide usable XAU/USD data':invalidKey?'Twelve Data API key is invalid':'All configured XAU/USD market feeds failed';
      const detail=feedDiagnostics.map(x=>x.provider+(x.keySlot?' #'+x.keySlot:'')+'='+x.status+(x.httpStatus?' ('+x.httpStatus+')':'')).join(', ');
      throw Error(reason+'. Feed diagnostics: '+detail);
    }
    const now=Math.floor(Date.now()/1000),seconds=interval==='1min'?60:interval==='5min'?300:900;
    const closed=candles.filter(c=>c.time+seconds<=now);
    const analysis=analyze(closed,{interval});
    let trades=[];
    if(env.TRADE_STATE){try{const id=env.TRADE_STATE.idFromName('xauusd'),stub=env.TRADE_STATE.get(id),stateResponse=await stub.fetch('https://state/'),state=await stateResponse.json(),bucket=state?.intervals?.[interval],persisted=[...(Array.isArray(bucket?.trades)?bucket.trades:[]),...(Array.isArray(bucket?.activeTrades)?bucket.activeTrades:[]),...(bucket?.active?[bucket.active]:[])],seen=new Set();trades=persisted.map(t=>({...t,interval:t.interval||interval})).filter(t=>{const key=t.interval+':'+(t.signalTime||'')+':'+(t.direction||'');if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>Number(a.signalTime||0)-Number(b.signalTime||0));}catch(_){}}
    if(!trades.length)trades=buildHistory(closed,{interval}).map(t=>({...t,interval}));
    const openTrades=trades.filter(t=>t.result==='OPEN'||t.status!=='CLOSED'),completed=trades.filter(t=>t.result!=='OPEN'&&t.status==='CLOSED');
    const activeTrades=openTrades;
    const summary={totalTrades:trades.length,wins:completed.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT').length,losses:completed.filter(t=>t.result==='LOSS').length,open:openTrades.length,totalR:trades.reduce((s,t)=>s+Number(t.realizedR||0),0)};
    summary.winRate=summary.wins+summary.losses?Number((summary.wins/(summary.wins+summary.losses)*100).toFixed(2)):0;
    const active=openTrades[0]||null,activePlan=active?{entry:active.entry,stopLoss:active.stopLoss,tp1:active.tp1,tp2:active.tp2,tp3:active.tp3,tp4:active.tp4,risk:active.risk,entryRule:active.entryRule}:null;
    return json({success:true,strategy:{id:'volume-ob-retest',name:'Volume OB · Box Retest Reaction',symbol:'XAU/USD',interval,parameters:{...CONFIG,intervalConfig:interval==='1min'?{requireRetest:false,minReactionBody:CONFIG.minReactionBody,minVolumePercent:CONFIG.minVolumePercent} :{requireRetest:true,minReactionBody:0.45,minVolumePercent:58}}},dataProvider:{name:provider,fallback},market:{symbol:'XAU/USD',interval,price:candles.at(-1)?.close,lastCandleTime:candles.at(-1)?.time,candleCount:candles.length,analysisCandleCount:closed.length},candles,swings:analysis.swings,liquidity:{levels:[],sweeps:[]},signal:analysis.signal,tradePlan:activePlan,activeTrade:active,activeTrades,diagnostics:{...(analysis.diagnostics||{}),feed:feedDiagnostics},news:null,volumeOB:analysis.volumeOB,history:{summary,trades}});
  }catch(e){return json({success:false,error:e?.message||'Market data error'},503)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}