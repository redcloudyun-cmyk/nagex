import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { NagexError } from '../../common/errors.js';
import { resolveNagexDataDir } from '../../governance/file-record.store.js';
import type { StructuredBrowserSnapshot, FindResult, ExtractResult, ElementMatchCandidate, StructuredLink, StructuredButton, StructuredInput, StructuredForm } from '../../browser/browser.types.js';

// NAgex Browser Runtime — Phase B / Browser Agent MVP (MASTER.md Section
// 14.5, item 06). This is the ONE concrete implementation of the
// BrowserRuntime interface below; every caller (browser.service.ts) depends
// only on the interface, so a future runtime (a different automation
// library, a remote/node-based runtime — see Section 14's Phase G4 "Node
// protocol") can replace this file without touching any tool logic.

export interface BrowserTabInfo {
  index: number;
  url: string;
  title: string;
}

export interface BrowserElementMatch {
  count: number;
  role: string | null;
  text: string | null;
  isFormControl: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  // A simplified, size-capped text extraction of the page — never the raw
  // DOM/HTML — for read-only "what does this page say" use (item 6: return
  // readable results inline).
  text: string;
}

export interface BrowserRuntime {
  // Cheap, synchronous-in-spirit-but-here-async capability probe. Callers
  // needing a synchronous answer (the Tool Registry's getLiveStatus) use
  // isAvailableSync() instead — see browserRuntimeLiveStatus() below.
  isAvailable(): Promise<boolean>;
  openSession(sessionId: string): Promise<{ url: string; title: string }>;
  closeSession(sessionId: string): Promise<void>;
  hasSession(sessionId: string): boolean;
  navigate(sessionId: string, url: string): Promise<{ url: string; title: string }>;
  listTabs(sessionId: string): Promise<BrowserTabInfo[]>;
  snapshot(sessionId: string): Promise<BrowserSnapshot>;
  structuredSnapshot(sessionId: string): Promise<StructuredBrowserSnapshot>;
  screenshot(sessionId: string): Promise<Buffer>;
  find(sessionId: string, query: string): Promise<FindResult>;
  extract(sessionId: string, target?: 'text' | 'links' | 'buttons' | 'inputs' | 'all'): Promise<ExtractResult>;
  back(sessionId: string): Promise<{ url: string; title: string }>;
  forward(sessionId: string): Promise<{ url: string; title: string }>;
  reload(sessionId: string): Promise<{ url: string; title: string }>;
  clearProfile(sessionId: string): Promise<void>;
  // Resolves a selector without acting on it — used both to validate
  // "exactly one match" before click/type/select (fail closed otherwise)
  // and to classify a click's consequence from the target's visible text.
  resolveSelector(sessionId: string, selector: string): Promise<BrowserElementMatch>;
  click(sessionId: string, selector: string): Promise<void>;
  type(sessionId: string, selector: string, text: string): Promise<void>;
  select(sessionId: string, selector: string, value: string): Promise<void>;
  scroll(sessionId: string, direction: 'up' | 'down', amountPx: number): Promise<void>;
  wait(sessionId: string, ms: number): Promise<void>;
  shutdown(): Promise<void>;
}

const MAX_SNAPSHOT_TEXT_LENGTH = 4000;
const MAX_WAIT_MS = 15_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

let cachedAvailable: boolean | null = null;

