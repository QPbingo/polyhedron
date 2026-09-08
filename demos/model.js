(function(root) {
 const hosts = [{name:'工作室 Mac mini',offline:false},{name:'家里的 MacBook',offline:true}];
 function normalizePath(value) {
  let path = String(value || '').trim();
  if (path === '~' || path.startsWith('~/')) path = '/Users/lin' + path.slice(1);
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('请输入绝对目录，或以 ~/ 开头的目录');
  const parts = [];
  for (const part of path.split('/')) {
   if (!part || part === '.') continue;
   if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
 }
 const api = {
  createState() { return {selected:'login',projects:[
   {id:'web',name:'polyhedron-web',path:'/Users/lin/Projects/polyhedron-web',host:hosts[0].name,offline:false},
   {id:'api',name:'polyhedron-api',path:'/Users/lin/Projects/polyhedron-api',host:hosts[0].name,offline:false},
   {id:'lab',name:'terminal-lab',path:'/Users/lin/Projects/terminal-lab',host:hosts[1].name,offline:true},
   {id:'notes',name:'pocket-notes',path:'/Users/lin/Projects/pocket-notes',host:hosts[0].name,offline:false},
   {id:'design',name:'prism-ui',path:'/Users/lin/Projects/prism-ui',host:hosts[0].name,offline:false}
  ],sessions:[
   {id:'login',title:'完善账号登录流程',projectId:'web',agent:'Codex',status:'working',owner:'other'},
   {id:'review',title:'检查 API 权限边界',projectId:'api',agent:'Claude Code',status:'approval',owner:'this'},
   {id:'docs',title:'整理项目使用文档',projectId:'web',agent:'Codex',status:'done',owner:'this'},
   {id:'old',title:'探索终端渲染方案',projectId:'lab',agent:'Claude Code',status:'idle',owner:'other'},
   {id:'web-search',title:'优化项目搜索体验',projectId:'web',agent:'Claude Code',status:'working',owner:'this'},
   {id:'api-stream',title:'接入终端消息流',projectId:'api',agent:'Codex',status:'working',owner:'this'},
   {id:'api-tests',title:'补充会话接口测试',projectId:'api',agent:'Claude Code',status:'done',owner:'this'},
   {id:'lab-snapshot',title:'验证终端快照恢复',projectId:'lab',agent:'Codex',status:'done',owner:'other'},
   {id:'lab-resize',title:'调试窗口尺寸同步',projectId:'lab',agent:'Claude Code',status:'idle',owner:'other'},
   {id:'notes-editor',title:'实现 Markdown 编辑器',projectId:'notes',agent:'Codex',status:'working',owner:'this'},
   {id:'notes-sync',title:'确认笔记冲突处理方案',projectId:'notes',agent:'Claude Code',status:'idle',owner:'this'},
   {id:'notes-export',title:'支持笔记导出',projectId:'notes',agent:'Codex',status:'done',owner:'this'},
   {id:'design-tokens',title:'确认主题颜色变量',projectId:'design',agent:'Claude Code',status:'idle',owner:'this'},
   {id:'design-buttons',title:'统一按钮交互状态',projectId:'design',agent:'Codex',status:'working',owner:'this'},
   {id:'design-icons',title:'整理图标组件',projectId:'design',agent:'Claude Code',status:'done',owner:'this'}
  ]}; },
  filterSessions(state,filter='all',query='') {
   const q = query.trim().toLowerCase().replace(/^~(?=\/|$)/,'/users/lin');
   return state.sessions.filter(s => {
    const p = state.projects.find(p => p.id === s.projectId);
    return p && (filter==='all' || (filter==='pending'&&!p.offline&&['approval','idle'].includes(s.status)) || (filter==='done'&&s.status==='done')) &&
     [s.title,s.agent,p.name,p.path].join(' ').toLowerCase().includes(q);
   });
  },
  takeover(state,id) {
   const s = state.sessions.find(s => s.id === id);
   const p = s && state.projects.find(p => p.id === s.projectId);
   if (!p || p.offline) return false;
   s.owner='this'; return true;
  },
  addProject(state,input) {
   const name = String(input.name || '').trim();
   if (!name || name.length>48) throw new Error('请填写项目名称，最多 48 个字符');
   const host = hosts.find(h => h.name === input.host);
   if (!host) throw new Error('请选择有效的执行主机');
   const path = normalizePath(input.path);
   if (state.projects.some(p => p.path===path && p.host===host.name)) throw new Error('此主机上的项目目录已添加');
   const p = {id:'project-'+Date.now()+'-'+state.projects.length,name,path,host:host.name,offline:host.offline};
   state.projects.push(p); return p;
  },
  addSession(state,input) {
   const title = String(input.title || '').trim();
   if (!title || title.length>48 || !['Codex','Claude Code'].includes(input.agent)) throw new Error('请填写会话名称，并选择支持的 Agent');
   const project = state.projects.find(p => p.id === input.projectId);
   if (!project) throw new Error('请选择已添加的项目目录');
   if (project.offline) throw new Error('项目主机离线，请选择在线项目');
   const s = {id:'session-'+Date.now()+'-'+state.sessions.length,title,projectId:project.id,agent:input.agent,status:'idle',owner:'this',fresh:true};
   state.sessions.unshift(s); state.selected=s.id; return s;
  }
 };
 if (typeof module!=='undefined') module.exports=api; else root.DemoModel=api;
})(typeof window!=='undefined'?window:globalThis);
