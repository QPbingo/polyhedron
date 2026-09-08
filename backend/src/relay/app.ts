import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {SignJWT} from 'jose';
import * as oidc from 'openid-client';
import WebSocket from 'ws';
import {z} from 'zod';
import {RelayStore,RelayError,digest,secret,type BrowserSession,type HostBinding} from './store.js';
import {decodeFrame,encodeFrame} from '../shared/wire.js';

export interface RelayConfig {
  devAuth?:boolean; bindHost?:string; publicOrigin?:string; sessionSecret?:string;
  databasePath?:string; databaseUrl?:string;
  oidc?:{issuer:string;clientId:string;clientSecret?:string};
  sessionTtlMs?:number;pairingTtlMs?:number;rpcTimeoutMs?:number;
}
declare module 'fastify' {interface FastifyInstance {relayStore:RelayStore}}
interface HostConnection {socket:WebSocket;binding:HostBinding}
interface BrowserConnection {socket:WebSocket;clientId:string;token:string;session:BrowserSession;subscriptions:Map<string,Set<string>>;hosts:Set<string>;pending:number;closed:boolean}
interface Pending {method:string;host:HostConnection;browser?:BrowserConnection;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}
const MAX_BUFFER=2*1024*1024;
const MAX_SNAPSHOT=8*1024*1024;
const METHODS=new Set(['list','listDirectories','configureHost','addProject','renameProject','deleteProject','createSession','renameSession','attach','detach','claimControl','input','resize','outputAck','interrupt','terminate','resume','archive','history']);
export function isLoopback(host:string){return host==='localhost'||host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host)||host==='::ffff:127.0.0.1';}
function equal(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
function failure(error:unknown){return error instanceof RelayError?{code:error.code,message:error.message}:{code:'INTERNAL_ERROR',message:'The relay could not complete this request'};}
const str=z.string().min(1).max(200);

export async function createRelay(config:RelayConfig={}):Promise<FastifyInstance>{
  const devAuth=config.devAuth===true, bindHost=config.bindHost??'127.0.0.1';
  if(devAuth&&(!isLoopback(bindHost)||process.env.NODE_ENV==='production'))throw new Error('Development authentication requires a loopback bind and non-production environment');
  if(!devAuth&&!config.oidc)throw new Error('OIDC configuration is required; development authentication must be explicitly enabled');
  if(!config.sessionSecret||config.sessionSecret.length<32)throw new Error('RELAY_SESSION_SECRET must contain at least 32 characters');
  if(!devAuth&&!config.databaseUrl)throw new Error('Production relay requires PostgreSQL DATABASE_URL');
  const publicUrl=new URL(config.publicOrigin??'http://127.0.0.1:18417');
  if(publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash||publicUrl.username||publicUrl.password)throw new Error('PUBLIC_ORIGIN must be an origin without path or credentials');
  if(devAuth&&!isLoopback(publicUrl.hostname))throw new Error('Development PUBLIC_ORIGIN must use loopback');
  if(!devAuth&&publicUrl.protocol!=='https:')throw new Error('Production PUBLIC_ORIGIN must use HTTPS');
  const origin=publicUrl.origin,sessionSecret=config.sessionSecret;
  const cookieName=devAuth?'polyhedron_session':'__Host-polyhedron_session';
  const flowCookie=devAuth?'polyhedron_oidc':'__Host-polyhedron_oidc';
  const cookieOptions={path:'/',httpOnly:true,sameSite:'lax' as const,secure:!devAuth};
  const sessionTtl=config.sessionTtlMs??7*24*3600_000;
  const store=new RelayStore({databasePath:config.databasePath,databaseUrl:config.databaseUrl,encryptionSecret:sessionSecret});
  await store.init();
  let oidcConfig:oidc.Configuration|undefined;
  try{if(config.oidc)oidcConfig=await oidc.discovery(new URL(config.oidc.issuer),config.oidc.clientId,config.oidc.clientSecret,undefined,{execute:[oidc.enableNonRepudiationChecks]});}catch(error){await store.close();throw error;}
  const app=Fastify({logger:false,bodyLimit:128*1024,trustProxy:false,requestTimeout:15_000});
  app.decorate('relayStore',store);
  await app.register(cookie);
  await app.register(rateLimit,{global:true,max:600,timeWindow:'1 minute',errorResponseBuilder:()=>({error:{code:'RATE_LIMITED',message:'Too many requests; try again shortly'}})});
  await app.register(websocket,{options:{maxPayload:MAX_SNAPSHOT,perMessageDeflate:false}});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Invalid request fields'}});
    const status=(error as {statusCode?:number}).statusCode??500;
    return reply.code(status).send({error:error instanceof RelayError?failure(error):{code:status===429?'RATE_LIMITED':status<500?'INVALID_REQUEST':'INTERNAL_ERROR',message:status===429?'Too many requests':status<500?'Invalid request':'The relay could not complete this request'}});
  });
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Route not found'}}));
  app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','same-origin');return payload;});
  const hosts=new Map<string,HostConnection>(),browsers=new Map<string,BrowserConnection>(),pending=new Map<string,Pending>();
  const authContext=new WeakMap<FastifyRequest,{session:BrowserSession;token:string}>();
  const hostContext=new WeakMap<FastifyRequest,HostBinding>();
  const csrf=(token:string)=>createHmac('sha256',sessionSecret).update(`csrf:${token}`).digest('base64url');
  function requireOrigin(request:FastifyRequest){if(request.headers.origin!==origin)throw new RelayError('ORIGIN_DENIED','This origin is not allowed',403);}
  async function authenticate(request:FastifyRequest){
    const token=request.cookies[cookieName];const session=token?await store.getSession(token):null;
    if(!session||!token)throw new RelayError('UNAUTHENTICATED','Sign in to continue',401);
    authContext.set(request,{session,token});return {session,token};
  }
  async function mutation(request:FastifyRequest){requireOrigin(request);const auth=await authenticate(request);if(!equal(String(request.headers['x-csrf-token']??''),csrf(auth.token)))throw new RelayError('CSRF_INVALID','Invalid CSRF token',403);return auth;}
  async function issueSession(reply:FastifyReply,account:{id:string;name:string}){const token=await store.createSession(account.id,sessionTtl);reply.setCookie(cookieName,token,{...cookieOptions,maxAge:Math.floor(sessionTtl/1000)});await store.audit(account.id,null,'browser.login');return {user:account,csrfToken:csrf(token)};}
  // Large screen snapshots have a separate budget; terminal-output backlog stays at 2 MiB.
  const snapshotBytes=new WeakMap<WebSocket,number>();
  function send(socket:WebSocket,message:Record<string,unknown>){
    if(socket.readyState!==WebSocket.OPEN)return false;
    const frame=encodeFrame(message),size=typeof frame==='string'?Buffer.byteLength(frame):frame.length;
    const large=message.type==='response'||message.event==='snapshot';
    const snapshots=snapshotBytes.get(socket)??0,outputBuffered=Math.max(0,socket.bufferedAmount-snapshots);
    if(size>(large?MAX_SNAPSHOT:MAX_BUFFER)||(large?snapshots+size>MAX_SNAPSHOT||outputBuffered>MAX_BUFFER:outputBuffered+size>MAX_BUFFER)){
      socket.close(1013,'Slow connection; reconnect for a snapshot');return false;
    }
    if(large)snapshotBytes.set(socket,snapshots+size);
    socket.send(frame,()=>{if(large)snapshotBytes.set(socket,Math.max(0,(snapshotBytes.get(socket)??0)-size));});return true;
  }
  async function signGrant(host:HostConnection,clientId:string,accountId:string,method:string,params:Record<string,any>){
    const claims:Record<string,any>={hostId:host.binding.id,clientId,scope:'host',method};
    if(typeof params.sessionId==='string')claims.sessionId=params.sessionId;
    if(typeof params.runtimeEpoch==='string')claims.runtimeEpoch=params.runtimeEpoch;
    return new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setSubject(accountId).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+30).setJti(randomUUID()).sign(new TextEncoder().encode(host.binding.hostToken));
  }
  async function detachClient(host:HostConnection,browser:BrowserConnection){
    const grant=await signGrant(host,browser.clientId,browser.session.accountId,'detach',{});
    send(host.socket,{type:'rpc',requestId:randomUUID(),clientId:browser.clientId,grant,method:'detach',params:{}});
  }
  async function rpc(host:HostConnection,clientId:string,accountId:string,method:string,params:Record<string,any>,browser?:BrowserConnection):Promise<any>{
    if(hosts.get(host.binding.id)!==host||host.socket.readyState!==WebSocket.OPEN)throw new RelayError('HOST_OFFLINE','Host is offline',503);
    if(pending.size>=2048||(browser&&browser.pending>=64))throw new RelayError('BUSY','Too many pending requests',429);
    const requestId=randomUUID();
    const grant=await signGrant(host,clientId,accountId,method,params);
    if(browser?.closed)throw new RelayError('UNAUTHENTICATED','Browser disconnected',401);
    return new Promise((resolve,reject)=>{
      if(browser)browser.pending++;
      const finish=(fn:(value:any)=>void,value:any)=>{pending.delete(requestId);if(browser)browser.pending--;fn(value);};
      const timer=setTimeout(()=>finish(reject,new RelayError('HOST_TIMEOUT','Host did not respond in time',504)),config.rpcTimeoutMs??15_000);
      timer.unref();pending.set(requestId,{method,host,browser,resolve:v=>finish(resolve,v),reject:e=>finish(reject,e),timer});
      if(!send(host.socket,{type:'rpc',requestId,clientId,grant,method,params})){clearTimeout(timer);pending.get(requestId)?.reject(new RelayError('HOST_OFFLINE','Host disconnected',503));}
    });
  }
  async function disconnectBrowser(browser:BrowserConnection,code=1000,reason='Disconnected'){
    if(browser.closed)return;browser.closed=true;
    if(browsers.get(browser.clientId)===browser)browsers.delete(browser.clientId);
    for(const [id,item]of pending){if(item.browser===browser){clearTimeout(item.timer);item.reject(new RelayError('UNAUTHENTICATED','Browser disconnected',401));pending.delete(id);}}
    for(const hostId of browser.hosts){const host=hosts.get(hostId);if(host&&host.binding.accountId===browser.session.accountId)await detachClient(host,browser).catch(()=>{});}
    browser.subscriptions.clear();browser.socket.close(code,reason);
  }
  function removeHost(connection:HostConnection){
    if(hosts.get(connection.binding.id)!==connection)return;
    hosts.delete(connection.binding.id);
    for(const item of pending.values()){if(item.host===connection){clearTimeout(item.timer);item.reject(new RelayError('HOST_OFFLINE','Host disconnected',503));}}
    for(const browser of browsers.values()){if(browser.session.accountId===connection.binding.accountId){browser.subscriptions.delete(connection.binding.id);send(browser.socket,{type:'event',event:'state',host:{id:connection.binding.id,name:connection.binding.name,online:false}});}}
  }
  app.get('/api/auth',async request=>{
    const token=request.cookies[cookieName],session=token?await store.getSession(token):null;
    return session&&token?{authenticated:true,user:{id:session.accountId,name:session.name},csrfToken:csrf(token),mode:devAuth?'development':'oidc'}:{authenticated:false,mode:devAuth?'development':'oidc'};
  });
  app.post('/auth/dev',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
    if(!devAuth)throw new RelayError('NOT_FOUND','Development authentication is disabled',404);
    requireOrigin(request);if(!isLoopback(request.ip))throw new RelayError('LOOPBACK_REQUIRED','Development login is limited to this computer',403);
    const body=z.object({name:z.string().trim().min(1).max(80).optional()}).parse(request.body??{}),name=body.name??'本地用户';
    const id=name==='本地用户'?'dev-local':`dev-${digest(name).slice(0,24)}`;
    const account=await store.upsertAccount({id,name,issuer:'development',subject:name});
    const previous=request.cookies[cookieName];if(previous){await store.revokeSession(digest(previous));for(const browser of browsers.values())if(browser.session.hash===digest(previous))await disconnectBrowser(browser,4001,'Login replaced');}
    return issueSession(reply,account);
  });
  app.get('/auth/login',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(_request,reply)=>{
    if(!oidcConfig)throw new RelayError('OIDC_UNAVAILABLE','OIDC login is not configured; use explicit local development login',503);
    const id=secret(),state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
    await store.saveOidcFlow(id,{state,nonce,verifier},10*60_000);
    const url=oidc.buildAuthorizationUrl(oidcConfig,{redirect_uri:`${origin}/auth/callback`,scope:'openid profile',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
    reply.setCookie(flowCookie,id,{...cookieOptions,maxAge:600});return reply.redirect(url.href);
  });
  app.get('/auth/callback',async(request,reply)=>{
    if(!oidcConfig)throw new RelayError('OIDC_UNAVAILABLE','OIDC is not configured',503);
    const id=request.cookies[flowCookie];reply.clearCookie(flowCookie,cookieOptions);
    const flow=id?await store.consumeOidcFlow(id):null;
    if(!flow)throw new RelayError('OIDC_FLOW_INVALID','Login expired or was already used',401);
    try{
      const tokens=await oidc.authorizationCodeGrant(oidcConfig,new URL(request.raw.url!,origin),{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
      const claims=tokens.claims();if(!claims?.sub)throw new Error('Missing OIDC subject');
      const account=await store.upsertAccount({id:randomUUID(),issuer:config.oidc!.issuer,subject:claims.sub,name:typeof claims.name==='string'?claims.name.slice(0,80):'用户'});
      const previous=request.cookies[cookieName];if(previous){await store.revokeSession(digest(previous));for(const browser of browsers.values())if(browser.session.hash===digest(previous))await disconnectBrowser(browser,4001,'Login replaced');}
      await issueSession(reply,account);return reply.redirect('/');
    }catch{throw new RelayError('OIDC_LOGIN_FAILED','Identity provider validation failed; start login again',401);}
  });
  app.post('/auth/logout',async(request,reply)=>{const {session}=await mutation(request);await store.revokeSession(session.hash);for(const browser of browsers.values())if(browser.session.hash===session.hash)await disconnectBrowser(browser,4001,'Browser session revoked');reply.clearCookie(cookieName,cookieOptions);await store.audit(session.accountId,null,'browser.logout');return {ok:true};});
  app.get('/api/browsers',async request=>{
    const {session}=await authenticate(request);
    return {browsers:(await store.listBrowserSessions(session.accountId)).map(browser=>({...browser,current:browser.id===session.hash}))};
  });
  app.post('/api/browsers/:id/revoke',async(request,reply)=>{
    const {session}=await mutation(request);
    const {id}=z.object({id:z.string().regex(/^[0-9a-f]{64}$/)}).parse(request.params);
    await store.revokeOwnedBrowserSession(id,session.accountId);
    await Promise.all([...browsers.values()].filter(browser=>browser.session.hash===id).map(browser=>disconnectBrowser(browser,4001,'Browser session revoked')));
    if(id===session.hash)reply.clearCookie(cookieName,cookieOptions);
    await store.audit(session.accountId,null,'browser.revoked');
    return {ok:true};
  });
  app.get('/api/hosts',async request=>{const {session}=await authenticate(request);return {hosts:(await store.listHosts(session.accountId)).map(host=>({...host,online:hosts.has(host.id)}))};});
  app.get('/api/state',async request=>{
    const {session}=await authenticate(request),bindings=await store.listHosts(session.accountId);
    const state:{hosts:any[];projects:any[];sessions:any[]}={hosts:[],projects:[],sessions:[]};
    await Promise.all(bindings.map(async binding=>{
      const offline=async()=>{const saved=await store.getProjection(binding.id,session.accountId);state.hosts.push({...binding,online:false});state.projects.push(...saved.projects);state.sessions.push(...saved.sessions);};
      const host=hosts.get(binding.id);if(!host){await offline();return;}
      try{const result=await rpc(host,`state-${randomUUID()}`,session.accountId,'list',{});state.hosts.push({...result.host,id:binding.id,name:binding.name,online:true});if(Array.isArray(result.projects))state.projects.push(...result.projects.map((project:Record<string,unknown>)=>({...project,hostId:binding.id})));if(Array.isArray(result.sessions))state.sessions.push(...result.sessions.map((entry:Record<string,unknown>)=>({...entry,hostId:binding.id})));}catch{await offline();}
    }));
    if(!await store.getSession(request.cookies[cookieName]!))throw new RelayError('UNAUTHENTICATED','Browser session expired',401);
    const owned=new Set((await store.listHosts(session.accountId)).map(host=>host.id));
    return {hosts:state.hosts.filter(host=>owned.has(host.id)),projects:state.projects.filter(project=>owned.has(project.hostId)),sessions:state.sessions.filter(entry=>owned.has(entry.hostId))};
  });
  app.post('/api/pairings/start',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{if(request.headers.origin)requireOrigin(request);const body=z.object({name:z.string().trim().min(1).max(80)}).parse(request.body);return store.startPairing(body.name,config.pairingTtlMs??5*60_000);});
  app.post('/api/pairings/poll',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{if(request.headers.origin)requireOrigin(request);const body=z.object({pairingId:str,pollToken:str}).parse(request.body);return store.pollPairing(body.pairingId,body.pollToken);});
  app.post('/api/pairings/approve',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>{const {session}=await mutation(request);const body=z.object({code:str}).parse(request.body);return store.approvePairing(body.code,session.accountId);});
  app.post('/api/hosts/:id/revoke',async request=>{const {session}=await mutation(request);const {id}=z.object({id:str}).parse(request.params);await store.revokeHost(id,session.accountId);const host=hosts.get(id);
    if(host){removeHost(host);await Promise.all([...browsers.values()].filter(browser=>browser.session.accountId===session.accountId&&browser.hosts.has(id)).map(browser=>detachClient(host,browser).catch(()=>{})));host.socket.close(4003,'Host revoked');}
    for(const browser of browsers.values())if(browser.session.accountId===session.accountId){browser.hosts.delete(id);browser.subscriptions.delete(id);send(browser.socket,{type:'event',event:'state',host:{id,online:false,revoked:true}});}
    await store.audit(session.accountId,id,'host.revoked');return {ok:true};
  });
  app.get('/ws/host',{websocket:true,preValidation:async request=>{
    if(request.headers.origin)throw new RelayError('HOST_ORIGIN_DENIED','Host transport does not accept browser origins',403);
    const id=request.headers['x-host-id'],authorization=request.headers.authorization;
    if(typeof id!=='string'||!authorization?.startsWith('Bearer '))throw new RelayError('HOST_UNAUTHORIZED','Host authentication required',401);
    const binding=await store.getHost(id);if(!binding||!equal(binding.hostToken,authorization.slice(7)))throw new RelayError('HOST_UNAUTHORIZED','Invalid host credentials',401);
    hostContext.set(request,binding);
  }},(socket,request)=>{
    const binding=hostContext.get(request)!,connection={socket,binding};const previous=hosts.get(binding.id);if(previous){removeHost(previous);previous.socket.close(4000,'Connector replaced');}hosts.set(binding.id,connection);
    socket.on('error',()=>{});
    socket.on('close',()=>removeHost(connection));
    socket.on('message',(data,isBinary)=>{
      try{
        const message=decodeFrame(data as Buffer,isBinary);
        if(!message||typeof message!=='object')return socket.close(1008,'Invalid message');
        if(hosts.get(binding.id)!==connection)return;
        if(message.type==='result'){
          const item=pending.get(message.requestId);if(!item||item.host!==connection)return;clearTimeout(item.timer);
          if(message.error)item.reject(new RelayError(String(message.error.code??'HOST_ERROR').slice(0,100),String(message.error.message??'Host request failed').slice(0,500)));
          else if(item.method==='list'){
            // Enqueue the projection before later state frames, preserving host wire order.
            void store.replaceProjection(binding.id,binding.accountId,message.result).then(()=>{if(pending.get(message.requestId)===item)item.resolve(message.result);}).catch(()=>{if(pending.get(message.requestId)===item)item.reject(new RelayError('PROJECTION_UNAVAILABLE','Offline host metadata could not be saved',503));});
          }else item.resolve(message.result);return;
        }
        if(message.type!=='event'||!['state','output','snapshot','resync','exit'].includes(message.event))return;
        if(['output','snapshot','resync'].includes(message.event)){
          if(typeof message.clientId!=='string'||message.hostId!==binding.id||typeof message.sessionId!=='string'||(message.event==='output'&&typeof message.data!=='string'))return;
          const browser=browsers.get(message.clientId);
          if(browser&&!browser.closed&&browser.session.expiresAt>Date.now()&&browser.session.accountId===binding.accountId&&browser.subscriptions.get(binding.id)?.has(message.sessionId))send(browser.socket,message);
        }else{
          if(message.event==='state')void store.mergeProjection(binding.id,binding.accountId,message).catch(()=>{socket.close(1011,'Offline host metadata could not be saved');});
          for(const browser of browsers.values())if(!browser.closed&&browser.session.expiresAt>Date.now()&&browser.session.accountId===binding.accountId&&(!message.clientId||message.clientId===browser.clientId))send(browser.socket,{...message,hostId:binding.id});
        }
      }catch{socket.close(1008,'Malformed host frame');}
    });
    for(const browser of browsers.values())if(browser.session.accountId===binding.accountId)send(browser.socket,{type:'event',event:'state',host:{id:binding.id,name:binding.name,online:true}});
  });
  app.get('/ws/browser',{websocket:true,preValidation:async request=>{
    requireOrigin(request);const {session}=await authenticate(request);const {clientId}=z.object({clientId:z.uuid()}).parse(request.query);const existing=browsers.get(clientId);
    if(existing&&existing.session.hash!==session.hash)throw new RelayError('CLIENT_ID_IN_USE','This tab identity is already connected',409);
  }},(socket,request)=>{
    const {clientId}=request.query as {clientId:string};const auth=authContext.get(request)!;const old=browsers.get(clientId);if(old)void disconnectBrowser(old,4000,'Tab reconnected');
    const browser:BrowserConnection={socket,clientId,...auth,subscriptions:new Map(),hosts:new Set(),pending:0,closed:false};browsers.set(clientId,browser);
    let count=0,windowStart=Date.now(),inFlight=0,queuedBytes=0;
    socket.on('error',()=>{});socket.on('close',()=>{void disconnectBrowser(browser)});
    socket.on('message',(data,isBinary)=>{
      if(Date.now()-windowStart>10_000){count=0;windowStart=Date.now();}
      if(++count>2000||isBinary||(data as Buffer).length>128*1024){void disconnectBrowser(browser,1008,'Invalid browser message');return;}
      void(async()=>{
        let id:unknown,reserved=false;
        try{
          const raw=decodeFrame(data as Buffer,false);id=raw?.id;
          const msg=z.object({type:z.literal('request'),id:z.string().min(1).max(128),hostId:str,method:str,params:z.record(z.string(),z.unknown())}).parse(raw);
          if(inFlight>=64||queuedBytes+(data as Buffer).length>MAX_BUFFER)throw new RelayError('BUSY','Too many queued requests',429);
          inFlight++;queuedBytes+=(data as Buffer).length;reserved=true;
          if(!METHODS.has(msg.method))throw new RelayError('METHOD_NOT_ALLOWED','Unknown operation',403);
          const live=await store.getSession(browser.token);if(!live||browser.closed){await disconnectBrowser(browser,4001,'Browser session expired');return;}
          const binding=await store.getHost(msg.hostId);if(!binding||binding.accountId!==live.accountId)throw new RelayError('HOST_NOT_FOUND','Host not found',404);
          const host=hosts.get(msg.hostId);if(!host)throw new RelayError('HOST_OFFLINE','Host is offline',503);
          browser.hosts.add(msg.hostId);
          const sessionId=typeof msg.params.sessionId==='string'?msg.params.sessionId:undefined;
          if(msg.method==='attach'){
            if(!sessionId)throw new RelayError('INVALID_REQUEST','Session ID is required');
            if(!browser.subscriptions.has(msg.hostId))browser.subscriptions.set(msg.hostId,new Set());
            browser.subscriptions.get(msg.hostId)!.add(sessionId);
          }
          let result:any;
          try{result=await rpc(host,clientId,live.accountId,msg.method,msg.params,browser);}catch(error){if(msg.method==='attach'&&sessionId)browser.subscriptions.get(msg.hostId)?.delete(sessionId);throw error;}
          if(msg.method==='detach'){if(sessionId)browser.subscriptions.get(msg.hostId)?.delete(sessionId);else browser.subscriptions.delete(msg.hostId);}
          if(!browser.closed)send(socket,{type:'response',id:msg.id,result});
        }catch(error){if(!browser.closed)send(socket,{type:'response',id:typeof id==='string'?id:null,error:error instanceof z.ZodError?{code:'INVALID_REQUEST',message:'Invalid request fields'}:failure(error)});}
        finally{if(reserved){inFlight--;queuedBytes-=(data as Buffer).length;}}
      })();
    });
  });
  let renewing=false;
  const renew=setInterval(()=>{if(renewing)return;renewing=true;void(async()=>{
    for(const browser of browsers.values()){
      if(!await store.getSession(browser.token)){await disconnectBrowser(browser,4001,'Browser session revoked');continue;}
      for(const hostId of browser.subscriptions.keys()){
        const binding=await store.getHost(hostId),host=hosts.get(hostId);
        if(!binding||binding.accountId!==browser.session.accountId){browser.subscriptions.delete(hostId);if(host){removeHost(host);host.socket.close(4003,'Host revoked');}continue;}
        if(host)void rpc(host,browser.clientId,browser.session.accountId,'authorize',{},browser).catch(()=>{});
      }
    }
  })().catch(()=>{for(const browser of browsers.values())void disconnectBrowser(browser,1011,'Authorization unavailable')}).finally(()=>{renewing=false})},10_000);renew.unref();
  const cleanup=setInterval(()=>{void store.cleanup().catch(()=>{})},60_000);cleanup.unref();
  app.addHook('preClose',async()=>{clearInterval(renew);clearInterval(cleanup);for(const browser of browsers.values())await disconnectBrowser(browser,1001,'Relay shutting down');for(const host of hosts.values()){host.socket.terminate();removeHost(host);}for(const item of pending.values()){clearTimeout(item.timer);item.reject(new RelayError('SHUTDOWN','Relay shutting down',503));}});
  app.addHook('onClose',async()=>{await store.close()});
  return app;
}