// Synchronous, cheap: checks that the Chromium binary Playwright expects is
// actually present on disk. Never launches a browser just to answer this —
// mirrors googleCalendarLiveStatus()/gmailLiveStatus()'s pattern of
// reporting live only from a real, checkable signal, and ToolRegistry's
// getLiveStatus contract is itself synchronous.
export function isBrowserRuntimeAvailableSync(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    const execPath = chromium.executablePath();
    cachedAvailable = Boolean(execPath) && fs.existsSync(execPath);
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

// Test-only: forces the next isBrowserRuntimeAvailableSync() call to
// recompute instead of returning a cached value from an earlier test.
export function resetBrowserRuntimeAvailabilityCache(): void {
  cachedAvailable = null;
}

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();

  constructor(
    // NAGEX_BROWSER_PERSISTENT_PROFILE=1 keeps cookies/local storage across
    // process restarts in a NAgex-owned profile directory — never the
    // user's real browser profile. Unset/false (the default) uses a fresh,
    // isolated in-memory-only context per launch, so nothing about a
    // browser session survives past this process by default (item 2:
    // persistent cookies optional/configurable, default off).
    private readonly persistent: boolean = process.env.NAGEX_BROWSER_PERSISTENT_PROFILE === '1',
    private readonly profileDir: string = resolveNagexDataDir('browser-profile', 'NAGEX_BROWSER_PROFILE_DIR'),
  ) {}

  public async isAvailable(): Promise<boolean> {
    return isBrowserRuntimeAvailableSync();
  }

  public hasSession(sessionId: string): boolean {
    return this.pages.has(sessionId);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  public async openSession(sessionId: string): Promise<{ url: string; title: string }> {
    if (this.pages.has(sessionId)) {
      const page = this.pages.get(sessionId)!;
      return { url: page.url(), title: await page.title() };
    }
    let page: Page;
    if (this.persistent) {
      fs.mkdirSync(path.join(this.profileDir, sessionId), { recursive: true, mode: 0o700 });
      const context = await chromium.launchPersistentContext(path.join(this.profileDir, sessionId), { headless: true });
      this.contexts.set(sessionId, context);
      page = context.pages()[0] ?? (await context.newPage());
    } else {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext();
      this.contexts.set(sessionId, context);
      page = await context.newPage();
    }
    await page.goto('about:blank');
    this.pages.set(sessionId, page);
    return { url: page.url(), title: await page.title() };
  }

  public async closeSession(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }
    this.pages.delete(sessionId);
  }

  // Closes every remaining context and the shared Chromium process itself.
  // Never called by a live server (the runtime is a process-lifetime
  // singleton there), but essential for anything — tests above all — that
  // constructs its own PlaywrightBrowserRuntime instance and must not leak
  // a real browser process past that instance's lifetime.
  public async shutdown(): Promise<void> {
    for (const context of this.contexts.values()) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    this.pages.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private requirePage(sessionId: string): Page {
    const page = this.pages.get(sessionId);
    if (!page) {
      throw new NagexError({ code: 'BROWSER_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Browser session ${sessionId} is not open.`, request_id: sessionId });
    }
    return page;
  }

  public async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return { url: page.url(), title: await page.title() };
  }

  public async listTabs(sessionId: string): Promise<BrowserTabInfo[]> {
    const context = this.contexts.get(sessionId);
    if (!context) return [];
    const pages = context.pages();
    const tabs: BrowserTabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      tabs.push({ index: i, url: pages[i].url(), title: await pages[i].title() });
    }
    return tabs;
  }

  public async snapshot(sessionId: string): Promise<BrowserSnapshot> {
    const page = this.requirePage(sessionId);
    const title = await page.title();
    // Runs inside the browser page, not Node — this file's tsconfig has no
    // DOM lib, so `document` is reached via globalThis to avoid needing one.
    const text = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
      return doc && doc.body ? doc.body.innerText || '' : '';
    });
    return { url: page.url(), title, text: truncate(text || '', MAX_SNAPSHOT_TEXT_LENGTH) };
  }

  public async structuredSnapshot(sessionId: string): Promise<StructuredBrowserSnapshot> {
    const page = this.requirePage(sessionId);
    const title = await page.title();
    const url = page.url();

    const result = await page.evaluate(() => {
      const g = globalThis as any;
      const doc = g.document;
      if (!doc || !doc.body) {
        return { text: '', links: [], buttons: [], inputs: [], forms: [] };
      }

      const text = (doc.body.innerText || '').slice(0, 4000);

      const links = Array.from(doc.querySelectorAll('a'))
        .slice(0, 30)
        .map((a: any) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim(), href: a.href || '' }))
        .filter((l: any) => l.text || l.href);

      const buttons = Array.from(doc.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
        .slice(0, 30)
        .map((b: any) => ({ text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim(), id: b.id || undefined, role: b.getAttribute('role') || 'button' }))
        .filter((b: any) => b.text);

      const inputs = Array.from(doc.querySelectorAll('input, textarea, select'))
        .slice(0, 30)
        .map((i: any) => ({
          label: i.getAttribute('aria-label') || i.name || i.id || undefined,
          name: i.name || undefined,
          type: i.type || 'text',
          placeholder: i.placeholder || undefined,
          value: i.value || undefined,
        }));

      const forms = Array.from(doc.querySelectorAll('form'))
        .slice(0, 10)
        .map((f: any) => ({ action: f.action || undefined, method: f.method || 'get', inputCount: f.querySelectorAll('input, select, textarea').length }));

      return { text, links, buttons, inputs, forms };
    });

    return { url, title, text: truncate(result.text || '', MAX_SNAPSHOT_TEXT_LENGTH), links: result.links, buttons: result.buttons, inputs: result.inputs, forms: result.forms };
  }

  public async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.requirePage(sessionId);
    return page.screenshot({ type: 'png' });
  }

  public async find(sessionId: string, query: string): Promise<FindResult> {
    const page = this.requirePage(sessionId);
    const qLower = query.toLowerCase();

    const candidates = await page.evaluate((searchTerm) => {
      const g = globalThis as any;
      const doc = g.document;
      if (!doc || !doc.body) return [];

      const list: Array<{ selector: string; role: string; text: string; isFormControl: boolean; score: number }> = [];
      const elements = Array.from(doc.querySelectorAll('button, a, input, select, textarea, [role]'));

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i] as any;
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        const textLower = text.toLowerCase();

        if (textLower.includes(searchTerm)) {
          const tagName = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tagName === 'button' ? 'button' : tagName === 'a' ? 'link' : tagName === 'select' ? 'select' : tagName);
          const isFormControl = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
          const selector = el.id ? `#${el.id}` : el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : text ? `${tagName}:has-text("${text.slice(0, 20)}")` : `${tagName}:nth-of-type(${i + 1})`;
          const score = textLower === searchTerm ? 100 : 80;

          list.push({ selector, role, text, isFormControl, score });
        }
      }
      return list.slice(0, 10);
    }, qLower);

    return { query, candidates, bestMatch: candidates.length === 1 ? candidates[0] : undefined };
  }

  public async extract(sessionId: string, target: 'text' | 'links' | 'buttons' | 'inputs' | 'all' = 'all'): Promise<ExtractResult> {
    const snap = await this.structuredSnapshot(sessionId);
    const timestamp = new Date().toISOString();

    const extracted: ExtractResult['extracted'] = {};
    if (target === 'text' || target === 'all') extracted.text = snap.text;
    if (target === 'links' || target === 'all') extracted.links = snap.links;
    if (target === 'buttons' || target === 'all') extracted.buttons = snap.buttons;
    if (target === 'inputs' || target === 'all') extracted.inputs = snap.inputs;

    extracted.summary = `Page '${snap.title}' (${snap.url}): ${snap.links.length} links, ${snap.buttons.length} buttons, ${snap.inputs.length} inputs.`;

    return { url: snap.url, title: snap.title, target, extracted, timestamp };
  }

  public async back(sessionId: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage(sessionId);
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    return { url: page.url(), title: await page.title() };
  }

  public async forward(sessionId: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage(sessionId);
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    return { url: page.url(), title: await page.title() };
  }

  public async reload(sessionId: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage(sessionId);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    return { url: page.url(), title: await page.title() };
  }

  public async clearProfile(sessionId: string): Promise<void> {
    await this.closeSession(sessionId);
    if (this.persistent) {
      const sessDir = path.join(this.profileDir, sessionId);
      if (fs.existsSync(sessDir)) {
        fs.rmSync(sessDir, { recursive: true, force: true });
      }
    }
  }

  public async resolveSelector(sessionId: string, selector: string): Promise<BrowserElementMatch> {
    const page = this.requirePage(sessionId);
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) return { count: 0, role: null, text: null, isFormControl: false };
    const first = locator.first();
    const [text, tagName, roleAttr, typeAttr] = await Promise.all([
      first.innerText().catch(() => first.getAttribute('aria-label').then((v) => v || '').catch(() => '')),
      first.evaluate((el) => el.tagName.toLowerCase()).catch(() => ''),
      first.getAttribute('role').catch(() => null),
      first.getAttribute('type').catch(() => null),
    ]);
    const role = roleAttr || (tagName === 'button' ? 'button' : tagName === 'a' ? 'link' : tagName === 'select' ? 'select' : tagName === 'input' || tagName === 'textarea' ? 'textbox' : tagName);
    const isFormControl = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    return { count, role, text: (text || '').trim() || null, isFormControl: isFormControl || typeAttr === 'submit' };
  }

  public async click(sessionId: string, selector: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.locator(selector).first().click({ timeout: 10_000 });
  }

  public async type(sessionId: string, selector: string, text: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.locator(selector).first().fill(text, { timeout: 10_000 });
  }

  public async select(sessionId: string, selector: string, value: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.locator(selector).first().selectOption(value, { timeout: 10_000 });
  }

  public async scroll(sessionId: string, direction: 'up' | 'down', amountPx: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.mouse.wheel(0, direction === 'down' ? amountPx : -amountPx);
  }

  public async wait(sessionId: string, ms: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.waitForTimeout(Math.min(ms, MAX_WAIT_MS));
  }
}

// Process-lifetime singleton — one runtime instance shares one underlying
// Chromium process across every NAgex browser session (item 14: "one
// browser runtime" for the MVP).
export const browserRuntime = new PlaywrightBrowserRuntime();
