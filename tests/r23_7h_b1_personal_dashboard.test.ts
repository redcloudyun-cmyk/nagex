import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createServerInstance } from '../src/server_web.js';

test('R23.7H-B1 - consolidated Personal Dashboard contract and responsive shell', async (t) => {
  const server = createServerInstance();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${port}`] });
  const evidenceDir = path.join(process.cwd(), 'artifacts', 'r23.7h-b1');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const run = async (width: number, height: number, locale: 'EN' | 'KR') => {
    const page = await browser.newPage({ viewport: { width, height }, extraHTTPHeaders: { 'Accept-Language': locale === 'KR' ? 'ko-KR,ko' : 'en-US,en' } });
    try {
      await page.addInitScript((selectedLocale) => localStorage.setItem('nagex_locale', selectedLocale), locale === 'KR' ? 'ko' : 'en');
      await page.goto(`http://127.0.0.1:${port}/?demo=1`);
      const root = width <= 768 ? '#mobile-view-home' : '#view-home';
      await page.waitForFunction((selector) => (globalThis as any).document.querySelectorAll(`${selector} [data-home-section]`).length === 5, root, { timeout: 15_000 });
      const result = await page.evaluate((selector) => {
        const doc = (globalThis as any).document;
        const sections = [...doc.querySelectorAll(`${selector} [data-home-section]`)].map((el: any) => el.getAttribute('data-home-section'));
        const keys = [...doc.querySelectorAll(`${selector} [data-source-key]`)].map((el: any) => el.getAttribute('data-source-key'));
        const states = [...doc.querySelectorAll(`${selector} .ph-state`)].map((el: any) => el.getAttribute('data-state') || '');
        const headings = [...doc.querySelectorAll(`${selector} [data-home-section] h2`)].map((el: any) => el.textContent?.trim() || '');
        const unnamedButtons = [...doc.querySelectorAll(`${selector} [data-home-section] button`)].filter((el: any) => !(el.textContent || el.getAttribute('aria-label') || '').trim()).length;
        return { sections, keys, states, headings, unnamedButtons, text: doc.querySelector(selector)?.textContent || '', overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth };
      }, root);
      assert.deepEqual(result.sections.sort(), ['needs-attention', 'preparing', 'recent', 'right-now', 'today']);
      assert.equal(new Set(result.keys).size, result.keys.length, 'source record is visible once');
      const allowed = new Set(['Prepared', 'Needs approval', 'In progress', 'Completed', 'Needs your action', 'Failed', 'Unavailable']);
      assert.equal(result.states.every((state) => allowed.has(state)), true);
      assert.equal(result.headings.filter(Boolean).length, 5, 'each semantic section has an accessible heading');
      assert.equal(result.unnamedButtons, 0, 'every dashboard action has an accessible name');
      assert.doesNotMatch(result.text, /priorityClass|sourceRef|Model Router|Capability Broker/);
      assert.equal(result.overflow, false);
      const acceptedState = await page.evaluate(() => (globalThis as any).NAGEX_PERSONAL_HOME.normalize({ recentResults: [{ id: 'accepted', sourceType: 'ACTIVITY', title: 'Email accepted', providerStatus: 'PROVIDER_ACCEPTED' }] }).recent[0].state);
      assert.equal(acceptedState, 'In progress', 'provider acceptance must not be presented as completion');
      await page.screenshot({ path: path.join(evidenceDir, `${width <= 768 ? 'mobile' : 'desktop'}-${width}-${locale.toLowerCase()}.png`), fullPage: true });
    } finally { await page.close(); }
  };

  await t.test('Desktop EN', () => run(1440, 900, 'EN'));
  await t.test('Desktop KR', () => run(1440, 900, 'KR'));
  for (const locale of ['EN', 'KR'] as const) {
    await t.test(`Mobile 360 ${locale}`, () => run(360, 800, locale));
    await t.test(`Mobile 390 ${locale}`, () => run(390, 844, locale));
    await t.test(`Mobile 430 ${locale}`, () => run(430, 932, locale));
  }
  await t.test('partial source failure preserves the rest of Home', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/api/v1/personal/home', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      generatedAt: new Date().toISOString(), rightNow: { type: 'TASK', title: 'Grounded active task', summary: 'Still running', sourceRef: 'task-live', state: 'In progress' },
      today: { meetings: [] }, needsAttention: [], preparedForYou: [], workingForYou: [{ id: 'work-1', sourceType: 'TASK', sourceId: 'task-work', type: 'TASK', title: 'Preparing evidence', state: 'In progress' }], recentResults: [], sourceStatus: { calendar: 'UNAVAILABLE', gmail: 'CONNECTED', activity: 'OK', tasks: 'OK' },
    }) }));
    await page.goto(`http://127.0.0.1:${port}/?demo=1`);
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('#view-home [data-home-section]').length === 5);
    const text = await page.locator('#view-home').innerText();
    assert.match(text, /Grounded active task/);
    assert.match(text, /unavailable/i);
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-partial-source-failure-en.png'), fullPage: true });
    await page.close();
  });
  await browser.close();
  server.close();
});
