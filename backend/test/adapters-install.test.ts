import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
test('launchagent generate writes only private reviewable plists with escaped paths and distinct host/connector jobs', async () => {
  const dir=await mkdtemp(join(tmpdir(),'poly-install-'));
  const backend=join(dir,'app & files'), output=join(dir,'generated'), config=join(dir,'user config.json');
  try {
    for (const part of ['host','connector']) { await mkdir(join(backend,'dist',part),{recursive:true}); await writeFile(join(backend,'dist',part,'main.js'),''); }
    const result=await exec(process.execPath,[resolve('scripts/launchagent.mjs'),'generate','--backend',backend,'--output',output,'--config',config]);
    assert.match(result.stdout,/No services were installed/);
    for (const part of ['host','connector']) {
      const path=join(output,`com.polyhedron.${part}.plist`), plist=await readFile(path,'utf8');
      assert.match(plist,/app &amp; files/); assert.ok(plist.includes(`/dist/${part}/main.js`));
      assert.ok(plist.includes(`<string>${config}</string>`)); assert.equal((await stat(path)).mode & 0o777,0o600);
      if (process.platform === 'darwin') assert.match((await exec('/usr/bin/plutil',['-lint',path])).stdout,/OK/);
    }
    await assert.rejects(stat(config),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
