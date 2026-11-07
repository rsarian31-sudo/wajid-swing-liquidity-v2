import { onRequest as dataRequest } from './functions/api/data.js';
import { onRequest as healthRequest } from './functions/api/health.js';
import { analyzeSmc } from './src/smc-core.js';
import { marketConfig, htfInterval, INTERVAL_SECONDS, SMC_RULE_VERSION } from './src/smc-config.js';
import { makeSmcTrade, advanceSmcTrade, dedupeSmcTrades } from './src/trade-manager.js';
import { validateCandles, splitClosed } from './src/feed-health.js';
import { fetchBitgetCandles, fetchBitgetTicker } from './src/bitget.js';
import { fetchNewsContext } from './src/news.js';
import { WajidTradeState } from './state.js';
import { handleAuthRequest, getAuthUser, hasActiveSubscription } from './auth.js';
import { handlePaymentRequest } from './payments.js';

// Legacy v4 intervals — used ONLY to read preserved historical trades.
// The live signal system is SMC v1 (see src/smc-config.js): Gold 5M/15M,
// BTC 15M/30M/1H. The old 1M signal system is retired.
const LEGACY_INTERVALS = ['1min', '5min'];
const SYMBOL = 'XAU/USD';
const DATA_URL = 'https://api.twelvedata.com/time_series';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_WEBHOOK_URL = 'https://wajid-swing-liquidity-v2.rsarian31.workers.dev/telegram/webhook';
// Fallback only. Prefer the TELEGRAM_CHANNEL_ID environment secret; see
// resolveChannelId(). Never print this value in logs or reports.
const TELEGRAM_CHANNEL_ID = '-1004402860410';
const MALAYSIA_UTC_OFFSET_MINUTES = 480;

// Live Telegram signals are OFF by default. Paper-trading results must be
// reviewed and the owner must explicitly approve live activation before
// setting LIVE_SIGNALS_ENABLED=true in the Worker environment.
function liveSignalsEnabled(env) {
  return String(env.LIVE_SIGNALS_ENABLED || '').trim().toLowerCase() === 'true';
}
// Channel ID resolution: environment secret first, then the channel ID the
// bot detected from a channel post, then the legacy constant above.
// The owner must set the TELEGRAM_CHANNEL_ID secret in Cloudflare;
// the constant fallback exists only so existing deployments keep working.
function resolveChannelId(env, telegram) {
  return String(env.TELEGRAM_CHANNEL_ID || '').trim()
    || String(telegram?.channelId || '').trim()
    || TELEGRAM_CHANNEL_ID;
}
function tfLabel(interval) {
  return { '5min': '5M', '15min': '15M', '30min': '30M', '1H': '1H' }[interval] || String(interval);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/')) return handleAuthRequest(request, env);
    if (url.pathname.startsWith('/api/payment/')) return handlePaymentRequest(request, env);
    if (url.pathname === '/api/btc-signals' && (request.method === 'GET' || request.method === 'OPTIONS')) return btcSignalsApi(request, env);
    if (url.pathname === '/api/btc-data' && request.method === 'GET') return btcDataApi(request, env);
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') return telegramWebhook(request, env);
    if (url.pathname === '/api/telegram/users' && request.method === 'GET') return telegramUsers(request, env);
    if (url.pathname === '/api/telegram/broadcast' && request.method === 'POST') return telegramAdminBroadcast(request, env);
    if (url.pathname === '/telegram/admin' && request.method === 'GET') return telegramAdminPage();
    if (url.pathname === '/api/data') return dataRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    if (url.pathname === '/api/health') return healthRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    // 24/7 operation: there is NO scheduled signal OFF period (KB §13).
    // The old OFF 08:30–18:30 MYT window was removed completely and must
    // never be reintroduced. Pipelines run HTF-first so the higher
    // timeframe's structure direction is fresh when the lower TF runs.
    if (!env.TRADE_STATE) return;
    if (env.TELEGRAM_BOT_TOKEN) await ensureTelegramWebhook(env);
    if (env.TELEGRAM_BOT_TOKEN && env.DB && new Date().getUTCMinutes() % 15 === 0) await cleanupExpiredChannelMembers(env);
    const jobs = [
      ['xau', '15min'], ['xau', '5min'],
      ['btc', '1H'], ['btc', '30min'], ['btc', '15min'],
    ];
    for (const [market, interval] of jobs) {
      try {
        await runSmcPipeline(market, interval, env);
      } catch (error) {
        console.error('scheduled SMC pipeline error', market, interval, error?.message || error);
      }
    }
  }
};

async function processTelegramChannelMember(member,env){
  if(!env?.DB||!env?.TRADE_STATE)return;
  const chatId=String(member?.chat?.id||'');
  if(chatId!==resolveChannelId(env))return;
  const inviteLink=String(member?.invite_link?.invite_link||'').trim();
  const telegramUserId=String(member?.new_chat_member?.user?.id||member?.old_chat_member?.user?.id||'').trim();
  if(!inviteLink||!telegramUserId)return;
  const row=await env.DB.prepare('SELECT id,user_id,expires_at FROM telegram_invites WHERE invite_link=? LIMIT 1').bind(inviteLink).first();
  if(!row)return;
  const status=String(member?.new_chat_member?.status||'');
  const joined=['member','administrator','creator'].includes(status);
  const stub=env.TRADE_STATE.get(env.TRADE_STATE.idFromName('xauusd'));
  const state=await getState(stub);
  const telegram=ensureTelegramState(state,env);
  const existing=telegram.subscribers.find(s=>String(s.chatId)===telegramUserId);
  const base={chatId:telegramUserId,userId:String(row.user_id),updatedAt:Date.now(),source:'premium-channel'};
  if(joined){
    if(existing)Object.assign(existing,base,{active:true,channelJoinedAt:Date.now()});
    else telegram.subscribers.push({...base,active:true,channelJoinedAt:Date.now()});
    await env.DB.prepare('UPDATE telegram_invites SET joined_chat_id=?,joined_at=? WHERE id=?').bind(telegramUserId,Date.now(),String(row.id)).run();
  }else{
    if(existing&&String(existing.userId||'')===String(row.user_id)){
      existing.active=false;
      existing.updatedAt=Date.now();
      existing.channelRemovedAt=Date.now();
    }
  }
  state.telegram=telegram;
  await putState(stub,state);
}


async function telegramAdminBroadcast(request, env) {
  if (!env?.TELEGRAM_BOT_TOKEN) return Response.json({ ok:false, error:'TELEGRAM_BOT_TOKEN is not configured' }, { status:503 });
  const user = await getAuthUser(request, env);
  if (!user || user.role !== 'admin') return Response.json({ ok:false, error:'ADMIN_ONLY' }, { status:403, headers:{'Cache-Control':'no-store'} });
  const body = await request.json().catch(()=>({}));
  const text = String(body?.text || '').trim();
  if (!text) return Response.json({ ok:false, error:'MESSAGE_REQUIRED' }, { status:400 });
  if (text.length > 4000) return Response.json({ ok:false, error:'MESSAGE_TOO_LONG' }, { status:400 });
  try {
    const channelId = resolveChannelId(env);
    const result = await telegramApiCall(env, 'sendMessage', { chat_id: channelId, text, disable_web_page_preview: false });
    return Response.json({ ok:true, messageId: result?.message_id || null, channelId }, { headers:{'Cache-Control':'no-store'} });
  } catch (error) {
    console.error('telegram admin broadcast failed', JSON.stringify({ error:error?.message || String(error) }));
    return Response.json({ ok:false, error:'TELEGRAM_SEND_FAILED', detail:String(error?.message || error) }, { status:502, headers:{'Cache-Control':'no-store'} });
  }
}

