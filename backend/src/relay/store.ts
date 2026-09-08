import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {sanitizeProjection,projectSummary,sessionSummary,type HostProjection} from './projection.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class RelayError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export interface Account { id: string; name: string; issuer: string; subject: string }
export interface BrowserSession { hash: string; accountId: string; name: string; expiresAt: number }
export interface HostBinding { id: string; accountId: string; name: string; hostToken: string; revoked: boolean }
interface StoreOptions { databasePath?: string; databaseUrl?: string; encryptionSecret: string }
type Row = Record<string, any>;
const schema = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(issuer, subject));
CREATE TABLE IF NOT EXISTS browser_sessions (id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at BIGINT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS browser_account_idx ON browser_sessions(account_id);
CREATE TABLE IF NOT EXISTS host_bindings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_cipher TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS hosts_account_idx ON host_bindings(account_id);
CREATE TABLE IF NOT EXISTS host_projections (host_id TEXT PRIMARY KEY REFERENCES host_bindings(id) ON DELETE CASCADE, projects_json TEXT NOT NULL, sessions_json TEXT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, poll_hash TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL, account_id TEXT REFERENCES accounts(id), host_id TEXT, status TEXT NOT NULL DEFAULT 'pending', issued INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oidc_flows (id_hash TEXT PRIMARY KEY, payload_cipher TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, account_id TEXT, host_id TEXT, event TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at);
`;
/** Account and allowlisted session metadata only; never project paths or terminal content. */
export class RelayStore {
  private sqlite?: DatabaseSync;
  private pool?: Pool;
  private key: Buffer;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(options: StoreOptions) {
    this.key = createHash('sha256').update(options.encryptionSecret).digest();
    if (options.databaseUrl) this.pool = new Pool({ connectionString: options.databaseUrl, max: 1 });
    else {
      const path = options.databasePath ?? '.data/relay.sqlite';
      if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
      this.sqlite = new DatabaseSync(path);
      this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
      if (path !== ':memory:') chmodSync(path, 0o600);
    }
  }
  async init() { if (this.sqlite) this.sqlite.exec(schema); else await this.pool!.query(schema); }
  private async query(sql: string, params: any[] = []): Promise<Row[]> {
    if (this.sqlite) return this.sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params) as Row[];
    return (await this.pool!.query(sql, params)).rows;
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result;
  }
  private async transaction<T>(fn: () => Promise<T>) {
    await this.query('BEGIN');
    try { const result = await fn(); await this.query('COMMIT'); return result; }
    catch (error) { await this.query('ROLLBACK'); throw error; }
  }
  private encrypt(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private decrypt(value: string) {
    const data = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
  upsertAccount(account: Account) { return this.run(async () => {
    const rows = await this.query('INSERT INTO accounts(id,issuer,subject,name,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO UPDATE SET name=excluded.name RETURNING *', [account.id, account.issuer, account.subject, account.name, Date.now()]);
    return {id: rows[0].id, name: rows[0].name};
  }); }
  createSession(accountId: string, ttlMs: number) { return this.run(async () => {
    const token = secret();
    await this.query('INSERT INTO browser_sessions(id_hash,account_id,expires_at,created_at) VALUES($1,$2,$3,$4)', [digest(token), accountId, Date.now() + ttlMs, Date.now()]);
    return token;
  }); }
  getSession(token: string) { return this.run(async (): Promise<BrowserSession | null> => {
    const [row] = await this.query('SELECT s.id_hash,s.account_id,s.expires_at,a.name FROM browser_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id_hash=$1 AND s.revoked=0 AND s.expires_at>$2', [digest(token), Date.now()]);
    return row ? { hash: row.id_hash, accountId: row.account_id, expiresAt: Number(row.expires_at), name: row.name } : null;
  }); }
  revokeSession(hash: string) { return this.run(async () => { await this.query('UPDATE browser_sessions SET revoked=1 WHERE id_hash=$1', [hash]); }); }
  listBrowserSessions(accountId: string) { return this.run(async () => {
    const rows = await this.query('SELECT id_hash,created_at,expires_at FROM browser_sessions WHERE account_id=$1 AND revoked=0 AND expires_at>$2 ORDER BY created_at DESC,id_hash', [accountId, Date.now()]);
    return rows.map(row => ({id: row.id_hash as string, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at)}));
  }); }
  revokeOwnedBrowserSession(hash: string, accountId: string) { return this.run(async () => {
    const rows = await this.query('UPDATE browser_sessions SET revoked=1 WHERE id_hash=$1 AND account_id=$2 RETURNING id_hash', [hash, accountId]);
    if (!rows.length) throw new RelayError('BROWSER_NOT_FOUND', 'Browser login not found', 404);
  }); }
  upsertHost(host: {id:string;accountId:string;name:string;hostToken:string}) { return this.run(async () => {
    const rows=await this.query('INSERT INTO host_bindings(id,account_id,name,token_hash,token_cipher,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,token_cipher=excluded.token_cipher,revoked=0 WHERE host_bindings.account_id=excluded.account_id RETURNING id', [host.id,host.accountId,host.name,digest(host.hostToken),this.encrypt(host.hostToken),Date.now()]);
    if(!rows.length) throw new RelayError('HOST_OWNER_MISMATCH','Host belongs to another account',403);
  }); }
  private host(row:Row):HostBinding { return {id:row.id,accountId:row.account_id,name:row.name,hostToken:this.decrypt(row.token_cipher),revoked:!!row.revoked}; }
  getHost(id:string) { return this.run(async()=>{const [row]=await this.query('SELECT * FROM host_bindings WHERE id=$1 AND revoked=0',[id]);return row?this.host(row):null;}); }
  listHosts(accountId:string) { return this.run(async()=> (await this.query('SELECT id,name FROM host_bindings WHERE account_id=$1 AND revoked=0 ORDER BY created_at',[accountId])).map(r=>({id:r.id as string,name:r.name as string}))); }
  revokeHost(id:string,accountId:string) { return this.run(()=>this.transaction(async()=>{
    const rows=await this.query('UPDATE host_bindings SET revoked=1 WHERE id=$1 AND account_id=$2 AND revoked=0 RETURNING id',[id,accountId]);
    if(!rows.length) throw new RelayError('HOST_NOT_FOUND','Host not found',404);
    await this.query('DELETE FROM host_projections WHERE host_id=$1',[id]);
  })); }
  private async saveProjection(hostId:string,accountId:string,projection:HostProjection){
    const projects=JSON.stringify(projection.projects),sessions=JSON.stringify(projection.sessions);
    if(Buffer.byteLength(projects)+Buffer.byteLength(sessions)>8*1024*1024)throw new RelayError('PROJECTION_TOO_LARGE','Host metadata exceeds the offline summary limit',413);
    await this.query('INSERT INTO host_projections(host_id,projects_json,sessions_json,updated_at) SELECT id,$1,$2,$3 FROM host_bindings WHERE id=$4 AND account_id=$5 AND revoked=0 ON CONFLICT(host_id) DO UPDATE SET projects_json=excluded.projects_json,sessions_json=excluded.sessions_json,updated_at=excluded.updated_at',[projects,sessions,Date.now(),hostId,accountId]);
  }
  replaceProjection(hostId:string,accountId:string,input:unknown){
    const projection=sanitizeProjection(hostId,input);
    return this.run(()=>this.saveProjection(hostId,accountId,projection));
  }
  mergeProjection(hostId:string,accountId:string,input:{project?:unknown;session?:unknown}){
    const project=projectSummary(hostId,input.project),session=sessionSummary(hostId,input.session);
    if(!project&&!session)return Promise.resolve();
    return this.run(async()=>{
      const [row]=await this.query('SELECT p.projects_json,p.sessions_json FROM host_projections p JOIN host_bindings h ON h.id=p.host_id WHERE p.host_id=$1 AND h.account_id=$2 AND h.revoked=0',[hostId,accountId]);
      const projection:HostProjection=row?{projects:JSON.parse(row.projects_json),sessions:JSON.parse(row.sessions_json)}:{projects:[],sessions:[]};
      if(project){const i=projection.projects.findIndex(p=>p.id===project.id);if(i<0)projection.projects.push(project);else projection.projects[i]=project;}
      if(session){const i=projection.sessions.findIndex(s=>s.id===session.id);if(i<0)projection.sessions.push(session);else projection.sessions[i]=session;}
      await this.saveProjection(hostId,accountId,projection);
    });
  }
  getProjection(hostId:string,accountId:string){return this.run(async():Promise<HostProjection>=>{
    const [row]=await this.query('SELECT p.projects_json,p.sessions_json FROM host_projections p JOIN host_bindings h ON h.id=p.host_id WHERE p.host_id=$1 AND h.account_id=$2 AND h.revoked=0',[hostId,accountId]);
    if(!row)return {projects:[],sessions:[]};
    return {projects:JSON.parse(row.projects_json).map((project:Record<string,unknown>)=>({...project,path:''})),sessions:JSON.parse(row.sessions_json)};
  }); }

  startPairing(name:string,ttlMs:number) { return this.run(async()=>{
    const pairingId=randomUUID(), code=randomBytes(5).toString('hex').toUpperCase(),pollToken=secret(),expiresAt=Date.now()+ttlMs;
    await this.query('INSERT INTO pairings(id,code_hash,poll_hash,name,expires_at) VALUES($1,$2,$3,$4,$5)',[pairingId,digest(code),digest(pollToken),name,expiresAt]);
    return {pairingId,code,pollToken,expiresAt};
  }); }
  approvePairing(code:string,accountId:string) { return this.run(()=>this.transaction(async()=>{
    const [existing]=await this.query('SELECT * FROM pairings WHERE code_hash=$1',[digest(code.toUpperCase().replace(/[\s-]/g,''))]);
    if(!existing) throw new RelayError('PAIRING_NOT_FOUND','Pairing code not found',404);
    if(Number(existing.expires_at)<=Date.now()) throw new RelayError('PAIRING_EXPIRED','Pairing code expired',410);
    const hostId=randomUUID(),hostToken=secret();
    const rows=await this.query("UPDATE pairings SET account_id=$1,host_id=$2,status='approved' WHERE id=$3 AND status='pending' AND expires_at>$4 RETURNING id",[accountId,hostId,existing.id,Date.now()]);
    if(!rows.length) throw new RelayError('PAIRING_USED','Pairing already approved',409);
    await this.query('INSERT INTO host_bindings(id,account_id,name,token_hash,token_cipher,created_at) VALUES($1,$2,$3,$4,$5,$6)',[hostId,accountId,existing.name,digest(hostToken),this.encrypt(hostToken),Date.now()]);
    await this.auditQuery(accountId,hostId,'host.paired');
    return {ok:true};
  })); }
  pollPairing(id:string,pollToken:string) {return this.run(()=>this.transaction(async()=>{
    const [row]=await this.query('SELECT * FROM pairings WHERE id=$1 AND poll_hash=$2',[id,digest(pollToken)]);
    if(!row) throw new RelayError('PAIRING_UNAUTHORIZED','Invalid pairing credentials',401);
    if(Number(row.expires_at)<=Date.now()) throw new RelayError('PAIRING_EXPIRED','Pairing expired',410);
    if(row.issued) throw new RelayError('PAIRING_CONSUMED','Pairing credentials have already been delivered',410);
    if(row.status==='pending') return {status:'pending'};
    const issued=await this.query('UPDATE pairings SET issued=1 WHERE id=$1 AND issued=0 RETURNING id',[id]);
    if(!issued.length) throw new RelayError('PAIRING_CONSUMED','Pairing credentials have already been delivered',410);
    const [host]=await this.query('SELECT * FROM host_bindings WHERE id=$1 AND revoked=0',[row.host_id]);
    if(!host) throw new RelayError('HOST_REVOKED','Host was revoked',410);
    return {status:'approved',hostId:host.id,hostToken:this.decrypt(host.token_cipher),accountId:host.account_id};
  }));}
  saveOidcFlow(id:string,payload:Record<string,string>,ttlMs:number) {return this.run(async()=>{await this.query('INSERT INTO oidc_flows(id_hash,payload_cipher,expires_at) VALUES($1,$2,$3)',[digest(id),this.encrypt(JSON.stringify(payload)),Date.now()+ttlMs]);});}
  consumeOidcFlow(id:string) {return this.run(async()=>{const [row]=await this.query('DELETE FROM oidc_flows WHERE id_hash=$1 RETURNING *',[digest(id)]);return row&&Number(row.expires_at)>Date.now()?JSON.parse(this.decrypt(row.payload_cipher)) as Record<string,string>:null;});}
  private async auditQuery(accountId:string|null,hostId:string|null,event:string){await this.query('INSERT INTO audit_events(id,account_id,host_id,event,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),accountId,hostId,event,Date.now()]);}
  audit(accountId:string|null,hostId:string|null,event:string){return this.run(()=>this.auditQuery(accountId,hostId,event));}
  cleanup() {return this.run(async()=>{const now=Date.now();await this.query('DELETE FROM oidc_flows WHERE expires_at<$1',[now]);await this.query('DELETE FROM pairings WHERE expires_at<$1',[now]);await this.query('DELETE FROM browser_sessions WHERE expires_at<$1',[now]);await this.query('DELETE FROM audit_events WHERE created_at<$1',[now-90*24*3600_000]);});}
  async close(){await this.tail;if(this.sqlite)this.sqlite.close();if(this.pool)await this.pool.end();}
}
