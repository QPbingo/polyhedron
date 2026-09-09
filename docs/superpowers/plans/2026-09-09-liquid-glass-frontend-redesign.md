# Liquid Glass Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Polyhedron React frontend as the approved Liquid Glass two-column workbench without changing backend contracts or native terminal behavior.

**Architecture:** Keep authentication, RPC subscription, data mutation, and dialog orchestration in `App.tsx`; extract reusable chrome, navigation, and workspace presentation into focused components. Use CSS tokens for all six compatible palette keys, reserve translucent glass for controls/navigation, and keep content and xterm surfaces opaque.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, xterm 5.5, vanilla CSS, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-liquid-glass-frontend-redesign.md`

## Global Constraints

- Do not change Relay, Host, Connector, database, HTTP, or WebSocket contracts.
- Keep the six existing palette IDs and local-storage/query-parameter compatibility.
- Keep `TerminalView` as the only terminal input surface; do not add a composer or send button.
- Keep project creation in the `Projects` heading and session creation scoped to a concrete `Project`.
- Show project actions on hover, `focus-within`, and touch environments.
- Keep the left navigation and right terminal side by side down to 580px.
- Preserve all loading, empty, offline, error, confirmation, history, accessibility, and reduced-motion states.
- Do not add a remote font, UI framework, or component dependency.

---

### Task 1: Lock the approved interaction contract with browser tests

**Files:**
- Modify: `frontend/test/workspace.spec.ts`

**Interfaces:**
- Consumes: Existing mocked `/api/auth`, `/api/state`, and browser WebSocket fixture in `setup(page)`.
- Produces: Stable DOM/accessibility contracts for `.shell-header`, `.sidebar`, `.workspace-card`, `.session-details-sheet`, `.project-actions`, and xterm-only input.

- [ ] **Step 1: Replace the obsolete layout assertion with the approved two-column contract**

```ts
test('liquid glass shell keeps navigation beside the terminal and details float above it', async ({page}) => {
  await setup(page);
  const sidebar = await page.locator('.sidebar').boundingBox();
  const workspace = await page.locator('.workspace-card').boundingBox();
  expect(sidebar?.y).toBe(workspace?.y);
  expect(workspace!.x).toBeGreaterThan(sidebar!.x + sidebar!.width - 1);
  await page.getByRole('button', {name: '会话详情', exact: true}).click();
  await expect(page.getByRole('region', {name: '会话详情'})).toBeVisible();
  expect((await page.locator('.workspace-card').boundingBox())?.width).toBe(workspace?.width);
});
```

- [ ] **Step 2: Add project-action and native-terminal assertions**

```ts
test('project actions are scoped and the terminal remains the only input surface', async ({page}) => {
  await setup(page);
  await expect(page.locator('#command-form')).toHaveCount(0);
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1);
  const group = page.locator('.project-group').filter({hasText: 'example'});
  await group.hover();
  await group.getByRole('button', {name: '在 example 中新建会话'}).click();
  await expect(page.getByRole('dialog')).toContainText('/Users/test/Projects/example');
});
```

- [ ] **Step 3: Run the focused tests and confirm they fail against the old UI**

Run: `cd frontend && npx playwright test test/workspace.spec.ts --grep "liquid glass shell|project actions are scoped"`

Expected: FAIL because the current workspace starts at `x=248`, details resize the layout, and project actions use one combined menu.

- [ ] **Step 4: Commit the test contract**

```bash
git add frontend/test/workspace.spec.ts
git commit -m "test: define liquid glass workspace contract"
```

### Task 2: Add reusable interface primitives and shell header

**Files:**
- Create: `frontend/src/components/Icon.tsx`
- Create: `frontend/src/components/ToolButton.tsx`
- Create: `frontend/src/components/Modal.tsx`
- Create: `frontend/src/components/ShellHeader.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Produces: `Icon({name, className?})`, `ToolButton({label, icon, onClick, disabled?, pressed?, className?})`, `Modal({title, eyebrow?, children, onClose})`, and `ShellHeader({project?, session?, connection, focus, onToggleFocus, onOpenSettings})`.
- Consumes: `Connection`, `Project`, and `Session` from existing modules.

- [ ] **Step 1: Add primitive unit-safe exports**

```tsx
export type IconName = 'refresh'|'plus'|'search'|'terminal'|'folder'|'chevron'|'settings'|'info'|'close'|'check'|'grid'|'book'|'expand'|'copy'|'computer'|'more';
export function Icon({name,className=''}:{name:IconName;className?:string}) {
  return <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;
}
```

- [ ] **Step 2: Implement `ToolButton` and `Modal` with existing accessibility behavior**

```tsx
export function ToolButton({label,icon,onClick,disabled,pressed,className='' }:Props) {
  return <button type="button" className={`icon-button glass-control ${className}`.trim()} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}><Icon name={icon}/></button>;
}
```

