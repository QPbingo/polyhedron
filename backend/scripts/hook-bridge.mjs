#!/usr/bin/env node
// Standalone JavaScript: usable by both source/tsx and dist launches without a loader.
// Observational only. No stdout, decisions, transcript reads, or payload persistence.
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

const finish = () => process.exit(0);
const deadline = setTimeout(finish, 1500);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
const allowed = new Set(['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PostToolUseFailure','Stop','SessionEnd']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
let bytes = 0;
const chunks = [];
process.stdin.on('error', finish);
process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) finish(); chunks.push(chunk); });
process.stdin.on('end', () => {
  try {
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!raw || typeof raw !== 'object' || !allowed.has(raw.hook_event_name)) return finish();
    const sessionId = identifier(process.env.POLY_SESSION_ID);
    const runtimeEpoch = identifier(process.env.POLY_RUNTIME_EPOCH);
    const socketPath = process.env.POLY_HOOK_SOCKET;
    const token = process.env.POLY_HOOK_TOKEN;
    if (!sessionId || !runtimeEpoch || !socketPath?.startsWith('/') || !token || /[\r\n]/.test(token)) return finish();
    const payload = { sessionId, runtimeEpoch, event: raw.hook_event_name, nativeSessionId: identifier(raw.session_id), eventId: identifier(raw.event_id ?? raw.eventId) ?? randomUUID(), agentId: identifier(raw.agent_id), toolUseId: identifier(raw.tool_use_id), toolName: identifier(raw.tool_name), at: new Date().toISOString() };
    // Invalid child identifiers must not silently turn a child event into a parent event.
    if (raw.agent_id != null && !payload.agentId) return finish();
    const body = JSON.stringify(payload);
    const req = request({ socketPath, path: '/hook', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', finish); res.on('error', finish); });
    req.on('error', finish); req.setTimeout(1000, () => { req.destroy(); finish(); }); req.end(body);
  } catch { finish(); }
});
