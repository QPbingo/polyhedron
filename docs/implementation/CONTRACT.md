# V1 implementation contract
The user approved PRODUCT.md / DESIGN.md and requested full implementation with independent frontend/ and backend/. New visual decisions follow latest DESIGN.md over original spec. demos/ remains a standalone mock. No git repo. No deployment, real model prompts, existing vendor configuration changes, or global service installation during implementation. Real launches may show native trust/login UI; never bypass native permissions.

## Processes
frontend Vite 127.0.0.1:18417 proxies /api,/auth,/ws to relay :3001. Relay Fastify :3001 authenticates browser using HttpOnly cookie; OIDC production, explicit loopback-only dev login. Relay never launches a process. Host :Unix socket backend/.data/host.sock owns PTYs, SQLite, headless terminal, persisted output, credentials. Connector opens outbound WS to relay then authenticated IPC WS to host; its restart must not kill PTYs. Authoritative runtime metadata stays on host. Cloud PG stores accounts, browsers, host bindings, pairing, audit and allowlisted offline project/session summaries without paths, native IDs, controllers or terminal text. SQLite local adapter for relay development.

## Types (frontend duplicates public types; independent packages)
Agent='codex'|'claude'; Activity='working'|'approval'|'idle'|'done'|'unknown'; ProcessState='starting'|'running'|'exited'|'interrupted'|'failed'.
Host={id,name,online,platform?,agents?:AgentInfo[],roots?:string[],settings?:{preventSleep:boolean,historyDays:number,maxHistoryBytes:number}}; AgentInfo={id:Agent,name,path:string|null,version:string|null,available:boolean,reason?:string,hooks?:boolean}.
Project={id,hostId,name,path,createdAt}.
Session={id,hostId,projectId,title,agent,processState,activity,runtimeEpoch:string,nativeSessionId:string|null,controlEpoch:number,controller:string|null,cols:number,rows:number,createdAt,updatedAt,archived:boolean,exitCode?:number|null,statusSource?:string,warning?:string|null}.
State={hosts:Host[],projects:Project[],sessions:Session[]}.
Session host list method returns {host:Host,projects:Project[],sessions:Session[]}.

## REST (relay)
GET /api/auth => {authenticated:boolean,user?:{id,name},csrfToken?:string,mode:'development'|'oidc'}.
POST /auth/dev {name?} => {user,csrfToken}; only if DEV_AUTH=1, both bind address and browser request loopback; no production fallback. Cookie session.
GET /auth/login, GET /auth/callback => OIDC flow, validates state/nonce/PKCE. POST /auth/logout revokes browser.
GET /api/state => State (queries each connected host list, preserves offline host record, no terminal content stored).
GET /api/hosts => {hosts:Host[]}.
GET /api/browsers => {browsers:[{id,createdAt,expiresAt,current}]}, current account only.
POST /api/browsers/:id/revoke => {ok:true}; account ownership, Origin/CSRF, detaches all tabs of that login.
POST /api/pairings/approve {code} => {ok:true}; authenticated, csrf.
POST /api/hosts/:id/revoke => {ok:true}; authenticated, csrf; revoke token and ongoing sockets.
POST /api/pairings/start {name} => {pairingId,code,pollToken,expiresAt} unauthenticated rate limited.
POST /api/pairings/poll {pairingId,pollToken} => {status:'pending'|'approved',hostId?,hostToken?,accountId?}; approved secret issued once.
WS /ws/host Authorization: Bearer hostToken, x-host-id. Registry ownership from persistent binding (not client claimed account).
WS /ws/browser?clientId=<uuid> with cookie + strict Origin; clientId is tab identity, relay binds each socket, cannot substitute another tab.
REST mutations use X-CSRF-Token and Origin validation. Errors {error:{code,message}} with meaningful status.