`Modal` must continue to call `showModal()`, prevent native cancel until `onClose`, and close on a backdrop click outside its rectangle.

- [ ] **Step 3: Implement the floating shell header**

Render the brand mark, `Projects / {project.name} / {session.title}` breadcrumb, connection capsule, focus toggle, settings button, and local user badge. Use `status` text for online, connecting, and offline states.

- [ ] **Step 4: Replace inline primitive definitions in `App.tsx`**

Import the new exports and remove the old `icons`, `Icon`, `Tool`, and `Modal` definitions without changing their callers' labels.

- [ ] **Step 5: Run typecheck and unit tests**

Run: `cd frontend && npm run typecheck && npm run test:unit`

Expected: PASS.

- [ ] **Step 6: Commit shell primitives**

```bash
git add frontend/src/components frontend/src/App.tsx
git commit -m "refactor: extract liquid glass shell primitives"
```

### Task 3: Build the scoped project sidebar

**Files:**
- Create: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/ProjectActions.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/test/workspace.spec.ts`

**Interfaces:**
- Consumes: `projects`, `sessions`, `hosts`, `loaded`, `connection`, `filter`, `query`, `collapsed`, `selected`, `seenCompletions`, and callbacks from `App`.
- Produces: `Sidebar` with `onAddProject`, `onCreateSession(project)`, `onEditProject(project)`, `onSelectSession(session)`, `onToggleProject(id)`, `onFilterChange(filter)`, and `onQueryChange(query)`.

- [ ] **Step 1: Change `ProjectActions` from one menu to two project-scoped controls**

```tsx
export function ProjectActions({name,canCreate,onCreate,onSettings}:Props) {
  return <span className="project-actions">
    <button type="button" aria-label={`在 ${name} 中新建会话`} title="新建会话" disabled={!canCreate} onClick={onCreate}><Icon name="plus"/></button>
    <button type="button" aria-label={`${name} 项目设置`} title="项目设置" onClick={onSettings}><Icon name="more"/></button>
  </span>;
}
```

- [ ] **Step 2: Extract sidebar filtering and project-tree rendering**

Move the existing project match, session match, pending, expanded, unread completion, and offline-host behavior into `Sidebar`. Keep query/filter expansion behavior identical.

- [ ] **Step 3: Render the add-project action in the heading**

```tsx
<div className="projects-heading">
  <h2 id="projects-heading">Projects <span>{projects.length}</span></h2>
  <ToolButton label="添加项目" icon="plus" onClick={onAddProject} disabled={connection !== 'online'}/>
</div>
```

- [ ] **Step 4: Update `App` to pass business callbacks instead of rendering navigation markup**

Selecting a session must still close the details sheet. New-session and settings callbacks must pass the exact `Project` instance into the existing dialog union.

- [ ] **Step 5: Run focused browser tests**

Run: `cd frontend && npx playwright test test/workspace.spec.ts --grep "project"`

Expected: project creation, folder selection, project-scoped session creation, settings, hover, focus, and filtering PASS.

- [ ] **Step 6: Commit sidebar refactor**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/ProjectActions.tsx frontend/src/App.tsx frontend/test/workspace.spec.ts
git commit -m "refactor: build project-scoped navigation"
```

### Task 4: Make the workspace terminal-first with an overlay details sheet

**Files:**
- Create: `frontend/src/components/SessionDetails.tsx`
- Create: `frontend/src/components/Workspace.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/TerminalView.tsx`
- Modify: `frontend/test/workspace.spec.ts`

**Interfaces:**
- Consumes: Current `Session`, `Project`, `Host`, `RpcClient`, connection/can-use state, terminal ref, terminal search state, history/dialog callbacks, and session mutation callbacks.
- Produces: A stable `.workspace-card`, `.terminal-frame`, and `.session-details-sheet` overlay that never alters workspace width.

- [ ] **Step 1: Extract `SessionDetails` with the existing actions and labels**

Keep `接管控制`, `中断任务`, `重命名`, `历史记录`, `恢复会话`, `归档`, `取消归档`, and `终止进程` behavior and disabled-state predicates unchanged.

- [ ] **Step 2: Extract the workspace frame and toolbar**

```tsx
<section className="workspace-card" id="terminal-workspace">
  <section className="terminal-frame">
    <header className="terminal-toolbar">…</header>
    {searchOpen && <TerminalSearch …/>}
    {current ? <TerminalView …/> : <WorkspaceEmpty …/>}
  </section>
  {details && current && <SessionDetails className="session-details-sheet" …/>}
</section>
```

- [ ] **Step 3: Preserve direct native xterm input**

Do not add any form outside xterm. Keep `.xterm-helper-textarea`, `onData`, claim/resize ordering, read-only guards, paste behavior, and terminal highlight overlays unchanged.

- [ ] **Step 4: Update browser tests for non-resizing overlay details**

