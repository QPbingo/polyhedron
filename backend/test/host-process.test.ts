import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {writePrivateJson} from '../src/host/config.js';

test('a real Host process restarts after SIGKILL using its stale PID record',async()=>{const dir=mkdtempSync(join(tmpdir(),'poly-host-process-')),root=join(dir,'root'),configPath=join(dir,'host.json');mkdirSync(root);writePrivateJson(configPath,{hostId:randomUUID(),accountId:'account',hostToken:randomBytes(32).toString('hex'),masterKey:randomBytes(32).toString('base64url'),ipcToken:randomBytes(32).toString('hex'),relayUrl:'ws://127.0.0.1:1/ws/host',name:'Process test',roots:[root],dataDir:join(dir,'data')});let child:ChildProcess|undefined;
 const start=async()=>{const spawned=spawn(process.execPath,['--import','tsx','src/host/main.ts','--config',configPath],{cwd:resolve('.'),stdio:['ignore','pipe','pipe']});let output='';spawned.stdout!.on('data',chunk=>{output+=chunk});spawned.stderr!.on('data',chunk=>{output+=chunk});const end=Date.now()+10000;while(!output.includes('本地会话执行服务已就绪')){if(spawned.exitCode!==null)throw new Error(`Host exited early: ${output}`);if(Date.now()>end)throw new Error(`Host start timed out: ${output}`);await new Promise(resolve=>setTimeout(resolve,20))}return spawned};
 try{child=await start();const firstPid=child.pid!;child.kill('SIGKILL');await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child=await start();assert.notEqual(child.pid,firstPid);child.kill('SIGTERM');await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child=undefined}finally{child?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}});
