import { onRequest as dataRequest } from './functions/api/data.js';
import { onRequest as healthRequest } from './functions/api/health.js';
import { CONFIG, analyze, buildHistory } from './src/strategy.js';
import { fetchNewsContext } from './src/news.js';
import { WajidTradeState } from './state.js';

const INTERVALS = ['1min', '5min', '15min'];
const SYMBOL = 'XAU/USD';
const RULE_VERSION = 'volume-ob-creation-v2';
const DATA_URL = 'https://api.twelvedata.com/time_series';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_WEBHOOK_URL = 'https://wajid-swing-liquidity-v2.rsarian31.workers.dev/telegram/webhook';
const DUPLICATE_WINDOW_SECONDS = 15 * 60;
const DUPLICATE_PRICE_TOLERANCE = 0.003;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') return telegramWebhook(request, env);
    if (url.pathname === '/api/data') return dataRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    if (url.pathname === '/api/health') return healthRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    // Cron is the outgoing Telegram signal engine.
    if (!env.TELEGRAM_BOT_TOKEN || !env.TRADE_STATE) return;
    await ensureTelegramWebhook(env);
    for (const interval of ['1min', '5min', '15min']) {
      try {
        await runInterval(interval, env);
      } catch (error) {
        console.error('scheduled signal error', interval, error?.message || error);
      }
    }
  }
};