async function telegramUsers(request, env) {
  const configured = String(env.ADMIN_TOKEN || '').trim();
  if (!configured) return Response.json({ error: 'ADMIN_TOKEN is not configured' }, { status: 503 });
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== configured) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const id = env.TRADE_STATE.idFromName('xauusd');
  const state = await getState(env.TRADE_STATE.get(id));
  const subscribers = Array.isArray(state?.telegram?.subscribers) ? state.telegram.subscribers : [];
  const users = subscribers.map(s => ({
    chatId: String(s.chatId || ''),
    username: s.username || null,
    firstName: s.firstName || null,
    active: s.active === true,
    updatedAt: Number(s.updatedAt || 0)
  })).filter(s => s.chatId).sort((a,b) => b.updatedAt - a.updatedAt);
  return Response.json({
    total: users.length,
    active: users.filter(u => u.active).length,
    inactive: users.filter(u => !u.active).length,
    users
  }, { headers: { 'Cache-Control': 'no-store' } });
}

function telegramAdminPage() {
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Users Admin</title><style>body{font-family:system-ui;background:#07101c;color:#eef;padding:20px;max-width:900px;margin:auto}input{width:100%;box-sizing:border-box;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #334;background:#101c2b;color:#fff}button{padding:12px 16px;border-radius:8px;border:1px solid #334;background:#101c2b;color:#fff;font-weight:700}button:active{opacity:.7}table{width:100%;border-collapse:collapse;margin-top:20px;display:block;overflow-x:auto}th,td{padding:10px;border-bottom:1px solid #263548;text-align:left;white-space:nowrap}.pill{padding:4px 8px;border-radius:999px;background:#17351f}.off{background:#382020}.error{color:#ff8b8b;margin-top:12px}.ok{color:#8ff0ad;margin-top:12px}</style></head><body><h1>Telegram Users</h1><p>Protected admin view.</p><label for="token">ADMIN_TOKEN</label><input id="token" type="password" autocomplete="off" placeholder="Enter ADMIN_TOKEN"><button id="load" type="button">Load users</button><div id="msg"></div><div id="summary"></div><div id="out"></div><script>document.getElementById("load").addEventListener("click",async()=>{const token=document.getElementById("token").value.trim();const msg=document.getElementById("msg"),out=document.getElementById("out"),summary=document.getElementById("summary");if(!token){msg.className="error";msg.textContent="Please enter ADMIN_TOKEN.";return}msg.className="ok";msg.textContent="Loading...";out.innerHTML="";summary.innerHTML="";try{const r=await fetch("/api/telegram/users?ts="+Date.now(),{method:"GET",headers:{Authorization:"Bearer "+token,Accept:"application/json"},cache:"no-store"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("Request failed ("+r.status+")"));msg.textContent="Loaded successfully.";summary.innerHTML="<p><b>Total:</b> "+d.total+" &nbsp; <b>Active:</b> "+d.active+" &nbsp; <b>Inactive:</b> "+d.inactive+"</p>";out.innerHTML="<table><thead><tr><th>Username</th><th>Name</th><th>Chat ID</th><th>Status</th><th>Updated</th></tr></thead><tbody>"+(d.users||[]).map(u=>"<tr><td>"+(u.username?"@"+u.username:"—")+"</td><td>"+(u.firstName||"—")+"</td><td>"+u.chatId+"</td><td><span class=\\\"pill "+(u.active?"":"off")+"\\\">"+(u.active?"ACTIVE":"OFF")+"</span></td><td>"+(u.updatedAt?new Date(u.updatedAt).toLocaleString():"—")+"</td></tr>").join("")+"</tbody></table>"}catch(e){msg.className="error";msg.textContent="Error: "+(e?.message||e)}});</script></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' } });
}

// ---- SMC PIPELINES (smc-v1) -------------------------------------------
// One independent pipeline per market+timeframe. BTC and Gold never share
// trade state, dedup keys or signal history; only the SMC core is shared.
function smcStub(env, market) {
  return env.TRADE_STATE.get(env.TRADE_STATE.idFromName(market === 'btc' ? 'btc' : 'xauusd'));
}
function ensureSmcState(state) {
  if (!state.smc || typeof state.smc !== 'object') state.smc = { version: 1, btc: {}, xau: {} };
  for (const m of ['btc', 'xau']) if (!state.smc[m] || typeof state.smc[m] !== 'object') state.smc[m] = {};
  return state.smc;
}
function smcBucket(smc, market, interval) {
  const m = smc[market] || (smc[market] = {});
  return m[interval] || (m[interval] = {
    activeTrades: [], trades: [], lastSignalId: null, lastCandleTime: null,
    structureDirection: null, feedHealth: 'UNKNOWN', lastFeedUpdate: null, lastFeedError: null,
  });
}

async function runSmcPipeline(market, interval, env) {
  const cfg = marketConfig(market);
  const seconds = INTERVAL_SECONDS[interval];
  const stub = smcStub(env, market);
  const lockOwner = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const lockKey = 'smc:' + market + ':' + interval;
  let locked = false;
  try {
    const lockResponse = await stub.fetch('https://state/lock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: lockKey, owner: lockOwner, ttl: 90000 }),
    });
    locked = lockResponse.ok;
    if (!locked) { console.log('skipping overlapping SMC run', market, interval); return { ok: false, reason: 'LOCKED' }; }

    // 1. Fetch closed candles. Gold reuses the existing Twelve Data source;
    // BTC uses the Bitget V3 public API. No silent provider fallbacks.
    // A fetch failure HALTs the market in state (so the UI shows HALTED,
    // not UNKNOWN) instead of leaving stale state behind.
    let feed;
    try {
      if (market === 'btc') {
        const r = await fetchBitgetCandles(interval, 300);
        feed = { closed: r.closed, current: r.current, provider: 'Bitget', fetchedAt: r.fetchedAt };
      } else {
        feed = await fetchGoldCandles(interval, env);
      }
    } catch (error) {
      const state = await getState(stub);
      const smc = ensureSmcState(state);
      const bucket = smcBucket(smc, market, interval);
      bucket.feedHealth = 'HALTED';
      bucket.lastFeedUpdate = Date.now();
      bucket.lastFeedError = String(error?.message || error).slice(0, 180);
      state.telegram = ensureTelegramState(state, env);
      await putState(stub, state);
      console.error('SMC feed fetch failed — HALTED', market, interval, bucket.lastFeedError);
      return { ok: false, health: 'HALTED', error: bucket.lastFeedError };
    }

    const state = await getState(stub);
    const smc = ensureSmcState(state);
    const bucket = smcBucket(smc, market, interval);

    // 2. Validate. HALTED disables new signal generation for this market
    // and timeframe until the feed recovers. Open trades are not advanced
    // on bad data either — never trade on stale or incomplete candles.
    const validation = validateCandles(feed.closed, seconds);
    bucket.feedHealth = validation.health;
    bucket.lastFeedUpdate = Date.now();
    if (validation.health === 'HALTED') {
      bucket.lastFeedError = validation.issues.join(', ');
      state.telegram = ensureTelegramState(state, env);
      await putState(stub, state);
      console.error('SMC feed HALTED', market, interval, validation.issues.join(', '));
      return { ok: false, health: 'HALTED', issues: validation.issues };
    }
    bucket.lastFeedError = validation.health === 'HEALTHY' ? null : validation.issues.join(', ');

    // 3. HTF context from the higher timeframe's own bucket (fresh because
    // the scheduler runs HTF first). No HTF data = neutral, not a veto.
    const htf = htfInterval(market, interval);
    const htfDirection = htf ? smcBucket(smc, market, htf).structureDirection || null : null;

    const news = market === 'xau' ? await fetchNewsContext().catch(() => null) : null;
    const analysis = analyzeSmc(feed.closed, { market, htfDirection });
    bucket.structureDirection = analysis.structureDirection;

    const telegram = ensureTelegramState(state, env);
    await retryPendingTelegram(env, telegram);
    const live = liveSignalsEnabled(env);

    // 4. Advance open trades (TP1–TP4 / SL) against the new closed candles.
    const stillActive = [];
    for (const trade of Array.isArray(bucket.activeTrades) ? bucket.activeTrades : []) {
      const out = advanceSmcTrade(trade, feed.closed);
      for (const n of out.notifications) {
        if (live) {
          await sendTelegramWithQueue(env, { type: n.type, market, interval, trade: n.trade, candleTime: n.candleTime }, telegram);
        } else {
          console.log('PAPER trade event (live Telegram OFF)', market, interval, n.type, trade.id);
        }
      }
      if (out.closed) bucket.trades.push(out.closed);
      else stillActive.push(out.active);
    }
    bucket.activeTrades = stillActive;
    bucket.trades = dedupeSmcTrades(bucket.trades);

    // 5. New signal? Only the full SMC sequence on the last closed candle.
    // Deduplicated by signal id; one signal per setup, never forced.
    if (analysis.signal?.direction && analysis.signal.direction !== 'WAIT' && analysis.tradePlan) {
      const tradeId = `${market}:${interval}:${analysis.signal.time}:${analysis.signal.direction}`;
      const known = bucket.lastSignalId === tradeId
        || bucket.activeTrades.some(t => t.id === tradeId)
        || bucket.trades.some(t => t.id === tradeId);
      if (!known) {
        const trade = makeSmcTrade(market, interval, analysis.signal, analysis.tradePlan, { paper: !live });
        if (news) trade.news = news;
        bucket.lastSignalId = tradeId;
        if (live) {
          const res = await sendTelegramWithQueue(env, {
            type: 'SIGNAL', market, interval, trade,
            probability: analysis.signal.probability, score: analysis.signal.score,
          }, telegram);
          if (res?.messageIds) trade.telegramMessageIds = res.messageIds;
        } else {
          console.log('PAPER signal (live Telegram OFF)', tradeId, JSON.stringify({
            direction: trade.direction, entry: trade.entry, stopLoss: trade.stopLoss,
            tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3, tp4: trade.tp4,
          }));
        }
        bucket.activeTrades.push(trade);
      }
    }

    bucket.lastCandleTime = feed.closed.at(-1)?.time ?? null;
    state.telegram = telegram;
    await putState(stub, state);
    return { ok: true, health: validation.health, signal: analysis.signal.direction, market, interval };
  } catch (error) {
    console.error('SMC pipeline error', market, interval, error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  } finally {
    if (locked) {
      try {
        await stub.fetch('https://state/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: lockKey, owner: lockOwner }),
        });
      } catch (_) {}
    }
  }
}