Assert workspace width before opening details equals workspace width after opening; assert the sheet is visible and closing it restores pointer access without remounting `TerminalView`.

- [ ] **Step 5: Run terminal and browser regressions**

Run: `cd frontend && npm run test:unit && npx playwright test test/workspace.spec.ts --grep "terminal|input|resize|details|disconnect"`

Expected: PASS with no unexpected input RPC calls.

- [ ] **Step 6: Commit terminal-first workspace**

```bash
git add frontend/src/components/SessionDetails.tsx frontend/src/components/Workspace.tsx frontend/src/App.tsx frontend/src/TerminalView.tsx frontend/test/workspace.spec.ts
git commit -m "refactor: make workspace terminal first"
```

### Task 5: Implement the Liquid Glass token system and all UI states

**Files:**
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/palettes.css`
- Modify: `frontend/src/index.html`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/ProjectForm.tsx`

**Interfaces:**
- Produces: CSS custom properties for environment light, opaque surfaces, glass controls, typography, state colors, shadows, radii, and terminal colors under all six palette IDs.
- Consumes: Existing class names plus the new component class contracts from Tasks 2–4.

- [ ] **Step 1: Replace palette values with six dark environment themes**

Each `[data-palette]` block must define `--ambient-a`, `--ambient-b`, `--panel`, `--panel-2`, `--glass`, `--glass-line`, `--accent`, `--accent-soft`, `--terminal`, `--terminal-bar`, `--terminal-line`, `--terminal-text`, and `--terminal-muted`.

- [ ] **Step 2: Rebuild the shell, header, sidebar, workspace, project actions, and details styles**

Use opaque content panels and glass-only control surfaces. Implement project action opacity through:

```css
.project-actions { opacity: 0; pointer-events: none; transform: translateX(.25rem) scale(.96); }
.project-group:hover .project-actions,
.project-group:focus-within .project-actions { opacity: 1; pointer-events: auto; transform: none; }
@media (hover: none) { .project-actions { opacity: 1; pointer-events: auto; transform: none; } }
```

- [ ] **Step 3: Restyle login, dialogs, forms, settings, folder picker, history, errors, empty states, and toast**

Use consistent form fields, glass actions, opaque readable bodies, visible focus rings, and direct Chinese error copy. Keep every existing role, label, and form field name.

- [ ] **Step 4: Implement responsive and preference fallbacks**

Keep two columns through 580px, stack only below it, and add `prefers-reduced-motion` plus `prefers-reduced-transparency` rules.

- [ ] **Step 5: Update document metadata**

Keep the Chinese title and description, set the dark color scheme and theme color, and do not load remote assets.

- [ ] **Step 6: Run all frontend tests and build**

Run: `cd frontend && npm run test:unit && npm run typecheck && npm run build && npx playwright test`

Expected: all tests PASS and Vite production build completes.

- [ ] **Step 7: Commit the complete visual system**

```bash
git add frontend/src/styles.css frontend/src/palettes.css frontend/src/index.html frontend/src/App.tsx frontend/src/ProjectForm.tsx frontend/test/workspace.spec.ts
git commit -m "feat: apply liquid glass design system"
```

### Task 6: Verify real rendered behavior and delivery readiness

**Files:**
- Modify: `docs/implementation/VERIFICATION.md`

**Interfaces:**
- Consumes: Completed frontend and existing development backend.
- Produces: Evidence of automated checks, tested viewports, console status, and any external validation limits.

- [ ] **Step 1: Run the complete frontend gate from a clean process**

Run: `cd frontend && npm run test:unit && npm run typecheck && npm run build && npx playwright test`

Expected: all unit and Playwright tests PASS; build exits 0.

- [ ] **Step 2: Inspect responsive rendering**

Capture and inspect 1440×900, 1237×745, 736×863, 580×800, and 390×844. Confirm two columns at 736px and stacking only below 580px; confirm no horizontal overflow.

- [ ] **Step 3: Inspect interaction states in the browser**

Verify add project, per-project actions, project collapse, session selection, details sheet, terminal search, settings, palette selection, dialogs, focus mode, loading/offline states, and direct xterm focus. Console errors must be empty.

- [ ] **Step 4: Update verification documentation with exact results**

Record command outputs and identify OIDC, TLS, physical cross-device, Safari, and signed-package checks as external when they were not run.

- [ ] **Step 5: Review the final diff and repository state**

Run: `git diff --check && git status --short && git diff --stat HEAD~4..HEAD`

Expected: no whitespace errors and only intended frontend/design/verification changes.

- [ ] **Step 6: Commit verification evidence**

```bash
git add docs/implementation/VERIFICATION.md
git commit -m "docs: verify liquid glass frontend"
```

- [ ] **Step 7: Push the verified main branch**

Run: `git push origin main`

Expected: remote `origin/main` advances to the final local commit.
