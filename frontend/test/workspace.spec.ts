import {test,expect,type Page} from '@playwright/test';
const session={id:'s1',hostId:'h1',projectId:'p1',title:'真实终端测试',agent:'codex',processState:'running',activity:'idle',runtimeEpoch:'runtime-1',nativeSessionId:null,controlEpoch:0,controller:null,cols:90,rows:30,createdAt:'2026-09-08T10:00:00Z',updatedAt:'2026-09-08T10:00:00Z',archived:false};
const project={id:'p1',hostId:'h1',name:'example',path:'/Users/test/Projects/example',createdAt:session.createdAt};
const host={id:'h1',name:'测试主机',online:true,platform:'darwin',roots:['/Users/test/Projects'],agents:[{id:'codex',name:'Codex',available:true,path:'/usr/bin/codex',version:'test'},{id:'claude',name:'Claude Code',available:false,path:null,version:null,reason:'尚未安装'}]};
async function setup(page:Page){
 let state={...session};let clientId='';const calls:{method:string;params:any}[]=[];let socket:any;
 await page.route('**/api/auth',r=>r.fulfill({json:{authenticated:true,user:{id:'u1',name:'测试用户'},csrfToken:'csrf-test',mode:'development'}}));
 await page.route('**/api/browsers',r=>r.fulfill({json:{browsers:[{id:'current-login',createdAt:1788900000000,expiresAt:1789900000000,current:true},{id:'other-login',createdAt:1788800000000,expiresAt:1789800000000,current:false}]}}));
 await page.route('**/api/state',r=>r.fulfill({json:{hosts:[host],projects:[project],sessions:[state]}}));
 await page.routeWebSocket('**/ws/browser?*',ws=>{socket=ws;clientId=new URL(ws.url()).searchParams.get('clientId')!;ws.onMessage(raw=>{const req=JSON.parse(String(raw));calls.push(req);const reply=(result:any)=>ws.send(JSON.stringify({type:'response',id:req.id,result}));switch(req.method){case 'attach': {const meta=Buffer.from(JSON.stringify({type:'event',event:'output',hostId:'h1',sessionId:'s1',clientId,runtimeEpoch:'runtime-1',seq:2}));const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);ws.send(Buffer.concat([size,meta,Buffer.from('LIVE_AFTER_SNAPSHOT\r\n')]));reply({session:state,seq:1,data:'SNAPSHOT_CONTENT\r\n',cols:90,rows:30});break}case 'claimControl':state={...state,controller:clientId as any,controlEpoch:state.controlEpoch+1};reply(state);break;case 'resize':state={...state,cols:req.params.cols,rows:req.params.rows};ws.send(JSON.stringify({type:'event',event:'snapshot',hostId:'h1',sessionId:'s1',clientId,session:state,seq:2,data:'SNAPSHOT_CONTENT\r\nLIVE_AFTER_SNAPSHOT\r\n',cols:state.cols,rows:state.rows}));reply(state);break;case 'history':reply({runs:[{runtimeEpoch:'runtime-1',createdAt:session.createdAt},{runtimeEpoch:'runtime-old',createdAt:'2026-09-07T10:00:00Z'}],entries:[{seq:1,data:req.params.runtimeEpoch==='runtime-old'?'PREVIOUS_RUN':'HISTORY_ONLY\x1b[31m',at:session.createdAt}],hasMore:false,truncated:false,runtimeEpoch:req.params.runtimeEpoch||state.runtimeEpoch});break;default:reply({ok:true})}})});
 await page.goto('/');await page.getByRole('button',{name:/真实终端测试/}).click();await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();
 return {calls,screen(data:string){socket.send(JSON.stringify({type:'event',event:'snapshot',hostId:'h1',sessionId:'s1',clientId,session:state,seq:2,data,cols:90,rows:30}))},query(){const meta=Buffer.from(JSON.stringify({type:'event',event:'output',hostId:'h1',sessionId:'s1',clientId,runtimeEpoch:'runtime-1',seq:3}));const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);socket.send(Buffer.concat([size,meta,Buffer.from('\x1b[6n\x1b[c\x1b[>c\x1b]52;c;dGVzdA==\x07QUERY_END')]))},broadcastSnapshot(){socket.send(JSON.stringify({type:'event',event:'snapshot',hostId:'h1',sessionId:'s1',clientId,session:state,seq:2,data:'RESIZED_SNAPSHOT\r\n',cols:72,rows:24}))},resync(){socket.send(JSON.stringify({type:'event',event:'resync',hostId:'h1',sessionId:'s1',clientId}))},revoke(){state={...state,controller:'another-client' as any,controlEpoch:state.controlEpoch+1};socket.send(JSON.stringify({type:'event',event:'state',session:state}))},disconnect(){socket.close()}};
}
async function setupEmptyWorkspace(page:Page){
 await page.route('**/api/auth',route=>route.fulfill({json:{authenticated:true,user:{id:'u1',name:'测试用户'},csrfToken:'csrf-test',mode:'development'}}));
 await page.route('**/api/state',route=>route.fulfill({json:{hosts:[host],projects:[],sessions:[]}}));
 await page.routeWebSocket('**/ws/browser?*',socket=>socket.onMessage(raw=>{const request=JSON.parse(String(raw));socket.send(JSON.stringify({type:'response',id:request.id,result:{ok:true}}))}));
 await page.goto('/');
}
async function setupOfflineWorkspace(page:Page){
 await page.route('**/api/auth',route=>route.fulfill({json:{authenticated:true,user:{id:'u1',name:'测试用户'},csrfToken:'csrf-test',mode:'development'}}));
 await page.route('**/api/browsers',route=>route.fulfill({json:{browsers:[]}}));
 await page.route('**/api/state',route=>route.fulfill({json:{hosts:[{...host,online:false}],projects:[],sessions:[]}}));
 await page.routeWebSocket('**/ws/browser?*',socket=>socket.onMessage(raw=>{const request=JSON.parse(String(raw));socket.send(JSON.stringify({type:'response',id:request.id,result:{ok:true}}))}));
 await page.goto('/');
}
test('snapshot output queue renders in order; input stays blocked until claim and resize, then revocation blocks it',async({page})=>{
 const {calls,revoke}=await setup(page);
 await expect.poll(()=>calls.filter(x=>x.method==='outputAck').map(x=>x.params.seq)).toContain(2);
 expect(calls.some(x=>x.method==='claimControl')).toBe(false);
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('blocked');expect(calls.filter(x=>x.method==='input')).toHaveLength(0);
 await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible();
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('x');await expect.poll(()=>calls.filter(x=>x.method==='input').length).toBe(1);
 const input=calls.find(x=>x.method==='input')!;expect(input.params).toMatchObject({runtimeEpoch:'runtime-1',controlEpoch:1,inputSeq:1,data:'x'});
 expect(calls.findIndex(x=>x.method==='resize')).toBeLessThan(calls.findIndex(x=>x.method==='input'));
 revoke();await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();await page.keyboard.type('blocked');expect(calls.filter(x=>x.method==='input')).toHaveLength(1);
});
test('six palettes, project scoped creation, unavailable agent and read-only history',async({page})=>{
 const {calls}=await setup(page);await page.getByRole('button',{name:'设置',exact:true}).click();
 for(const name of ['电光蓝','鸢尾紫','珊瑚橙','翡翠绿','玫瑰粉','原版蓝青']){const button=page.getByRole('button',{name:new RegExp(name)});await button.click();await expect(button).toHaveAttribute('aria-pressed','true')}
 await page.getByLabel('终端字号').fill('18');await expect(page.getByText('18px',{exact:true})).toBeVisible();await page.getByRole('button',{name:'关闭对话框'}).click();
 await page.locator('.project-group').filter({hasText:'example'}).hover();await page.getByRole('button',{name:'在 example 中新建会话',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('/Users/test/Projects/example');await expect(page.getByRole('radio',{name:/Claude Code/})).toBeDisabled();await page.getByRole('button',{name:'关闭对话框'}).click();
 await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'历史记录',exact:true}).click();await expect(page.locator('.history-output')).toHaveText('HISTORY_ONLY');await page.getByLabel('选择历史运行').selectOption('runtime-old');await expect(page.locator('.history-output')).toHaveText('PREVIOUS_RUN');expect(calls.filter(x=>x.method==='input')).toHaveLength(0);
 await page.getByRole('button',{name:'关闭对话框'}).click();await page.getByRole('button',{name:'进入专注模式'}).click();await expect(page.getByRole('complementary')).toBeHidden();await page.keyboard.press('Control+k');await expect(page.getByRole('searchbox',{name:'搜索会话或项目'})).toBeFocused();
});
test('disconnect suspends input and reconnect requires a fresh snapshot and explicit claim',async({page})=>{
 const {calls,disconnect}=await setup(page);await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible();disconnect();await expect(page.getByRole('status').filter({hasText:'输入已暂停'})).toBeVisible();await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('never-replay');await expect.poll(()=>calls.filter(x=>x.method==='attach').length).toBe(2);await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();expect(calls.filter(x=>x.method==='input')).toHaveLength(0);expect(calls.filter(x=>x.method==='claimControl')).toHaveLength(1);
});

