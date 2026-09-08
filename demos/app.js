/* Visual prototype only: no commands, authentication, networking, or real Agent calls. */
(() => {
 const state = DemoModel.createState();
 const $ = id => document.getElementById(id);
 const labels = {working:'工作中',approval:'等待审批',done:'本轮结束',idle:'等待输入'};
 let filter = 'all', disconnected = false, toastTimer, newSessionProjectId = null;
 const outputs = new Map(), drafts = new Map(), collapsedProjects = new Set();
 const session = () => state.sessions.find(s => s.id === state.selected);
 const project = (s=session()) => state.projects.find(p => p.id === s.projectId);
 const displayPath = path => path.replace(/^\/Users\/lin(?=\/|$)/, '~');
 function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'), use=document.createElementNS('http://www.w3.org/2000/svg','use');
  svg.classList.add('icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;
 }
 function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;},3500);
 }
 function renderList() {
  const query=$('session-search').value, rows=DemoModel.filterSessions(state,filter,query);
  const list=$('session-list');list.replaceChildren();
  $('session-count').textContent=state.sessions.length;
  $('project-count').textContent=state.projects.length;
  $('pending-count').textContent=DemoModel.filterSessions(state,'pending').length;
  document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));
  for(const p of state.projects) {
   const sessions=rows.filter(s=>s.projectId===p.id);
   if(!sessions.length && (filter!=='all' || ![p.name,p.path,displayPath(p.path)].join(' ').toLowerCase().includes(query.trim().toLowerCase())))continue;
   const group=document.createElement('section');group.className='project-group';group.dataset.projectId=p.id;
   const heading=document.createElement('div');heading.className='project-heading';
   const toggle=document.createElement('button');toggle.className='project-toggle';toggle.type='button';toggle.title=p.path+' · '+p.host;
   const open=Boolean(query.trim())||filter!=='all'||!collapsedProjects.has(p.id);
   toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-controls','project-sessions-'+p.id);
   const chevron=icon('chevron');chevron.classList.add('project-chevron');
   const copy=document.createElement('span');copy.className='project-label';
   const name=document.createElement('strong');name.textContent=p.name;
   const path=document.createElement('small');path.textContent=displayPath(p.path);
   copy.append(name,path);toggle.append(chevron,icon('folder'),copy);
   const add=document.createElement('button');add.type='button';add.className='icon-button project-add';add.setAttribute('aria-label','在 '+p.name+' 中新建会话');add.title=p.offline?'项目主机离线':'在此项目中新建会话';add.disabled=p.offline;add.append(icon('plus'));add.addEventListener('click',()=>openNewSession(p.id));
   heading.append(toggle,add);
   const children=document.createElement('div');children.className='session-list';children.id='project-sessions-'+p.id;children.hidden=!open;
   toggle.addEventListener('click',()=>{const next=children.hidden;children.hidden=!next;toggle.setAttribute('aria-expanded',String(next));if(next)collapsedProjects.delete(p.id);else collapsedProjects.add(p.id);});
   for(const s of sessions) {
    const b=document.createElement('button');b.className='session-item'+(s.id===state.selected?' active':'');b.setAttribute('aria-current',String(s.id===state.selected));b.dataset.sessionId=s.id;
    const name=document.createElement('span');name.className='session-name';name.textContent=s.title;
    const meta=document.createElement('span');meta.className='session-meta';
    const dot=document.createElement('span');dot.className='dot '+(p.offline?'offline':s.status);dot.setAttribute('aria-hidden','true');
    meta.append(dot,document.createTextNode(s.agent+' · '+(p.offline?'主机离线':labels[s.status])));b.append(name,meta);
    b.addEventListener('click',()=>{drafts.set(state.selected,$('terminal-command').value);state.selected=s.id;render();});children.append(b);
   }
   if(!sessions.length){const empty=document.createElement('p');empty.className='project-empty';empty.textContent='暂无会话';children.append(empty);}
   group.append(heading,children);list.append(group);
  }
  if(!list.children.length){const empty=document.createElement('p');empty.className='session-empty';empty.textContent='没有找到项目或会话';list.append(empty);}
 }
 function openNewSession(projectId) {
  const p=state.projects.find(p=>p.id===projectId);
  if(!p||p.offline)return;
  newSessionProjectId=p.id;
  $('new-form').reset();$('form-error').textContent='';
  $('new-project-name').textContent=p.name;
  $('new-project-path').textContent=p.path;
  $('new-session-host').textContent=p.host;
  openDialog('new-dialog');
 }
 const code = ['<span class="lineno">  24</span>  export async function refreshSession() {','<span class="removed">− 25    return cachedSession;</span>','<span class="added">+ 25    if (isExpired(session)) {</span>','<span class="added">+ 26      return redirectToLogin();</span>','<span class="added">+ 27    }</span>','<span class="lineno">  28</span>    return session;','<span class="lineno">  29</span>  }'].join('\n');
 const samples = {
  "web-search": "<div class=\"term-prompt\"><span>›</span><p>支持按项目名称、目录和会话标题搜索。</p></div><p class=\"term-line\">已梳理搜索匹配逻辑，正在补充快捷键和空结果提示。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/components/ProjectSearch.tsx</span></p><p class=\"term-line\">正在检查中文输入和目录匹配…</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "api-stream": "<div class=\"term-prompt\"><span>›</span><p>为终端接入实时消息流，支持断线后的续传。</p></div><p class=\"term-line\">已补充消息序号和订阅接口，正在处理重连时的重复消息。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/api/terminal-stream.ts</span></p><p class=\"term-line\">正在检查消息顺序…</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "api-tests": "<div class=\"term-prompt\"><span>›</span><p>补充会话创建、读取和关闭接口的测试。</p></div><p class=\"term-line\">示例测试覆盖了正常请求、参数校验和跨账号访问。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">tests/session-api.test.ts</span></p><p class=\"term-line\">本轮结束，可以继续补充测试场景。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "lab-snapshot": "<div class=\"term-prompt\"><span>›</span><p>验证终端快照能否恢复滚动位置和光标。</p></div><p class=\"term-line\">已记录屏幕缓冲区、光标位置与终端尺寸的恢复顺序。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">experiments/snapshot.ts</span></p><p class=\"term-line\">主机离线，当前展示最后保存的演示画面。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "lab-resize": "<div class=\"term-prompt\"><span>›</span><p>排查切换设备后终端换行错位的问题。</p></div><p class=\"term-line\">已定位到窗口尺寸更新先于字体加载的情况，等待主机上线后继续验证。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">experiments/resize.ts</span></p><p class=\"term-line\">主机离线，当前展示最后保存的演示画面。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "notes-editor": "<div class=\"term-prompt\"><span>›</span><p>实现支持实时预览的 Markdown 笔记编辑器。</p></div><p class=\"term-line\">已完成编辑区和预览区的布局，正在补充列表、引用和代码块样式。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/editor/MarkdownEditor.tsx</span></p><p class=\"term-line\">正在完善键盘快捷键…</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "notes-sync": "<div class=\"term-prompt\"><span>›</span><p>两台设备同时修改笔记时，应该如何处理冲突？</p></div><p class=\"term-line\">建议保留两个版本，并展示差异供用户选择。已整理自动合并和手动确认的边界。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">docs/sync-conflicts.md</span></p><p class=\"term-line\">等待输入：是否采用保留双版本的方案？</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "notes-export": "<div class=\"term-prompt\"><span>›</span><p>支持将笔记导出为 Markdown 文件。</p></div><p class=\"term-line\">已整理导出流程，文件名使用笔记标题，并保留正文中的图片引用。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/export/markdown.ts</span></p><p class=\"term-line\">本轮结束，可以继续补充批量导出。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "design-tokens": "<div class=\"term-prompt\"><span>›</span><p>整理明亮主题的颜色变量，统一组件用色。</p></div><p class=\"term-line\">已分为背景、正文、交互和状态四组，主色提供蓝色与紫色两个候选。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/tokens/colors.css</span></p><p class=\"term-line\">等待输入：确定默认主题色。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "design-buttons": "<div class=\"term-prompt\"><span>›</span><p>统一按钮的悬停、按下、加载和禁用状态。</p></div><p class=\"term-line\">已对齐按钮高度和图标间距，正在检查不同背景上的可读性。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/components/Button.tsx</span></p><p class=\"term-line\">正在完善加载状态…</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  "design-icons": "<div class=\"term-prompt\"><span>›</span><p>整理常用图标，统一尺寸和线条风格。</p></div><p class=\"term-line\">已整理搜索、文件夹、终端和设置图标，补充了可访问名称示例。</p><p class=\"tool-command\"><b>•</b> <span class=\"muted\">src/icons/index.ts</span></p><p class=\"term-line\">本轮结束，可以在组件预览中查看。</p><p class=\"term-line muted\">以上为演示内容，未执行真实任务。</p>",
  login: '<div class="term-prompt"><span>›</span><p>帮我完善账号登录流程，支持邮箱验证码，<br>并检查登录失效时的处理。</p></div><p class="term-line">我会先检查现有的认证逻辑，再补上验证码登录和过期处理。</p><p class="tool-command"><b>•</b> 已查看 <span class="muted">src/auth/ · 3 个文件</span></p><div class="tool-result">└ session.ts · login.tsx · middleware.ts</div><p class="tool-command"><b>•</b> 正在修改 <span class="muted">src/auth/session.ts</span></p><pre class="code-block">'+code+'</pre><p class="term-line">过期会话现在会返回登录页，同时保留原来的跳转地址。</p><div class="term-working"><span class="pixel-loader"></span>正在补充验证码校验…</div><p class="term-line muted">esc 中断 · 以上均为示例输出</p>',
  review: '<div class="term-prompt"><span>›</span><p>检查会话 API 的权限边界，确认其他账号不能读取我的终端。</p></div><p class="term-line">已检查主机和会话的归属校验。接下来运行针对性的权限测试。</p><p class="tool-command"><b>•</b> Read <span class="muted">src/api/sessions.ts</span></p><div class="tool-result">└ 已找到 accountId → hostId → sessionId 校验</div><div class="approval-box"><strong>需要你的批准（演示）</strong><p>Run command: npm run test:auth</p><div class="approval-options">1. 允许这一次<br>2. 拒绝</div></div><p class="term-line muted approval-help">在下方输入 1 或 2 并按 Enter，体验终端内审批。</p>',
  docs: '<div class="term-prompt"><span>›</span><p>整理项目使用文档，补上本地启动与跨设备操作的说明。</p></div><p class="term-line">文档已整理完成。</p><p class="tool-command"><b>✓</b> README.md</p><div class="tool-result">新增环境准备、安装步骤与启动命令。</div><p class="tool-command"><b>✓</b> docs/session-guide.md</p><div class="tool-result">补充同账号查看、接管、断线重连的操作说明。</div><p class="term-line">你可以继续告诉我需要调整的地方。</p><p class="term-line muted">以上为示例内容，未创建真实文件。</p>',
  old: '<div class="term-prompt"><span>›</span><p>探索 xterm.js 的渲染和快照恢复方案。</p></div><p class="term-line">已整理终端状态恢复需要保存的信息：</p><div class="tool-result">屏幕缓冲区、光标、行列尺寸、终端模式与输出序号。</div><div class="empty-art">执行主机当前离线。<br>可以查看最后的演示画面，主机上线后才能继续操作。</div>'
 };
 function render() {
  const s = session(); renderList();
  $('detail-project').textContent = project().path;
  $('terminal-screen').setAttribute('aria-label',s.title+'：终端输出，全部为演示数据');
  $('detail-host').textContent = $('detail-execution-host').textContent = project().host;
  $('detail-agent').textContent = s.agent === 'Codex'?'Codex CLI':s.agent;
  $('detail-session').textContent = s.id;
  $('terminal-agent').textContent = s.agent;
  // Authored constant fixtures only; user input is always inserted with textContent.
  $('terminal-output').innerHTML = samples[s.id] || '<div class="empty-art">会话已准备好。<br>在下方输入，体验终端中的交互。<br><br>这是一份 HTML 样式 Demo，不会启动真实 Agent。</div>';
  if (s.id === 'review' && s.status !== 'approval') {
   document.querySelector('.approval-box')?.remove(); document.querySelector('.approval-help')?.remove();
  }
  if (s.id === 'login' && s.status !== 'working') document.querySelector('.term-working')?.remove();
  $('extra-output').replaceChildren(); (outputs.get(s.id)||[]).forEach(entry=>appendOutput(entry,false));
  $('terminal-command').value=drafts.get(s.id)||'';
  renderControl();renderTimeline();
 }
 function renderControl() {
  const s=session(), offline=disconnected||project().offline, mine=s.owner==='this'&&!offline;
  $('acquire-control').disabled=offline;$('acquire-control').hidden=mine;
  $('detail-control').textContent=offline?'连接已断开':mine?'当前设备':'办公室 MacBook';
  $('terminal-command').disabled=!mine;document.querySelector('.input-submit').disabled=!mine;
  $('terminal-command').placeholder=offline?'连接恢复后可继续输入…':mine?'继续输入指令…':'在会话详情中接管后输入…';
  $('input-hint').textContent=mine?'Enter 发送 · Shift + Enter 换行':offline?'连接已断开 · 未发送输入不会自动重放':'只读 · 在会话详情中接管';
  $('connection-label').textContent=offline?'离线':'已连接';
  document.querySelectorAll('.connection-dot').forEach(dot=>{dot.style.background=offline?'var(--muted)':'var(--teal)';});
  document.querySelector('.host-connection').style.color=offline?'var(--muted)':'var(--teal)';
  $('simulate-network').querySelector('span').textContent=disconnected?'恢复演示连接':'模拟断线重连';$('simulate-network').disabled=project().offline;
  $('interrupt').disabled=!mine||['idle','done'].includes(s.status);
 }
 function renderTimeline() {
  const s=session();const items=project().offline?[['主机离线，保留最后画面','昨天 20:18'],['会话已创建','昨天 19:52']]:s.owner==='this'?[['当前设备持有操作权','刚刚'],['会话状态已同步','14:36'],[s.agent+' 会话已创建','14:32']]:[['Agent 正在处理任务','14:36'],['办公室 MacBook 正在操作','14:33'],[s.agent+' 会话已创建','14:32']];
  $('timeline').replaceChildren();items.forEach(([label,time])=>{const li=document.createElement('li'),t=document.createElement('time');li.textContent=label;t.textContent=time;li.append(t);$('timeline').append(li);});
 }
 function appendOutput(entry,scroll=true){const p=document.createElement('p');p.className='term-line'+(entry.role==='answer'?' muted':'');p.textContent=(entry.role==='user'?'› ':'  ')+entry.text;$('extra-output').append(p);if(scroll)$('terminal-screen').scrollTop=$('terminal-screen').scrollHeight;}
 function openDialog(id){$(id).showModal();}
 document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;renderList();}));
 document.querySelectorAll('[data-action="settings"]').forEach(b=>b.addEventListener('click',()=>openDialog('settings-dialog')));
 document.querySelectorAll('[data-action="help"]').forEach(b=>b.addEventListener('click',()=>openDialog('help-dialog')));
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
 document.querySelectorAll('[data-action="project"]').forEach(b=>b.addEventListener('click',()=>{$('project-form').reset();$('project-error').textContent='';openDialog('project-dialog');}));
 $('new-dialog').addEventListener('close',()=>{newSessionProjectId=null;});
 $('project-form').addEventListener('submit',e=>{
  e.preventDefault();const data=new FormData(e.currentTarget);
  try{const p=DemoModel.addProject(state,{name:data.get('name'),path:data.get('path'),host:data.get('host')});collapsedProjects.delete(p.id);filter='all';$('session-search').value='';renderList();$('project-dialog').close();toast('演示项目已添加，可在项目旁新建会话。');}
  catch(error){$('project-error').textContent=error.message;}
 });
 $('session-search').addEventListener('input',renderList);
 $('acquire-control').addEventListener('click',()=>{if(disconnected)return;if(DemoModel.takeover(state,state.selected)){renderControl();renderTimeline();$('terminal-command').focus();toast('已在此设备接管演示会话，执行位置保持不变。');}});
 $('toggle-details').addEventListener('click',()=>{const hidden=!$('details').hidden;$('details').hidden=hidden;$('toggle-details').setAttribute('aria-expanded',String(!hidden));});
 $('toggle-focus').addEventListener('click',()=>{const focused=document.body.classList.toggle('focus-mode');$('toggle-focus').setAttribute('aria-pressed',String(focused));$('toggle-focus').setAttribute('aria-label',focused?'退出专注模式':'进入专注模式');$('toggle-focus').title=focused?'退出专注模式':'专注模式';});
 $('new-form').addEventListener('submit',e=>{
  e.preventDefault();const data=new FormData(e.currentTarget);
  try{DemoModel.addSession(state,{title:data.get('title'),agent:data.get('agent'),projectId:newSessionProjectId});collapsedProjects.delete(session().projectId);filter='all';$('session-search').value='';$('new-dialog').close();e.currentTarget.reset();$('form-error').textContent='';render();if(!disconnected)$('terminal-command').focus();toast('演示会话已创建，未启动真实 Agent。');}
  catch(error){$('form-error').textContent=error.message;}
 });
 $('terminal-form').addEventListener('submit',e=>{
  e.preventDefault();const s=session(),input=$('terminal-command'),text=input.value.trim();if(!text||s.owner!=='this'||project().offline||disconnected)return;
  let reply='演示输入已收到。正式版本会把输入送到原生 CLI；此处不会执行命令。';
  if(s.status==='approval'&&['1','2'].includes(text)){s.status=text==='1'?'done':'idle';reply=text==='1'?'演示：批准已提交，权限测试通过。没有执行真实测试。':'演示：已拒绝本次操作。';}
  const entries=[{role:'user',text},{role:'answer',text:reply}];outputs.set(s.id,[...(outputs.get(s.id)||[]),...entries]);input.value='';drafts.delete(s.id);render();$('terminal-screen').scrollTop=$('terminal-screen').scrollHeight;input.focus();
 });
 $('terminal-command').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('terminal-form').requestSubmit();}});
 $('terminal-command').addEventListener('input',e=>drafts.set(state.selected,e.target.value));
 $('simulate-network').addEventListener('click',()=>{disconnected=!disconnected;renderControl();toast(disconnected?'已模拟断线：画面保留，输入暂停。':'演示连接已恢复，会话没有重新创建。');});
 $('interrupt').addEventListener('click',()=>{const s=session();s.status='idle';outputs.set(s.id,[...(outputs.get(s.id)||[]),{role:'answer',text:'演示任务已中断，会话保留。'}]);render();toast('已模拟中断当前任务，会话保留。');});
 $('copy-terminal').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('terminal-screen').innerText);toast('演示终端内容已复制。');}catch{toast('浏览器未允许复制，请在终端内选择文字后复制。');}});
 $('font-size').addEventListener('input',e=>{document.documentElement.style.setProperty('--term-size',e.target.value+'px');$('font-size-output').textContent=e.target.value+'px';});
 document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.body.classList.remove('focus-mode');$('toggle-focus').setAttribute('aria-pressed','false');$('toggle-focus').setAttribute('aria-label','进入专注模式');$('session-search').focus();}});
 render();
})();
