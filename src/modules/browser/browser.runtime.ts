import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type FrameLocator, type Locator, type Page } from 'playwright';
import { NagexError } from '../../common/errors.js';
import { resolveNagexDataDir } from '../../governance/file-record.store.js';
import { validateOutboundUrl, type OutboundDnsResolver } from '../../security/outbound-url-policy.js';
import type { StructuredBrowserSnapshot, FindResult, ExtractResult, ElementMatchCandidate, StructuredLink, StructuredButton, StructuredInput, StructuredForm, InteractiveElementSummary } from './browser.types.js';
import { mapDescribeInPage, mapScanInPage, mapSelectorsInPage, pickBest, rankMapElements, type RawMapElement } from './element-map.js';
import { keyActivationInPage, type KeyActivation, type KeyActivationKind } from './key-activation.js';
import { EXPECTATION_SURFACE_CHARS, readExpectationSurfaceInPage, type ExpectationSurface } from './expectation.js';
import { OBSERVE_PAGE_ARGS, observePageInPage, observeTargetInPage, readFieldInPage, type FieldState, type PageObservation, type TargetObservation } from './action-verification.js';

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
  // The accessible name when it says something the visible text does not (an icon-only button named by aria-label, "Go" labelled "Buy now"). Present only then, so a plain button's
  // approval payload is unchanged. Consequence classification reads it too.
  accessibleName?: string;
  // The field is for a secret (a password, a one-time code): NAgex never types into it, whoever asks.
  sensitiveField?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  // A simplified, size-capped text extraction of the page — never the raw
  // DOM/HTML — for read-only "what does this page say" use (item 6: return
  // readable results inline). `text.length` always equals returnedCharacters
  // (it is exactly what was kept after any truncation).
  text: string;
  // Real extracted length BEFORE truncation — a caller (e.g. CaptureProcessor)
  // needs this to tell a genuinely short page apart from a long one that was
  // capped, which `text.length` alone cannot do (Phase 1 STEP 3 truthfulness
  // fix — see MAX_SNAPSHOT_TEXT_LENGTH below).
  totalCharacters: number;
  // Always equal to `text.length` — included alongside totalCharacters/
  // truncated so a consumer never has to re-derive it.
  returnedCharacters: number;
  truncated: boolean;
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
  // DC1-8 — a single named key (e.g. "Enter", "Tab", "Escape") via
  // Playwright's own key-name vocabulary, applied to the currently
  // focused element (no selector — mirrors real keyboard input, which has
  // no target of its own beyond whatever already has focus).
  keypress(sessionId: string, key: string): Promise<void>;
  // What pressing `key` now would activate (a button, a link, a form's submit button), without pressing it. A runtime that cannot tell leaves it out, and Enter / Space are then not pressed.
  describeKeyActivation?(sessionId: string, key: string): Promise<KeyActivation>;
  // The visible text (and the values of visible fields) of the page, or of one element, for a deterministic check of what the page must show.
  readExpectationSurface?(sessionId: string, selector: string | null): Promise<ExpectationSurface>;
  // Optional observation primitives (action-verification.ts). A runtime that cannot observe leaves them out; the service then reports NOT_VERIFIED / NO_OBSERVATION - it never guesses a result.
  observePage?(sessionId: string): Promise<PageObservation>;
  observeTarget?(sessionId: string, selector: string): Promise<TargetObservation | null>;
  readFieldState?(sessionId: string, selector: string, expected: string): Promise<FieldState | null>;
  shutdown(): Promise<void>;
}

