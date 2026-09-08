const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./model.js');

test('each session belongs to an existing project directory', () => {
  const state = model.createState();
  assert.ok(Array.isArray(state.projects));
  for (const session of state.sessions) {
    const project = state.projects.find(p => p.id === session.projectId);
    assert.ok(project, session.id + ' needs a project');
    assert.ok(project.path.startsWith('/'));
  }
});
test('takeover keeps the session and its project binding', () => {
  const state = model.createState(), s = state.sessions[0];
  const before = { id: s.id, projectId: s.projectId };
  assert.equal(model.takeover(state, s.id), true);
  assert.equal(s.owner, 'this');
  assert.deepEqual({ id: s.id, projectId: s.projectId }, before);
});
test('offline projects cannot be taken over or start sessions', () => {
  const state = model.createState();
  const project = state.projects.find(p => p.offline);
  const session = state.sessions.find(s => s.projectId === project.id);
  assert.equal(model.takeover(state, session.id), false);
  assert.throws(() => model.addSession(state, { title:'测试', agent:'Codex', projectId:project.id }), /离线/);
});
test('new sessions require a valid project, title and agent', () => {
  const state = model.createState();
  const valid = { title:'测试会话', agent:'Claude Code', projectId:'web' };
  assert.throws(() => model.addSession(state, { ...valid, title:' ' }));
  assert.throws(() => model.addSession(state, { ...valid, agent:'other' }));
  assert.throws(() => model.addSession(state, { ...valid, projectId:'missing' }), /项目/);
  assert.throws(() => model.addSession(state, { title:'测试', agent:'Codex' }), /项目/);
  const session = model.addSession(state, valid);
  assert.equal(session.projectId, 'web');
  assert.equal(session.owner, 'this');
  assert.equal(state.selected, session.id);
});
test('pending filter shows online sessions needing input', () => {
  const state = model.createState();
  assert.deepEqual(model.filterSessions(state, 'pending').map(s => s.id), ['review', 'notes-sync', 'design-tokens']);
});
test('search includes the bound directory and respects the status filter', () => {
  const state = model.createState();
  assert.deepEqual(model.filterSessions(state, 'done', '/USERS/LIN/PROJECTS/POLYHEDRON-WEB').map(s => s.id), ['docs']);
  assert.deepEqual(model.filterSessions(state, 'pending', 'not-found'), []);
});
test('projects normalize their directory and prevent duplicate bindings on one host', () => {
  const state = model.createState();
  const p = model.addProject(state, { name:'新项目', path:'~/Projects/new/./', host:'工作室 Mac mini' });
  assert.equal(p.path, '/Users/lin/Projects/new');
  assert.throws(() => model.addProject(state, { name:'另一个名字', path:'/Users/lin/Projects/new', host:p.host }), /已添加/);
  const s = model.addSession(state, { title:'开发', agent:'Codex', projectId:p.id });
  assert.equal(s.projectId, p.id);
});
test('same-named folders remain separate projects', () => {
  const state = model.createState();
  const first = model.addProject(state, { name:'app', path:'/Users/lin/Work/app', host:'工作室 Mac mini' });
  const second = model.addProject(state, { name:'app', path:'/Users/lin/Personal/app', host:'工作室 Mac mini' });
  assert.notEqual(first.id, second.id);
  const a = model.addSession(state, { title:'A', agent:'Codex', projectId:first.id });
  const b = model.addSession(state, { title:'B', agent:'Claude Code', projectId:second.id });
  assert.equal(a.projectId, first.id);
  assert.equal(b.projectId, second.id);
});
test('project registration rejects invalid paths and hosts without changing the project list', () => {
  const state = model.createState(), count = state.projects.length;
  for (const input of [
    { name:'test', path:'relative/folder', host:'工作室 Mac mini' },
    { name:' ', path:'/tmp/test', host:'工作室 Mac mini' },
    { name:'test', path:'/tmp/test', host:'unknown' }
  ]) assert.throws(() => model.addProject(state, input));
  assert.equal(state.projects.length, count);
});
