// Explicit real-browser entry point for the isolated echo PTY fixture.
// It never targets a native Agent and only sends input when LIVE_PTY_TEST=1.
import {chromium,expect} from '@playwright/test';
const origin=process.env.LIVE_FRONTEND_URL||'http://127.0.0.1:15174',sessionId=process.env.LIVE_SESSION_ID,sessionTitle=process.env.LIVE_SESSION_TITLE||'真实 PTY 联调';
if(!sessionId||process.env.LIVE_PTY_TEST!=='1')throw new Error('Set LIVE_SESSION_ID and LIVE_PTY_TEST=1 for the isolated echo PTY fixture.');
const browser=await chromium.launch({channel:'chrome',headless:true}),contexts=[],errors=[],runId=Date.now(),firstMarker=`browser-one-${runId}`,secondMarker=`browser-two-${runId}`,blockedMarker=`must-stay-blocked-${runId}`;
async function open(){
 const context=await browser.newContext({viewport:{width:1280,height:800}});contexts.push(context);const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});await page.goto(origin);
 const login=page.getByRole('button',{name:'进入本机工作台'});await expect(login).toBeVisible();await login.click();await expect(page.getByRole('button',{name:'设置',exact:true})).toBeVisible();
 const trust=page.getByRole('dialog',{name:'确认执行主机身份'});if(await trust.isVisible().catch(()=>false)){await expect(trust.locator('.trust-fingerprint')).toHaveText(/^[A-Za-z0-9_-]{43}$/);await trust.getByRole('button',{name:'我已核对并信任此主机'}).click()}
 await expect(page.getByRole('button',{name:new RegExp(sessionTitle)})).toBeVisible();await page.getByRole('button',{name:new RegExp(sessionTitle)}).click();await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();return {context,page};
}
async function ensureDetails(page){if(await page.getByRole('button',{name:'会话详情',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'会话详情',exact:true}).click()}
async function claim(page){await ensureDetails(page);await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible()}
async function input(page,text){await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type(text,{delay:8});await page.keyboard.press('Enter')}
async function terminalContains(page,text){await expect(page.locator('.xterm-accessibility-tree')).toContainText(text,{timeout:8000})}
async function history(page){await ensureDetails(page);await page.getByRole('button',{name:'历史记录',exact:true}).click();return page.locator('.history-output')}
try{
 const first=await open();await claim(first.page);await input(first.page,firstMarker);await terminalContains(first.page,'ACK:'+firstMarker);
 const second=await open();await claim(second.page);await expect(first.page.getByRole('status').filter({hasText:'只读'})).toBeVisible();await input(first.page,blockedMarker);await input(second.page,secondMarker);await terminalContains(second.page,'ACK:'+secondMarker);
 let output=await history(second.page);await expect(output).toContainText(firstMarker);await expect(output).toContainText(secondMarker);await expect(output).not.toContainText(blockedMarker);await second.page.getByRole('button',{name:'关闭对话框'}).click();
 await first.context.close();await second.context.close();const restored=await open();output=await history(restored.page);await expect(output).toContainText(secondMarker);await expect(output).not.toContainText(blockedMarker);await restored.page.getByRole('button',{name:'关闭对话框'}).click();
 await restored.page.getByRole('button',{name:'设置',exact:true}).click();await restored.page.getByText('安全、CLI 与目录',{exact:true}).click();await expect(restored.page.getByText('端到端加密')).toBeVisible();await expect(restored.page.locator('.host-diagnostics .mono')).toBeVisible();await restored.page.getByRole('button',{name:'关闭对话框'}).click();
 expect(errors).toEqual([]);console.log(`PASS: encrypted two-browser takeover, readonly rejection, shared output/history, reconnect and Host fingerprint for ${sessionId}.`);
}finally{for(const context of contexts)await context.close().catch(()=>{});await browser.close()}