// Phase 1 STEP 3: raised from the original 4000 so CaptureProcessor's
// existing 8000-character chunk/synthesis path (shared with PDF
// understanding) can actually be reached for real long-form pages, while
// still bounding memory/serialization size — a "sane maximum," not
// unbounded. Never silently discards how much was cut: see truncateWithMeta.
const MAX_SNAPSHOT_TEXT_LENGTH = 20_000;
const MAX_WAIT_MS = 15_000;
// How many page elements one element-map pass lists (find) and how many of them the snapshot reports.
const ELEMENT_MAP_SCAN_LIMIT = 400;
const SNAPSHOT_INTERACTIVE_LIMIT = 60;
// How far the element map goes into a page: nodes looked at in total (document + open shadow roots), time spent, and how many frames, how deep. Beyond a bound the map says so (`limits`) instead of pretending to be complete.
const ELEMENT_MAP_NODE_BUDGET = 40_000;
const ELEMENT_MAP_DEADLINE_MS = 2_500;
const MAX_MAPPED_FRAMES = 8;
const MAX_FRAME_DEPTH = 3;
// Separates the selector of an <iframe> from the selector of a control inside it: `iframe#pay ⟫ button#go`. NAgex's own notation (Playwright cannot express a frame in a plain selector string); it is
// split outside quotes only, so a page attribute that contains it can never change what a selector means.
export const FRAME_PATH_SEPARATOR = ' ⟫ ';

// Splits `iframe#a ⟫ iframe#b ⟫ button` into its segments, ignoring a separator that sits inside a quoted attribute value.
export function splitFramePath(selector: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < selector.length) { current += selector[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (selector.startsWith(FRAME_PATH_SEPARATOR, i)) { segments.push(current); current = ''; i += FRAME_PATH_SEPARATOR.length - 1; continue; }
    current += ch;
  }
  segments.push(current);
  return segments;
}

interface TruncationResult {
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  truncated: boolean;
}

