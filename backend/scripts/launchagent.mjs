#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const [action = 'help', ...argv] = process.argv.slice(2);
const opts = {};
for (let i=0; i<argv.length; i+=2) { if (!argv[i]?.startsWith('--') || !argv[i+1]) throw new Error('Expected --option value'); opts[argv[i].slice(2)] = argv[i+1]; }
const labels = ['com.polyhedron.host', 'com.polyhedron.connector'];
const backend = resolve(opts.backend ?? fileURLToPath(new URL('..', import.meta.url)));
const node = opts.node ?? process.execPath;
const config = opts.config ?? join(homedir(), '.config/polyhedron/host.json');
const out = resolve(opts.output ?? join(backend, '.data/launchagents'));
const installed = join(homedir(), 'Library/LaunchAgents');
const xml = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const launchctl = (...args) => execFileSync('/bin/launchctl', args, {stdio:'inherit'});

async function generate() {
  if (![backend, node, config].every(isAbsolute)) throw new Error('Backend, node, and config must be absolute paths');
  await access(node);
  for (const service of ['host','connector']) await access(join(backend, `dist/${service}/main.js`));
  await mkdir(out, {recursive:true,mode:0o700});
  const logs = join(dirname(config), 'logs');
  // The generated jobs inherit no secrets; both resolve credentials using the protected config.
  for (let i=0;i<labels.length;i++) {
    const service = i === 0 ? 'host' : 'connector';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${labels[i]}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(backend, `dist/${service}/main.js`))}</string><string>--config</string><string>${xml(config)}</string></array>
<key>WorkingDirectory</key><string>${xml(backend)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([dirname(node),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin',join(homedir(),'.local/bin')].join(':'))}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, `${service}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, `${service}.error.log`))}</string>
</dict></plist>\n`;
    await writeFile(join(out, `${labels[i]}.plist`), plist, {mode:0o600});
    await chmod(join(out, `${labels[i]}.plist`), 0o600);
  }
  return logs;
}
if (action === 'generate') {
  await generate(); console.log(`Generated two plists in ${out}. No services were installed.`);
} else if (action === 'install') {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Install as the logged-in macOS user, without sudo');
  await access(config);
  const logs = await generate();
  await mkdir(logs, {recursive:true,mode:0o700}); await chmod(logs, 0o700);
  await mkdir(installed, {recursive:true});
  for (const label of labels) {
    const target = join(installed, `${label}.plist`);
    try { await access(target); throw new Error(`Existing service ${label}; explicitly uninstall it before replacing`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const label of labels) { const target = join(installed, `${label}.plist`); await copyFile(join(out, `${label}.plist`), target); await chmod(target,0o600); launchctl('bootstrap', `gui/${process.getuid()}`, target); }
  console.log('Installed host and connector for this user. The relay is managed separately.');
} else if (action === 'uninstall') {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Uninstall as the logged-in macOS user, without sudo');
  // Explicit uninstall stops managed PTYs through host shutdown; data and credentials remain.
  for (const label of [...labels].reverse()) {
    const target = join(installed, `${label}.plist`);
    try { await readFile(target); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    launchctl('bootout', `gui/${process.getuid()}`, target); await rm(target);
  }
  console.log('Removed this user’s services. Session data and Keychain entries were retained.');
} else {
  console.log('Usage: node scripts/launchagent.mjs generate|install|uninstall [--config ABS_PATH] [--backend ABS_PATH] [--node ABS_PATH] [--output ABS_PATH]\nGenerate is reversible and does not install. Install/uninstall explicitly change per-user services.');
  if (action !== 'help') process.exitCode = 1;
}
