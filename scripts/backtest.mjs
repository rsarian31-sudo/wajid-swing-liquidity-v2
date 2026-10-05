import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA_URL = 'https://raw.githubusercontent.com/getdata-finance/xauusd-1m-ohlcv-metals-historical-data/main/XAUUSD_1m.csv';
const CSV = '/tmp/XAUUSD_1m.csv';
const strategyPath = '/tmp/strategy.mjs';

if (!fs.existsSync(CSV)) execFileSync('curl', ['-L','--fail','--silent','--show-error','-o',CSV,DATA_URL], {stdio:'inherit'});

const lines = fs.readFileSync(CSV,'utf8').trim().split(/\r?\n/);
const candles = [];
for (let i=1;i<lines.length;i++) {
  const p = lines[i].split(',');
  if (p.length < 6) continue;
  const time = Math.floor(new Date(p[0]).getTime()/1000);
  const open=+p[1], high=+p[2], low=+p[3], close=+p[4], volume=+p[5];
  if ([time,open,high,low,close].every(Number.isFinite)) candles.push({time,open,high,low,close,volume:Number.isFinite(volume)?volume:0});
}
candles.sort((a,b)=>a.time-b.time);

function bucket5(c) { return Math.floor(c.time/300)*300; }
function resample5(src) {
  const out=[]; let cur=null;
  for (const c of src) {
    const b=bucket5(c);
    if (!cur || cur.time!==b) {
      cur={time:b,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};
      out.push(cur);
    } else {
      cur.high=Math.max(cur.high,c.high); cur.low=Math.min(cur.low,c.low); cur.close=c.close; cur.volume+=c.volume;
    }
  }
  return out;
}
const candles5=resample5(candles);

const { analyze } = await import(strategyPath);

function myHour(ts) {
  return new Date(ts*1000).getUTCHours()+8 >= 24 ? new Date(ts*1000).getUTCHours()-16 : new Date(ts*1000).getUTCHours()+8;
}
function newEntriesOn(ts) {
  const h=myHour(ts);
  return h>=18 || h<8 || (h===8); // corrected below using minutes
}
function myMinutes(ts) {
  const d=new Date(ts*1000); return (d.getUTCHours()+8)%24*60+d.getUTCMinutes();
}
function sessionOpen(ts) {
  const m=myMinutes(ts);
  return m>=18*60+30 || m<8*60+30;
}

function closeTrade(t, result, r, exit, exitTime, reason) {
  t.result=result; t.realizedR=r; t.exit=exit; t.exitTime=exitTime; t.status='CLOSED'; t.reason=reason; return t;
}
function advance(trades, c) {
  const closed=[];
  for (const t of trades) {
    if (t.status==='CLOSED') continue;
    const levels=[['TP1',1,'tp1'],['TP2',2,'tp2'],['TP3',3,'tp3'],['TP4',4,'tp4']];
    for (const [label,r,key] of levels) {
      if (t.hit.has(label)) continue;
      const hit=t.direction==='BUY'?c.high>=t[key]:c.low<=t[key];
      if (!hit) continue;
      t.hit.add(label); t.realizedR=Math.max(t.realizedR,r);
      if (label==='TP1') t.stop=t.entry;
      if (label==='TP2') t.stop=t.entry;
      if (label==='TP4') { closed.push(closeTrade(t,'FULL TP HIT',4,t.tp4,c.time,'TP4_FULL')); break; }
    }
    if (t.status==='CLOSED') continue;
    const sl=t.direction==='BUY'?c.low<=t.stop:c.high>=t.stop;
    if (sl) {
      if (t.hit.has('TP2')) closed.push(closeTrade(t,t.hit.has('TP3')?'TP3 HIT CLOSE':'TP2 HIT CLOSE',1,t.stop,c.time,'SL_AT_ENTRY_AFTER_TP2'));
      else if (t.hit.has('TP1')) closed.push(closeTrade(t,'BREAK EVEN',0,t.stop,c.time,'SL_AT_ENTRY_AFTER_TP1'));
      else closed.push(closeTrade(t,'LOSS',-1,t.stop,c.time,'SL_BEFORE_TP1'));
    }
  }
  return closed;
}