// Unlike the old truncate() this never discards the real pre-truncation
// length — a caller needs totalCharacters to tell a genuinely short page
// apart from a long one that was capped (Phase 1 STEP 3 truthfulness fix).
function truncateWithMeta(text: string, max: number): TruncationResult {
  const totalCharacters = text.length;
  const truncated = totalCharacters > max;
  const returnedText = truncated ? text.slice(0, max) : text;
  return { text: returnedText, totalCharacters, returnedCharacters: returnedText.length, truncated };
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
    private readonly outboundResolver?: OutboundDnsResolver,
  ) {}

  public async isAvailable(): Promise<boolean> {
    return isBrowserRuntimeAvailableSync();
  }

  public hasSession(sessionId: string): boolean {
    return this.pages.has(sessionId);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--explicitly-allowed-ports=6697,6665,6666,6667,6668,6669'],
      });
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
      const context = await chromium.launchPersistentContext(path.join(this.profileDir, sessionId), {
        headless: true,
        args: ['--explicitly-allowed-ports=6697,6665,6666,6667,6668,6669'],
      });
      await this.installOutboundPolicy(context);
      this.contexts.set(sessionId, context);
      page = context.pages()[0] ?? (await context.newPage());
    } else {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext();
      await this.installOutboundPolicy(context);
      this.contexts.set(sessionId, context);
      page = await context.newPage();
    }
    await page.goto('about:blank');
    this.pages.set(sessionId, page);
    return { url: page.url(), title: await page.title() };
  }

  private async installOutboundPolicy(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (url === 'about:blank' || url.startsWith('data:')) {
        await route.continue();
        return;
      }
      try {
        await validateOutboundUrl(url, { resolver: this.outboundResolver, allowLocalTestDestinations: process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1' });
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
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
  // Called exactly once by a live server too, as the last step of
  // server_web.ts's SIGTERM/SIGINT graceful shutdown (the runtime is a
  // process-lifetime singleton there, so this only ever runs at process
  // exit) — and by anything else, tests above all, that constructs its own
  // PlaywrightBrowserRuntime instance and must not leak a real browser
  // process past that instance's lifetime.
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
    await validateOutboundUrl(url, { resolver: this.outboundResolver, allowLocalTestDestinations: process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1' });
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
    const { text: boundedText, totalCharacters, returnedCharacters, truncated } = truncateWithMeta(text || '', MAX_SNAPSHOT_TEXT_LENGTH);
    return { url: page.url(), title, text: boundedText, totalCharacters, returnedCharacters, truncated };
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

    const interactive = await this.interactiveSummary(page);
    return { url, title, text: truncateWithMeta(result.text || '', MAX_SNAPSHOT_TEXT_LENGTH).text, links: result.links, buttons: result.buttons, inputs: result.inputs, forms: result.forms, ...(interactive ? { interactive: interactive.list, ...(interactive.limits.length > 0 ? { interactiveLimits: interactive.limits } : {}) } : {}) };
  }

  // The interactive element map of the page (element-map.ts). It reads the page and changes nothing in it.
  // The locator for a selector, following a frame path (`iframe#a ⟫ button`) into same-origin frames.
  private locate(page: Page, selector: string): Locator {
    const segments = splitFramePath(selector);
    let scope: Page | FrameLocator = page;
    for (const frameSelector of segments.slice(0, -1)) scope = scope.frameLocator(frameSelector);
    return scope.locator(segments[segments.length - 1]);
  }

  // The whole page as one element map: the top document and its open shadow roots, plus every SAME-ORIGIN iframe (also nested ones), each control carrying a selector that works from the top page.
  // A frame of another origin (or with an opaque origin, e.g. sandboxed) is NOT entered - the browser's isolation is respected - and is reported in `limits`, as is any bound that cut the scan short.
  private async scanAll(page: Page, query?: string): Promise<{ elements: RawMapElement[]; limits: string[] }> {
    const startedAt = Date.now();
    const limits: string[] = [];
    const args = (remaining: number) => ({ limit: remaining, ...(query ? { query } : {}), nodeBudget: ELEMENT_MAP_NODE_BUDGET, deadlineMs: Math.max(200, ELEMENT_MAP_DEADLINE_MS - (Date.now() - startedAt)) });
    const top = await page.evaluate(mapScanInPage, args(ELEMENT_MAP_SCAN_LIMIT));
    const elements: RawMapElement[] = [...top.elements];
    if (top.truncated) limits.push('SCAN_TRUNCATED');

    let topOrigin = '';
    try { topOrigin = new URL(page.url()).origin; } catch { topOrigin = ''; }
    const prefixes = new Map<unknown, string>([[page.mainFrame(), '']]);
    let mapped = 0;
    let crossOrigin = 0;
    let opaque = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let depth = 0;
      for (let f = frame.parentFrame(); f; f = f.parentFrame()) depth++;
      if (depth > MAX_FRAME_DEPTH) { if (!limits.includes('FRAME_DEPTH_LIMIT')) limits.push('FRAME_DEPTH_LIMIT'); continue; }
      const parent = frame.parentFrame();
      if (!parent || !prefixes.has(parent)) continue; // its parent was not entered
      if (mapped >= MAX_MAPPED_FRAMES) { if (!limits.includes('FRAME_COUNT_LIMIT')) limits.push('FRAME_COUNT_LIMIT'); continue; }
      if (Date.now() - startedAt > ELEMENT_MAP_DEADLINE_MS) { if (!limits.includes('SCAN_TRUNCATED')) limits.push('SCAN_TRUNCATED'); break; }
      const url = frame.url();
      let origin = '';
      try { origin = new URL(url).origin; } catch { origin = ''; }
      const inherits = url === '' || url === 'about:blank' || url === 'about:srcdoc';
      if (!inherits && origin !== topOrigin) { crossOrigin++; continue; }
      try {
        // a sandboxed frame without allow-same-origin has an opaque origin even when its address is ours (window.origin, not location.origin: the latter is derived from the address, and is "null" for an about:srcdoc frame that really has our origin)
        if ((await frame.evaluate(() => (globalThis as unknown as { origin: string }).origin)) === 'null') { opaque++; continue; }
        // the selector of the <iframe> element, seen from its parent frame, that Playwright resolves to exactly that one element
        const handle = await frame.frameElement();
        const candidates: string[] = await handle.evaluate(mapSelectorsInPage as (el: any) => string[]);
        const parentPrefix = prefixes.get(parent) as string;
        let frameSelector: string | null = null;
        for (const candidate of candidates) {
          const full = parentPrefix ? `${parentPrefix}${FRAME_PATH_SEPARATOR}${candidate}` : candidate;
          try { if ((await this.locate(page, full).count()) === 1) { frameSelector = full; break; } } catch { /* try the next */ }
        }
        if (!frameSelector) { if (!limits.includes('FRAME_NOT_ADDRESSABLE')) limits.push('FRAME_NOT_ADDRESSABLE'); continue; }
        prefixes.set(frame, frameSelector);
        mapped++;
        const remaining = ELEMENT_MAP_SCAN_LIMIT - elements.length;
        if (remaining <= 0) { if (!limits.includes('SCAN_TRUNCATED')) limits.push('SCAN_TRUNCATED'); break; }
        const inner = await frame.evaluate(mapScanInPage, args(remaining));
        if (inner.truncated && !limits.includes('SCAN_TRUNCATED')) limits.push('SCAN_TRUNCATED');
        for (const el of inner.elements) {
          elements.push({ ...el, selectors: el.selectors.map((sel) => `${frameSelector}${FRAME_PATH_SEPARATOR}${sel}`), frame: frameSelector });
        }
      } catch {
        if (!limits.includes('FRAME_NOT_ADDRESSABLE')) limits.push('FRAME_NOT_ADDRESSABLE'); // detached while scanning, or not reachable
      }
    }
    if (crossOrigin > 0) limits.push(`CROSS_ORIGIN_FRAMES:${crossOrigin}`);
    if (opaque > 0) limits.push(`OPAQUE_ORIGIN_FRAMES:${opaque}`);
    return { elements: elements.map((el, index) => ({ ...el, index })), limits };
  }

  // The map is an addition to the snapshot: if it cannot be built on some page the snapshot is still returned, without it (never a failure of the snapshot, never an invented list).
  private async interactiveSummary(page: Page): Promise<{ list: InteractiveElementSummary[]; limits: string[] } | null> {
    try {
      const scan = await this.scanAll(page);
      const list = scan.elements
        .filter((el) => el.visible && el.selectors.length > 0)
        .slice(0, SNAPSHOT_INTERACTIVE_LIMIT)
        .map((el, index) => ({
          index,
          role: el.role,
          name: el.name.slice(0, 100),
          selector: el.selectors[0],
          enabled: el.enabled,
          ...(el.type ? { type: el.type } : {}),
          ...(el.context ? { context: el.context } : {}),
          ...(el.checked !== undefined ? { checked: el.checked } : {}),
          ...(el.value ? { value: el.value } : {}),
          ...(el.expanded !== undefined ? { expanded: el.expanded } : {}),
          ...(el.frame ? { frame: el.frame } : {}),
          ...(el.inShadow ? { inShadow: true } : {}),
        }));
      return { list, limits: scan.limits };
    } catch {
      return null;
    }
  }

  // Of the selectors the page verified for one element, the first that Playwright - the engine that will resolve it - also resolves to exactly one element. If none does, the first is returned
  // and resolveSelector refuses it later (exactly one match or nothing happens).
  private async verifiedSelector(page: Page, element: RawMapElement): Promise<string> {
    for (const selector of element.selectors) {
      try {
        if ((await this.locate(page, selector).count()) === 1) return selector;
      } catch {
        // a selector the engine cannot parse is skipped
      }
    }
    return element.selectors[0];
  }

  public async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.requirePage(sessionId);
    return page.screenshot({ type: 'png' });
  }

  // Finds the controls on the page that a person would call `query`: matched against the accessible name (aria-labelledby, aria-label, <label>, placeholder, title, alt, value, text), ranked
  // (exact > prefix > whole word > substring > all words; a weaker field or a disabled/obscured control ranks lower) and returned with a selector verified to select exactly that element.
  // Hidden controls are not candidates (they are only counted). `bestMatch` is set when one candidate is clearly ahead; two close candidates are left to the caller, who can tell them apart by
  // their `context`. Finding is not permission: acting on a candidate still needs exactly one match and, for a consequential click, Human Approval.
  public async find(sessionId: string, query: string): Promise<FindResult> {
    const page = this.requirePage(sessionId);
    const scan = await this.scanAll(page, query);
    const { ranked, hiddenMatches } = rankMapElements(scan.elements, query);

    const candidates: ElementMatchCandidate[] = [];
    for (const { element, score } of ranked) {
      candidates.push({
        selector: await this.verifiedSelector(page, element),
        role: element.role,
        text: element.name || element.text,
        isFormControl: element.isFormControl,
        score,
        name: element.name,
        ...(element.context ? { context: element.context } : {}),
        enabled: element.enabled,
        inViewport: element.inViewport,
        ...(element.type ? { type: element.type } : {}),
        ...(element.frame ? { frame: element.frame } : {}),
        ...(element.inShadow ? { inShadow: true } : {}),
      });
    }
    const best = pickBest(ranked.map((entry, index) => ({ score: entry.score, index })));
    return { query, candidates, bestMatch: best ? candidates[best.index] : undefined, ...(hiddenMatches > 0 ? { hiddenMatches } : {}), ...(scan.limits.length > 0 ? { limits: scan.limits } : {}) };
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

  // A frame path may only lead into frames of the page's own origin. The element map never lists anything else, and a path written by hand (or remembered from before the page changed) gets the same answer:
  // NAgex does not act inside another origin's frame or a sandboxed one.
  private async assertFramePathAllowed(sessionId: string, page: Page, frameSegments: string[]): Promise<boolean> {
    let scope: Page | FrameLocator = page;
    let topOrigin = '';
    try { topOrigin = new URL(page.url()).origin; } catch { topOrigin = ''; }
    for (const segment of frameSegments) {
      const handle = await scope.locator(segment).first().elementHandle({ timeout: 2_000 }).catch(() => null);
      const frame = handle ? await handle.contentFrame() : null;
      if (!frame) return false; // there is no such frame (any more): the selector simply does not resolve
      const url = frame.url();
      let origin = '';
      try { origin = new URL(url).origin; } catch { origin = ''; }
      const inherits = url === '' || url === 'about:blank' || url === 'about:srcdoc';
      const opaque = (await frame.evaluate(() => (globalThis as unknown as { origin: string }).origin).catch(() => 'null')) === 'null';
      if ((!inherits && origin !== topOrigin) || opaque) {
        throw new NagexError({ code: 'BROWSER_FRAME_NOT_ACCESSIBLE', category: 'POLICY', message: 'This frame belongs to another origin (or is sandboxed). NAgex does not act inside it.', request_id: sessionId });
      }
      scope = scope.frameLocator(segment);
    }
    return true;
  }

  public async resolveSelector(sessionId: string, selector: string): Promise<BrowserElementMatch> {
    const page = this.requirePage(sessionId);
    const frameSegments = splitFramePath(selector).slice(0, -1);
    if (frameSegments.length > 0 && !(await this.assertFramePathAllowed(sessionId, page, frameSegments))) return { count: 0, role: null, text: null, isFormControl: false };
    const locator = this.locate(page, selector);
    const count = await locator.count();
    if (count === 0) return { count: 0, role: null, text: null, isFormControl: false };
    const first = locator.first();
    const [text, tagName, roleAttr, typeAttr, autocompleteAttr] = await Promise.all([
      first.innerText().catch(() => first.getAttribute('aria-label').then((v) => v || '').catch(() => '')),
      first.evaluate((el) => el.tagName.toLowerCase()).catch(() => ''),
      first.getAttribute('role').catch(() => null),
      first.getAttribute('type').catch(() => null),
      first.getAttribute('autocomplete').catch(() => null),
    ]);
    const sensitiveField = tagName === 'input' && ((typeAttr || '').toLowerCase() === 'password' || /(one-time-code|current-password|new-password|cc-number|cc-csc)/i.test(autocompleteAttr || ''));
    const role = roleAttr || (tagName === 'button' ? 'button' : tagName === 'a' ? 'link' : tagName === 'select' ? 'select' : tagName === 'input' || tagName === 'textarea' ? 'textbox' : tagName);
    const isFormControl = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    // An icon-only control has no innerText: it is named by aria-label, title, value or an inner image. That name is what a person (and an approval prompt) knows the control by, and what
    // decides whether a click is consequential - "Buy now" must not go unapproved because its caption is an icon.
    const described = await first.evaluate(mapDescribeInPage as (el: any) => { accessibleName: string; visibleText: string }).catch(() => null);
    const visible = (text || '').trim();
    const named = typeof described?.accessibleName === 'string' ? described.accessibleName.trim() : '';
    return {
      count,
      role,
      text: visible || named || null,
      isFormControl: isFormControl || typeAttr === 'submit',
      ...(named && named !== visible ? { accessibleName: named } : {}),
      ...(sensitiveField ? { sensitiveField: true } : {}),
    };
  }

  public async click(sessionId: string, selector: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await this.locate(page, selector).first().click({ timeout: 10_000 });
  }

  public async type(sessionId: string, selector: string, text: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await this.locate(page, selector).first().fill(text, { timeout: 10_000 });
  }

  public async select(sessionId: string, selector: string, value: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await this.locate(page, selector).first().selectOption(value, { timeout: 10_000 });
  }

  public async scroll(sessionId: string, direction: 'up' | 'down', amountPx: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.mouse.wheel(0, direction === 'down' ? amountPx : -amountPx);
  }

  public async wait(sessionId: string, ms: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.waitForTimeout(Math.min(ms, MAX_WAIT_MS));
  }

  public async keypress(sessionId: string, key: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.keyboard.press(key);
  }

  public async readExpectationSurface(sessionId: string, selector: string | null): Promise<ExpectationSurface> {
    const page = this.requirePage(sessionId);
    const locator = selector ? this.locate(page, selector) : page.locator('body');
    if ((await locator.count()) !== 1) return { found: false, texts: [], truncated: false };
    return await locator.first().evaluate(readExpectationSurfaceInPage as (el: any, maxChars: number) => ExpectationSurface, EXPECTATION_SURFACE_CHARS);
  }

  public async describeKeyActivation(sessionId: string, key: string): Promise<KeyActivation> {
    const page = this.requirePage(sessionId);
    const handle = await page.evaluateHandle(keyActivationInPage as (key: string) => { kind: KeyActivationKind; el: unknown }, key);
    try {
      const kind = (await (await handle.getProperty('kind')).jsonValue()) as KeyActivationKind;
      if (kind === 'NONE' || kind === 'IMPLICIT_SUBMIT_UNRESOLVED') return { kind };
      const element = (await handle.getProperty('el')).asElement();
      if (!element) return { kind: 'NONE' };
      // a control inside a frame cannot be named by a selector of the top page: the caller must not press the key
      if ((await element.ownerFrame()) !== page.mainFrame()) return { kind: 'UNRESOLVED_FRAME' };
      const selectors = await element.evaluate(mapSelectorsInPage as (el: any) => string[]);
      return { kind, selectors: Array.isArray(selectors) ? selectors : [] };
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // What the page shows right now: address, title, a signature of its content, visible alert / status / error / success messages, invalid form fields, an open dialog. Read-only; the page is not touched.
  public async observePage(sessionId: string): Promise<PageObservation> {
    const page = this.requirePage(sessionId);
    await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {});
    const observed = await page.evaluate(observePageInPage, OBSERVE_PAGE_ARGS);
    return { url: page.url(), title: await page.title(), ...observed, messages: observed.messages as PageObservation['messages'] };
  }

  // The state of one control (null when it is no longer on the page): connected, visible, enabled, checked / expanded / pressed / selected, a link's destination.
  public async observeTarget(sessionId: string, selector: string): Promise<TargetObservation | null> {
    const page = this.requirePage(sessionId);
    try {
      const locator = this.locate(page, selector);
      if ((await locator.count()) !== 1) return null;
      return await locator.first().evaluate(observeTargetInPage as (el: any) => TargetObservation);
    } catch {
      return null;
    }
  }

  // Reads a field back and compares it, inside the page, with the text that was written; the value itself never leaves the page (a password stays private).
  public async readFieldState(sessionId: string, selector: string, expected: string): Promise<FieldState | null> {
    const page = this.requirePage(sessionId);
    try {
      const locator = this.locate(page, selector);
      if ((await locator.count()) !== 1) return null;
      return await locator.first().evaluate(readFieldInPage as (el: any, expected: string) => FieldState, expected);
    } catch {
      return null;
    }
  }
}

// Process-lifetime singleton — one runtime instance shares one underlying
// Chromium process across every NAgex browser session (item 14: "one
// browser runtime" for the MVP).
export const browserRuntime = new PlaywrightBrowserRuntime();