function ensureTelegramState(state, env) {
  if (!state.telegram || typeof state.telegram !== 'object') state.telegram = { offset: 0, subscribers: [] };
  if (!Number.isFinite(Number(state.telegram.offset))) state.telegram.offset = 0;
  if (!Array.isArray(state.telegram.subscribers)) state.telegram.subscribers = [];
  if (!Array.isArray(state.telegram.pending)) state.telegram.pending = [];
  if (!Array.isArray(state.telegram.sentKeys)) state.telegram.sentKeys = [];
  state.telegram.channelId = resolveChannelId(env, state.telegram);
  if (!Array.isArray(state.telegram.deliveryLog)) state.telegram.deliveryLog = [];
  const configured = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (configured) {
    const found = state.telegram.subscribers.find(s => String(s.chatId) === configured);
    if (!found) state.telegram.subscribers.push({ chatId: configured, active: true, source: 'env', updatedAt: Date.now() });
  }
  return state.telegram;
}
function telegramKeyboard(){return{keyboard:[[{text:'📊 Daily Stats'},{text:'📅 Weekly Report'}],[{text:'📈 All Stats'},{text:'🔄 Refresh Stats'}],[{text:'🟢 Status'},{text:'❓ Help'}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false}}
function normalizeTelegramCommand(text){const value=String(text||'').trim().toLowerCase();if(value==='📊 daily stats'||value==='/daily'||value==='/today')return'/daily';if(value==='📅 weekly report'||value==='/weekly'||value==='/week')return'/weekly';if(value==='📈 all stats'||value==='🔄 refresh stats'||value==='/stats')return'/stats';if(value==='🟢 status'||value==='/status')return'/status';if(value==='🧪 test'||value==='/test')return'/test';if(value==='📢 broadcast'||value==='/broadcast'||value==='/bc')return'/broadcast';if(value==='❓ help'||value==='/help')return'/help';if(value==='/start'||value==='/subscribe')return'/start';if(value==='/stop'||value==='/unsubscribe')return'/stop';return value.split(/\s+/)[0].split('@')[0]}
async function ensureTelegramWebhook(env){if(!env.TELEGRAM_BOT_TOKEN)return false;try{const response=await fetch(`${TELEGRAM_API}${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:TELEGRAM_WEBHOOK_URL,allowed_updates:['message','channel_post','chat_member'],drop_pending_updates:false})});const data=await response.json();return response.ok&&data?.ok===true}catch(_){return false}}
async function telegramWebhook(request,env){if(!env.TELEGRAM_BOT_TOKEN||!env.TRADE_STATE)return new Response('Not configured',{status:503});try{await processTelegramUpdate(await request.json(),env);return new Response('OK',{status:200})}catch(_){return new Response('OK',{status:200})}}
async function processTelegramUpdate(update,env){
  if(update?.chat_member){
    await processTelegramChannelMember(update.chat_member,env);
    return;
  }
  const message=update?.message || update?.channel_post;
  if(update?.channel_post){
    const channel=update.channel_post;
    if(channel?.chat?.type==='channel'){
      const id=String(channel.chat.id);
      const title=String(channel.chat.title||'');
      console.log('Telegram channel detected',JSON.stringify({id,title}));
      if(env.TRADE_STATE){
        const stub=env.TRADE_STATE.get(env.TRADE_STATE.idFromName('xauusd'));
        const state=await getState(stub);
        state.telegram=ensureTelegramState(state,env);
        state.telegram.channelId=id;
        state.telegram.channelTitle=title;
        state.telegram.channelDetectedAt=Date.now();
        await putState(stub,state);
      }
    }
    return;
  }
  if(!message||message.chat?.type!=='private'||!message.text)return;
  const id=env.TRADE_STATE.idFromName('xauusd'),stub=env.TRADE_STATE.get(id),state=await getState(stub);
  const telegram=ensureTelegramState(state,env),command=normalizeTelegramCommand(message.text),chatId=String(message.chat.id);
  const adminChatId=String(env.TELEGRAM_CHAT_ID||'').trim(),isAdmin=!!adminChatId&&chatId===adminChatId;
  const existing=telegram.subscribers.find(s=>String(s.chatId)===chatId),base={chatId,username:message.from?.username||null,firstName:message.from?.first_name||null,updatedAt:Date.now()};let changed=false;
  if(command==='/channelid' && isAdmin){
    const channelId=String(telegram.channelId||'').trim();
    const channelTitle=String(telegram.channelTitle||'').trim();
    await sendTelegramMessage(chatId, channelId ? `📡 Channel detected\n\nTitle: ${channelTitle||'—'}\nChannel ID: ${channelId}` : '❌ Channel ID not detected yet. Send a new message in the channel first.',env);
    return;
  }
  if(command==='/start'){
    const raw=String(message.text||'').trim();
    const tokenMatch=raw.match(/^\/start(?:@[^\\s]+)?\\s+connect_([a-f0-9]{20,64})$/i);
    let linkedUser=null;
    if(tokenMatch&&env.DB){
      linkedUser=await env.DB.prepare("SELECT id,name,email,subscription_status,subscription_expires_at FROM users WHERE telegram_connect_token=? AND telegram_connect_expires_at>? LIMIT 1").bind(tokenMatch[1],Date.now()).first();
    }
    if(linkedUser&&linkedUser.subscription_status==='active'&&Number(linkedUser.subscription_expires_at)>Date.now()){
      if(existing)Object.assign(existing,base,{active:true,userId:String(linkedUser.id)});
      else telegram.subscribers.push({...base,active:true,userId:String(linkedUser.id)});
      await env.DB.prepare('UPDATE users SET telegram_connect_token=NULL,telegram_connect_expires_at=0,updated_at=? WHERE id=?').bind(Date.now(),String(linkedUser.id)).run();
      const channelInvite=await createPremiumChannelInvite(env,String(linkedUser.id),Number(linkedUser.subscription_expires_at));
      await telegramMessage(env,chatId,channelInvite?'✅ Telegram connected successfully.\n\n🔐 Premium Channel Access:\n'+channelInvite+'\n\nYou will receive XAU/USD signals in the private channel while your subscription remains active.':'✅ Telegram connected successfully.\n\nYour subscription is active, but the channel invite could not be generated yet. Please contact support.');
      changed=true;
    }else if(isAdmin){
      if(existing)Object.assign(existing,base,{active:true});
      else telegram.subscribers.push({...base,active:true,source:'env'});
      await telegramMessage(env,chatId,'✅ WAJID Swing Liquidity owner access is ACTIVE.');
      changed=true;
    }else if(existing?.active===true){
      await telegramMessage(env,chatId,'🟢 Telegram is already connected.\n\nUse /status to check access.');
    }else{
      await telegramMessage(env,chatId,'🔒 Subscription required.\n\nPlease purchase a 1 Week or 1 Month plan on the website, then use the Telegram Connect link shown after payment.');
    }
  }
  else if(command==='/stop'){if(existing)Object.assign(existing,base,{active:false});else telegram.subscribers.push({...base,active:false});await telegramMessage(env,chatId,'🛑 WAJID Swing Liquidity subscription is OFF. Send /start to subscribe again.');changed=true}
  else if(command==='/status'){await telegramMessage(env,chatId,existing?.active===true?'🟢 Subscription status: ACTIVE\n\nSignal notifications: ON':'⚪ Subscription status: OFF.\n\nSend /start to subscribe.')}
  else if(command==='/test'){
    if(!isAdmin)await telegramMessage(env,chatId,'⛔ TEST is available to the bot owner only.');
    else if(existing?.active!==true)await telegramMessage(env,chatId,'⚪ Signal subscription is OFF. Send /start first.');
    else{const result=await sendTelegramTest(env,telegram);await telegramMessage(env,chatId,result?.ok===true?'🧪 TEST MESSAGE SENT.\n\nA clearly-labelled test message was sent to the Premium Channel. This was NOT a trading signal.':'⚠️ TEST MESSAGE FAILED.\n\nReason: '+String(result?.error||'Telegram delivery failed'))}
  }else if(command==='/broadcast'){
    if(!isAdmin)await telegramMessage(env,chatId,'⛔ BROADCAST is available to the bot owner only.');
    else{const body=String(message.text||'').trim().replace(/^\/broadcast(?:@[^\s]+)?\s*/i,'').replace(/^\/bc(?:@[^\s]+)?\s*/i,'').trim();if(!body)await telegramMessage(env,chatId,'📢 Usage: /broadcast Your message here');else{const result=await sendTelegramBroadcast(env,body,telegram);await telegramMessage(env,chatId,'📢 BROADCAST COMPLETE.\n\nDelivered: '+result.delivered+'\nFailed: '+result.failed+'\nActive users: '+result.total);}}
  }else if(command==='/daily')await telegramMessage(env,chatId,formatPeriodReport(state,'daily'));
  else if(command==='/weekly')await telegramMessage(env,chatId,formatPeriodReport(state,'weekly'));
  else if(command==='/stats')await telegramMessage(env,chatId,formatPeriodReport(state,'daily')+'\n\n'+formatPeriodReport(state,'weekly'));
  else if(command==='/help')await telegramMessage(env,chatId,'📊 WAJID Swing Liquidity\n\n📊 Daily Stats — today signals + W/L + win rate\n📅 Weekly Report — this week signals + W/L + win rate\n📈 All Stats — today + this week\n🔄 Refresh Stats — refresh current statistics\n🟢 Status — subscription status\n🧪 Test — owner only\n📢 Broadcast — owner only: /broadcast message\n\nCommands: /start /stop /daily /weekly /stats /status /test /broadcast /help');
  state.telegram=telegram;if(changed)await putState(stub,state);
}
function formatPeriodReport(state,period){const now=new Date(),start=period==='daily'?startOfMalaysiaDay(now):startOfMalaysiaWeek(now),end=period==='daily'?new Date(start.getTime()+86400000):new Date(start.getTime()+7*86400000),trades=collectTrades(state).filter(t=>{const raw=t.signalTime??t.createdAt??0;const numeric=Number(raw);const ts=Number.isFinite(numeric)?numeric*(numeric<100000000000?1000:1):Date.parse(String(raw));return Number.isFinite(ts)&&ts>=start.getTime()&&ts<end.getTime()}),signals=trades.length,wins=trades.filter(t=>t.status==='CLOSED'&&Number(t.realizedR)>0).length,losses=trades.filter(t=>t.status==='CLOSED'&&Number(t.realizedR)<0).length,openTrades=collectOpenTrades(state),open=openTrades.length,decided=wins+losses,winRate=decided?((wins/decided)*100).toFixed(1):'0.0',totalR=trades.filter(t=>t.status==='CLOSED').reduce((sum,t)=>sum+(Number.isFinite(Number(t.realizedR))?Number(t.realizedR):0),0),label=period==='daily'?`📊 DAILY REPORT · ${malaysiaDateLabel(start)}`:`📅 WEEKLY REPORT · ${malaysiaDateLabel(start)} → ${malaysiaDateLabel(new Date(end.getTime()-86400000))}`;const byKey={};for(const t of trades){const k=(t.market||'xau')+':'+(t.interval||'');byKey[k]=byKey[k]||{total:0,w:0,l:0};byKey[k].total++;if(t.status==='CLOSED'&&Number(t.realizedR)>0)byKey[k].w++;if(t.status==='CLOSED'&&Number(t.realizedR)<0)byKey[k].l++;}const openLines=openTrades.map((t,i)=>{const mkt=t.market==='btc'?'BTC':'XAU';const tf=tfLabel(t.interval);const tp2=t.tp2Hit?' · TP2 milestone reached':'';return `🔹 ${i+1}. ${mkt} ${tf} ${t.direction} · Entry ${t.entry} · SL ${t.stopLoss}\n   TP1 ${t.tp1} · TP2 ${t.tp2} · TP3 ${t.tp3} · TP4 ${t.tp4}${tp2}`});const breakdown=Object.entries(byKey).sort().map(([k,v])=>`${k}: ${v.total} signals · ${v.w}W / ${v.l}L`);return[`🔥 WAJID SWING LIQUIDITY`,label,'BTC + XAU/USD · SMC v1','',`📌 Signals: ${signals}`,`✅ Win: ${wins}`,`❌ Loss: ${losses}`,`⏳ Open: ${open}`,`🎯 Win Rate: ${winRate}%`,`📈 Total R: ${totalR>=0?'+':''}${totalR.toFixed(2)}R`,'',...(openLines.length?['📂 OPEN TRADES',...openLines]:['📂 OPEN TRADES','None']),'',...breakdown,'','🔒 Server-controlled results · Wins/losses from actual exit prices','🕐 Report timezone: Malaysia (UTC+8)'].join('\n')}
function collectOpenTrades(state){const all=[];const pushBucket=b=>{if(!b)return;if(Array.isArray(b.activeTrades))all.push(...b.activeTrades);else if(b.active)all.push(b.active)};for(const interval of LEGACY_INTERVALS)pushBucket(state?.intervals?.[interval]);if(state?.smc)for(const m of ['btc','xau'])for(const interval of Object.keys(state.smc[m]||{}))pushBucket(state.smc[m][interval]);const seen=new Set();return all.filter(t=>t?.id&&!seen.has(t.id)&&(seen.add(t.id),true))}
function collectTrades(state){const all=[];const pushBucket=b=>{if(!b)return;if(Array.isArray(b.trades))all.push(...b.trades);if(Array.isArray(b.activeTrades))all.push(...b.activeTrades);else if(b.active)all.push(b.active)};for(const interval of LEGACY_INTERVALS)pushBucket(state?.intervals?.[interval]);if(state?.smc)for(const m of ['btc','xau'])for(const interval of Object.keys(state.smc[m]||{}))pushBucket(state.smc[m][interval]);const seen=new Set();return all.filter(t=>t?.id&&!seen.has(t.id)&&(seen.add(t.id),true))}
const MALAYSIA_OFFSET_MS=8*60*60*1000;
function malaysiaParts(date){const shifted=new Date(date.getTime()+MALAYSIA_OFFSET_MS);return{year:shifted.getUTCFullYear(),month:shifted.getUTCMonth(),day:shifted.getUTCDate(),weekday:shifted.getUTCDay()}}
function startOfMalaysiaDay(date){const p=malaysiaParts(date);return new Date(Date.UTC(p.year,p.month,p.day)-MALAYSIA_OFFSET_MS)}
function startOfMalaysiaWeek(date){const p=malaysiaParts(date),diff=p.weekday===0?-6:1-p.weekday;const dayStart=Date.UTC(p.year,p.month,p.day)+diff*86400000;return new Date(dayStart-MALAYSIA_OFFSET_MS)}
function malaysiaDateLabel(date){const p=malaysiaParts(date);return [p.year,String(p.month+1).padStart(2,'0'),String(p.day).padStart(2,'0')].join('-')}

// Gold candles — Twelve Data ONLY (the existing verified source).
// The old Yahoo Finance fallback and the XAUS fallback have been REMOVED:
// Yahoo is unofficial with terms that prohibit commercial reuse, and XAUS
// synthesised 1m/5m OHLC candles from 5-minute sampled spot prices
// (volume 0) — fabricated candles. On any Twelve Data failure this throws
// and the pipeline HALTs that market instead of silently switching provider.
// LICENSING LIMITATION: Twelve Data Basic is internal non-display only and
// is NOT confirmed permitted for production Telegram signals. See README /
// final report. Do not claim otherwise.
async function fetchGoldCandles(interval, env) {
  const keys = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2, env.TWELVE_DATA_API_KEY_3, env.TWELVE_DATA_API_KEY_4]
    .map(k => String(k || '').trim()).filter(Boolean);
  const seconds = INTERVAL_SECONDS[interval];
  let lastError = null;
  const diagnostics = [];
  for (const apiKey of keys) {
    try {
      const params = new URLSearchParams({ symbol: SYMBOL, interval, outputsize: '300', order: 'ASC', timezone: 'UTC', apikey: apiKey });
      const response = await fetch(DATA_URL + '?' + params);
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status === 'error' || data?.code) throw new Error(data?.message || 'Twelve Data request failed');
      const candles = (data.values || []).map(x => ({
        time: Math.floor(x.timestamp ? Number(x.timestamp) : Date.parse(String(x.datetime || '')) / 1000),
        open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume || 0),
      })).filter(x => [x.time, x.open, x.high, x.low, x.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);
      const unique = [], seen = new Set();
      for (const candle of candles) if (!seen.has(candle.time)) { seen.add(candle.time); unique.push(candle); }
      const { closed, current } = splitClosed(unique, seconds);
      if (closed.length >= 50) return { closed, current, provider: 'Twelve Data', fetchedAt: Date.now(), diagnostics };
      throw new Error('Twelve Data returned insufficient closed candles');
    } catch (error) {
      lastError = error;
      diagnostics.push(String(error?.message || error).slice(0, 160));
    }
  }
  console.error('Gold feed failed (Twelve Data only, no fallback)', interval, diagnostics.join(' | '));
  throw lastError || new Error('No usable XAU/USD market data feed');
}
async function getState(stub){const response=await stub.fetch('https://state/');return response.json()}
async function putState(stub,state){await stub.fetch('https://state/replace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)})}
async function createPremiumChannelInvite(env,userId,expiresAt){
  if(!env?.TELEGRAM_BOT_TOKEN)return null;
  try{
    const response=await fetch(TELEGRAM_API+encodeURIComponent(env.TELEGRAM_BOT_TOKEN)+'/createChatInviteLink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:resolveChannelId(env),name:'Premium '+String(userId).slice(0,8),expire_date:Math.floor(Number(expiresAt)/1000),member_limit:1})});
    const data=await response.json().catch(()=>null);
    return data?.ok===true?data?.result?.invite_link||null:null;
  }catch(_){return null}
}
async function cleanupExpiredChannelMembers(env){
  if(!env?.DB||!env?.TELEGRAM_BOT_TOKEN||!env?.TRADE_STATE)return;
  const stub=env.TRADE_STATE.get(env.TRADE_STATE.idFromName('xauusd'));
  const state=await getState(stub);
  const telegram=ensureTelegramState(state,env);
  let changed=false;
  for(const subscriber of (telegram.subscribers||[])){
    if(!subscriber.active||!subscriber.userId||!subscriber.chatId||String(subscriber.chatId)===String(env.TELEGRAM_CHAT_ID||''))continue;
    const row=await env.DB.prepare('SELECT role,subscription_status,subscription_expires_at FROM users WHERE id=? LIMIT 1').bind(String(subscriber.userId)).first();
    if(row?.role==='admin')continue;
    const active=row?.subscription_status==='active'&&Number(row?.subscription_expires_at||0)>Date.now();
    if(active)continue;
    try{
      await telegramApiCall(env,'banChatMember',{chat_id:resolveChannelId(env),user_id:Number(subscriber.chatId),until_date:Math.floor(Date.now()/1000)+60,revoke_messages:false});
      subscriber.active=false;
      subscriber.channelRemovedAt=Date.now();
      changed=true;
    }catch(_){}
  }
  if(changed)await putState(stub,state);
}

// BTC signals: SMC v1 history from the Durable Object (per pipeline).
// The old Binance EMA 13/21 cross prototype has been removed entirely.
async function btcSignalsApi(request, env) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const url = new URL(request.url);
    const interval = ['15min', '30min', '1H'].includes(url.searchParams.get('interval')) ? url.searchParams.get('interval') : null;
    const stub = env.TRADE_STATE.get(env.TRADE_STATE.idFromName('btc'));
    const state = await getState(stub);
    const smc = state?.smc?.btc || {};
    const intervals = interval ? [interval] : ['15min', '30min', '1H'];
    const items = [];
    for (const tf of intervals) {
      const bucket = smc[tf] || {};
      for (const t of [...(bucket.trades || []), ...(bucket.activeTrades || [])]) {
        items.push({
          id: t.id, symbol: 'BTC/USDT', market: 'btc', timeframe: tfLabel(tf), interval: tf,
          side: t.direction, direction: t.direction, entry: t.entry, stopLoss: t.stopLoss,
          tp: [t.tp1, t.tp2, t.tp3, t.tp4], tp1: t.tp1, tp2: t.tp2, tp3: t.tp3, tp4: t.tp4,
          risk: t.risk, candleTime: (t.signalTime || 0) * 1000, detectedAt: t.createdAt,
          status: t.status, result: t.result || null, realizedR: t.realizedR ?? null,
          tp1Hit: !!t.tp1Hit, tp2Hit: !!t.tp2Hit, tp3Hit: !!t.tp3Hit, tp4Hit: !!t.tp4Hit,
          source: 'Bitget BTCUSDT', rule: 'SMC Sweep/MSS/BOS/OB/FVG · Closed candle',
          confirmations: t.confirmations || null,
        });
      }
    }
    items.sort((a, b) => b.candleTime - a.candleTime);
    return Response.json({ ok: true, interval: interval || null, signals: items.slice(0, 2000), liveSignalsEnabled: liveSignalsEnabled(env) }, { headers });
  } catch (error) {
    return Response.json({ ok: false, error: String(error?.message || error) }, { status: 503, headers });
  }
}

// BTC market data endpoint for the BTC page: live Bitget candles (20s
// cache) + the current SMC analysis + active/closed trades for the
// requested timeframe. Auth gating mirrors /api/data. On a feed failure
// the response reports health HALTED with no candles — never fabricated.
function summarizeTrades(trades) {
  const closed = trades.filter(t => t.status === 'CLOSED');
  const wins = closed.filter(t => Number(t.realizedR) > 0);
  const losses = closed.filter(t => Number(t.realizedR) < 0);
  const totalR = closed.reduce((sum, t) => sum + (Number.isFinite(Number(t.realizedR)) ? Number(t.realizedR) : 0), 0);
  const sum = arr => arr.reduce((a, t) => a + (Number.isFinite(Number(t.realizedR)) ? Number(t.realizedR) : 0), 0);
  const profitFactor = losses.length && sum(losses) !== 0 ? Math.abs(sum(wins) / sum(losses)) : (wins.length ? Infinity : 0);
  return {
    total: trades.length, closed: closed.length, open: trades.length - closed.length,
    wins: wins.length, losses: losses.length,
    winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : 0,
    totalR: +totalR.toFixed(2), profitFactor: Number.isFinite(profitFactor) ? +profitFactor.toFixed(2) : null,
  };
}

async function btcDataApi(request, env) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const url = new URL(request.url);
    const interval = ['15min', '30min', '1H'].includes(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '15min';
    const authConfigured = !!env.DB;
    const user = authConfigured ? await getAuthUser(request, env) : null;
    if (authConfigured && !user) return Response.json({ success: false, error: 'LOGIN_REQUIRED' }, { status: 401, headers });
    const subscriber = authConfigured ? hasActiveSubscription(user) : true;
    const seconds = INTERVAL_SECONDS[interval];
    let candles = [], provider = 'Bitget', health = 'HEALTHY', feedError = null, ticker = null;
    try {
      const r = await fetchBitgetCandles(interval, 300);
      const validation = validateCandles(r.closed, seconds);
      health = validation.health;
      if (validation.health === 'HALTED') { feedError = validation.issues.join(', '); }
      else { candles = r.closed; if (validation.issues.length) feedError = validation.issues.join(', '); }
      ticker = await fetchBitgetTicker().catch(() => null);
    } catch (error) {
      health = 'HALTED';
      feedError = String(error?.message || error).slice(0, 180);
    }
    let bucket = null, htfDirection = null, trades = [], activeTrades = [];
    if (env.TRADE_STATE) {
      try {
        const stub = env.TRADE_STATE.get(env.TRADE_STATE.idFromName('btc'));
        const state = await getState(stub);
        const smc = state?.smc?.btc || {};
        bucket = smc[interval] || null;
        const htf = htfInterval('btc', interval);
        htfDirection = htf ? smc[htf]?.structureDirection || null : null;
        trades = dedupeSmcTrades([...(bucket?.trades || []), ...(bucket?.activeTrades || [])]);
        activeTrades = Array.isArray(bucket?.activeTrades) ? bucket.activeTrades : [];
      } catch (_) {}
    }
    const analysis = candles.length >= 40 ? analyzeSmc(candles, { market: 'btc', htfDirection }) : null;
    const active = activeTrades[0] || null;
    const summary = summarizeTrades(trades);
    const base = {
      success: true, strategy: { id: SMC_RULE_VERSION, name: 'BTC SMC · Sweep/MSS/BOS/OB/FVG', symbol: 'BTCUSDT', interval },
      market: { symbol: 'BTCUSDT', interval },
      dataProvider: { name: provider, health, lastError: feedError },
      liveSignalsEnabled: liveSignalsEnabled(env),
      history: { summary, trades },
    };
    if (!subscriber) {
      return Response.json({ ...base, member: { subscriptionStatus: 'inactive' }, signal: { direction: 'LOCKED' }, tradePlan: null, activeTrade: null, activeTrades: [], candles: [] }, { headers });
    }
    return Response.json({
      ...base,
      market: {
        symbol: 'BTCUSDT', interval,
        price: ticker?.last ?? candles.at(-1)?.close ?? null,
        lastCandleTime: candles.at(-1)?.time ?? null, candleCount: candles.length,
      },
      candles,
      signal: analysis?.signal ?? { direction: 'WAIT' },
      tradePlan: active ? { entry: active.entry, stopLoss: active.stopLoss, tp1: active.tp1, tp2: active.tp2, tp3: active.tp3, tp4: active.tp4, risk: active.risk } : (analysis?.tradePlan ?? null),
      activeTrade: active, activeTrades,
      diagnostics: { ...(analysis?.diagnostics || {}), feed: { health, error: feedError } },
    }, { headers });
  } catch (error) {
    return Response.json({ success: false, error: String(error?.message || error) }, { status: 503, headers });
  }
}

async function telegramApiCall(env,method,payload){
  const response=await fetch(TELEGRAM_API+encodeURIComponent(env.TELEGRAM_BOT_TOKEN)+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ok!==true)throw new Error(data?.description||('Telegram '+method+' failed'));
  return data.result;
}
async function sendTelegramMessage(chatId,text,env){
  if(!env?.TELEGRAM_BOT_TOKEN)return false;
  try{
    const response=await fetch(TELEGRAM_API+encodeURIComponent(env.TELEGRAM_BOT_TOKEN)+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:String(chatId),text})});
    const data=await response.json().catch(()=>null);
    return response.ok&&data?.ok===true;
  }catch(_){return false}
}
async function sendTelegramBroadcast(env,text,telegram){
  const active=(telegram?.subscribers||[]).filter(s=>s.active===true&&String(s.chatId));let delivered=0,failed=0;
  for(const subscriber of active){const chatId=String(subscriber.chatId);let ok=false;
    for(let attempt=0;attempt<3;attempt++){try{
      const response=await fetch(TELEGRAM_API+encodeURIComponent(env.TELEGRAM_BOT_TOKEN)+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,reply_markup:telegramKeyboard()})});
      const data=await response.json().catch(()=>null);
      if(response.ok&&data?.ok===true){ok=true;break}
      console.error('telegram broadcast failed',JSON.stringify({chatId,error:data?.description||('HTTP '+response.status)}));
    }catch(error){console.error('telegram broadcast failed',JSON.stringify({chatId,error:error?.message||String(error)}))}
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
    if(ok)delivered++;else failed++;
  }
  return{total:active.length,delivered,failed};
}
// Confirmation labels shown in every signal message (KB format).
function confirmationLines(trade) {
  const c = trade?.confirmations || {};
  const lines = [];
  if (c.sweep) lines.push('Liquidity Sweep');
  if (c.mss) lines.push('MSS');
  if (c.bos) lines.push('BOS');
  if (c.orderBlock) lines.push('Order Block');
  if (c.fvg) lines.push('FVG');
  if (c.erc) lines.push('ERC / Displacement');
  if (c.fvgObConfluence) lines.push('FVG + OB confluence');
  if (c.htfAligned) lines.push('HTF aligned');
  return lines.length ? lines : ['SMC sequence confirmed'];
}

async function sendTelegram(env,event,subscribers){
  if(!env.TELEGRAM_BOT_TOKEN)return false;
  const activeSubscribers=(subscribers||[]).filter(s=>s.active===true&&String(s.chatId));
  if(!activeSubscribers.length)return false;
  const trade=event.trade;
  const market=event.market||trade?.market||'xau';
  const marketLabel=market==='btc'?'BTCUSD':'XAUUSD';
  const symbol=market==='btc'?'BTCUSDT':'XAU/USD';
  const tf=tfLabel(event.interval);
  const planLines=[
    `🎯 Entry: ${trade.entry}`,
    `🛑 SL: ${trade.stopLoss}`,
    `1️⃣ TP1: ${trade.tp1}`,
    `2️⃣ TP2: ${trade.tp2}`,
    `3️⃣ TP3: ${trade.tp3}`,
    `4️⃣ TP4: ${trade.tp4}`,
  ];
  const statusLine = (t, extra) => `${t}\n\n${marketLabel} — ${trade.direction}\nTimeframe: ${tf}\n\n` + planLines.join('\n') + (extra ? '\n\n' + extra : '');
  let text;
  if(event.type==='SIGNAL'){
    const emoji = trade.direction==='BUY' ? '🟢' : '🔴';
    text=`${emoji} WAJID AI TRADING SIGNAL\n\n${marketLabel} — ${trade.direction}\n\nTimeframe: ${tf}\n\n`+planLines.join('\n')+`\n\nRisk: ${trade.risk} · TP1 1R · TP2 2R · TP3 3R · TP4 4R\n\nCONFIRMATION:\n`+confirmationLines(trade).map(l=>`- ${l}`).join('\n')+`\n\nStatus: CONFIRMED`;
  } else if(event.type==='TP1') {
    text=statusLine('🟡 TP1 HIT — SL moved to Entry.', 'Trade remains OPEN · monitoring TP2–TP4');
  } else if(event.type==='TP2') {
    // KB language: TP2 is a milestone only — the trade is NOT completed.
    text=statusLine('🟡 TP2 HIT — milestone (not a completed trade).', 'Trade remains OPEN · SL at Entry · monitoring TP3–TP4');
  } else if(event.type==='TP3') {
    text=statusLine('🟡 TP3 HIT.', 'Trade remains OPEN · monitoring TP4');
  } else if(event.type==='TP4') {
    text=statusLine('✅ TP4 HIT — Trade completed successfully.', 'Realised R: ' + (trade.realizedR ?? ''));
  } else if(event.type==='BREAK_EVEN') {
    text=statusLine('↔️ BREAK-EVEN — SL at Entry.', 'Trade closed at 0R.');
  } else {
    text=statusLine('❌ SL HIT — Trade closed.', 'Realised R: ' + (trade.realizedR ?? ''));
  }
  const messageIds = {};
  for(const subscriber of activeSubscribers){
    const chatId = subscriber.chatId;
    let payload = {chat_id: chatId, text, disable_web_page_preview: true};
    if(event.type!=='SIGNAL' && messageIds[chatId]) payload.reply_parameters = {message_id: messageIds[chatId]};
    if(chatId!==resolveChannelId(env)) payload.reply_markup=telegramKeyboard();
    try{
      const data=await telegramApiCall(env,'sendMessage',payload);
      if(data?.message_id){
        if(event.type==='SIGNAL') messageIds[chatId]=data.message_id;
        else messageIds[chatId]=messageIds[chatId]||data.message_id;
      }
      if(data?.ok===false){
        if(data.error_code===400&&data.description&&data.description.toLowerCase().includes('message to reply not found')) continue;
        if(data.error_code===403) continue;
        throw new Error('Telegram API error: '+(data.description||'unknown'));
      }
      if(!data?.message_id) throw new Error('Telegram response missing message_id');
    }catch(error){
      console.error('sendTelegram failed', trade.id, chatId, error?.message || error);
      if(String(error?.message || error).includes('bot was blocked by the user')){
        try{
          if(env.DB){
            const row=await env.DB.prepare('SELECT id FROM telegram_subscribers WHERE chat_id=?').bind(chatId).first();
            if(row) await env.DB.prepare('UPDATE telegram_subscribers SET active=0, updated_at=? WHERE id=?').bind(Date.now(),row.id).run();
          }
        }catch(_){}
      }
      return false;
    }
  }
  return { messageIds, failedChatIds: [], ok: true };
}

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
  const channelId = resolveChannelId(env, telegram);
  const active=[{chatId:channelId,active:true,source:'channel'}];
  if(!Array.isArray(telegram.sentKeys)) telegram.sentKeys=[];
  const pendingActive=active.filter(s=>!telegram.sentKeys.includes(telegramEventKey(event,String(s.chatId))));
  if(!pendingActive.length)return {messageIds:{},failedChatIds:[],ok:true,reason:active.length?'ALREADY_DELIVERED':'NO_ACTIVE_SUBSCRIBERS'};
  const result=await sendTelegram(env,event,pendingActive,telegram); telegram.lastDelivery={type:event?.type||null,interval:event?.interval||null,signalTime:event?.trade?.signalTime||null,attemptedAt:Date.now(),activeSubscribers:pendingActive.length,delivered:Object.keys(result?.messageIds||{}).length,failed:(result?.failedChatIds||[]).length,error:result?.error||null};
  // Persistent delivery log (Durable Object state, capped at 500 entries):
  // message, dedup key, status, attempts, timestamp. Never stores secrets.
  if (!Array.isArray(telegram.deliveryLog)) telegram.deliveryLog = [];
  const logDelivery = (chatId, status, messageId, error) => {
    telegram.deliveryLog.push({
      dedupKey: telegramEventKey(event, String(chatId)), type: event?.type || null,
      market: event?.market || null, interval: event?.interval || null,
      tradeId: event?.trade?.id || null, chatId: String(chatId), status,
      messageId: messageId || null, error: error || null, at: Date.now(),
    });
    if (telegram.deliveryLog.length > 500) telegram.deliveryLog = telegram.deliveryLog.slice(-500);
  };
  if(result===false){
    for(const subscriber of pendingActive) enqueuePendingTelegram(telegram,event,String(subscriber.chatId));
    return {messageIds:{},failedChatIds:pendingActive.map(s=>String(s.chatId)),ok:false,reason:'TELEGRAM_SEND_UNAVAILABLE'};
  }
  for(const chatId of (result?.failedChatIds||[])) enqueuePendingTelegram(telegram,event,chatId);
  for(const chatId of (result?.messageIds?Object.keys(result.messageIds):[])){
    const key=telegramEventKey(event,chatId);
    if(!telegram.sentKeys.includes(key)) telegram.sentKeys.push(key);
  }
  if(telegram.sentKeys.length>5000)telegram.sentKeys=telegram.sentKeys.slice(-5000);
  if (result === false) {
    for (const a of pendingActive) logDelivery(a.chatId, 'FAILED', null, result?.error || 'Telegram send failed');
  } else {
    for (const a of pendingActive) logDelivery(a.chatId, result?.messageIds?.[String(a.chatId)] ? 'DELIVERED' : 'FAILED', result?.messageIds?.[String(a.chatId)] || null, result?.error || null);
  }
  return result;
}

// Labelled connectivity test: sends a plain test message (no prices, no
// entry, no trade) to the Premium Channel. Never sends a fake signal.
async function sendTelegramTest(env, telegram) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  const channelId = resolveChannelId(env, telegram);
  const text = '🧪 WAJID TEST — Telegram connectivity check\n\nThis is a test message, not a trading signal.\nNo prices, no entry, no trade.\nTime: ' + new Date().toISOString();
  try {
    const data = await telegramApiCall(env, 'sendMessage', { chat_id: channelId, text, disable_web_page_preview: true });
    if (!Array.isArray(telegram.deliveryLog)) telegram.deliveryLog = [];
    telegram.deliveryLog.push({ dedupKey: 'test:' + Date.now(), type: 'TEST', market: null, interval: null, tradeId: null, chatId: channelId, status: data?.message_id ? 'DELIVERED' : 'FAILED', messageId: data?.message_id || null, error: null, at: Date.now() });
    return { ok: !!data?.message_id, messageId: data?.message_id || null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
}

async function retryPendingTelegram(env,telegram){
  if(!telegram || !Array.isArray(telegram.pending) || !telegram.pending.length) return;
  const now=Date.now(), remaining=[];
  // Retry a bounded batch each minute so one bad subscriber cannot block the queue.
  for(const item of telegram.pending.slice(0,100)){
    if(!item?.event || !item?.chatId) continue;
    if(Number(item.nextAttemptAt||0)>now){remaining.push(item);continue;}
    const isChannel=String(item.chatId)===String(resolveChannelId(env, telegram));
    const subscriber=isChannel
      ? {chatId:String(resolveChannelId(env, telegram)),active:true,source:'channel'}
      : telegram.subscribers?.find(s=>String(s.chatId)===String(item.chatId));
    if(!subscriber || subscriber.active!==true) continue;
    const result=await sendTelegram(env,item.event,[subscriber]);
    if(result?.messageIds?.[String(item.chatId)]){
      const key=item.key||telegramEventKey(item.event,String(item.chatId));
      if(!Array.isArray(telegram.sentKeys)) telegram.sentKeys=[];
      if(!telegram.sentKeys.includes(key)) telegram.sentKeys.push(key);
      continue;
    }
    if(result===false || (result?.failedChatIds||[]).includes(String(item.chatId))){
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