async function runInterval(interval, env) {
  if (!env.TRADE_STATE) return;
  const feed = await fetchClosedCandles(interval, env);
  const candles = feed.closed;
  const entryCandle = feed.current;
  if (candles.length < 50) return;

  const id = env.TRADE_STATE.idFromName('xauusd');
  const state = env.TRADE_STATE.get(id);
  const current = await getState(state);
  const htfKey = interval === '1min' ? '5min' : interval === '5min' ? '15min' : null;
  const htfStructure = htfKey ? current?.intervals?.[htfKey]?.structureDirection || null : null;
  const news = await fetchNewsContext();
  const analysis = analyze(candles, news, entryCandle, { structureDirection: htfStructure, requireStructureAlignment: !!htfStructure });
  const bucket = current.intervals[interval] || { active: null, trades: [], lastSignalId: null, lastCandleTime: null, structureDirection: null };
  bucket.structureDirection = analysis.structureDirection || null;

  if (bucket.ruleVersion !== RULE_VERSION) {
    bucket.active = null; bucket.activeTrades = []; bucket.trades = []; bucket.lastSignalId = null; bucket.lastCandleTime = null; bucket.ruleVersion = RULE_VERSION;
  }

  const telegram = ensureTelegramState(current, env);
  await retryPendingTelegram(env, telegram);

  // Persist every discovered historical signal for this timeframe.
  // The previous version only seeded history once and capped it at 200 trades,
  // which caused older signals to disappear from the website/report.
  const discoveredHistory = buildHistory(candles, analysis.swings, SYMBOL)
    .filter(t => t.result !== 'OPEN')
    .map(t => ({ ...t, interval }));
  if (discoveredHistory.length) {
    bucket.trades = mergeTrades(bucket.trades, discoveredHistory);
  }

  const activeList = Array.isArray(bucket.activeTrades) ? bucket.activeTrades : (bucket.active ? [bucket.active] : []);
  const stillActive = [];
  for (const activeTrade of activeList) {
    const events = advanceActiveTrade(activeTrade, candles);
    for (const event of events.notifications) {
      await sendTelegramWithQueue(env, event, telegram);
      current.telegram = telegram;
      await putState(state, current);
    }
    if (events.closed) { bucket.trades.push(events.closed); bucket.trades = dedupeTrades(bucket.trades); }
    else stillActive.push(events.active);
  }
  bucket.activeTrades = stillActive;
  bucket.active = stillActive[0] || null;

  // Catch up any signals created since the previous scheduler tick.
  // This prevents a delayed/skipped cron invocation from permanently losing a signal.
  const previousCandleTime = Number(bucket.lastCandleTime || 0);
  const historicalSignals = buildHistory(candles)
    .filter(t => t && t.signalTime && t.direction && t.direction !== 'WAIT')
    .filter(t => previousCandleTime ? Number(t.signalTime) > previousCandleTime : false)
    .slice(-20);

  const candidates = [...historicalSignals];
  if (analysis.signal?.direction && analysis.signal.direction !== 'WAIT' && analysis.signal.time) {
    candidates.push({
      signalTime: analysis.signal.time, direction: analysis.signal.direction,
      entry: analysis.tradePlan?.entry, stopLoss: analysis.tradePlan?.stopLoss,
      tp1: analysis.tradePlan?.tp1, tp2: analysis.tradePlan?.tp2, tp3: analysis.tradePlan?.tp3, tp4: analysis.tradePlan?.tp4,
      risk: analysis.tradePlan?.risk, probability: analysis.signal.probability, score: analysis.signal.score
    });
  }

  const uniqueCandidates = [];
  const seenCandidateIds = new Set();
  for (const candidate of candidates.sort((a,b) => Number(a.signalTime)-Number(b.signalTime))) {
    const signalId = `${interval}:${candidate.signalTime}:${candidate.direction}`;
    if (seenCandidateIds.has(signalId) || bucket.lastSignalId === signalId) continue;
    seenCandidateIds.add(signalId);
    uniqueCandidates.push({ candidate, signalId });
  }

  for (const { candidate, signalId } of uniqueCandidates) {
    const signal = {
      direction: candidate.direction, time: Number(candidate.signalTime), entryTime: Number(candidate.signalTime),
      price: Number(candidate.entry ?? candidate.price ?? 0),
      probability: Number(candidate.probability ?? analysis.signal?.probability ?? 0),
      score: Number(candidate.score ?? analysis.signal?.score ?? 0),
      confirmation: { time: Number(candidate.confirmationTime ?? candidate.signalTime), price: Number(candidate.entry ?? candidate.price ?? 0) },
      sweep: null
    };
    const plan = candidate.entry != null
      ? { entry:candidate.entry, stopLoss:candidate.stopLoss, tp1:candidate.tp1, tp2:candidate.tp2, tp3:candidate.tp3, tp4:candidate.tp4, risk:candidate.risk }
      : analysis.tradePlan;
    if (!plan) continue;

    if (isCrossTimeframeDuplicate(current, interval, signal)) {
      bucket.lastSignalId = signalId;
      bucket.lastDuplicate = { time: signal.time, direction: signal.direction, price: signal.price, reason: 'CROSS_TIMEFRAME_DUPLICATE' };
      continue;
    }

    let active = makeActiveTrade(interval, signal, plan, analysis, news);
    bucket.lastSignalId = signalId;
    const telegramResult = await sendTelegramWithQueue(env, { type:'SIGNAL', interval, trade:active, probability:signal.probability, score:signal.score }, telegram);
    if (telegramResult?.messageIds) active = { ...active, telegramMessageIds: telegramResult.messageIds };
    current.telegram = telegram;
    await putState(state, current);
    bucket.activeTrades = [...(Array.isArray(bucket.activeTrades) ? bucket.activeTrades : []), active];
    bucket.active = bucket.activeTrades[0] || active;
    current.intervals[interval] = bucket;
    current.telegram = telegram;
    await putState(state, current);

    const events = advanceActiveTrade(active, candles);
    for (const event of events.notifications) await sendTelegramWithQueue(env, event, telegram);
    if (events.closed) {
      bucket.trades.push(events.closed); bucket.trades = dedupeTrades(bucket.trades);
      bucket.activeTrades = bucket.activeTrades.filter(t => t.id !== active.id);
    } else {
      bucket.activeTrades = bucket.activeTrades.map(t => t.id === active.id ? events.active : t);
    }
    bucket.active = bucket.activeTrades[0] || null;
  }
  bucket.trades = dedupeTrades(bucket.trades);
  bucket.lastCandleTime = candles.at(-1)?.time ?? null;
  current.intervals[interval] = bucket;
  current.telegram = telegram;
  await putState(state, current);
}

