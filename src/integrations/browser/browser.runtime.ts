import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { NagexError } from '../../common/errors.js';
import { resolveNagexDataDir } from '../../governance/file-record.store.js';

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
  screenshot(sessionId: string): Promise<Buffer>;
  // Resolves a selector without acting on it — used both to validate
  // "exactly one match" before click/type/select (fail closed otherwise)
  // and to classify a click's consequence from the target's visible text.
  resolveSelector(sessionId: string, selector: string): Promise<BrowserElementMatch>;
  click(sessionId: string, selector: string): Promise<void>;
  type(sessionId: string, selector: string, text: string): Promise<void>;
  select(sessionId: string, selector: string, value: string): Promise<void>;
  scroll(sessionId: string, direction: 'up' | 'down', amountPx: number): Promise<void>;
  wait(sessionId: string, ms: number): Promise<void>;
  // Releases every underlying resource this runtime instance holds (all
  // contexts and, if applicable, the browser process itself). A live
  // server never calls this on its process-lifetime singleton; it exists
  // so tests (and any future graceful-shutdown path) never leak a real
  // browser process past the runtime instance's own lifetime.
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

  public async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.requirePage(sessionId);
    return page.screenshot({ type: 'png' });
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
