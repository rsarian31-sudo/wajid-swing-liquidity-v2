const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const RECEIVING_WALLET = '0xcb23069d5Ec57b21039D571aa805843D0127ce61'.toLowerCase();
const BSC_RPC = 'https://bsc-dataseed.binance.org';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const PLANS = { week:{id:'week',name:'1 Week',usd:5,days:7}, month:{id:'month',name:'1 Month',usd:10,days:30} };

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
function cleanHash(v){return String(v||'').trim().toLowerCase()}
function validHash(v){return /^0x[a-f0-9]{64}$/.test(cleanHash(v))}
function normalizeAddress(v){return String(v||'').trim().toLowerCase()}
function hexToBigInt(v){try{return BigInt(v)}catch{return null}}
async function rpc(method,params=[]){
  const r=await fetch(BSC_RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const d=await r.json().catch(()=>null); if(!r.ok||d?.error)throw new Error(d?.error?.message||'BSC RPC error'); return d?.result;
}
async function currentUser(request,env){const mod=await import('./auth.js');return mod.getAuthUser(request,env)}
async function createOrder(request,env){
  const user=await currentUser(request,env); if(!user)return json({ok:false,error:'UNAUTHORIZED'},401);
  if(!env.DB)return json({ok:false,error:'AUTH_DATABASE_NOT_CONFIGURED'},503);
  const body=await request.json().catch(()=>({})),plan=PLANS[String(body.plan||'').toLowerCase()];
  if(!plan)return json({ok:false,error:'INVALID_PLAN'},400);
  const existing=await env.DB.prepare("SELECT id,plan,amount_usdt,expires_at,status FROM payment_orders WHERE user_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(user.id,Date.now()).first();
  if(existing)return json({ok:true,order:{id:existing.id,plan:existing.plan,amountUsdt:Number(existing.amount_usdt),expiresAt:Number(existing.expires_at),wallet:RECEIVING_WALLET,network:'BSC / BEP-20',token:'USDT'}});
  const id=crypto.randomUUID(),now=Date.now(),expiresAt=now+15*60*1000;
  await env.DB.prepare('INSERT INTO payment_orders (id,user_id,plan,amount_usdt,network,token_contract,recipient_address,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,user.id,plan.id,plan.usd,'BSC',USDT_BSC,RECEIVING_WALLET,'pending',now,expiresAt).run();
  return json({ok:true,order:{id,plan:plan.id,planName:plan.name,amountUsdt:plan.usd,expiresAt,wallet:RECEIVING_WALLET,network:'BSC / BEP-20',token:'USDT'}},201);
}
async function makeTelegramToken(env,userId){
  const token=Array.from(crypto.getRandomValues(new Uint8Array(18))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const now=Date.now();
  await env.DB.prepare('UPDATE users SET telegram_connect_token=?,telegram_connect_expires_at=?,updated_at=? WHERE id=?').bind(token,now+15*60*1000,now,userId).run();
  return token;
}
async function verifyOrder(request,env){
  const user=await currentUser(request,env); if(!user)return json({ok:false,error:'UNAUTHORIZED'},401);
  if(!env.DB)return json({ok:false,error:'AUTH_DATABASE_NOT_CONFIGURED'},503);
  const body=await request.json().catch(()=>({})),orderId=String(body.orderId||'').trim(),txHash=cleanHash(body.txHash);
  if(!orderId||!validHash(txHash))return json({ok:false,error:'INVALID_ORDER_OR_TX_HASH'},400);
  const order=await env.DB.prepare('SELECT * FROM payment_orders WHERE id=? AND user_id=? LIMIT 1').bind(orderId,user.id).first();
  if(!order)return json({ok:false,error:'ORDER_NOT_FOUND'},404);
  if(order.status==='paid')return json({ok:true,paid:true,subscriptionExpiresAt:Number(order.subscription_expires_at||0)});
  if(Number(order.expires_at)<Date.now())return json({ok:false,error:'PAYMENT_WINDOW_EXPIRED'},400);
  const used=await env.DB.prepare('SELECT id FROM payment_orders WHERE tx_hash=? AND status=? LIMIT 1').bind(txHash,'paid').first();
  if(used)return json({ok:false,error:'TRANSACTION_ALREADY_USED'},409);
  try{
    const tx=await rpc('eth_getTransactionByHash',[txHash]); if(!tx)return json({ok:false,error:'TRANSACTION_NOT_FOUND'},400);
    if(normalizeAddress(tx.to)!==USDT_BSC)return json({ok:false,error:'NOT_BSC_USDT_TRANSFER'},400);
    const receipt=await rpc('eth_getTransactionReceipt',[txHash]); if(!receipt||receipt.status!=='0x1')return json({ok:false,error:'TRANSACTION_NOT_SUCCESSFUL'},400);
    const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const recipientTopic='0x'+RECEIVING_WALLET.slice(2).padStart(64,'0');
    let matched=null;
    for(const log of (Array.isArray(receipt.logs)?receipt.logs:[])){
      if(normalizeAddress(log.address)!==USDT_BSC)continue;
      if(String(log.topics?.[0]||'').toLowerCase()!==transferTopic)continue;
      if(String(log.topics?.[2]||'').toLowerCase()!==recipientTopic)continue;
      const raw=hexToBigInt(log.data); if(raw===null)continue;
      matched={raw,from:'0x'+String(log.topics?.[1]||'').slice(-40)}; break;
    }
    if(!matched)return json({ok:false,error:'NO_PAYMENT_TO_RECEIVING_WALLET'},400);
    const expected=BigInt(Math.round(Number(order.amount_usdt)*1e18));
    if(matched.raw<expected)return json({ok:false,error:'INSUFFICIENT_PAYMENT'},400);
    const blockNumber=Number.parseInt(String(receipt.blockNumber||'0'),16);
    const latest=await rpc('eth_blockNumber'),latestNumber=Number.parseInt(String(latest||'0'),16);
    if(Math.max(0,latestNumber-blockNumber+1)<1)return json({ok:false,error:'WAITING_FOR_CONFIRMATION'},409);
    const userRow=await env.DB.prepare('SELECT subscription_expires_at FROM users WHERE id=? LIMIT 1').bind(user.id).first();
    const now=Date.now(),currentExpiry=Number(userRow?.subscription_expires_at||0),base=Math.max(now,currentExpiry),plan=PLANS[String(order.plan)],expires=base+plan.days*86400000;
    await env.DB.prepare("UPDATE payment_orders SET status='paid',tx_hash=?,from_address=?,block_number=?,verified_at=?,subscription_expires_at=? WHERE id=? AND status='pending'").bind(txHash,matched.from,blockNumber,now,expires,order.id).run();
    await env.DB.prepare("UPDATE users SET subscription_status='active',subscription_expires_at=?,updated_at=? WHERE id=?").bind(expires,now,user.id).run();
    const token=await makeTelegramToken(env,user.id);
    const bot=String(env.TELEGRAM_BOT_USERNAME||'').replace(/^@/,'');
    return json({ok:true,paid:true,plan:plan.name,amountUsdt:plan.usd,subscriptionExpiresAt:expires,telegramConnect:bot?'https://t.me/'+bot+'?start=connect_'+token:null});
  }catch(error){console.error('payment verification error',error?.message||String(error));return json({ok:false,error:'PAYMENT_VERIFICATION_FAILED'},502)}
}
async function telegramLink(request,env){
  const user=await currentUser(request,env); if(!user)return json({ok:false,error:'UNAUTHORIZED'},401);
  if(user.subscriptionStatus!=='active')return json({ok:false,error:'SUBSCRIPTION_REQUIRED'},403);
  const token=await makeTelegramToken(env,user.id);
  let bot=String(env.TELEGRAM_BOT_USERNAME||'').replace(/^@/,'');
  if(!bot&&env.TELEGRAM_BOT_TOKEN){try{const r=await fetch(TELEGRAM_API+encodeURIComponent(env.TELEGRAM_BOT_TOKEN)+'/getMe');const d=await r.json().catch(()=>null);bot=d?.result?.username||''}catch(_){}
  }
  return json({ok:true,telegramConnect:bot?'https://t.me/'+bot+'?start=connect_'+token:null});
}
export async function handlePaymentRequest(request,env){
  const path=new URL(request.url).pathname;
  if(request.method==='POST'&&path==='/api/payment/create')return createOrder(request,env);
  if(request.method==='POST'&&path==='/api/payment/verify')return verifyOrder(request,env);
  if(request.method==='GET'&&path==='/api/payment/telegram')return telegramLink(request,env);
  if(request.method==='GET'&&path==='/api/payment/config')return json({ok:true,network:'BSC / BEP-20',token:'USDT',tokenContract:USDT_BSC,wallet:RECEIVING_WALLET,plans:Object.values(PLANS).map(x=>({id:x.id,name:x.name,usd:x.usd,days:x.days}))});
  return json({ok:false,error:'Not found'},404);
}