test('authoritative resize snapshots preserve readonly viewing and resync reattaches without claiming',async({page})=>{
 const {calls,broadcastSnapshot,resync}=await setup(page);broadcastSnapshot();await page.getByRole('button',{name:'搜索终端',exact:true}).click();await page.getByRole('searchbox',{name:'在终端中查找'}).fill('RESIZED_SNAPSHOT');await page.getByRole('button',{name:'下一个',exact:true}).click();await expect(page.locator('.toast')).toHaveCount(0);
 expect(calls.filter(x=>x.method==='resize')).toHaveLength(0);expect(calls.filter(x=>x.method==='claimControl')).toHaveLength(0);resync();await expect.poll(()=>calls.filter(x=>x.method==='attach').length).toBe(2);await expect(page.getByRole('status').filter({hasText:'只读'})).toBeVisible();
});
test('keyboard project search has a visible focus indicator',async({page})=>{
 await setup(page);await page.keyboard.press('Control+k');await expect(page.getByRole('searchbox',{name:'搜索会话或项目'})).toBeFocused();await expect(page.locator('.session-search')).toHaveCSS('border-color','rgb(141, 173, 255)');
});
test('terminal search has a visible focus indicator',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'搜索终端',exact:true}).click();await expect(page.getByRole('searchbox',{name:'在终端中查找'})).toBeFocused();await expect(page.locator('.terminal-search')).toHaveCSS('border-color','rgb(154, 186, 255)');
});
test('the application keeps one stable page heading',async({page})=>{
 await setupEmptyWorkspace(page);await expect(page.getByRole('heading',{name:'多面体',level:1,exact:true})).toHaveCount(1);await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'多面体',level:1,exact:true})).toHaveCount(1);
});
test('mobile header keeps the product identity visible',async({page})=>{
 await setupEmptyWorkspace(page);await page.setViewportSize({width:390,height:844});const heading=page.getByRole('heading',{name:'多面体',level:1,exact:true});await expect(heading).toBeVisible();expect((await heading.boundingBox())!.width).toBeGreaterThan(30);
});
test('the skip link moves keyboard focus to the terminal workspace',async({page})=>{
 await setup(page);const skip=page.getByRole('link',{name:'跳到会话工作区',exact:true});await skip.focus();await page.keyboard.press('Enter');await expect(page.locator('#terminal-workspace')).toBeFocused();
});
test('mobile icon controls keep usable touch targets',async({page})=>{
 await setup(page);await page.setViewportSize({width:390,height:844});const add=await page.getByRole('button',{name:'添加项目',exact:true}).boundingBox(),search=await page.getByRole('button',{name:'搜索终端',exact:true}).boundingBox();
 expect(add!.width).toBeGreaterThanOrEqual(36);expect(add!.height).toBeGreaterThanOrEqual(36);expect(search!.width).toBeGreaterThanOrEqual(36);expect(search!.height).toBeGreaterThanOrEqual(36);await expect(page.getByRole('button',{name:'搜索终端',exact:true})).toHaveCSS('touch-action','manipulation');
});
test('online host without projects offers a usable first-project action',async({page})=>{
 await setupEmptyWorkspace(page);await expect(page.getByText('点击左侧 Projects 旁的“添加项目”，创建第一个项目。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'添加第一个项目',exact:true}).click();await expect(page.getByRole('dialog',{name:'添加项目'})).toBeVisible();
});
test('offline host state remains visually muted and settings contain their own scroll',async({page})=>{
 await setupOfflineWorkspace(page);await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'设置'});
 await expect(dialog).toHaveCSS('overscroll-behavior-y','contain');await expect(dialog.getByText('离线',{exact:true})).toHaveCSS('color','rgb(141, 154, 177)');
});
test('liquid glass shell keeps navigation beside the terminal and details float above it',async({page},testInfo)=>{
 const browserErrors:string[]=[];page.on('pageerror',error=>browserErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')browserErrors.push(message.text())});
 await setup(page);await expect(page.locator('.shell-header')).toBeVisible();await expect(page.locator('#command-form')).toHaveCount(0);await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1);await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBe(true);
 const sidebar=await page.locator('.sidebar').boundingBox(),workspace=await page.locator('.workspace-card').boundingBox();
 expect(Math.abs(sidebar!.y-workspace!.y)).toBeLessThan(2);expect(workspace!.x).toBeGreaterThan(sidebar!.x+sidebar!.width-1);
 const width=workspace!.width;await page.getByRole('button',{name:'会话详情',exact:true}).click();await expect(page.locator('.session-details-sheet')).toBeVisible();
 expect((await page.locator('.workspace-card').boundingBox())?.width).toBe(width);await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
 await page.setViewportSize({width:736,height:863});const compactSidebar=await page.locator('.sidebar').boundingBox(),compactWorkspace=await page.locator('.workspace-card').boundingBox();
 expect(Math.abs(compactSidebar!.y-compactWorkspace!.y)).toBeLessThan(2);expect(compactWorkspace!.x).toBeGreaterThan(compactSidebar!.x+compactSidebar!.width-1);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.screenshot({path:testInfo.outputPath('settings.png'),fullPage:true});
 await page.getByRole('button',{name:'关闭对话框'}).click();await page.setViewportSize({width:580,height:844});const thresholdSidebar=await page.locator('.sidebar').boundingBox(),thresholdWorkspace=await page.locator('.workspace-card').boundingBox();expect(thresholdWorkspace!.x).toBeGreaterThan(thresholdSidebar!.x+thresholdSidebar!.width-1);
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);expect(browserErrors).toEqual([]);
});

