const SESSION_COOKIE = 'wajid_session';
const SESSION_DAYS = 30;
const encoder = new TextEncoder();

function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':'application/json',
      'Cache-Control':'no-store',
      ...extra
    }
  });
}

function normalizeEmail(v){return String(v||'').trim().toLowerCase()}

function publicUser(row){
  if(!row)return null;
  const expires=Number(row.subscription_expires_at||0);
  const active=row.subscription_status==='active' && expires>Date.now();
  const role=normalizeEmail(row.email)==='waged30a@gmail.com'?'admin':(row.role||'user');
  return {
    id:String(row.id),
    name:row.name,
    email:row.email,
    role,
    subscriptionStatus:active?'active':'inactive',
    subscriptionExpiresAt:active?expires:null
  };
}

function cookie(name,value,maxAge){
  const expires = new Date(Date.now() + Math.max(0, Number(maxAge || 0)) * 1000).toUTCString();
  return name+'='+value+'; Max-Age='+Math.max(0, Number(maxAge || 0))+'; Expires='+expires+'; Path=/; HttpOnly; Secure; SameSite=None'
}

function readCookie(request,name){
  const raw=request.headers.get('Cookie')||'';
  for(const part of raw.split(';')){
    const [k,...rest]=part.trim().split('=');
    if(k===name)return rest.join('=');
  }
  return '';
}

function bytesToBase64(bytes){
  let s='';
  for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(v){
  const s=atob(v);
  const o=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)o[i]=s.charCodeAt(i);
  return o;
}

function randomBytes(n){
  const o=new Uint8Array(n);
  crypto.getRandomValues(o);
  return o;
}

async function sha256(v){
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(v)))
  );
}

async function hashPassword(password){
  const iterations=100000;
  const salt=randomBytes(16);
  const key=await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits=await crypto.subtle.deriveBits(
    {name:'PBKDF2',salt,iterations,hash:'SHA-256'},
    key,
    256
  );
  return 'pbkdf2$'+iterations+'$'+bytesToBase64(salt)+'$'+bytesToBase64(new Uint8Array(bits));
}

async function verifyPassword(password,stored){
  const p=String(stored||'').split('$');
  if(p.length!==4||p[0]!=='pbkdf2')return false;

  const iterations=Number(p[1]);
  const salt=base64ToBytes(p[2]);
  const expected=base64ToBytes(p[3]);

  if(!Number.isFinite(iterations)||iterations<1||iterations>100000||!salt.length||!expected.length){
    return false;
  }

  const key=await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits=await crypto.subtle.deriveBits(
    {name:'PBKDF2',salt,iterations,hash:'SHA-256'},
    key,
    expected.length*8
  );

  const actual=new Uint8Array(bits);
  if(actual.length!==expected.length)return false;

  let diff=0;
  for(let i=0;i<actual.length;i++)diff|=actual[i]^expected[i];
  return diff===0;
}

async function createSession(env,userId){
  const token=Array.from(randomBytes(32))
    .map(x=>x.toString(16).padStart(2,'0'))
    .join('');
  const hash=await sha256(token);
  const expires=Date.now()+SESSION_DAYS*86400000;

  await env.DB.prepare(
    'INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)'
  ).bind(
    crypto.randomUUID(),
    String(userId),
    hash,
    expires,
    Date.now()
  ).run();

  return {token,expires};
}

async function currentUser(request,env){
  if(!env.DB)return null;

  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return null;

  const hash=await sha256(token);

  const row=await env.DB.prepare(
    'SELECT u.id,u.name,u.email,u.role,u.subscription_status,u.subscription_expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status=? LIMIT 1'
  ).bind(hash,Date.now(),'active').first();

  return publicUser(row);
}

export async function getAuthUser(request,env){
  return currentUser(request,env);
}

export function hasActiveSubscription(user){
  return user?.subscriptionStatus==='active';
}

export async function handleAuthRequest(request,env){
  if(!env.DB)return json({ok:false,error:'AUTH_DATABASE_NOT_CONFIGURED'},503);

  const action=new URL(request.url).pathname
    .replace('/api/auth/','')
    .replace(/\/$/,'')||'me';

  let stage='start';

  try{
    if(action==='me'&&request.method==='GET'){
      stage='me_lookup';
      const user=await currentUser(request,env);
      return user
        ? json({ok:true,user})
        : json({ok:false,error:'UNAUTHORIZED'},401);
    }

    if(action==='register'&&request.method==='POST'){
      stage='register_parse';

      const b=await request.json().catch(()=>({}));
      const name=String(b.name||'').trim();
      const email=normalizeEmail(b.email);
      const password=String(b.password||'');

      if(name.length<2||name.length>80)
        return json({ok:false,error:'Enter a valid name.'},400);

      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>160)
        return json({ok:false,error:'Enter a valid email.'},400);

      if(password.length<8||password.length>128)
        return json({ok:false,error:'Password must be 8–128 characters.'},400);

      stage='register_email_check';

      const existing=await env.DB.prepare(
        'SELECT id FROM users WHERE email=? LIMIT 1'
      ).bind(email).first();

      if(existing)
        return json({ok:false,error:'An account with this email already exists.'},409);

      stage='register_password_hash';

      const id=crypto.randomUUID();
      const now=Date.now();
      const passwordHash=await hashPassword(password);

      stage='register_user_insert';

      await env.DB.prepare(
        'INSERT INTO users (id,name,email,password_hash,role,status,subscription_status,subscription_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        id,
        name,
        email,
        passwordHash,
        'user',
        'active',
        'inactive',
        0,
        now,
        now
      ).run();

      stage='register_session_create';

      const s=await createSession(env,id);

      stage='register_success';

      return json({
        ok:true,
        user:{
          id,
          name,
          email,
          role:'user',
          subscriptionStatus:'inactive',
          subscriptionExpiresAt:null
        }
      },201,{
        'Set-Cookie':cookie(SESSION_COOKIE,s.token,SESSION_DAYS*86400)
      });
    }

    if(action==='login'&&request.method==='POST'){
      const b=await request.json().catch(()=>({}));
      const email=normalizeEmail(b.email);
      const password=String(b.password||'');

      const row=await env.DB.prepare(
        'SELECT id,name,email,password_hash,role,status,subscription_status,subscription_expires_at FROM users WHERE email=? LIMIT 1'
      ).bind(email).first();

      if(!row||row.status!=='active'||!(await verifyPassword(password,row.password_hash))){
        return json({ok:false,error:'Invalid email or password.'},401);
      }

      await env.DB.prepare(
        'DELETE FROM sessions WHERE user_id=? OR expires_at<=?'
      ).bind(String(row.id),Date.now()).run();

      const s=await createSession(env,row.id);

      return json({ok:true,user:publicUser(row)},200,{
        'Set-Cookie':cookie(SESSION_COOKIE,s.token,SESSION_DAYS*86400)
      });
    }

    if(action==='logout'&&request.method==='POST'){
      const token=readCookie(request,SESSION_COOKIE);

      if(token){
        await env.DB.prepare(
          'DELETE FROM sessions WHERE token_hash=?'
        ).bind(await sha256(token)).run();
      }

      return json({ok:true},200,{
        'Set-Cookie':cookie(SESSION_COOKIE,'',0)
      });
    }

    return json({ok:false,error:'Not found'},404);

  }catch(error){
    console.error(
      'auth error',
      JSON.stringify({
        action,
        stage,
        message:error?.message||String(error),
        name:error?.name||''
      })
    );

    return json({
      ok:false,
      error:'Authentication service error.',
      stage
    },500);
  }
}
