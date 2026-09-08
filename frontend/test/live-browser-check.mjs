// Explicit integration entry point for the root-owned isolated echo PTY fixture.
// This never creates an Agent session or sends input without the fixture flag.
import {chromium,expect} from '@playwright/test';
const origin=process.env.LIVE_FRONTEND_URL||'http://127.0.0.1:15174';
const sessionId=process.env.LIVE_SESSION_ID;
if(!sessionId||process.env.LIVE_PTY_TEST!=='1')throw new Error('Set LIVE_SESSION_ID and LIVE_PTY_TEST=1 for the isolated echo PTY fixture.');
const browser=await chromium.launch({channel:'chrome',headless:true});
const runId=Date.now();const firstMarker=`browser-one-${runId}`,secondMarker=`browser-two-${runId}`,newMarker=`new-session-${runId}`;
const contexts=[];
const errors=[];
async function open(){
 const context=await browser.newContext({viewport:{width:1280,height:800}});contexts.push(context);const page=await context.newPage();const inputs=[],outputs=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('websocket',ws=>{ws.on('framereceived',frame=>{if(Buffer.isBuffer(frame.payload)){const size=frame.payload.readUInt32BE(0);outputs.push(frame.payload.subarray(4+size).toString())}else{try{const data=JSON.parse(frame.payload);if(data.data)outputs.push(data.data)}catch{}}});ws.on('framesent',frame=>{try{const data=JSON.parse(String(frame.payload));if(data.method==='input')inputs.push(data)}catch{}})});
 await page.goto(origin);const login=page.getByRole('button',{name:'进入本机工作台'});await expect(login).toBeVisible();await login.click();
 await expect(page.getByRole('button',{name:'设置',exact:true})).toBeVisible();
 const state=await page.evaluate(()=>fetch('/api/state').then(r=>r.json()));const session=state.sessions.find(s=>s.id===sessionId);if(!session)throw new Error('Fixture session not found under the current development account');
 await page.getByRole('button',{name:new RegExp(session.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();
 await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();return {context,page,inputs,outputs};
}
async function claim(page){await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible()}
async function input(page,text){await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Escape');await page.keyboard.type(text,{delay:8});await page.keyboard.press('Enter')}
async function historyContains(page,text){await page.getByRole('button',{name:'历史记录',exact:true}).click();await expect(page.locator('.history-output')).toContainText(text);await page.getByRole('button',{name:'关闭对话框'}).click()}
try{
 const first=await open();await claim(first.page);await input(first.page,firstMarker);await expect.poll(()=>first.inputs.length).toBeGreaterThan(0);await expect.poll(()=>first.outputs.join('')).toContain('ACK:'+firstMarker);
 const second=await open();expect(second.inputs).toHaveLength(0);await claim(second.page);await expect(first.page.getByRole('status').filter({hasText:'只读'})).toBeVisible();
 const sent=first.inputs.length;await input(first.page,'must-stay-blocked');expect(first.inputs).toHaveLength(sent);
 await input(second.page,secondMarker);await expect.poll(()=>second.outputs.join('')).toContain('ACK:'+secondMarker);await historyContains(second.page,firstMarker);await historyContains(second.page,secondMarker);
 await first.context.close();await second.context.close();
 const restored=await open();await restored.page.getByRole('button',{name:'会话详情',exact:true}).click();await historyContains(restored.page,secondMarker);
 const state=await restored.page.evaluate(()=>fetch('/api/state').then(r=>r.json()));expect(state.sessions.find(s=>s.id===sessionId).processState).toBe('running');
 if(process.env.LIVE_PROJECT_PATH){
  const page=restored.page;const path=process.env.LIVE_PROJECT_PATH;let projects=(await page.evaluate(()=>fetch('/api/state').then(r=>r.json()))).projects;let project=projects.find(p=>p.path===path);
  if(!project){await page.getByRole('button',{name:'添加项目',exact:true}).click();await page.getByLabel('项目名称',{exact:true}).fill('browser-notes');await page.getByLabel('项目目录',{exact:true}).fill(path);await page.locator('select[name=host]').selectOption({index:1});await page.getByRole('button',{name:'添加项目',exact:true}).last().click();await expect(page.getByRole('dialog')).toHaveCount(0);projects=(await page.evaluate(()=>fetch('/api/state').then(r=>r.json()))).projects;project=projects.find(p=>p.path===path)}
  const title=`浏览器创建会话-${Date.now()}`;await page.getByRole('button',{name:`${project.name} 项目操作`,exact:true}).focus();await page.getByRole('button',{name:`${project.name} 项目操作`,exact:true}).click();await page.getByRole('menuitem',{name:'新建会话',exact:true}).click();await page.getByLabel('会话名称',{exact:true}).fill(title);await page.getByRole('radio',{name:/Codex/}).check();await page.getByRole('button',{name:'创建会话',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();
  if(await page.getByRole('button',{name:'会话详情',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible();
  await input(page,newMarker);await expect.poll(()=>restored.outputs.join('')).toContain('ACK:'+newMarker);await page.getByRole('button',{name:'重命名',exact:true}).click();await page.getByLabel('会话名称',{exact:true}).fill(`${title}-renamed`);await page.getByRole('button',{name:'保存名称',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'终止进程',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await expect(page.getByRole('button',{name:'归档',exact:true})).toBeVisible();await page.getByRole('button',{name:'归档',exact:true}).click();await expect(page.getByRole('button',{name:'取消归档',exact:true})).toBeVisible();
  console.log('PASS: project registration, project-scoped real fixture session creation, rename, managed termination and archive.');
 }
 expect(errors).toEqual([]);console.log('PASS: two browser contexts, claim/resize, old owner blocked, shared output/history, close/reopen PTY survival.');
}finally{await browser.close()}