test('display queries never become controller input and OSC52 cannot write the clipboard',async({page})=>{
 const {calls,query}=await setup(page);await page.getByRole('button',{name:'会话详情',exact:true}).click();await page.getByRole('button',{name:'接管控制',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已接管'})).toBeVisible();
 query();await expect.poll(()=>calls.filter(x=>x.method==='outputAck').map(x=>x.params.seq)).toContain(3);expect(calls.filter(x=>x.method==='input')).toHaveLength(0);
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('y');await expect.poll(()=>calls.filter(x=>x.method==='input').length).toBe(1);expect(calls.find(x=>x.method==='input')?.params.data).toBe('y');
});

test('expired development authentication returns to the development login',async({page})=>{
 const {revoke}=await setup(page);await page.route('**/api/auth',r=>r.fulfill({json:{authenticated:false,mode:'development'}}));await page.route('**/api/state',r=>r.fulfill({status:401,json:{error:{code:'UNAUTHENTICATED',message:'Session expired'}}}));revoke();await expect(page.getByRole('button',{name:'进入本机工作台'})).toBeVisible();await expect(page.getByRole('link',{name:'登录并继续'})).toHaveCount(0);
});

test('host preferences submit bounded retention settings and idle sessions appear in pending',async({page})=>{
 const {calls}=await setup(page);await page.getByRole('button',{name:/^待处理/}).click();await expect(page.getByRole('button',{name:/真实终端测试/})).toBeVisible();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('任务运行时阻止空闲睡眠').check();await page.getByLabel('历史保留（天）').fill('45');await page.getByLabel('历史容量（MiB）').fill('256');await page.getByRole('button',{name:'保存主机设置'}).click();await expect.poll(()=>calls.find(x=>x.method==='configureHost')?.params).toEqual({preventSleep:true,historyDays:45,maxHistoryBytes:268435456});
});

test('other browser login revocation requires confirmation and sends CSRF',async({page})=>{
 await setup(page);let revoked=false;await page.route('**/api/browsers/other-login/revoke',r=>{expect(r.request().headers()['x-csrf-token']).toBe('csrf-test');revoked=true;return r.fulfill({json:{ok:true}})});await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByText('当前登录',{exact:true})).toBeVisible();await page.getByRole('button',{name:'撤销登录',exact:true}).click();expect(revoked).toBe(false);await page.getByRole('button',{name:'确认',exact:true}).click();await expect.poll(()=>revoked).toBe(true);
});

test('folder picker browses directories, preserves cancellation and submits the chosen project path',async({page})=>{
 const {calls}=await setup(page);
 await page.routeWebSocket('**/ws/browser?*',ws=>ws.onMessage(raw=>{
  const req=JSON.parse(String(raw));calls.push(req);
  const path=req.params.path;let result:any={ok:true};
  if(req.method==='listDirectories')result=path===undefined?{path:null,parent:null,entries:[{name:'Projects',path:'/Users/test/Projects'}]}:path==='/Users/test/Projects'?{path,parent:null,entries:[{name:'我的应用',path:path+'/我的应用'}]}:{path,parent:'/Users/test/Projects',entries:[]};
  if(req.method==='addProject')result={...project,id:'p2',name:req.params.name,path:req.params.path};
  ws.send(JSON.stringify({type:'response',id:req.id,result}));
 }));
 await page.reload();await page.getByRole('button',{name:'添加项目',exact:true}).click();
 await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'选择项目文件夹'})).toBeVisible();
 await page.getByRole('button',{name:'打开 Projects',exact:true}).click();
 await page.getByRole('button',{name:'打开 我的应用',exact:true}).click();
 await expect(page.getByText('此文件夹内没有可浏览的子文件夹。')).toBeVisible();
 await page.getByRole('button',{name:'选择此文件夹',exact:true}).click();
 await expect(page.getByLabel('项目目录',{exact:true})).toHaveValue('/Users/test/Projects/我的应用');
 await expect(page.getByLabel('项目名称',{exact:true})).toHaveValue('我的应用');
 await page.getByLabel('项目名称',{exact:true}).fill('自定义项目');
 await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
 await page.getByRole('button',{name:'上一级',exact:true}).click();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(1);
 await expect(page.getByLabel('项目目录',{exact:true})).toHaveValue('/Users/test/Projects/我的应用');
 await expect(page.getByLabel('项目名称',{exact:true})).toHaveValue('自定义项目');
 await page.getByRole('button',{name:'添加项目',exact:true}).last().click();
 await expect.poll(()=>calls.find(c=>c.method==='addProject')?.params).toEqual({name:'自定义项目',path:'/Users/test/Projects/我的应用'});
});

