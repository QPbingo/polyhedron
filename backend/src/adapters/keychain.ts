import {spawn,spawnSync} from 'node:child_process';

export const JOURNAL_HEALTHY='UE9MWUhFRFJPTjpIRUFMVEhZOlYxISEh';
export const JOURNAL_FAILED='UE9MWUhFRFJPTjpGQUlMRUQ6VjEhISEh';

function validate(service: string, account: string): void {
  if (![service, account].every(v => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(v))) throw new Error('Invalid Keychain identifier');
}
function platform(): void { if (process.platform !== 'darwin') throw new Error('macOS Keychain is unavailable on this platform'); }
function security(args: string[], input?: string): Promise<string> {
  platform();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output.trim()); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Keychain access timed out; unlock the login Keychain and retry')); }, 10_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 16_384) { child.kill(); finish(new Error('Invalid Keychain response')); } else output += chunk; });
    // Never reflect security's command echo/errors: they can contain a credential supplied on stdin.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Could not execute macOS Keychain helper')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('Keychain operation failed; item may be missing, locked, or access denied')));
    child.stdin.end(input);
  });
}
export async function readHostToken(service: string, account: string): Promise<string> {
  validate(service, account);
  const token = await security(['find-generic-password','-s',service,'-a',account,'-w']);
  if (!/^[A-Za-z0-9_+./=-]{32,4096}$/.test(token)) throw new Error('Invalid host token in Keychain');
  return token;
}
export async function storeHostToken(service: string, account: string, token: string): Promise<void> {
  validate(service, account);
  if (!/^[A-Za-z0-9_+./=-]{32,4096}$/.test(token)) throw new Error('Invalid host token');
  // -i accepts commands through stdin, keeping the token out of the process argument list.
  // All values are restricted above to characters with no interactive parser metacharacters.
  await security(['-i'], `add-generic-password -U -s ${service} -a ${account} -w ${token}\n`);
  // Interactive security may exit successfully after an individual command failed.
  if (await readHostToken(service, account) !== token) throw new Error('Keychain credential verification failed');
}
export async function deleteHostToken(service: string, account: string): Promise<void> {
  validate(service, account);
  await security(['delete-generic-password','-s',service,'-a',account]);
}

export function storeJournalHealthSync(service:string,account:string,failed:boolean):void{
  validate(service,account);platform();const value=failed?JOURNAL_FAILED:JOURNAL_HEALTHY,result=spawnSync('/usr/bin/security',['-i'],{input:`add-generic-password -U -s ${service} -a ${account} -w ${value}\n`,encoding:'utf8',timeout:10_000,maxBuffer:16_384});
  if(result.error||result.status!==0)throw new Error('Keychain journal-health update failed');const verified=spawnSync('/usr/bin/security',['find-generic-password','-s',service,'-a',account,'-w'],{encoding:'utf8',timeout:10_000,maxBuffer:16_384});if(verified.error||verified.status!==0||verified.stdout.trim()!==value)throw new Error('Keychain journal-health verification failed');
}
