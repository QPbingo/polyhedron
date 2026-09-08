import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { detectAgents } from './index.js';

const bridge = fileURLToPath(new URL('../../scripts/hook-bridge.mjs', import.meta.url));
let bridgeReadable = false;
try { await access(bridge, constants.R_OK); bridgeReadable = true; } catch { /* Included in report. */ }
const agents = await detectAgents();
console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version, nodeExecutable: process.execPath, hookBridge: { path: bridge, readable: bridgeReadable, deadlineMs: 1500 }, agents, notes: [
  'Detection executes only --version and --help, never a model prompt.',
  'Codex inline hooks may require native hook trust consent; no trust bypass is supplied.',
  'Native login, project trust, permissions, and terminal approval UI remain in the CLI.',
  'Hook availability is a capability probe, not proof of user consent or hook delivery.',
  'Resume requires a UUID captured from SessionStart; missing hooks leave native history unavailable.',
  'No CLI settings or launch agents are changed by this diagnostic.'
] }, null, 2));
process.exitCode = bridgeReadable && agents.some(a => a.available) ? 0 : 1;