test('project header exposes scoped create and settings controls on hover or focus',async({page},testInfo)=>{
 await setup(page);const group=page.locator('.project-group').filter({hasText:'example'}),actions=group.locator('.project-actions');
 const create=group.getByRole('button',{name:'在 example 中新建会话',exact:true}),settings=group.getByRole('button',{name:'example 项目设置',exact:true});
 await page.getByRole('button',{name:'全部会话 1',exact:true}).focus();await page.mouse.move(600,100);await expect(actions).toHaveCSS('opacity','0');
 await group.hover();await expect(actions).toHaveCSS('opacity','1');await create.click();await expect(page.getByRole('dialog',{name:'新建会话'})).toContainText('/Users/test/Projects/example');await page.getByRole('button',{name:'关闭对话框'}).click();
 await settings.focus();await expect(actions).toHaveCSS('opacity','1');await settings.click();await expect(page.getByRole('dialog',{name:'项目设置'})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('project-actions.png')});
});
test('native user prompt backgrounds follow terminal repaint without modifying output or forwarding input',async({page},testInfo)=>{
 const {screen,calls}=await setup(page);
 screen('› 帮我检查登录流程\r\n模型输出保持原生样式\r\n> 引用文字不算用户输入');
 await expect(page.locator('.terminal-input-row')).toHaveCount(1);await expect(page.locator('.terminal-input-row')).toHaveCSS('pointer-events','none');
 await expect(page.locator('.xterm-accessibility-tree')).toContainText('模型输出保持原生样式');expect(calls.filter(x=>x.method==='input')).toHaveLength(0);await page.screenshot({path:testInfo.outputPath('terminal-input-contrast.png')});
 screen('模型的新输出\r\n没有用户提示行');await expect(page.locator('.terminal-input-row')).toHaveCount(0);
 screen('\x1b[?1049h› 全屏终端输入\r\n全屏输出');await expect(page.locator('.terminal-input-row')).toHaveCount(1);
 screen('\x1b[?1049l普通终端输出');await expect(page.locator('.terminal-input-row')).toHaveCount(0);
});
