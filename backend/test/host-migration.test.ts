import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostStore} from '../src/host/store.js';

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
  assert.equal(store.history('s1','runtime-1').entries[0].data,'LEGACY SECRET OUTPUT');
  assert.equal(readFileSync(file,'utf8'),content);
  store.close();
  const persisted=readFileSync(join(dir,'host.sqlite')).toString('latin1');
  assert.doesNotMatch(persisted,/Secret Project|private\/secret|Secret Session|LEGACY SECRET OUTPUT/);
});

test('legacy journal migration rejects corruption without deleting or rewriting source data',()=>{
  const {file,content,options}=legacy(true);
  assert.throws(()=>new HostStore(options),/legacy|旧版|JSON/i);
  assert.equal(readFileSync(file,'utf8'),content);
  const db=new DatabaseSync(join(options.dir,'host.sqlite'));
  const count=(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='journal_events'").get() as any).count;
  if(count)assert.equal((db.prepare('SELECT COUNT(*) AS count FROM journal_events').get() as any).count,0);
  db.close();
});
