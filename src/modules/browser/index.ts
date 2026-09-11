// Phase 04 — Browser Module Extraction.
//
// The only public surface external consumers may depend on. Everything
// else in this module (Playwright session/page tracking, evidence
// filesystem internals, click-consequence classification tables, the
// human-verification keyword list, ...) stays module-private.
export { BrowserToolService } from './browser.service.js';
export { browserRuntime, isBrowserRuntimeAvailableSync } from './browser.runtime.js';
export { browserSessionStore } from './browser-session.store.js';
export { isUrlSafe } from './browser-url-validator.js';

export type { BrowserSessionRecord, BrowserSessionStatus } from './browser-session.store.js';
export type { BrowserActionResult, BrowserClickResult, BrowserClickExecuted, BrowserClickApprovalRequired, BrowserEvidence } from './browser.service.js';
export type { BrowserRuntime, BrowserSnapshot } from './browser.runtime.js';
export type { FindResult, ExtractResult, StructuredBrowserSnapshot } from './browser.types.js';
