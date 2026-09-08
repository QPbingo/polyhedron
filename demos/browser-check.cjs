// Optional browser check: set PLAYWRIGHT_MODULE to an installed Playwright module.
// Uses a fresh headless Chrome profile; never connects to a personal browser.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = process.env.DEMO_URL || 'http://127.0.0.1:4173/';
    const out = path.resolve(__dirname, 'review-projects');
    await fs.mkdir(out, { recursive: true });
    await page.goto(url);
    assert.deepEqual(errors, [], 'page should initialize without errors');
    assert.equal(await page.locator('#session-title,#control-message,.project-path,#takeover,#agent-status,.workspace-footer,.brand,.demo-badge').count(),0);
    assert.match(await page.locator('.session-item.active .session-meta').innerText(), /工作中/);
    assert.equal(await page.locator('.project-group').count(),5);
    assert.equal(await page.locator('[data-project-id="web"] .session-item').count(),3);
    await page.locator('[data-project-id="web"] .project-toggle').click();
    assert.equal(await page.locator('[data-project-id="web"] .session-list').isVisible(),false);
    await page.locator('[data-project-id="web"] .project-toggle').click();
    assert.equal(await page.locator('[data-project-id="lab"] .project-add').isDisabled(),true);
    const palette = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return Object.fromEntries(['--text','--surface','--muted','--bg','--accent','--accent-end','--teal','--teal-soft','--terminal-text','--terminal','--terminal-muted','--terminal-bar'].map(k => [k,s.getPropertyValue(k).trim()]));
    });
    const luminance = hex => {
      const c = hex.match(/[a-f0-9]{2}/gi).map(x => parseInt(x,16)/255).map(x => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4);
      return c[0]*.2126 + c[1]*.7152 + c[2]*.0722;
    };
    for (const [name, foreground, background] of [
      ['body',palette['--text'],palette['--surface']],
      ['muted',palette['--muted'],palette['--bg']],
      ['action start','#ffffff',palette['--accent']],
      ['action end','#ffffff',palette['--accent-end']],
      ['status',palette['--teal'],palette['--teal-soft']],
      ['terminal',palette['--terminal-text'],palette['--terminal']],
      ['terminal muted',palette['--terminal-muted'],palette['--terminal-bar']]
    ]) {
      const a=luminance(foreground), b=luminance(background), ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      assert.ok(ratio>=4.5,name+' contrast is '+ratio.toFixed(2));
    }
    assert.equal(await page.locator('[data-filter="pending"]').count(), 1, 'pending session filter must be available');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, 'desktop workspace should fit the viewport');
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    await page.locator('[data-filter="pending"]').click();
    assert.equal(await page.locator('.session-item').count(), 3);
    assert.deepEqual(await page.locator('.project-group').evaluateAll(groups=>groups.map(g=>g.dataset.projectId)),['api','notes','design']);
    await page.locator('[data-filter="all"]').click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(out, 'desktop-1280.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, 'compact workspace should fit the viewport');
    await page.setViewportSize({ width: 1231, height: 805 });
    const bounds = await page.locator('.terminal-frame').evaluate(e=>{const r=e.getBoundingClientRect();const shell=e.closest('.workspace-card').getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,shellLeft:shell.left,radius:getComputedStyle(e).borderRadius};});
    assert.deepEqual(bounds,{top:0,left:248,right:1231,bottom:805,shellLeft:248,radius:'0px'});
    assert.ok(await page.locator('#terminal-form').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight));
    await page.screenshot({ path: path.join(out, 'feedback-1231.png'), fullPage: true });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.screenshot({ path: path.join(out, 'compact-desktop.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#terminal-command').isDisabled(), true);
    await page.locator('#toggle-details').click();
    await page.locator('#acquire-control').click();
    await page.locator('#toggle-details').click();
    assert.equal(await page.locator('#terminal-command').isEnabled(), true);
    await page.locator('#terminal-command').fill('<img src=x onerror=alert(1)>');
    await page.locator('#terminal-command').press('Enter');
    assert.equal(await page.locator('#extra-output img').count(), 0);
    assert.match(await page.locator('#extra-output').innerText(), /<img src=x/);
    await page.locator('#terminal-command').fill('尚未发送的草稿');
    await page.locator('[data-action="settings"]').click();
    await page.locator('.demo-tools summary').click();
    await page.locator('#simulate-network').click();
    assert.equal(await page.locator('#terminal-command').isDisabled(), true);
    await page.locator('#simulate-network').click();
    assert.equal(await page.locator('#terminal-command').isEnabled(), true);
    assert.equal(await page.locator('#terminal-command').inputValue(), '尚未发送的草稿');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /检查 API 权限边界/ }).click();
    await page.locator('#terminal-command').fill('1');
    await page.locator('#terminal-command').press('Enter');
    assert.match(await page.locator('.session-item.active .session-meta').innerText(), /本轮结束/);
    assert.equal(await page.locator('.approval-box').count(), 0);
    await page.getByRole('button', { name: /完善账号登录流程/ }).click();
    assert.equal(await page.locator('#terminal-command').inputValue(), '尚未发送的草稿');
    await page.locator('#toggle-details').click();
    assert.equal(await page.locator('#interrupt').isEnabled(), true);
    await page.locator('#interrupt').click();
    assert.match(await page.locator('.session-item.active .session-meta').innerText(), /等待输入/);
    assert.equal(await page.locator('#terminal-command').inputValue(), '尚未发送的草稿');
    await page.locator('#toggle-details').click();
    assert.equal(await page.locator('[data-action="new"]').count(), 0);
    await page.locator('[data-project-id="api"] .project-add').click();
    await page.locator('#new-name').fill('新的演示会话');
    assert.equal(await page.locator('#new-form select').count(), 0);
    assert.equal(await page.locator('#new-project-name').innerText(), 'polyhedron-api');
    assert.equal(await page.locator('#new-project-path').innerText(),'/Users/lin/Projects/polyhedron-api');
    await page.locator('input[value="Claude Code"]').check();
    await page.screenshot({ path: path.join(out, 'new-session-dialog.png'), fullPage: true });
    await page.locator('#new-form button[type="submit"]').click();
    assert.equal(await page.locator('.session-item.active .session-name').innerText(), '新的演示会话');
    assert.equal(await page.locator('#terminal-agent').innerText(), 'Claude Code');
    assert.equal(await page.locator('.session-item.active').evaluate(e=>e.closest('.project-group').dataset.projectId),'api');
    assert.equal(await page.locator('#detail-project').innerText(),'/Users/lin/Projects/polyhedron-api');
    await page.locator('#session-search').fill('不存在的会话');
    assert.equal(await page.locator('.session-empty').count(), 1);
    await page.locator('#session-search').fill('');
    await page.getByRole('button', { name: /探索终端渲染方案/ }).click();
    assert.equal(await page.locator('#acquire-control').isDisabled(), true);
    await page.locator('#toggle-details').click();
    assert.equal(await page.locator('#details').isVisible(), true);
    await page.locator('#toggle-details').click();
    assert.equal(await page.locator('#details').isVisible(), false);
    await page.locator('#toggle-focus').click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.locator('#toggle-focus').click();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await page.locator('[data-action="help"]').click();
    assert.equal(await page.locator('#help-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#help-dialog').isVisible(), false);
    await page.locator('[data-action="settings"]').first().click();
    assert.equal(await page.locator('.palette-option').count(), 6);
    for (const id of ['iris','coral','emerald','rose','original','electric']) {
      await page.locator('.palette-option[data-palette="'+id+'"]').click();
      assert.equal(await page.locator('html').getAttribute('data-palette'), id);
    }
    await page.screenshot({ path: path.join(out, 'settings.png'), fullPage: true });
    await page.locator('#font-size').fill('18');
    assert.equal(await page.locator('#font-size-output').innerText(), '18px');
    assert.equal(await page.locator('.terminal-screen').evaluate(e => getComputedStyle(e).fontSize), '18px');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    await page.locator('[data-action="project"]').click();
    await page.locator('#project-name-input').fill('fresh-app');
    await page.locator('#project-path-input').fill('~/Work/fresh-app');
    await page.screenshot({path:path.join(out,'add-project.png'),fullPage:true});
    await page.locator('#project-form button[type="submit"]').click();
    const fresh = page.locator('.project-group').filter({has:page.locator('.project-label strong',{hasText:'fresh-app'})});
    assert.equal(await fresh.locator('.project-empty').count(),1);
    await fresh.locator('.project-add').click();
    assert.equal(await page.locator('#new-project-name').innerText(),'fresh-app');
    assert.equal(await page.locator('#new-project-path').innerText(),'/Users/lin/Work/fresh-app');
    await page.locator('#new-name').fill('项目绑定检查');
    await page.locator('#new-form button[type="submit"]').click();
    assert.equal(await fresh.locator('.session-item.active .session-name').innerText(),'项目绑定检查');
    assert.equal(await page.locator('#detail-project').innerText(),'/Users/lin/Work/fresh-app');
    await page.locator('#session-search').fill('~/Work/fresh-app');
    assert.equal(await page.locator('.project-group').count(),1);
    assert.equal(await page.locator('.session-item').count(),1);
    await page.locator('#session-search').fill('');
    await page.reload();
    assert.equal(await page.locator('.project-group').count(),5,'demo data resets on reload');
    assert.equal(await page.locator('.session-item').count(),15);
    for (const id of ['web','api','lab','notes','design']) {
      const group=page.locator('[data-project-id="'+id+'"]');
      assert.equal(await group.locator('.session-item').count(),3);
      for (const row of await group.locator('.session-item').all()) {
        const sessionId=await row.getAttribute('data-session-id');
        await page.locator('[data-session-id="'+sessionId+'"]').click();
        assert.match(await page.locator('#detail-project').innerText(),/\/Projects\//);
        assert.equal(await page.locator('#terminal-output .term-prompt').count(),1);
        assert.equal(await page.locator('.session-item.active').evaluate(e=>e.closest('.project-group').dataset.projectId),id);
      }
    }
    await page.reload();
    for (const width of [760,390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow at '+width);
      await page.evaluate(() => window.scrollTo(0,0));
      await page.screenshot({ path: path.join(out, 'narrow-'+width+'.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: project groups, directory binding, scoped creation, project registration,  desktop layout, filters, takeover, safe input, reconnect, approval, create, search, offline, details, focus, help, settings and six palettes; no page errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
