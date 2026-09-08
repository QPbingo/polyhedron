import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Agent = 'codex' | 'claude';
export type AgentInfo = { id: Agent; name: string; path: string | null; version: string | null; available: boolean; reason?: string; hooks?: boolean };
export type LaunchOptions = { agent: Agent; cwd: string; nativeSessionId?: string | null; sessionId: string; runtimeEpoch: string; hookToken: string; hookSocket: string; dataDir: string };
const exec = promisify(execFile);
const bridgePath = fileURLToPath(new URL('../../scripts/hook-bridge.mjs', import.meta.url));
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

async function locate(agent: Agent): Promise<string | null> {
  const override = process.env[`POLY_${agent.toUpperCase()}_PATH`];
  const paths = override ? [override] : [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`].map(dir => join(dir, agent));
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch { /* Try next executable. */ }
  }
  return null;
}
function supported(agent: Agent, version: string): boolean {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  // Refuse unknown major lines. These are the minimum versions checked against native help.
  return agent === 'codex' ? major === 0 && (minor > 153 || (minor === 153 && patch >= 4)) : major === 2 && (minor > 1 || (minor === 1 && patch >= 236));
}
async function detect(agent: Agent): Promise<AgentInfo> {
  const info: AgentInfo = { id: agent, name: agent === 'codex' ? 'Codex' : 'Claude Code', path: await locate(agent), version: null, available: false, hooks: false };
  if (!info.path) return { ...info, reason: `${info.name} executable not found; install the native CLI or set POLY_${agent.toUpperCase()}_PATH.` };
  try {
    const { stdout } = await exec(info.path, ['--version'], { timeout: 2500, maxBuffer: 32_768 });
    info.version = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
    if (!info.version || !supported(agent, info.version)) return { ...info, reason: `Unsupported ${info.name} version ${info.version ?? 'unknown'}; requires ${agent === 'codex' ? '0.153.4+ in 0.x' : '2.1.236+ in 2.x'}.` };
    const { stdout: help } = await exec(info.path, ['--help'], { timeout: 2500, maxBuffer: 65_536 });
    if (!help.includes(agent === 'codex' ? '--config' : '--settings')) return { ...info, reason: `${info.name} is missing required interactive configuration flags.` };
    return { ...info, available: true, hooks: true };
  } catch { return { ...info, reason: `${info.name} executable failed the bounded version/help check.` }; }
}
export async function detectAgents(): Promise<AgentInfo[]> { return Promise.all([detect('codex'), detect('claude')]); }
export async function buildLaunch(options: LaunchOptions): Promise<{ file: string; args: string[]; env: Record<string, string> }> {
  if (!['codex', 'claude'].includes(options.agent)) throw new Error('Unsupported agent');
  if (options.nativeSessionId !== undefined && options.nativeSessionId !== null && !uuid.test(options.nativeSessionId)) throw new Error('Native session ID must be an exact captured UUID');
  if (!isAbsolute(options.cwd) || !isAbsolute(options.hookSocket) || !isAbsolute(options.dataDir)) throw new Error('Launch paths must be absolute');
  if (![options.sessionId, options.runtimeEpoch, options.hookToken].every(s => s && !/[\x00-\x1f]/.test(s))) throw new Error('Invalid runtime hook context');
  const info = await detect(options.agent);
  if (!info.available || !info.path) throw new Error(info.reason ?? 'CLI unavailable');
  await access(bridgePath, constants.R_OK);
  const command = `${quote(process.execPath)} ${quote(bridgePath)}`;
  const args: string[] = [];
  if (options.agent === 'codex') {
    if (options.nativeSessionId) args.push('resume', options.nativeSessionId);
    args.push('--cd', options.cwd);
    for (const event of events) args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=2}]}]`);
  } else {
    if (options.nativeSessionId) args.push('--resume', options.nativeSessionId);
    const hooks = Object.fromEntries([...events, 'PostToolUseFailure'].map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]]));
    args.push('--settings', JSON.stringify({ hooks }));
  }
  return { file: info.path, args, env: { POLY_SESSION_ID: options.sessionId, POLY_RUNTIME_EPOCH: options.runtimeEpoch, POLY_HOOK_TOKEN: options.hookToken, POLY_HOOK_SOCKET: options.hookSocket } };
}