function isCrossTimeframeDuplicate(_state, _interval, _signal) {
  // Each timeframe is an independent signal stream.
  // A valid 1M signal must not suppress a 5M/15M signal, and vice versa.
  // Same-timeframe duplicates are already blocked by bucket.lastSignalId.
  return false;
}

function ensureTelegramState(state, env) {
  if (!state.telegram || typeof state.telegram !== 'object') state.telegram = { offset: 0, subscribers: [] };
  if (!Number.isFinite(Number(state.telegram.offset))) state.telegram.offset = 0;
  if (!Array.isArray(state.telegram.subscribers)) state.telegram.subscribers = [];
  if (!Array.isArray(state.telegram.pending)) state.telegram.pending = [];
  const configured = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (configured) {
    const found = state.telegram.subscribers.find(s => String(s.chatId) === configured);
    if (!found) state.telegram.subscribers.push({ chatId: configured, active: true, source: 'env', updatedAt: Date.now() });
  }
  return state.telegram;
}
function telegramKeyboard(){return{keyboard:[[{text:'📊 Daily Stats'},{text:'📅 Weekly Report'}],[{text:'📈 All Stats'},{text:'🔄 Refresh Stats'}],[{text:'🟢 Status'},{text:'❓ Help'}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false}}
function normalizeTelegramCommand(text){const value=String(text||'').trim().toLowerCase();if(value==='📊 daily stats'||value==='/daily'||value==='/today')return'/daily';if(value==='📅 weekly report'||value==='/weekly'||value==='/week')return'/weekly';if(value==='📈 all stats'||value==='🔄 refresh stats'||value==='/stats')return'/stats';if(value==='🟢 status'||value==='/status')return'/status';if(value==='❓ help'||value==='/help')return'/help';if(value==='/start'||value==='/subscribe')return'/start';if(value==='/stop'||value==='/unsubscribe')return'/stop';return value.split(/\s+/)[0].split('@')[0]}
async function ensureTelegramWebhook(env){if(!env.TELEGRAM_BOT_TOKEN)return false;try{const response=await fetch(`${TELEGRAM_API}${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:TELEGRAM_WEBHOOK_URL,allowed_updates:['message'],drop_pending_updates:false})});const data=await response.json();return response.ok&&data?.ok===true}catch(_){return false}}
async function telegramWebhook(request,env){if(!env.TELEGRAM_BOT_TOKEN||!env.TRADE_STATE)return new Response('Not configured',{status:503});try{await processTelegramUpdate(await request.json(),env);return new Response('OK',{status:200})}catch(_){return new Response('OK',{status:200})}}
async function processTelegramUpdate(update,env){const message=update?.message;if(!message||message.chat?.type!=='private'||!message.text)return;const id=env.TRADE_STATE.idFromName('xauusd'),stub=env.TRADE_STATE.get(id),state=await getState(stub);const telegram=ensureTelegramState(state,env),command=normalizeTelegramCommand(message.text),chatId=String(message.chat.id);const existing=telegram.subscribers.find(s=>String(s.chatId)===chatId),base={chatId,username:message.from?.username||null,firstName:message.from?.first_name||null,updatedAt:Date.now()};let changed=false;if(command==='/start'){if(existing)Object.assign(existing,base,{active:true});else telegram.subscribers.push({...base,active:true});await telegramMessage(env,chatId,'✅ WAJID Swing Liquidity is ACTIVE.\n\nUse the buttons below to view Daily, Weekly and All Stats.\n\nYou will receive future XAU/USD 1M, 5M and 15M signals and trade results automatically.');changed=true}else if(command==='/stop'){if(existing)Object.assign(existing,base,{active:false});else telegram.subscribers.push({...base,active:false});await telegramMessage(env,chatId,'🛑 WAJID Swing Liquidity subscription is OFF. Send /start to subscribe again.');changed=true}else if(command==='/status'){await telegramMessage(env,chatId,existing?.active===true?'🟢 Subscription status: ACTIVE\n\nSignal notifications: ON':'⚪ Subscription status: OFF.\n\nSend /start to subscribe.')}else if(command==='/daily')await telegramMessage(env,chatId,formatPeriodReport(state,'daily'));else if(command==='/weekly')await telegramMessage(env,chatId,formatPeriodReport(state,'weekly'));else if(command==='/stats')await telegramMessage(env,chatId,`${formatPeriodReport(state,'daily')}\n\n${formatPeriodReport(state,'weekly')}`);else if(command==='/help')await telegramMessage(env,chatId,'📊 WAJID Swing Liquidity\n\n📊 Daily Stats — today signals + W/L + win rate\n📅 Weekly Report — this week signals + W/L + win rate\n📈 All Stats — today + this week\n🔄 Refresh Stats — refresh current statistics\n🟢 Status — subscription status\n\nCommands: /start /stop /daily /weekly /stats /status /help');state.telegram=telegram;if(changed)await putState(stub,state)}
function formatPeriodReport(state,period){const now=new Date(),start=period==='daily'?startOfUtcDay(now):startOfUtcWeek(now),end=period==='daily'?new Date(start.getTime()+86400000):new Date(start.getTime()+7*86400000),trades=collectTrades(state).filter(t=>{const raw=t.signalTime??t.createdAt??0;const numeric=Number(raw);const ts=Number.isFinite(numeric)?numeric*(numeric<100000000000?1000:1):Date.parse(String(raw));return Number.isFinite(ts)&&ts>=start.getTime()&&ts<end.getTime()}),signals=trades.length,wins=trades.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT').length,losses=trades.filter(t=>t.result==='LOSS').length,open=trades.filter(t=>!t.result||t.status!=='CLOSED').length,decided=wins+losses,winRate=decided?((wins/decided)*100).toFixed(1):'0.0',totalR=trades.reduce((sum,t)=>sum+(Number.isFinite(Number(t.realizedR))?Number(t.realizedR):0),0),one=trades.filter(t=>t.interval==='1min'),five=trades.filter(t=>t.interval==='5min'),fifteen=trades.filter(t=>t.interval==='15min'),label=period==='daily'?`📊 DAILY REPORT · ${utcDateLabel(start)}`:`📅 WEEKLY REPORT · ${utcDateLabel(start)} → ${utcDateLabel(new Date(end.getTime()-86400000))}`;return[`🔥 WAJID SWING LIQUIDITY`,label,`XAU/USD`,'',`📌 Signals: ${signals}`,`✅ Win: ${wins}`,`❌ Loss: ${losses}`,`⏳ Open: ${open}`,`🎯 Win Rate: ${winRate}%`,`📈 Total R: ${totalR>=0?'+':''}${totalR.toFixed(2)}R`,'',`1M: ${one.length} signals · ${one.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT').length}W / ${one.filter(t=>t.result==='LOSS').length}L`,`5M: ${five.length} signals · ${five.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT').length}W / ${five.filter(t=>t.result==='LOSS').length}L`,`15M: ${fifteen.length} signals · ${fifteen.filter(t=>t.result==='WIN'||t.result==='FULL TP HIT').length}W / ${fifteen.filter(t=>t.result==='LOSS').length}L`,'','🔒 Server-controlled results','🕐 Report timezone: UTC'].join('\n')}
function collectTrades(state){const all=[];for(const interval of INTERVALS){const bucket=state?.intervals?.[interval];if(!bucket)continue;if(Array.isArray(bucket.trades))all.push(...bucket.trades);if(bucket.active)all.push(bucket.active)}const seen=new Set();return all.filter(t=>t?.id&&!seen.has(t.id)&&(seen.add(t.id),true))}
function startOfUtcDay(date){return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()))}
function startOfUtcWeek(date){const day=date.getUTCDay(),diff=day===0?-6:1-day,start=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));start.setUTCDate(start.getUTCDate()+diff);return start}
function utcDateLabel(date){return date.toISOString().slice(0,10)}

async function fetchClosedCandles(interval,env){const keys=[env.TWELVE_DATA_API_KEY,env.TWELVE_DATA_API_KEY_2,env.TWELVE_DATA_API_KEY_3,env.TWELVE_DATA_API_KEY_4].map(k=>String(k||'').trim()).filter(Boolean);let lastError=null;for(const apiKey of keys){try{const params=new URLSearchParams({symbol:SYMBOL,interval,outputsize:String(CONFIG.outputSize),order:'ASC',timezone:'UTC',apikey:apiKey}),response=await fetch(DATA_URL+'?'+params),data=await response.json();if(!response.ok||data?.status==='error'||data?.code)throw new Error(data?.message||'Twelve Data request failed');const seconds=interval==='1min'?60:interval==='5min'?300:900,now=Math.floor(Date.now()/1000),candles=(data.values||[]).map(x=>({time:Math.floor(x.timestamp?Number(x.timestamp):Date.parse(String(x.datetime||''))/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite));candles.sort((a,b)=>a.time-b.time);const unique=[],seen=new Set();for(const candle of candles)if(!seen.has(candle.time)){seen.add(candle.time);unique.push(candle)}const current=unique.length&&unique.at(-1).time+seconds>now?unique.at(-1):null,closed=current?unique.slice(0,-1):unique;if(closed.length<50)throw new Error('Twelve Data returned insufficient closed candles');return{closed,current}}catch(error){lastError=error}}throw lastError||new Error('No Twelve Data API key configured')}
function makeActiveTrade(interval,signal,plan,analysis,news){return{id:interval+':'+signal.time+':'+signal.direction,interval,direction:signal.direction,signalTime:signal.entryTime||signal.time,confirmationTime:signal.confirmation?.time??signal.time,confirmationPrice:Number(signal.confirmation?.price??0),signalPrice:Number(signal.price.toFixed(2)),probability:signal.probability,score:signal.score,entry:Number(plan.entry.toFixed(2)),stopLoss:Number(plan.stopLoss.toFixed(2)),tp1:Number(plan.tp1.toFixed(2)),tp2:Number(plan.tp2.toFixed(2)),tp3:Number(plan.tp3.toFixed(2)),tp4:Number(plan.tp4.toFixed(2)),risk:Number(plan.risk.toFixed(2)),sweep:analysis.signal?.sweep||null,news:news||null,tp1Hit:false,tp2Hit:false,tp3Hit:false,tp4Hit:false,hitTPs:[],realizedR:0,telegramMessageIds:{},createdAt:Date.now()}}
function advanceActiveTrade(active,candles){
  const notifications=[],next={...active,hitTPs:Array.isArray(active.hitTPs)?[...active.hitTPs]:[]};
  const start=candles.findIndex(c=>c.time>=active.signalTime);
  if(start<0)return{active:next,closed:null,notifications};
  for(let i=start;i<candles.length;i++){
    const candle=candles[i];
    const sl=active.direction==='BUY'?candle.low<=active.stopLoss:candle.high>=active.stopLoss;
    if(sl){
      next.realizedR=Number((Number(next.realizedR||0)-1).toFixed(2));
      return{active:null,closed:closeTrade(next,'LOSS',next.realizedR,next.stopLoss,candle.time,'SL hit; realized R includes TP milestones'),notifications:[...notifications,{type:'LOSS',interval:active.interval,trade:next,candleTime:candle.time}]};
    }
    const levels=[['TP1',1,'tp1','tp1Hit'],['TP2',2,'tp2','tp2Hit'],['TP3',3,'tp3','tp3Hit'],['TP4',4,'tp4','tp4Hit']];
    for(const [label,r,key,flag] of levels){
      const hit=active.direction==='BUY'?candle.high>=active[key]:candle.low<=active[key];
      if(hit&&!next[flag]){
        next[flag]=true;
        next.hitTPs.push(label);
        // Realized R is the highest TP reached, not the sum of TP milestones.
        next.realizedR=Number(Math.max(Number(next.realizedR||0), r).toFixed(2));
        notifications.push({type:label,interval:active.interval,trade:next,candleTime:candle.time});
        if(label==='TP4')return{active:null,closed:closeTrade(next,'FULL TP HIT',next.realizedR,next.tp4,candle.time,'TP4 hit'),notifications};
      }
    }
  }
  return{active:next,closed:null,notifications};
}
function tradeKey(t) {
  return `${t.interval || ''}:${t.signalTime || ''}:${t.direction || ''}`;
}

function dedupeTrades(trades = []) {
  const map = new Map();
  for (const trade of trades || []) {
    if (!trade) continue;
    const key = tradeKey(trade);
    if (!key || key === '::') continue;
    const previous = map.get(key);
    // Prefer the persisted/live record with the most complete lifecycle data.
    if (!previous) map.set(key, trade);
    else {
      const previousScore =
        Number(!!previous.exitTime) * 4 +
        Number(!!previous.result && previous.result !== 'OPEN') * 2 +
        Number(Array.isArray(previous.hitTPs) ? previous.hitTPs.length : 0);
      const currentScore =
        Number(!!trade.exitTime) * 4 +
        Number(!!trade.result && trade.result !== 'OPEN') * 2 +
        Number(Array.isArray(trade.hitTPs) ? trade.hitTPs.length : 0);
      if (currentScore >= previousScore) map.set(key, trade);
    }
  }
  return [...map.values()].sort((a,b) => Number(a.signalTime || 0) - Number(b.signalTime || 0));
}

function mergeTrades(existing = [], discovered = []) {
  return dedupeTrades([...(existing || []), ...(discovered || [])]);
}

function closeTrade(trade,result,realizedR,exit,exitTime,reason){
  return{id:trade.id,interval:trade.interval,direction:trade.direction,signalTime:trade.signalTime,confirmationTime:trade.confirmationTime??null,swingTime:trade.sweep?.level?.time??null,swingType:trade.sweep?.level?.type??null,swingPrice:Number.isFinite(Number(trade.sweep?.level?.price))?Number(Number(trade.sweep.level.price).toFixed(2)):null,entry:trade.entry,stopLoss:trade.stopLoss,tp1:trade.tp1,tp2:trade.tp2,tp3:trade.tp3,tp4:trade.tp4,risk:trade.risk,tp1Hit:!!trade.tp1Hit,tp2Hit:!!trade.tp2Hit,tp3Hit:!!trade.tp3Hit,tp4Hit:!!trade.tp4Hit,hitTPs:Array.isArray(trade.hitTPs)?trade.hitTPs:[],realizedR,result,status:'CLOSED',exit:Number(exit.toFixed(2)),exitTime,reason,news:trade.news||null,entryRule:'ORDER_BLOCK_CREATED_ENTRY'};
}
async function getState(stub){const response=await stub.fetch('https://state/');return response.json()}
async function putState(stub,state){await stub.fetch('https://state/replace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)})}
async function sendTelegram(env,event,subscribers){if(!env.TELEGRAM_BOT_TOKEN)return false;const activeSubscribers=(subscribers||[]).filter(s=>s.active===true&&String(s.chatId));if(!activeSubscribers.length)return false;const trade=event.trade,tf=event.interval==='1min'?'1M':event.interval==='5min'?'5M':'15M';let text;if(event.type==='SIGNAL'){const nb=trade.news?.bias||'NEUTRAL',ni=trade.news?.highImpactRecent?'⚠️ HIGH-IMPACT NEWS':'📰 News: '+nb;text=['🟢 WAJID SWING LIQUIDITY',`XAU/USD · ${tf}`,'',`📈 SIGNAL: ${trade.direction}`,`🎯 Entry: ${trade.entry}`,`🛑 SL: ${trade.stopLoss}`,`1️⃣ TP1: ${trade.tp1} (1R)`,`2️⃣ TP2: ${trade.tp2} (2R)`,`3️⃣ TP3: ${trade.tp3} (3R WIN)`,`4️⃣ TP4: ${trade.tp4} (4R FULL WIN)`,`📊 Probability: ${trade.probability}%`,`⭐ Score: ${trade.score}`,ni,'','🔒 Server controlled · Non-repainting'].join('\n')}else if(event.type==='TP1')text=`🟡 WAJID ${tf} · XAU/USD\n\nTP1 REACHED · +1R milestone\nEntry: ${trade.entry}\nTP1: ${trade.tp1}\nStatus: monitoring TP2–TP4`;else if(event.type==='TP2')text=`🟠 WAJID ${tf} · XAU/USD\n\nTP2 REACHED · +2R milestone\nEntry: ${trade.entry}\nTP2: ${trade.tp2}\nStatus: monitoring TP3–TP4`;else if(event.type==='TP3')text=`🏆 WAJID ${tf} · XAU/USD\n\n✅ WIN · TP3 reached\nEntry: ${trade.entry}\nTP3: ${trade.tp3}\nResult: TP3 WIN · monitoring TP4`;else if(event.type==='TP4')text=`🏆🔥 WAJID ${tf} · XAU/USD\n\n✅ FULL TP HIT · TP4 reached\nEntry: ${trade.entry}\nTP4: ${trade.tp4}\nResult: FULL TP HIT`;else if(event.type==='LOSS')text=`🔴 WAJID ${tf} · XAU/USD\n\n❌ LOSS · SL reached\nEntry: ${trade.entry}\nSL: ${trade.stopLoss}\nResult: -1R`;else return false;const messageIds={},failedChatIds=[];for(const subscriber of activeSubscribers){const payload={chat_id:subscriber.chatId,text,reply_markup:telegramKeyboard()},original=trade.telegramMessageIds?.[String(subscriber.chatId)];if(event.type!=='SIGNAL'&&Number.isFinite(Number(original)))payload.reply_parameters={message_id:Number(original),allow_sending_without_reply:true};for(let attempt=0;attempt<2;attempt++){try{const response=await fetch(`${TELEGRAM_API}${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json().catch(()=>null);if(response.ok&&data?.ok&&data?.result?.message_id){messageIds[String(subscriber.chatId)]=data.result.message_id;break}}catch(_){} } if(!messageIds[String(subscriber.chatId)]) failedChatIds.push(String(subscriber.chatId)); } return {messageIds,failedChatIds};}
function telegramEventKey(event, chatId){
  const tradeId = event?.trade?.id || `${event?.interval || ''}:${event?.trade?.signalTime || ''}:${event?.trade?.direction || ''}`;
  return `${chatId}:${event?.type || ''}:${event?.interval || ''}:${tradeId}:${event?.candleTime || ''}`;
}

function enqueuePendingTelegram(telegram, event, chatId){
  if(!telegram || !chatId || !event?.type || !event?.trade) return;
  if(!Array.isArray(telegram.pending)) telegram.pending=[];
  const key=telegramEventKey(event,chatId);
  if(telegram.pending.some(x=>x.key===key)) return;
  telegram.pending.push({key,chatId,event,queuedAt:Date.now(),attempts:0});
  if(telegram.pending.length>5000) telegram.pending=telegram.pending.slice(-5000);
}

async function sendTelegramWithQueue(env,event,telegram){
  const result=await sendTelegram(env,event,telegram?.subscribers||[]);
  for(const chatId of (result?.failedChatIds||[])) enqueuePendingTelegram(telegram,event,chatId);
  return result;
}

async function retryPendingTelegram(env,telegram){
  if(!telegram || !Array.isArray(telegram.pending) || !telegram.pending.length) return;
  const now=Date.now(), remaining=[];
  // Retry a bounded batch each minute so one bad subscriber cannot block the queue.
  for(const item of telegram.pending.slice(0,100)){
    if(!item?.event || !item?.chatId) continue;
    if(Number(item.nextAttemptAt||0)>now){remaining.push(item);continue;}
    const subscriber=telegram.subscribers?.find(s=>String(s.chatId)===String(item.chatId));
    if(!subscriber || subscriber.active!==true) continue;
    const result=await sendTelegram(env,item.event,[subscriber]);
    if((result?.failedChatIds||[]).includes(String(item.chatId))){
      item.attempts=Number(item.attempts||0)+1;
      item.nextAttemptAt=now+Math.min(15*60*1000,Math.max(60*1000,2**Math.min(item.attempts,4)*1000));
      remaining.push(item);
    }
  }
  remaining.push(...telegram.pending.slice(100));
  telegram.pending=remaining;
}

async function telegramMessage(env,chatId,text){await fetch(`${TELEGRAM_API}${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,reply_markup:telegramKeyboard()})})}
export { WajidTradeState };