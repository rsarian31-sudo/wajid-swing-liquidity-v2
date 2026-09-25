import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';
const ALLOWED=new Set(['1min','5min']);
const FEED_CACHE=new Map();
const FEED_CACHE_TTL_MS=15000;

export async function onRequest({request,env,waitUntil}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  try{
    const u=new URL(request.url),interval=ALLOWED.has(u.searchParams.get('interval'))?u.searchParams.get('interval'):'1min';
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
    let bucket=null;
    if(env.TRADE_STATE){try{const id=env.TRADE_STATE.idFromName('xauusd'),stub=env.TRADE_STATE.get(id),stateResponse=await stub.fetch('https://state/'),state=await stateResponse.json();bucket=state?.intervals?.[interval]||null;const persisted=[...(Array.isArray(bucket?.trades)?bucket.trades:[]),...(Array.isArray(bucket?.activeTrades)?bucket.activeTrades:[]),...(bucket?.active?[bucket.active]:[])],seen=new Set();trades=persisted.map(t=>({...t,interval:t.interval||interval})).filter(t=>{const key=t.interval+':'+(t.signalTime||'')+':'+(t.direction||'');if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>Number(a.signalTime||0)-Number(b.signalTime||0));}catch(_){}}
    if(!trades.length)trades=buildHistory(closed,{interval}).map(t=>({...t,interval}));
    // activeTrades is the authoritative source for currently open positions.
    // Do not infer OPEN from historical records with a missing status field.
    const persistedActive=Array.isArray(bucket?.activeTrades)?bucket.activeTrades:(bucket?.active?[bucket.active]:[]);
    // activeTrades is normally authoritative. If state persistence misses an
    // active position, recover OPEN records from the same 1M trade history.
    // This keeps the Open counter aligned with trades that are visibly still
    // running (for example TP1/TP2/TP3 hit but TP4/SL not yet reached).
    const activeMap=new Map();
    for(const t of persistedActive.filter(t=>t?.id)) activeMap.set(String(t.id),{...t,interval:t.interval||interval});
    for(const t of trades.filter(t=>t?.id&&t?.status==='OPEN')) {
      if(!activeMap.has(String(t.id))) activeMap.set(String(t.id),{...t,interval:t.interval||interval});
    }
    const activeTrades=[...activeMap.values()];
    const activeIds=new Set(activeTrades.map(t=>String(t.id)));
    const completed=trades.filter(t=>!activeIds.has(String(t.id)) && t.status==='CLOSED');
    const completedWins=completed.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT'||t.result==='FINAL TP4 HIT'||t.result==='TP2 HIT CLOSE'||t.result==='TP3 HIT CLOSE').length; const completedLosses=completed.filter(t=>t.result==='LOSS').length; const summary={totalTrades:trades.length,wins:completedWins,losses:completedLosses,open:activeTrades.length,totalR:Number(completed.reduce((s,t)=>s+Number(t.realizedR||0),0).toFixed(2))};
    summary.winRate=summary.wins+summary.losses?Number((summary.wins/(summary.wins+summary.losses)*100).toFixed(2)):0;
    const active=activeTrades[0]||null,activePlan=active?{entry:active.entry,stopLoss:active.stopLoss,tp1:active.tp1,tp2:active.tp2,tp3:active.tp3,tp4:active.tp4,risk:active.risk,entryRule:active.entryRule}:null;
    function accountR(t){
      const result=String(t?.result||'').toUpperCase();
      const hits=Array.isArray(t?.hitTPs)?t.hitTPs:[];
      if(result==='LOSS')return -1;
      if(result==='BREAK EVEN')return 0;
      if(result==='FULL TP HIT' || result==='FINAL TP4 HIT')return 4;
      // Dollar account P/L is realized only after the trade is CLOSED.
      // TP2/TP3 are milestones while OPEN, not realized profit.
      if(result==='FULL TP HIT' || result==='FINAL TP4 HIT' || hits.includes('TP4'))return 4;
      // If TP2/TP3 was reached and the trade later closes at entry,
      // the realized result is +1R (not the highest milestone reached).
      if(result==='TP2 HIT CLOSE' || result==='TP3 HIT CLOSE')return 1;
      if(result==='WIN' && (t.reason==='SL_AFTER_TP2_WIN' || hits.includes('TP2')))return 1;
      return 0;
    }
    // Trade/candle timestamps in this system are normally Unix seconds.
    // Normalize seconds and milliseconds before applying Malaysia UTC+8.
    function malaysiaDate(ms){
      const raw=Number(ms);
      const millis=raw>0&&raw<1e12?raw*1000:raw;
      return new Date(millis+480*60000);
    }
    function malaysiaDayKey(ms){
      const d=malaysiaDate(ms);
      return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
    }
    function malaysiaWeekKey(ms){
      const d=malaysiaDate(ms);
      const day=d.getUTCDay();
      d.setUTCDate(d.getUTCDate()-(day===0?6:day-1));
      return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
    }
    function buildAccountReport(source){
      // Dollar account P/L is based only on fully CLOSED 1M trades.
      // Open trades and TP milestones do not change the account balance.
      const closed1m=source.filter(t=>t?.interval==='1min'&&t?.status==='CLOSED');
      const dayKey=malaysiaDayKey(Date.now());
      const weekKey=malaysiaWeekKey(Date.now());
      const make=(rows,period)=> {
        const rs=rows.map(accountR);
        const totalR=Number(rs.reduce((a,b)=>a+b,0).toFixed(2));
        const profit=Number(rs.filter(r=>r>0).reduce((a,b)=>a+b*8,0).toFixed(2));
        const loss=Number(rs.filter(r=>r<0).reduce((a,b)=>a+b*8,0).toFixed(2));
        const net=Number((profit+loss).toFixed(2));
        return {period,startingBalance:100,riskPerTrade:8,trades:rows.length,profit,loss,net,totalR,currentBalance:Number((100+net).toFixed(2))};
      };
      const daily=closed1m.filter(t=>malaysiaDayKey(t.exitTime||t.signalTime||t.createdAt)===dayKey);
      const weekly=closed1m.filter(t=>malaysiaWeekKey(t.exitTime||t.signalTime||t.createdAt)===weekKey);
      return {daily:make(daily,'DAILY'),weekly:make(weekly,'WEEKLY')};
    }
    const accountReport=buildAccountReport(trades);
    return json({success:true,strategy:{id:'volume-ob-retest',name:'Volume OB · Box Retest Reaction',symbol:'XAU/USD',interval,parameters:{...CONFIG,intervalConfig:interval==='1min'?{requireRetest:false,minReactionBody:CONFIG.minReactionBody,minVolumePercent:CONFIG.minVolumePercent} :{requireRetest:true,minReactionBody:0.45,minVolumePercent:58}}},dataProvider:{name:provider,fallback},market:{symbol:'XAU/USD',interval,price:candles.at(-1)?.close,lastCandleTime:candles.at(-1)?.time,candleCount:candles.length,analysisCandleCount:closed.length},candles,swings:analysis.swings,liquidity:{levels:[],sweeps:[]},signal:analysis.signal,tradePlan:activePlan,activeTrade:active,activeTrades,diagnostics:{...(analysis.diagnostics||{}),feed:feedDiagnostics},news:null,volumeOB:analysis.volumeOB,history:{summary,trades},accountReport});
  }catch(e){return json({success:false,error:e?.message||'Market data error'},503)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}