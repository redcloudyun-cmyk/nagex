import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

function primaryNavTabs(appJs: string): string[] {
  const match = appJs.match(/window\.NAGEX_PRIMARY_NAV\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'NAGEX_PRIMARY_NAV is defined');
  return [...match[1].matchAll(/tab:\s*'([^']+)'/g)].map((m) => m[1]);
}

test('Sidebar IA v1 primary menu is canonical and excludes approval/internals', () => {
  const appJs = read('public/app.js');
  const index = read('public/index.html');
  assert.deepEqual(primaryNavTabs(appJs), [
    'tab-home',
    'tab-inbox',
    'tab-create',
    'tab-canvas',
    'tab-tasks',
    'tab-knowledge',
    'tab-executions',
    'tab-settings',
  ]);
  const sidebar = index.match(/<ul class="nav-menu">([\s\S]*?)<\/ul>/)?.[1] || '';
  assert.equal((sidebar.match(/<li class="nav-item(?: active)?" data-tab=/g) || []).length, 8);
  assert.doesNotMatch(sidebar, /tab-approvals/);
  assert.doesNotMatch(sidebar, /nav\.approvals/);
  for (const hidden of ['nav.agents', 'nav.skills', 'nav.tools', 'nav.executions']) {
    assert.doesNotMatch(sidebar, new RegExp(hidden.replace('.', '\\.')));
  }
});

test('Legacy approval navigation lands in Inbox while live approval remains in rail', () => {
  const appJs = read('public/app.js');
  const home = read('public/personal-home-view.js');
  assert.match(appJs, /'#approvals':\s*'tab-inbox'/);
  assert.match(appJs, /if \(tabId === 'tab-approvals'\) tabId = 'tab-inbox'/);
  assert.match(appJs, /APPROVALS/);
  assert.match(appJs, /groupApprovals/);
  assert.match(home, /data-home-section', 'action-lifecycle'/);
  assert.match(home, /AWAITING_APPROVAL/);
});

test('Inbox, Create, Tasks, Knowledge, Activity, Settings expose user-facing IA', () => {
  const appJs = read('public/app.js');
  const index = read('public/index.html');
  assert.match(appJs, /const groupKeys = \['NEEDS_ATTENTION', 'APPROVALS', 'SUGGESTIONS', 'NOTIFICATIONS'\]/);
  for (const group of ['Documents', 'Presentations', 'Visual', 'Analysis', 'Technical']) {
    assert.match(index, new RegExp(`data-create-group="${group}"`));
  }
  for (const type of ['ONE_TIME', 'RECURRING', 'CONDITIONAL', 'BACKGROUND']) {
    assert.match(index + appJs, new RegExp(type));
  }
  assert.match(index, /id="view-knowledge"/);
  assert.match(index, /id="view-executions"/);
  assert.doesNotMatch(index, /Executions & Audit Timeline/);
  for (const settings of ['cat-panel-connections', 'cat-panel-devices', 'cat-panel-privacy', 'cat-panel-account']) {
    assert.match(index, new RegExp(settings));
  }
});

test('Desktop and mobile navigation stay semantically aligned and accessible', () => {
  const index = read('public/index.html');
  const desktopTabs = [...(index.match(/<ul class="nav-menu">([\s\S]*?)<\/ul>/)?.[1] || '').matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const mobileTabs = [...index.matchAll(/class="(?:mob-nav-item|mh-nav-item)[^"]*"\s+data-tab="([^"]+)"/g)].map((m) => m[1]);
  for (const tab of ['tab-home', 'tab-inbox', 'tab-create', 'tab-canvas', 'tab-settings']) {
    assert.ok(desktopTabs.includes(tab), `${tab} in desktop nav`);
    assert.ok(mobileTabs.includes(tab), `${tab} in mobile nav`);
  }
  assert.match(index, /title="Activity"/);
  assert.match(read('public/desktop/desktop-home.css'), /\.nav-link:focus|:focus-visible/);
});

test('Sidebar feature mapping document exists and records approval relocation', () => {
  const mapping = read('docs/NAGEX_SIDEBAR_FEATURE_MAPPING.md');
  assert.match(mapping, /Home\s*\nInbox\s*\nCreate\s*\nCanvas\s*\nTasks\s*\nKnowledge\s*\nActivity\s*\nSettings/);
  assert.match(mapping, /Deferred approvals -> Inbox > Approvals/);
  assert.match(mapping, /Live approval \/ execution -> Right Execution Rail/);
});
