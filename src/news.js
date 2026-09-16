const RSS_QUERIES=[
  'gold XAU USD Federal Reserve CPI PCE NFP FOMC',
  'US dollar Fed rates Treasury yields gold'
];
const BULLISH=['gold rises','gold climbs','gold gains','gold rallies','bullish gold','safe haven demand','rate cut','rate cuts','dovish','weaker dollar','weak dollar','lower yields','yield falls','soft inflation','cooling inflation','geopolitical tension','geopolitical tensions','war risk','uncertainty'];
const BEARISH=['gold falls','gold drops','gold declines','gold slides','bearish gold','rate hike','rate hikes','hawkish','stronger dollar','strong dollar','higher yields','yield rises','hot inflation','sticky inflation','strong jobs','strong payrolls','risk-on'];
const HIGH_IMPACT=['fomc','federal reserve','fed ','powell','cpi','pce','ppi','nonfarm','nfp','payroll','unemployment','interest rate','rate decision'];
function clean(s){return String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim()}
function tag(xml,name){const m=xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`,'i'));return m?clean(m[1]):''}
function items(xml){return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(m=>m[0]).map(x=>({title:tag(x,'title'),pubDate:tag(x,'pubDate'),link:tag(x,'link')})).filter(x=>x.title)}
function termCount(text,list){let n=0;for(const t of list)if(text.includes(t))n++;return n}
export async function fetchNewsContext(){
  const now=Date.now();
  const all=[];
  for(const q of RSS_QUERIES){
    try{
      const url='https://news.google.com/rss/search?q='+encodeURIComponent(q)+'&hl=en-US&gl=US&ceid=US:en';
      const r=await fetch(url,{headers:{'Accept':'application/rss+xml,text/xml','User-Agent':'WajidSwingLiquidity/2.0'}});
      if(!r.ok)continue;
      const xml=await r.text();
      all.push(...items(xml));
    }catch(_){ }
  }
  const seen=new Set(),recent=[];let bull=0,bear=0,highImpactRecent=false;
  for(const item of all){
    const key=item.title.toLowerCase();if(seen.has(key))continue;seen.add(key);
    const ts=Date.parse(item.pubDate);if(!Number.isFinite(ts))continue;
    const age=(now-ts)/60000;if(age<0||age>360)continue;
    const text=item.title.toLowerCase();
    const b=termCount(text,BULLISH),s=termCount(text,BEARISH),hi=termCount(text,HIGH_IMPACT)>0;
    if(b>s)bull+=Math.max(1,b-s);else if(s>b)bear+=Math.max(1,s-b);
    if(hi&&age<=45)highImpactRecent=true;
    if(recent.length<12)recent.push({title:item.title,time:Math.floor(ts/1000),ageMinutes:Math.round(age),highImpact:hi,source:item.link||null,direction:b>s?'BULLISH':s>b?'BEARISH':'NEUTRAL'});
  }
  const raw=bull-bear,bias=raw>0?'BULLISH':raw<0?'BEARISH':'NEUTRAL',strength=Math.min(100,Math.abs(raw)*25);
  return{available:recent.length>0,bias,biasStrength:strength,highImpactRecent,updatedAt:Math.floor(now/1000),items:recent};
}