import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLaunch, detectAgents } from '../src/adapters/index.js';

const nativeId = 'c55d669d-c03e-4f67-8900-5518ce7b585d';
const base = { cwd: '/tmp/project', sessionId: 'our-session', runtimeToken: 'runtime-token', hookToken: 'secret-hook-token', hookSocket: '/tmp/host.sock', dataDir: '/tmp/data' };
// Fake only the installed vendor executable: these tests must never make a paid model call.
async function fakeCli(name: string, version: string, fn: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'poly-adapter-'));
  const old = process.env.PATH;
  const override = process.env[`POLY_${name.toUpperCase()}_PATH`];
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\ncase "$1" in\n--version) echo '${version}' ;;\n--help) echo '--config --settings --resume' ;;\n*) exit 23 ;;\nesac\n`);
  await chmod(file, 0o700);
  process.env[`POLY_${name.toUpperCase()}_PATH`] = file;
  try { await fn(); } finally { process.env.PATH = old; if (override === undefined) delete process.env[`POLY_${name.toUpperCase()}_PATH`]; else process.env[`POLY_${name.toUpperCase()}_PATH`] = override; await rm(dir, { recursive: true, force: true }); }
}

test('codex resumes only the exact captured UUID and injects hooks without credentials in arguments', async () => {
  await fakeCli('codex', 'codex-cli 0.153.4', async () => {
    const launch = await buildLaunch({ ...base, agent: 'codex', nativeSessionId: nativeId });
    assert.deepEqual(launch.args.slice(0, 2), ['resume', nativeId]);
    assert.equal(launch.args.includes('--last'), false);
    assert.equal(launch.args.some(a => /bypass|yolo|secret-hook-token/.test(a)), false);
    assert.equal(launch.env.POLY_HOOK_TOKEN, 'secret-hook-token');
    assert.equal(launch.env.POLY_RUNTIME_TOKEN, 'runtime-token');
    assert.ok(launch.args.some(a => a.startsWith('hooks.SessionStart=')));
    assert.ok(launch.args.some(a => a.startsWith('hooks.PermissionRequest=')));
  });
});
test('claude settings preserve default native permissions and configure silent bounded lifecycle hooks', async () => {
  await fakeCli('claude', '2.1.236 (Claude Code)', async () => {
    const launch = await buildLaunch({ ...base, agent: 'claude', nativeSessionId: nativeId });
    assert.deepEqual(launch.args.slice(0, 2), ['--resume', nativeId]);
    const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]!);
    assert.equal(settings.permissionMode, undefined);
    assert.equal(launch.args.includes('--print'), false);
    for (const groups of Object.values(settings.hooks) as any[]) for (const group of groups) for (const hook of group.hooks) {
      assert.equal(hook.type, 'command'); assert.ok(hook.timeout <= 2); assert.ok(hook.command.includes('hook-bridge.mjs'));
    }
  });
});
test('refuses ambiguous resume targets and unverified old CLIs', async () => {
  await assert.rejects(buildLaunch({ ...base, agent: 'codex', nativeSessionId: '--last' }), /session.*UUID/i);
  await fakeCli('codex', 'codex-cli 0.90.0', async () => {
    const info = (await detectAgents()).find(a => a.id === 'codex')!;
    assert.equal(info.available, false); assert.match(info.reason!, /version/i);
    await assert.rejects(buildLaunch({ ...base, agent: 'codex' }), /version/i);
  });
});
test('an explicit missing executable never silently falls back to a different installation', async () => {
  const old = process.env.POLY_CODEX_PATH;
  process.env.POLY_CODEX_PATH = '/tmp/poly-no-such-cli';
  try { await assert.rejects(buildLaunch({ ...base, agent: 'codex' }), /not found|executable/i); }
  finally { if (old === undefined) delete process.env.POLY_CODEX_PATH; else process.env.POLY_CODEX_PATH = old; }
});
test('codex versions below the verified patch are refused', async () => {
  await fakeCli('codex', 'codex-cli 0.153.0', async () => {
    await assert.rejects(buildLaunch({ ...base, agent: 'codex' }), /version/i);
  });
});