## RPC browser <-> relay <-> connector <-> host
Browser JSON {type:'request',id,hostId,method,params}. Response {type:'response',id,result} or {type:'response',id,error:{code,message}}.
Relay sends host {type:'rpc',requestId,clientId,grant,method,params}; host returns {type:'result',requestId,result} or error. Grant JWT HS256 using hostToken bytes secret: {sub:accountId,hostId,clientId,scope:'host',method,sessionId?,runtimeEpoch?,exp:now+30}. Host validates JWT signature, sub against bound account, hostId, scope, exact method/session/runtime, exp on each request. Relay only signs for actual owned connected host. Relays renew attached sockets using authorize method every 10s; browser revocation stops renewals and sends detach. Host expires client authorization after <=30s (including output). Browser disconnect sends detach for each attachment, does not terminate CLI. All browser methods allowlisted.
Host RPC methods:
- list {} -> {host,projects,sessions}
- listDirectories {path?:string} -> {path:string|null,parent:string|null,entries:[{name,path}],truncated:boolean}; omitted path lists available authorized roots. Canonical directories only, no file contents, escaped/broken links skipped, at most 500 folders / 10000 scanned entries per request. Parent navigation stops at authorized roots.
- configureHost {preventSleep?,historyDays?,maxHistoryBytes?} -> settings; persists, days 1–365, quota 16 MiB–10 GiB, cannot widen directory roots
- addProject {name,path} -> Project (realpath, directory exists, authorized root containment; duplicate root canonical path rejection)
- renameProject {projectId,name} -> Project
- deleteProject {projectId} -> {ok:true}, reject if has sessions
- createSession {projectId,title,agent,confirmConflict?:boolean} -> Session; reject PROJECT_BUSY unless confirmConflict when another running session in same directory
- renameSession {sessionId,title} -> Session
- attach {sessionId} -> Snapshot, also subscribes browser client; must be read-only even on creation; controller matching client may send only after resize + snapshot acknowledged by frontend
- detach {sessionId?} -> {ok:true}; removes client subscriptions, releases own control
- authorize {} -> {ok:true}; renew grant of existing subscriptions
- claimControl {sessionId,runtimeEpoch} -> Session; monotonic controlEpoch, new controller clientId
- input {sessionId,runtimeEpoch,controlEpoch,inputSeq:number,data:string} -> {inputSeq,duplicate:boolean}; <=16KiB, monotonic per (clientId,controlEpoch), reject stale runtime/control; no disconnected input replay
- resize {sessionId,runtimeEpoch,controlEpoch,cols,rows} -> Session; owner only
- outputAck {sessionId,runtimeEpoch,seq} -> {ok:true}; older valid ACKs are idempotent, invalid/future sequences rejected
- interrupt {sessionId,runtimeEpoch,controlEpoch} -> {ok:true}; CLI Esc for codex / Ctrl+C claude, no guessed done status
- terminate {sessionId,runtimeEpoch,controlEpoch,confirm:true} -> {ok:true}; managed process tree only
- resume {sessionId} -> Session; exited only exact validated nativeSessionId, original host/path, new runtimeEpoch, never --last
- archive {sessionId,archived:boolean} -> Session; active cannot archive
- history {sessionId,runtimeEpoch?,before?:number,limit?:number} -> {entries:[{seq,data,at}],hasMore:boolean,truncated:boolean,runtimeEpoch:string,runs:[{runtimeEpoch,createdAt}]}; bounded read-only page (do not write historical entries into terminal)
Snapshot={session:Session,seq:number,data:string,cols,rows,truncated?:boolean}; current serialized parsed checkpoint and subscription sequence atomic.
Host broadcasts {type:'event',event:'state',session?:Session,project?:Project,clientId?} and {type:'event',event:'output',hostId,sessionId,clientId,runtimeEpoch,seq,data}. output target client mandatory; relay routes only to authenticated host-owner matching client socket. Output wire is binary: uint32 BE metadata JSON byte length, UTF8 metadata (all event fields except data), UTF8 data bytes. shared/wire.ts contains encoding/decoding helpers. Other events JSON. Ordinary output backlog is capped at 2 MiB; responses/snapshots have a separate 8 MiB cap. Slow sockets close and require an authoritative full snapshot on reconnect. Cross-connection incremental replay is not implemented. Host receives actual acknowledgements to bound outstanding output.

## Host IPC configuration
backend/.data/host.json = {hostId,accountId,hostToken,ipcToken,relayUrl,name,roots:string[]} mode0600, dataDir mode0700. macOS production hostToken in Keychain, config may reference it; explicit dev storage file. Host socket authenticates Authorization Bearer ipcToken. Connector uses same config path; no browser can access IPC. Host main --config <path> or HOST_CONFIG env, default .data/host.json relative backend. Connector same.
Root owns backend/src/shared/{types,wire}.ts, backend/src/host/**, backend/src/connector/**, backend/src/dev.ts and backend package/dependencies/configs.
Relay worker owns backend/src/relay/** + backend/test/relay*.ts.
Adapter worker owns backend/src/adapters/** + backend/test/adapters*.ts + backend/scripts/**. Export detectAgents():Promise<AgentInfo[]>; buildLaunch({agent,cwd,nativeSessionId?,sessionId,runtimeEpoch,hookToken,hookSocket,dataDir}):Promise<{file,args,env:Record<string,string>}>. Hook bridge sends sanitized JSON to authenticated IPC POST /hook via Unix socket: {sessionId,runtimeEpoch,event,nativeSessionId?,eventId,agentId?,toolUseId?,toolName?,at}. Header Authorization Bearer hookToken. Host maps safe events only. No payload/output secrets persisted. Child events ignored for parent activity.
Frontend worker owns frontend/** excluding package manifest installed by root.
