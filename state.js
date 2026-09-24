import { DurableObject } from 'cloudflare:workers';
const RESET_VERSION='volume-ob-creation-v2';
const EMPTY=()=>({version:3,ruleVersion:RESET_VERSION,intervals:{'1min':{active:null,activeTrades:[],trades:[],lastSignalId:null,lastCandleTime:null,ruleVersion:RESET_VERSION},'5min':{active:null,activeTrades:[],trades:[],lastSignalId:null,lastCandleTime:null,ruleVersion:RESET_VERSION},'15min':{active:null,activeTrades:[],trades:[],lastSignalId:null,lastCandleTime:null,ruleVersion:RESET_VERSION}},telegram:{offset:0,subscribers:[],pending:[]},schedulerLocks:{}});
export class WajidTradeState extends DurableObject{
  async fetch(request){
    const url=new URL(request.url);
    let state=await this.ctx.storage.get('state');
    if(!state||state.ruleVersion!==RESET_VERSION){
      state=EMPTY();
      await this.ctx.storage.put('state',state);
    }
    if(request.method==='GET')return json(state);
    if(request.method==='POST'&&url.pathname==='/replace'){
      const body=await request.json();
      if(!body||typeof body!=='object')return json({error:'Invalid state'},400);
      await this.ctx.storage.put('state',body);
      return json(body);
    }
    if(request.method==='POST'&&url.pathname==='/lock'){
      const body=await request.json().catch(()=>({}));
      const key=String(body?.key||'').trim();
      const owner=String(body?.owner||'').trim();
      const ttl=Math.max(10000,Math.min(120000,Number(body?.ttl||90000)));
      if(!key||!owner)return json({error:'Invalid lock request'},400);
      const now=Date.now();
      const locks=state.schedulerLocks&&typeof state.schedulerLocks==='object'?state.schedulerLocks:{};
      const current=locks[key];
      if(current&&Number(current.expiresAt)>now&&String(current.owner)!==owner)return json({ok:false,locked:true,expiresAt:Number(current.expiresAt)},409);
      locks[key]={owner,expiresAt:now+ttl};
      state.schedulerLocks=locks;
      await this.ctx.storage.put('state',state);
      return json({ok:true,locked:false,expiresAt:locks[key].expiresAt});
    }
    if(request.method==='POST'&&url.pathname==='/unlock'){
      const body=await request.json().catch(()=>({}));
      const key=String(body?.key||'').trim();
      const owner=String(body?.owner||'').trim();
      if(!key||!owner)return json({error:'Invalid unlock request'},400);
      const locks=state.schedulerLocks&&typeof state.schedulerLocks==='object'?state.schedulerLocks:{};
      const current=locks[key];
      if(current&&String(current.owner)===owner){
        delete locks[key];
        state.schedulerLocks=locks;
        await this.ctx.storage.put('state',state);
      }
      return json({ok:true});
    }
    return json({error:'Not found'},404);
  }
}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
