import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,appendFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Fault,type Project,type Session,type Snapshot} from '../shared/types.js';
export class HostStore {
 readonly db:DatabaseSync;
 constructor(readonly dir:string,private quota=128*1024*1024,private days=30){
  mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);mkdirSync(join(dir,'logs'),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(join(dir,'host.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS snapshots(session_id TEXT,runtime TEXT,data TEXT NOT NULL,PRIMARY KEY(session_id,runtime));CREATE TABLE IF NOT EXISTS segments(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,runtime TEXT,file TEXT,size INTEGER DEFAULT 0,first_seq INTEGER,last_seq INTEGER,at TEXT);CREATE TABLE IF NOT EXISTS retention(session_id TEXT,runtime TEXT,truncated INTEGER DEFAULT 0,PRIMARY KEY(session_id,runtime));CREATE TABLE IF NOT EXISTS hooks(id TEXT PRIMARY KEY,session_id TEXT,runtime TEXT,event TEXT,native_id TEXT,at TEXT);`);
 }
 preferences(){const row=this.db.prepare('SELECT data FROM settings WHERE id=1').get() as any;return row?JSON.parse(row.data):{};}
 configure(settings:{preventSleep:boolean;historyDays:number;maxHistoryBytes:number}){this.db.prepare('INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings));this.days=settings.historyDays;this.quota=settings.maxHistoryBytes;}
 projects():Project[]{return (this.db.prepare('SELECT data FROM projects ORDER BY rowid').all() as any[]).map(x=>JSON.parse(x.data));}
 sessions():Session[]{return (this.db.prepare('SELECT data FROM sessions ORDER BY rowid DESC').all() as any[]).map(x=>JSON.parse(x.data));}
 saveProject(p:Project){this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(p.id,JSON.stringify(p));}
 deleteProject(id:string){this.db.prepare('DELETE FROM projects WHERE id=?').run(id);}
 saveSession(s:Session){this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(s.id,JSON.stringify(s));}
 saveSnapshot(snapshot:Snapshot){this.db.prepare('INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(session_id,runtime) DO UPDATE SET data=excluded.data').run(snapshot.session.id,snapshot.session.runtimeEpoch,JSON.stringify(snapshot));}
 snapshot(id:string,runtime:string):Snapshot|null{const row=this.db.prepare('SELECT data FROM snapshots WHERE session_id=? AND runtime=?').get(id,runtime) as any;if(!row)return null;try{return JSON.parse(row.data);}catch{throw new Fault('SNAPSHOT_CORRUPT','保存的终端快照已损坏，可查看历史记录或恢复原生会话');}}
 recordHook(id:string,s:Session,event:string,at:string,nativeId=s.nativeSessionId){const result=this.db.prepare('INSERT OR IGNORE INTO hooks VALUES (?,?,?,?,?,?)').run(id,s.id,s.runtimeEpoch,event,nativeId,at);return result.changes>0;}
 append(s:Session,seq:number,data:string){
  const at=new Date().toISOString(),line=JSON.stringify({seq,data,at})+'\n';
  let seg=this.db.prepare('SELECT * FROM segments WHERE session_id=? AND runtime=? ORDER BY id DESC LIMIT 1').get(s.id,s.runtimeEpoch) as any;
  if(!seg||seg.size+Buffer.byteLength(line)>1024*1024){const id=Number(this.db.prepare('INSERT INTO segments(session_id,runtime,file,first_seq,last_seq,at) VALUES (?,?,?,?,?,?)').run(s.id,s.runtimeEpoch,'',seq,seq,at).lastInsertRowid);seg={id,size:0,file:join(this.dir,'logs',id+'.jsonl')};this.db.prepare('UPDATE segments SET file=? WHERE id=?').run(seg.file,id);}
  appendFileSync(seg.file,line,{mode:0o600});this.db.prepare('UPDATE segments SET size=size+?,last_seq=? WHERE id=?').run(Buffer.byteLength(line),seq,seg.id);
  // Sweep on segment boundaries; active snapshots are stored separately and retained.
  if(seg.size===0)this.prune();
 }
 prune(){const rows=this.db.prepare('SELECT * FROM segments ORDER BY id').all() as any[];let total=rows.reduce((a,r)=>a+r.size,0);const expiry=Date.now()-this.days*86400000;for(const row of rows){if(total<=this.quota&&Date.parse(row.at)>=expiry)continue;try{if(existsSync(row.file))unlinkSync(row.file);this.db.prepare('INSERT INTO retention VALUES (?,?,1) ON CONFLICT(session_id,runtime) DO UPDATE SET truncated=1').run(row.session_id,row.runtime);this.db.prepare('DELETE FROM segments WHERE id=?').run(row.id);total-=row.size;}catch{/* Retained segment stays indexed if disk cleanup failed. */}}
  const sessions=this.sessions(),snapshots=this.db.prepare('SELECT session_id,runtime,LENGTH(data) AS size FROM snapshots ORDER BY rowid').all() as any[];
  total+=snapshots.reduce((n,r)=>n+r.size,0);
  for(const row of snapshots){const session=sessions.find(x=>x.id===row.session_id);if(session&&['running','starting'].includes(session.processState)&&session.runtimeEpoch===row.runtime)continue;if(total<=this.quota&&session&&Date.parse(session.updatedAt)>=expiry)continue;this.db.prepare('INSERT INTO retention VALUES (?,?,1) ON CONFLICT(session_id,runtime) DO UPDATE SET truncated=1').run(row.session_id,row.runtime);this.db.prepare('DELETE FROM snapshots WHERE session_id=? AND runtime=?').run(row.session_id,row.runtime);total-=row.size;}
  this.db.prepare('DELETE FROM hooks WHERE at<? OR rowid NOT IN (SELECT rowid FROM hooks ORDER BY rowid DESC LIMIT 10000)').run(new Date(expiry).toISOString());
 }
 history(id:string,runtime:string,before=Number.MAX_SAFE_INTEGER,limit=100){
  const rows=this.db.prepare('SELECT * FROM segments WHERE session_id=? AND runtime=? AND first_seq<? ORDER BY id DESC LIMIT 4').all(id,runtime,before) as any[];
  const entries:{seq:number;data:string;at:string}[]=[];let damaged=false;
  for(const row of rows){try{const parsed=readFileSync(row.file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));entries.unshift(...parsed.filter(e=>e.seq<before));}catch{damaged=true;}}
  const page=entries.slice(-limit);const first=this.db.prepare('SELECT MIN(first_seq) AS seq FROM segments WHERE session_id=? AND runtime=?').get(id,runtime) as any;
  return {entries:page,hasMore:page.length>0&&first.seq<page[0].seq,truncated:damaged||!!this.db.prepare('SELECT 1 FROM retention WHERE session_id=? AND runtime=? AND truncated=1').get(id,runtime)||(first.seq!==null&&first.seq>1),runtimeEpoch:runtime,runs:(this.db.prepare('SELECT runtime,MIN(at) AS createdAt FROM (SELECT runtime,at FROM segments WHERE session_id=? UNION ALL SELECT runtime,at FROM hooks WHERE session_id=?) GROUP BY runtime ORDER BY createdAt DESC').all(id,id) as any[]).map(r=>({runtimeEpoch:r.runtime,createdAt:r.createdAt}))};
 }
 close(){this.db.close();}
}
