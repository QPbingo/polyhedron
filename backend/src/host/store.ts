import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Fault,type Project,type Session,type Snapshot,type SessionSnapshot} from '../shared/types.js';
import {LocalCipher} from './crypto.js';
import {HostJournal,type JournalFaults} from './journal.js';

interface HostStoreOptions{dir:string;secret:string;hostId:string;quota?:number;days?:number;faults?:JournalFaults}
const encrypted=(value:string)=>value.startsWith('enc:v1:');

export class HostStore{
  readonly db:DatabaseSync;readonly dir:string;readonly cipher:LocalCipher;readonly journal:HostJournal;
  private quota:number;private days:number;
  constructor(options:HostStoreOptions|string,quota=128*1024*1024,days=30){
    const resolved=typeof options==='string'?{dir:options,secret:`development-only:${options}:polyhedron`,hostId:'legacy-host',quota,days}:options;
    this.dir=resolved.dir;this.quota=resolved.quota??quota;this.days=resolved.days??days;
    mkdirSync(this.dir,{recursive:true,mode:0o700});chmodSync(this.dir,0o700);mkdirSync(join(this.dir,'logs'),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(this.dir,'host.sqlite'));
    try{
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS snapshots(session_id TEXT,runtime TEXT,data TEXT NOT NULL,PRIMARY KEY(session_id,runtime));CREATE TABLE IF NOT EXISTS segments(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,runtime TEXT,file TEXT,size INTEGER DEFAULT 0,first_seq INTEGER,last_seq INTEGER,at TEXT);CREATE TABLE IF NOT EXISTS retention(session_id TEXT,runtime TEXT,truncated INTEGER DEFAULT 0,PRIMARY KEY(session_id,runtime));CREATE TABLE IF NOT EXISTS hooks(id TEXT PRIMARY KEY,session_id TEXT,runtime TEXT,event TEXT,native_id TEXT,at TEXT);`);
      this.cipher=new LocalCipher(resolved.secret,resolved.hostId);this.journal=new HostJournal(this.db,this.cipher,resolved.faults);this.migrateLegacySegments();this.encryptDomainRows();
    }catch(error){try{this.db.close()}catch{}throw error}
  }
  private encode(value:unknown,aad:string){return this.cipher.sealJson(value,this.cipher.domainKey,aad)}
  private decode<T>(value:string,aad:string):T{return encrypted(value)?this.cipher.openJson<T>(value,this.cipher.domainKey,aad):JSON.parse(value) as T}
  private encryptDomainRows(){let changed=false;this.db.exec('BEGIN IMMEDIATE');try{for(const table of ['projects','sessions'] as const)for(const row of this.db.prepare(`SELECT id,data FROM ${table}`).all() as any[])if(!encrypted(row.data)){this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(this.encode(JSON.parse(row.data),`${table}:${row.id}`),row.id);changed=true}for(const row of this.db.prepare('SELECT session_id,runtime,data FROM snapshots').all() as any[])if(!encrypted(row.data)){this.db.prepare('UPDATE snapshots SET data=? WHERE session_id=? AND runtime=?').run(this.encode(JSON.parse(row.data),`snapshot:${row.session_id}:${row.runtime}`),row.session_id,row.runtime);changed=true}this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}if(changed){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);VACUUM;')};}
  private migrateLegacySegments(){
    const rows=this.db.prepare('SELECT * FROM segments ORDER BY id').all() as any[];if(!rows.length)return;
    const entries:any[]=[],hashParts:string[]=[];
    try{
      for(const row of rows){
        if(!existsSync(row.file))throw new Error(`missing segment ${row.id}`);
        const content=readFileSync(row.file,'utf8');hashParts.push(`${row.id}:${this.cipher.digest(content)}`);
        for(const line of content.split('\n').filter(Boolean)){
          const item=JSON.parse(line);
          if(!Number.isSafeInteger(item.seq)||typeof item.data!=='string'||typeof item.at!=='string')throw new Error(`invalid segment ${row.id}`);
          entries.push({streamId:`session:${row.session_id}`,kind:'pty_output',runtimeOffset:1,at:item.at,payload:{seq:item.seq,data:item.data,at:item.at,runtimeEpoch:row.runtime,legacy:true}});
        }
      }
    }catch(error){throw new Fault('LEGACY_MIGRATION_FAILED',`旧版 JSON journal 无法安全迁移：${error instanceof Error?error.message:'invalid data'}`)}
    this.journal.importLegacy('jsonl-v1',this.cipher.digest(hashParts.join('|')),entries);
  }
  preferences(){const row=this.db.prepare('SELECT data FROM settings WHERE id=1').get() as any;return row?JSON.parse(row.data):{};}
  configure(settings:{preventSleep:boolean;historyDays:number;maxHistoryBytes:number}){this.db.prepare('INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings));this.days=settings.historyDays;this.quota=settings.maxHistoryBytes;}
  projects():Project[]{return (this.db.prepare('SELECT id,data FROM projects ORDER BY rowid').all() as any[]).map(row=>this.decode<Project>(row.data,`projects:${row.id}`))}
  sessions():Session[]{return (this.db.prepare('SELECT id,data FROM sessions ORDER BY rowid DESC').all() as any[]).map(row=>this.decode<Session>(row.data,`sessions:${row.id}`))}
  saveProject(project:Project){this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id,this.encode(project,`projects:${project.id}`))}
  deleteProject(id:string){this.db.prepare('DELETE FROM projects WHERE id=?').run(id)}
  saveSession(session:Session){this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id,this.encode(session,`sessions:${session.id}`))}
  saveSnapshot(snapshot:Snapshot){this.db.prepare('INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(session_id,runtime) DO UPDATE SET data=excluded.data').run(snapshot.session.id,snapshot.session.runtimeEpoch,this.encode(snapshot,`snapshot:${snapshot.session.id}:${snapshot.session.runtimeEpoch}`))}
  snapshot(id:string,runtime:string):Snapshot|null{const row=this.db.prepare('SELECT data FROM snapshots WHERE session_id=? AND runtime=?').get(id,runtime) as any;if(!row)return null;try{return this.decode<Snapshot>(row.data,`snapshot:${id}:${runtime}`)}catch{throw new Fault('SNAPSHOT_CORRUPT','保存的终端快照已损坏，可查看历史记录或恢复原生会话')}}
  saveOffsetSnapshot(snapshot:SessionSnapshot){const runtime=String(snapshot.session.runtimeOffset??0);this.db.prepare('INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(session_id,runtime) DO UPDATE SET data=excluded.data').run(snapshot.session.id,runtime,this.encode(snapshot,`snapshot:${snapshot.session.id}:${runtime}`))}
  offsetSnapshot(id:string,runtimeOffset:number):SessionSnapshot|null{const runtime=String(runtimeOffset),row=this.db.prepare('SELECT data FROM snapshots WHERE session_id=? AND runtime=?').get(id,runtime) as any;if(!row)return null;try{return this.decode<SessionSnapshot>(row.data,`snapshot:${id}:${runtime}`)}catch{throw new Fault('SNAPSHOT_CORRUPT','保存的终端快照已损坏，可从 journal 重新构建')}}
  recordHook(id:string,session:Session,event:string,at:string,nativeId=session.nativeSessionId){const encoded=nativeId?this.encode(nativeId,`hook:${id}`):null;const result=this.db.prepare('INSERT OR IGNORE INTO hooks VALUES (?,?,?,?,?,?)').run(id,session.id,session.runtimeEpoch,event,encoded,at);return result.changes>0}
  hasHook(id:string){return !!this.db.prepare('SELECT 1 FROM hooks WHERE id=?').get(id)}
  append(session:Session,seq:number,data:string){const at=new Date().toISOString();return this.journal.appendFact({streamId:`session:${session.id}`,kind:'pty_output',runtimeOffset:session.runtimeOffset??1,at,payload:{seq,data,at,runtimeEpoch:session.runtimeEpoch}})}
  prune(){/* Journal history is permanent until an explicit user deletion. */}
  history(id:string,runtime:string,before=Number.MAX_SAFE_INTEGER,limit=100){
    const all=this.journal.eventsAfter(`session:${id}`,0,Number.MAX_SAFE_INTEGER).filter(event=>event.kind==='pty_output').map(event=>{const payload=event.payload as any;return {offset:event.offset,seq:Number.isSafeInteger(payload?.seq)?payload.seq:event.offset,data:String(payload?.data??''),at:String(payload?.at??event.at),runtimeEpoch:String(payload?.runtimeEpoch??event.runtimeOffset)}}).filter(entry=>entry.runtimeEpoch===runtime&&entry.seq<before);
    const page=all.slice(-limit),runs=[...new Map(this.journal.eventsAfter(`session:${id}`,0,Number.MAX_SAFE_INTEGER).filter(event=>event.kind==='pty_output').map(event=>{const payload=event.payload as any;return [String(payload?.runtimeEpoch??event.runtimeOffset),{runtimeEpoch:String(payload?.runtimeEpoch??event.runtimeOffset),createdAt:String(payload?.at??event.at)}]})).values()].reverse();
    return {entries:page,hasMore:all.length>page.length,truncated:false,runtimeEpoch:runtime,runs};
  }
  close(){this.db.close()}
}
