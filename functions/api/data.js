import { CONFIG, analyze, buildHistory } from '../../src/strategy.js';
const ALLOWED=new Set(['1min','5min','15min']);
export async function onRequest({request,env,waitUntil}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  try{
    const u=new URL(request.url),interval=ALLOWED.has(u.searchParams.get('interval'))?u.searchParams.get('interval'):'15min';
    const outputsize=Math.min(500,Math.max(100,Number(u.searchParams.get('outputsize')||CONFIG.outputSize)));
    let candles=null;
    const key=String(env.TWELVE_DATA_API_KEY||'').trim();
    if(key)try{
      const p=new URLSearchParams({symbol:'XAU/USD',interval,outputsize:String(outputsize),order:'ASC',timezone:'UTC',apikey:key});
      const r=await fetch('https://api.twelvedata.com/time_series?'+p),d=await r.json();
      if(r.ok&&d?.status!=='error'&&Array.isArray(d?.values))candles=d.values.map(x=>({time:Math.floor(Date.parse(x.datetime+'Z')/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
    }catch(_){}
    if(!candles?.length){
      const yi=interval==='1min'?'1m':interval==='5min'?'5m':'15m';
      const y=new URL('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X');
      y.searchParams.set('range','5d');y.searchParams.set('interval',yi);y.searchParams.set('includePrePost','false');
      const yr=await fetch(y.toString(),{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'}}),yd=await yr.json(),q=yd?.chart?.result?.[0],v=q?.indicators?.quote?.[0]||{};
      if(!yr.ok||!q?.timestamp)throw Error('Market data unavailable from Twelve Data and Yahoo');
      candles=q.timestamp.map((ts,i)=>({time:Number(ts),open:Number(v.open?.[i]),high:Number(v.high?.[i]),low:Number(v.low?.[i]),close:Number(v.close?.[i]),volume:Number(v.volume?.[i]||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));
    }
    const now=Math.floor(Date.now()/1000),seconds=interval==='1min'?60:interval==='5min'?300:900;
    const closed=candles.filter(c=>c.time+seconds<=now);
    const analysis=analyze(closed);
    const trades=buildHistory(closed).map(t=>({...t,interval}));
    const completed=trades.filter(t=>t.result!=='OPEN');
    const summary={totalTrades:trades.length,wins:completed.filter(t=>t.result==='WIN').length,losses:completed.filter(t=>t.result==='LOSS').length,open:trades.filter(t=>t.result==='OPEN').length,totalR:trades.reduce((s,t)=>s+Number(t.realizedR||0),0)};
    summary.winRate=summary.wins+summary.losses?Number((summary.wins/(summary.wins+summary.losses)*100).toFixed(2)):0;
    const active=analysis.signal.direction!=='WAIT'&&analysis.tradePlan?{id:interval+':'+analysis.signal.time+':'+analysis.signal.direction,interval,direction:analysis.signal.direction,signalTime:analysis.signal.time,entry:analysis.tradePlan.entry,stopLoss:analysis.tradePlan.stopLoss,tp1:analysis.tradePlan.tp1,tp2:analysis.tradePlan.tp2,tp3:analysis.tradePlan.tp3,tp4:analysis.tradePlan.tp4,risk:analysis.tradePlan.risk,hitTPs:[],result:'OPEN',status:'OPEN',entryRule:analysis.tradePlan.entryRule,zoneId:analysis.signal.zoneId}:null;
    return json({success:true,strategy:{id:'volume-ob-retest',name:'Volume OB · Box Retest Reaction',symbol:'XAU/USD',interval,parameters:CONFIG},dataProvider:{name:key?'Twelve Data':'Yahoo Finance',fallback:!key},market:{symbol:'XAU/USD',interval,price:candles.at(-1)?.close,lastCandleTime:candles.at(-1)?.time,candleCount:candles.length,analysisCandleCount:closed.length},candles,swings:analysis.swings,liquidity:{levels:[],sweeps:[]},signal:analysis.signal,tradePlan:analysis.tradePlan,activeTrade:active,activeTrades:active?[active]:[],diagnostics:analysis.diagnostics,news:null,volumeOB:analysis.volumeOB,history:{summary,trades}});
  }catch(e){return json({success:false,error:e?.message||'Market data error'},500)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}