// MASTER.md Section 14.12 — Agentless Command UI / Navigation Redefinition.
//
// Verifies the default consumer sidebar is reduced to exactly five flat
// items (Home/Inbox/Activity/Vault/Settings, no section labels), that the
// reclassified features (Tasks/Memory/Knowledge/Approvals/Skills/Tools)
// are gone from that sidebar but remain fully reachable from Settings, and
// that nothing was deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function extractBetween(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return html.slice(start, end);
}

test('the default consumer sidebar contains exactly five nav items — Home, Inbox, Activity, Vault, Settings — in that order', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const navMenu = extractBetween(html, '<ul class="nav-menu">', '</ul>');

    const dataTabs = [...navMenu.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(dataTabs, ['tab-home', 'tab-inbox', 'tab-executions', 'tab-vault', 'tab-settings']);

    // No "More" / "Advanced" section labels or dividers in default mode.
    assert.doesNotMatch(navMenu, /nav-header-divider/);
    assert.doesNotMatch(navMenu, /nav\.more|nav\.advanced/);
  });
});

test('reclassified features are absent from the default sidebar nav-menu', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const navMenu = extractBetween(html, '<ul class="nav-menu">', '</ul>');

    for (const tab of ['tab-tasks', 'tab-memory', 'tab-knowledge', 'tab-approvals', 'tab-skills', 'tab-tools']) {
      assert.doesNotMatch(navMenu, new RegExp(`data-tab="${tab}"`), `${tab} must not be a default sidebar item`);
    }
  });
});

test('Inbox is labeled via nav.inbox, not the old nav.capture label, in the sidebar', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const navMenu = extractBetween(html, '<ul class="nav-menu">', '</ul>');
    const inboxItem = extractBetween(navMenu, 'data-tab="tab-inbox"', '</li>');
    assert.match(inboxItem, /data-i18n="nav\.inbox"/);
    assert.doesNotMatch(inboxItem, /data-i18n="nav\.capture"/);
  });
});

test('Settings surfaces real navigation to every reclassified feature — nothing is deleted, only moved', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const settingsView = extractBetween(html, 'id="view-settings"', '<!-- Right Context Drawer');

    for (const tab of ['tab-memory', 'tab-tasks', 'tab-knowledge', 'tab-approvals', 'tab-skills', 'tab-tools']) {
      assert.match(
        settingsView,
        new RegExp(`onclick="window\\.NAGEX\\.switchTab\\('${tab}'\\)"`),
        `Settings must link to ${tab}`
      );
    }

    // Advanced is a distinct, collapsed-by-default group within Settings.
    assert.match(settingsView, /id="settings-advanced-list"[^>]*hidden/);
    assert.match(settingsView, /id="btn-settings-advanced-toggle"/);
  });
});

test('every reclassified view still exists and is reachable — deep links do not break', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    for (const viewId of ['view-tasks', 'view-memory', 'view-knowledge', 'view-approvals', 'view-skills', 'view-tools', 'view-inbox', 'view-executions', 'view-vault', 'view-settings']) {
      assert.match(html, new RegExp(`id="${viewId}"`), `${viewId} must still exist`);
    }
    // Each formerly-top-level view offers a way back to Settings.
    for (const viewId of ['view-memory', 'view-tasks', 'view-skills', 'view-tools', 'view-knowledge', 'view-approvals']) {
      const view = extractBetween(html, `id="${viewId}"`, viewId === 'view-approvals' ? 'mountain-hero-banner-sub' : 'view-header');
      assert.match(view, /settings-back-link/, `${viewId} should offer a way back to Settings`);
    }
  });
});

test('the mobile bottom nav mirrors the reduced consumer set and drops Tasks', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const mobileNav = extractBetween(html, '<nav class="mobile-bottom-nav">', '</nav>');
    assert.match(mobileNav, /switchTab\('tab-home'\)/);
    assert.match(mobileNav, /switchTab\('tab-inbox'\)/);
    assert.doesNotMatch(mobileNav, /switchTab\('tab-tasks'\)/);
    assert.doesNotMatch(mobileNav, /data-i18n="nav\.capture"/);
  });
});

test('nav.inbox and the new settings.* keys resolve to real, non-empty EN and KR strings', async () => {
  await withServer(async (origin) => {
    const i18nContent = await (await fetch(`${origin}/i18n.js`)).text();
    const keys = [
      'nav.inbox',
      'settings.connections',
      'settings.memory',
      'settings.automations',
      'settings.advanced',
      'settings.knowledge',
      'settings.approvals',
      'settings.skills',
      'settings.tools',
      'settings.backToSettings',
    ];
    for (const key of keys) {
      const matches = i18nContent.match(new RegExp(`'${key.replace('.', '\\.')}': '([^']+)'`, 'g'));
      assert.ok(matches && matches.length >= 2, `${key} should have both an EN and a KR entry`);
    }
  });
});
