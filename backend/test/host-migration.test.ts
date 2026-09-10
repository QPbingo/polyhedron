import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostStore} from '../src/host/store.js';
import type {JournalFaultPoint} from '../src/host/journal.js';

const dirs:string[]=[];
test.after(()=>dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
function legacy(corrupt=false){
  const dir=mkdtempSync(join(tmpdir(),'poly-migrate-'));dirs.push(dir);mkdirSync(join(dir,'logs'));
  const db=new DatabaseSync(join(dir,'host.sqlite'));
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE segments(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,runtime TEXT,file TEXT,size INTEGER DEFAULT 0,first_seq INTEGER,last_seq INTEGER,at TEXT);');
  const project={id:'p1',hostId:'host-a',name:'Secret Project',path:'/private/secret/project',createdAt:'2026-01-01T00:00:00.000Z'};
  const session={id:'s1',hostId:'host-a',projectId:'p1',title:'Secret Session',agent:'codex',processState:'exited',activity:'done',runtimeEpoch:'runtime-1',nativeSessionId:null,controlEpoch:1,controller:null,cols:80,rows:24,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:01.000Z',archived:false};
  db.prepare('INSERT INTO projects VALUES (?,?)').run(project.id,JSON.stringify(project));db.prepare('INSERT INTO sessions VALUES (?,?)').run(session.id,JSON.stringify(session));
  const file=join(dir,'logs','1.jsonl'),content=corrupt?'{bad json\n':JSON.stringify({seq:1,data:'LEGACY SECRET OUTPUT',at:'2026-01-01T00:00:01.000Z'})+'\n';writeFileSync(file,content);
  db.prepare('INSERT INTO segments(session_id,runtime,file,size,first_seq,last_seq,at) VALUES (?,?,?,?,?,?,?)').run('s1','runtime-1',file,Buffer.byteLength(content),1,1,'2026-01-01T00:00:01.000Z');db.close();
  return {dir,file,content,options:{dir,secret:'migration-secret-at-least-32-chars',hostId:'host-a'}};
}

test('legacy journal migration imports output, encrypts domain rows and retains source files',()=>{
  const {dir,file,content,options}=legacy();const store=new HostStore(options);
  assert.equal(store.projects()[0].path,'/private/secret/project');
  assert.equal(store.sessions()[0].title,'Secret Session');
  const events=store.journal.eventsAfter('session:s1',0),runtime=events.find(event=>event.kind==='legacy_runtime_started')!.offset;
  assert.equal(store.history('s1',runtime).entries[0].data,'LEGACY SECRET OUTPUT');
  assert.equal(events.find(event=>event.kind==='pty_output')!.runtimeOffset,runtime);
  assert.equal(events.some(event=>event.kind==='legacy_imported'),true);
  assert.equal(readFileSync(file,'utf8'),content);
  store.close();
  const persisted=readFileSync(join(dir,'host.sqlite')).toString('latin1');
  assert.doesNotMatch(persisted,/Secret Project|private\/secret|Secret Session|LEGACY SECRET OUTPUT/);
});

test('a crash after domain encryption commit resumes the pending physical scrub',()=>{
  const dir=mkdtempSync(join(tmpdir(),'poly-domain-scrub-')),options={dir,secret:'migration-secret-at-least-32-chars',hostId:'host-a'},sentinel='PRIVATE_DOMAIN_SENTINEL';dirs.push(dir);let store=new HostStore(options);store.close();
  let db=new DatabaseSync(join(dir,'host.sqlite'));db.prepare('INSERT INTO projects VALUES (?,?)').run('p-private',JSON.stringify({id:'p-private',hostId:'host-a',name:sentinel,path:`/private/${sentinel}`,createdAt:'2026-01-01T00:00:00.000Z'}));db.close();
  const faults={point:'privacy.hostBeforeScrub' as JournalFaultPoint|null,hit(point:JournalFaultPoint){if(this.point===point){this.point=null;throw new Error(`injected ${point}`)}}};assert.throws(()=>new HostStore({...options,faults}),/privacy\.hostBeforeScrub/);
  db=new DatabaseSync(join(dir,'host.sqlite'));assert.equal((db.prepare("SELECT value FROM host_meta WHERE key='privacy_scrub_pending'").get() as any).value,'1');assert.match((db.prepare("SELECT data FROM projects WHERE id='p-private'").get() as any).data,/^enc:v1:/);db.close();
  store=new HostStore(options);assert.equal(store.db.prepare("SELECT 1 FROM host_meta WHERE key='privacy_scrub_pending'").get(),undefined);assert.equal(store.projects()[0].name,sentinel);store.close();assert.doesNotMatch(readFileSync(join(dir,'host.sqlite')).toString('latin1'),new RegExp(sentinel));
});

test('domain privacy scrub stays pending while a reader prevents WAL truncation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'poly-domain-busy-')),options={dir,secret:'migration-secret-at-least-32-chars',hostId:'host-a'},sentinel='PRIVATE_BUSY_DOMAIN';dirs.push(dir);let store=new HostStore(options);store.close();let db=new DatabaseSync(join(dir,'host.sqlite'));db.prepare('INSERT INTO projects VALUES (?,?)').run('p-private',JSON.stringify({id:'p-private',hostId:'host-a',name:sentinel,path:`/private/${sentinel}`,createdAt:'2026-01-01T00:00:00.000Z'}));db.close();
  const reader=new DatabaseSync(join(dir,'host.sqlite'));reader.exec('BEGIN');reader.prepare("SELECT data FROM projects WHERE id='p-private'").get();try{assert.throws(()=>new HostStore(options),/privacy|scrub|checkpoint|WAL|busy/i)}finally{reader.exec('ROLLBACK');reader.close()}
  db=new DatabaseSync(join(dir,'host.sqlite'));assert.equal((db.prepare("SELECT value FROM host_meta WHERE key='privacy_scrub_pending'").get() as any).value,'1');db.close();store=new HostStore(options);assert.equal(store.db.prepare("SELECT 1 FROM host_meta WHERE key='privacy_scrub_pending'").get(),undefined);store.close();assert.doesNotMatch(readFileSync(join(dir,'host.sqlite')).toString('latin1'),new RegExp(sentinel));
});

test('multi-runtime legacy projection keeps the selected runtime across later opens',()=>{
  const {dir,options}=legacy(),file=join(dir,'logs','2.jsonl'),content=JSON.stringify({seq:1,data:'SECOND RUNTIME',at:'2026-01-02T00:00:01.000Z'})+'\n';writeFileSync(file,content);
  const db=new DatabaseSync(join(dir,'host.sqlite'));db.prepare('INSERT INTO segments(session_id,runtime,file,size,first_seq,last_seq,at) VALUES (?,?,?,?,?,?,?)').run('s1','runtime-2',file,Buffer.byteLength(content),1,1,'2026-01-02T00:00:01.000Z');db.close();
  let store=new HostStore(options),events=store.journal.eventsAfter('session:s1',0),first=events.find(event=>event.kind==='legacy_runtime_started'&&(event.payload as any).legacyRuntime==='runtime-1')!.offset,second=events.find(event=>event.kind==='legacy_runtime_started'&&(event.payload as any).legacyRuntime==='runtime-2')!.offset;
  assert.notEqual(first,second);assert.equal(store.sessions()[0].runtimeOffset,first);store.close();
  store=new HostStore(options);assert.equal(store.sessions()[0].runtimeOffset,first);assert.equal(store.history('s1',first).entries[0].data,'LEGACY SECRET OUTPUT');assert.equal(store.history('s1',second).entries[0].data,'SECOND RUNTIME');store.close();
});

test('snapshot presence does not replace known chronological runtime ordering',()=>{
  const {dir,options}=legacy(),file=join(dir,'logs','2.jsonl'),content=JSON.stringify({seq:1,data:'LATER',at:'2026-01-02T00:00:01.000Z'})+'\n',db=new DatabaseSync(join(dir,'host.sqlite')),session=JSON.parse((db.prepare("SELECT data FROM sessions WHERE id='s1'").get() as any).data);writeFileSync(file,content);db.exec('CREATE TABLE snapshots(session_id TEXT,runtime TEXT,data TEXT NOT NULL,PRIMARY KEY(session_id,runtime));');db.prepare('INSERT INTO segments(session_id,runtime,file,size,first_seq,last_seq,at) VALUES (?,?,?,?,?,?,?)').run('s1','aaa-runtime',file,Buffer.byteLength(content),1,1,'2026-01-02T00:00:01.000Z');db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run('s1','runtime-1',JSON.stringify({session,seq:1,data:'EARLY',cols:80,rows:24}));db.close();
  const store=new HostStore(options),boundaries=store.journal.eventsAfter('session:s1',0).filter(event=>event.kind==='legacy_runtime_started');assert.deepEqual(boundaries.map(event=>(event.payload as any).legacyRuntime),['runtime-1','aaa-runtime']);store.close();
});

test('legacy migration rejects source rows that reference a missing session',()=>{
  const {dir,options}=legacy(),file=join(dir,'logs','orphan.jsonl'),content=JSON.stringify({seq:1,data:'ORPHAN',at:'2026-01-03T00:00:00.000Z'})+'\n',db=new DatabaseSync(join(dir,'host.sqlite'));writeFileSync(file,content);db.prepare('INSERT INTO segments(session_id,runtime,file,size,first_seq,last_seq,at) VALUES (?,?,?,?,?,?,?)').run('missing','orphan-runtime',file,Buffer.byteLength(content),1,1,'2026-01-03T00:00:00.000Z');db.close();assert.throws(()=>new HostStore(options),/不存在的会话|missing/);
});

test('snapshot-only and hook-only legacy runtimes remain reachable and encrypted',()=>{
  const {dir,file,options}=legacy(),db=new DatabaseSync(join(dir,'host.sqlite')),session=JSON.parse((db.prepare("SELECT data FROM sessions WHERE id='s1'").get() as any).data),nativeId='12345678-1234-4234-8234-123456789abc';
  db.exec('CREATE TABLE snapshots(session_id TEXT,runtime TEXT,data TEXT NOT NULL,PRIMARY KEY(session_id,runtime));CREATE TABLE hooks(id TEXT PRIMARY KEY,session_id TEXT,runtime TEXT,event TEXT,native_id TEXT,at TEXT);');db.prepare('DELETE FROM segments').run();db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run('s1','runtime-1',JSON.stringify({session,seq:0,data:'SNAPSHOT ONLY',cols:91,rows:27}));db.prepare('INSERT INTO hooks VALUES (?,?,?,?,?,?)').run('legacy-hook','s1','runtime-2','SessionStart',nativeId,'2026-01-02T00:00:00.000Z');db.close();rmSync(file);
  let store=new HostStore({...options,secret:'new-master-secret-at-least-32-chars',legacySecret:options.secret}),events=store.journal.eventsAfter('session:s1',0),first=events.find(event=>event.kind==='legacy_runtime_started'&&(event.payload as any).legacyRuntime==='runtime-1')!.offset,second=events.find(event=>event.kind==='legacy_runtime_started'&&(event.payload as any).legacyRuntime==='runtime-2')!.offset;
  assert.equal(store.sessions()[0].runtimeOffset,first);assert.equal(store.offsetSnapshot('s1',first)?.data,'SNAPSHOT ONLY');assert.equal(store.offsetSnapshot('s1',first)?.baseOffset,first);assert.equal((store.db.prepare("SELECT runtime FROM hooks WHERE id='legacy-hook'").get() as any).runtime,String(second));assert.equal(events.some(event=>event.actor==='legacy-hook'&&event.runtimeOffset===second),true);store.close();
  assert.doesNotMatch(readFileSync(join(dir,'host.sqlite')).toString('latin1'),new RegExp(nativeId));store=new HostStore({...options,secret:'new-master-secret-at-least-32-chars'});assert.equal(store.sessions()[0].runtimeOffset,first);assert.equal(store.offsetSnapshot('s1',first)?.data,'SNAPSHOT ONLY');store.close();
});

test('explicit migrated-session deletion removes legacy rows and source files',()=>{
  const {file,options}=legacy();let store=new HostStore(options);store.db.exec('BEGIN IMMEDIATE');try{store.deleteSessionWithin('s1');store.db.exec('COMMIT')}catch(error){store.db.exec('ROLLBACK');throw error}
  assert.equal(exists(file),true);assert.equal((store.db.prepare('SELECT COUNT(*) count FROM pending_file_deletions').get() as any).count,1);store.close();
  store=new HostStore(options);assert.equal(exists(file),false);for(const table of ['sessions','segments','legacy_runtime_map','snapshots','hooks','retention','pending_file_deletions'])assert.equal((store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as any).count,0);assert.equal(store.journal.eventsAfter('session:s1',0).length,0);store.close();
});

test('pending file cleanup completes after a crash between unlink and cleanup-record commit',()=>{
  const {file,options}=legacy(),cleanupFaults={active:true,hit(){if(this.active){this.active=false;throw new Error('crash after unlink')}}};let store=new HostStore({...options,cleanupFaults});store.db.exec('BEGIN IMMEDIATE');try{store.deleteSessionWithin('s1');store.db.exec('COMMIT')}catch(error){store.db.exec('ROLLBACK');throw error}store.cleanupPendingFiles();assert.equal(exists(file),false);assert.equal((store.db.prepare('SELECT COUNT(*) count FROM pending_file_deletions').get() as any).count,1);store.close();
  store=new HostStore({...options,cleanupFaults});assert.equal((store.db.prepare('SELECT COUNT(*) count FROM pending_file_deletions').get() as any).count,0);store.close();
});

function exists(path:string){try{readFileSync(path);return true}catch{return false}}

test('legacy journal migration rejects corruption without deleting or rewriting source data',()=>{
  const {file,content,options}=legacy(true),beforeDb=new DatabaseSync(join(options.dir,'host.sqlite')),before={project:(beforeDb.prepare('SELECT data FROM projects').get() as any).data,session:(beforeDb.prepare('SELECT data FROM sessions').get() as any).data,segment:beforeDb.prepare('SELECT * FROM segments').get()};beforeDb.close();
  assert.throws(()=>new HostStore({...options,secret:'replacement-master-secret-at-least-32',legacySecret:options.secret}),/legacy|旧版|JSON/i);
  assert.equal(readFileSync(file,'utf8'),content);
  const db=new DatabaseSync(join(options.dir,'host.sqlite'));
  assert.equal((db.prepare('SELECT data FROM projects').get() as any).data,before.project);assert.equal((db.prepare('SELECT data FROM sessions').get() as any).data,before.session);assert.deepEqual(db.prepare('SELECT * FROM segments').get(),before.segment);
  const count=(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='journal_events'").get() as any).count;
  if(count)assert.equal((db.prepare('SELECT COUNT(*) AS count FROM journal_events').get() as any).count,0);
  db.close();
});