async function run() {
  const active=[]; const closed=[]; let last5=null; let signals=0;
  const start=Math.max(300,60);
  for (let i=start;i<candles.length;i++) {
    const c=candles[i];
    const b=bucket5(c);
    const prev5=candles5.findIndex(x=>x.time===b)-1;
    // Recompute 5M only when a 5M candle has just closed (minute 4).
    if (c.time%300===240) {
      const fiveClosed=candles5.filter(x=>x.time<=b);
      if (fiveClosed.length>=40) last5=analyze(fiveClosed.slice(-300),{interval:'5min'});
    }
    // Existing trades are monitored 24/7.
    const done=advance(active,c);
    for (const x of done) {
      const idx=active.indexOf(x); if(idx>=0) active.splice(idx,1);
      closed.push(x);
    }
    const one=analyze(candles.slice(Math.max(0,i-299),i+1),{
      interval:'1min',
      structureDirection:last5?.structureDirection||null
    });
    if (one?.signal?.direction && one.signal.direction!=='WAIT' && one.tradePlan && sessionOpen(c.time)) {
      const id=`${c.time}:${one.signal.direction}`;
      if (!active.some(t=>t.id===id) && !closed.some(t=>t.id===id)) {
        const p=one.tradePlan;
        active.push({
          id, direction:one.signal.direction, signalTime:c.time, entry:p.entry, stop:p.stopLoss,
          tp1:p.tp1,tp2:p.tp2,tp3:p.tp3,tp4:p.tp4,hit:new Set(),realizedR:0,status:'OPEN'
        });
        signals++;
      }
    }
  }
  const last=candles.at(-1);
  // Force-close still-open trades at end only for reporting; exclude them from realized metrics.
  const realized=closed.filter(t=>t.status==='CLOSED');
  const rsum=realized.reduce((s,t)=>s+t.realizedR,0);
  let equity=0, peak=0, maxDD=0;
  for(const t of realized){ equity+=t.realizedR; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity); }
  const wins=realized.filter(t=>t.realizedR>0).length;
  const losses=realized.filter(t=>t.realizedR<0).length;
  const be=realized.filter(t=>t.realizedR===0).length;
  const grossWin=realized.filter(t=>t.realizedR>0).reduce((s,t)=>s+t.realizedR,0);
  const grossLoss=Math.abs(realized.filter(t=>t.realizedR<0).reduce((s,t)=>s+t.realizedR,0));
  const pf=grossLoss?grossWin/grossLoss:null;
  const byTF={};
  for(const t of realized){const tf=t.id.includes(':')?'1M':'?'; byTF[tf]=(byTF[tf]||0)+t.realizedR;}
  const summary={
    dataset:{source:'getdata-finance GitHub XAUUSD 1m sample',from:new Date(candles[0].time*1000).toISOString(),to:new Date(last.time*1000).toISOString(),candles:candles.length},
    rule:'volume-ob-retest-v3',
    execution:{entry:'signal candle close',newEntries:'18:30–08:30 MYT',existingTrades:'monitored 24/7',overlappingTrades:true},
    results:{signals,closedTrades:realized.length,wins,losses,breakEven:be,winRatePct:realized.length?100*wins/realized.length:0,totalR:rsum,profitFactor:pf,maxDrawdownR:maxDD,openAtEnd:active.length},
    note:'Intrabar TP/SL ordering follows the current worker logic: TP milestones are checked before stop within the same candle.'
  };
  fs.writeFileSync('/tmp/backtest-summary.json',JSON.stringify(summary,null,2));
  fs.writeFileSync('/tmp/backtest-trades.json',JSON.stringify(realized,null,2));
  console.log(JSON.stringify(summary,null,2));
}
await run();
