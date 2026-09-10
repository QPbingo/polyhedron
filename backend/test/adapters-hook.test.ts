import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bridge = resolve('scripts/hook-bridge.mjs');
function run(input: string, socket: string, end = true) {
  return new Promise<{ code: number|null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], { env: { ...process.env, POLY_HOOK_SOCKET: socket, POLY_HOOK_TOKEN: 'runtime-secret', POLY_SESSION_ID: 'session', POLY_RUNTIME_TOKEN: 'runtime-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d); child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.on('error', () => {}); if (end) child.stdin.end(input); else child.stdin.write(input);
  });
}
test('bridge authenticates Unix IPC and strips prompt, tool arguments, transcript, and output while retaining event identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ph-')); const socket = join(dir, 'h.sock');
  let received: any, auth: string|undefined, url: string|undefined;
  const server = createServer(async (req, res) => { let data=''; for await (const c of req) data += c; received = JSON.parse(data); auth = req.headers.authorization; url=req.url; res.end('{}'); });
  await new Promise<void>(r => server.listen(socket, r));
  try {
    const result = await run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'native-id', event_id: 'event-123', agent_id: 'child-1', tool_use_id: 'tool-123', tool_name: 'Bash', prompt: 'TOP SECRET', tool_input: {command:'SECRET'}, tool_response:'SECRET', transcript_path:'/private/secret' }), socket);
    assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(auth, 'Bearer runtime-secret'); assert.equal(url, '/hook');
    assert.deepEqual(Object.keys(received).sort(), ['agentId','at','event','eventId','nativeSessionId','runtimeToken','sessionId','toolName','toolUseId'].sort());
    assert.equal(received.eventId, 'event-123'); assert.equal(received.agentId, 'child-1'); assert.equal(received.toolUseId, 'tool-123'); assert.equal(received.nativeSessionId, 'native-id'); assert.equal(received.toolName, 'Bash');
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(dir, {recursive:true,force:true}); }
});
test('malformed and unsafe hooks never produce decisions or errors', async () => {
  for (const value of ['{', JSON.stringify({hook_event_name:'UnknownEvent', prompt:'secret'}), 'x'.repeat(300_000)]) {
    assert.deepEqual(await run(value, '/tmp/not-a-real-hook.sock'), { code:0, stdout:'', stderr:'' });
  }
});
test('hook deadline covers blocked stdin and unavailable IPC without blocking the agent', async () => {
  const start = Date.now(); const result = await run('{', '/tmp/no-hook.sock', false);
  assert.deepEqual(result, { code:0, stdout:'', stderr:'' }); assert.ok(Date.now() - start < 2000);
});
