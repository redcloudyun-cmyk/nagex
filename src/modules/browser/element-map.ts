// Interactive element map for the Browser Runtime.
//
// Why: `find` used to match visible text only (innerText / value / aria-label) over a fixed tag list and build its selector from the id, the name or the first 20 characters of text. Measured on
// deterministic pages that left whole classes of everyday controls untargetable - placeholder-only and <label for> inputs, icon buttons named by aria-label, ids such as "user:email", button text
// with quotes, a hidden duplicate in front of the visible control, a disabled twin, a clickable <div> - and an icon-only "Buy now" button was classified as non-consequential (its innerText is empty), so
// it was clicked without approval.
//
// What: ONE in-page pass lists the visible, interactive elements with an accessible name (aria-labelledby, aria-label, <label>, placeholder, title, alt, value, text), a role, state (enabled,
// obscured, in viewport), the nearest context text (to tell three identical "Add to cart" buttons apart) and an ordered list of selectors, each verified in the page to select exactly that element.
// The ranking (below) is pure Node code. The page is never mutated: no attribute, no style, no listener is added, and a password value is never read.
//
// What does not change: every action still goes through resolveSelector (exactly one match or refuse) -> classifyClickConsequence -> Human Approval -> re-resolve -> payload-hash consume. A map entry is a
// suggestion for a selector, never a permission.
//
// Technique credit: the idea of an indexed list of visible interactive elements with accessible names, and acting on it, is the common design of browser-use (MIT, c75e8476e26d) and the OpenHands
// browser tool (MIT, software-agent-sdk f5f849f5ab51), which wraps it. Nothing is copied from them; this is a small TypeScript implementation for the Playwright runtime NAgex already has.

export interface RawMapElement {
  index: number;
  /** selectors verified in the page to select exactly this element, best first */
  selectors: string[];
  tag: string;
  role: string;
  /** accessible name: aria-labelledby > aria-label > <label> > placeholder > title/alt/value > visible text */
  name: string;
  text: string;
  placeholder: string;
  label: string;
  title: string;
  ariaLabel: string;
  /** id / name attribute, a weak hint only */
  hint: string;
  type: string;
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  obscured: boolean;
  isFormControl: boolean;
  context: string;
  /** inside an open shadow root */
  inShadow?: boolean;
  /** the iframe chain this control is in (set by the runtime; absent for the top page) */
  frame?: string;
  checked?: boolean;
  expanded?: boolean;
}

export interface ElementMapOptions {
  limit: number;
  /** when given, only controls that could match it are described in full (a layout-free prefilter) */
  query?: string;
  /** most nodes gathered across the document and its open shadow roots */
  nodeBudget: number;
  /** wall-clock budget of the scan inside the page */
  deadlineMs: number;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------
// In-page code. Every function below is serialized with toString() into one script (see PAGE_SCRIPTS), so each one may use ONLY its arguments, other functions of this group and globalThis.
// Do not reference module-level values or imports from them.
// ----------------------------------------------------------------------------------------------------------------------------------------------

function mapClean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function mapVisibleText(el: any): string {
  // innerText follows the rendering (and is empty for a visibility:hidden element, whose text is still its name); textContent is the fallback
  const rendered = mapClean(el.innerText, 160);
  return rendered || mapClean(el.textContent, 160);
}

function mapAccessibleName(el: any): string {
  const g = globalThis as any;
  const doc = g.document;
  const tag = String(el.tagName || '').toLowerCase();
  const attr = (n: string) => (el.getAttribute ? el.getAttribute(n) : null);
  const labelledby = attr('aria-labelledby');
  if (labelledby) {
    const root = el.getRootNode ? el.getRootNode() : doc;
    const joined = labelledby.split(/\s+/).map((id: string) => { const t = root && root.getElementById ? root.getElementById(id) : doc.getElementById(id); return t ? mapClean(t.innerText !== undefined ? t.innerText : t.textContent, 120) : ''; }).filter(Boolean).join(' ');
    if (joined) return mapClean(joined, 120);
  }
  const aria = mapClean(attr('aria-label'), 120);
  if (aria) return aria;
  const type = String(attr('type') || '').toLowerCase();
  if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
    const v = mapClean(el.value, 120);
    if (v) return v;
    return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
  }
  if (tag === 'input' && type === 'image') { const a = mapClean(attr('alt'), 120); if (a) return a; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const labels = el.labels ? Array.from(el.labels as ArrayLike<any>) : [];
    const fromLabels = mapClean(labels.map((l: any) => mapVisibleText(l)).filter(Boolean).join(' '), 120);
    if (fromLabels) return fromLabels;
    const ph = mapClean(attr('placeholder'), 120);
    if (ph) return ph;
    const ti = mapClean(attr('title'), 120);
    if (ti) return ti;
    return '';
  }
  const text = mapVisibleText(el);
  if (text) return mapClean(text, 120);
  const img = el.querySelector ? el.querySelector('img[alt]') : null;
  const imgAlt = img ? mapClean(img.getAttribute('alt'), 120) : '';
  if (imgAlt) return imgAlt;
  const svgTitle = el.querySelector ? el.querySelector('svg title') : null;
  const svgText = svgTitle ? mapClean(svgTitle.textContent, 120) : '';
  if (svgText) return svgText;
  return mapClean(attr('title') || attr('alt') || attr('value'), 120);
}

function mapRoleOf(el: any): string {
  const explicit = el.getAttribute ? el.getAttribute('role') : null;
  if (explicit) return String(explicit).trim().split(/\s+/)[0].toLowerCase();
  const tag = String(el.tagName || '').toLowerCase();
  const type = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'label') return 'label';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return tag;
}

function mapIsVisible(el: any): boolean {
  const g = globalThis as any;
  const style = g.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  if (Number(style.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  // positioned off the document (the classic "skip link" at left:-9999px) cannot be clicked
  if (r.right + g.scrollX <= 0 || r.bottom + g.scrollY <= 0) return false;
  return true;
}

function mapIsEnabled(el: any): boolean {
  if (el.matches && el.matches(':disabled')) return false;
  return !(el.getAttribute && el.getAttribute('aria-disabled') === 'true');
}

// Every root a page has: the document and every OPEN shadow root inside it (closed shadow roots are, by definition, not reachable from script). Breadth first, bounded.
function mapRoots(): any[] {
  const g = globalThis as any;
  const doc = g.document;
  const roots: any[] = [doc];
  const MAX_ROOTS = 200;
  const MAX_NODES_PER_ROOT = 30000;
  for (let i = 0; i < roots.length && roots.length < MAX_ROOTS; i++) {
    const all = roots[i].querySelectorAll('*');
    const limit = Math.min(all.length, MAX_NODES_PER_ROOT);
    for (let j = 0; j < limit && roots.length < MAX_ROOTS; j++) {
      const shadow = all[j].shadowRoot;
      if (shadow) roots.push(shadow);
    }
  }
  return roots;
}

function mapQueryAll(roots: any[], selector: string): any[] {
  const out: any[] = [];
  for (const root of roots) {
    try {
      const found = root.querySelectorAll(selector);
      for (let i = 0; i < found.length; i++) out.push(found[i]);
    } catch {
      // not a valid selector for this root
    }
  }
  return out;
}

// The parent in the FLAT page: the parent element, or the shadow host when the element is the top of a shadow root.
function mapParentOrHost(node: any): any {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode ? node.getRootNode() : null;
  return root && root.host ? root.host : null;
}

function mapContextOf(el: any, ownName: string): string {
  let node = mapParentOrHost(el);
  for (let depth = 0; node && depth < 5; depth++, node = mapParentOrHost(node)) {
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    let text = mapClean(node.innerText !== undefined ? node.innerText : node.textContent, 400);
    // a shadow host's own text is only its light-DOM children; its shadow content is part of the flat page, so read the host's rendered text above and fall back to the root's text
    if (!text && node.shadowRoot) text = mapClean(node.shadowRoot.textContent, 400);
    if (ownName) text = mapClean(text.split(ownName).join(' '), 400);
    if (text.length >= 3 && text.length <= 300) return mapClean(text, 80);
  }
  return '';
}

// "nth-child" path of an element inside ONE root, then the same for its shadow host in the root above, joined with a descendant combinator (which Playwright's CSS engine follows into open shadow roots).
function mapStructuralPath(el: any): string {
  const parts: string[] = [];
  let node = el;
  for (let depth = 0; node && depth < 8; depth++) {
    const inner: string[] = [];
    let cur = node;
    while (cur) {
      const parent = cur.parentElement;
      const container = parent || (cur.getRootNode ? cur.getRootNode() : null);
      const siblings = container && container.children ? Array.from(container.children as ArrayLike<any>) : [];
      inner.unshift(`${String(cur.tagName).toLowerCase()}:nth-child(${siblings.indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift(inner.join(' > '));
    const root = node.getRootNode ? node.getRootNode() : null;
    node = root && root.host ? root.host : null;
  }
  return parts.join(' ');
}

function mapSelectorsFor(el: any, roots: any[]): string[] {
  const g = globalThis as any;
  const out: string[] = [];
  const tag = String(el.tagName || '').toLowerCase();
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const usable = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 80 && !/[\n\r\u0000-\u001F]/.test(v);
  // unique across the document AND its open shadow roots: Playwright's CSS engine pierces them, so a selector that is unique in the light DOM alone can still match twice
  const unique = (sel: string) => { const found = mapQueryAll(roots, sel); return found.length === 1 && found[0] === el; };
  const add = (sel: string) => { if (!out.includes(sel) && unique(sel)) out.push(sel); };
  const norm = (s: string) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

  const id = el.getAttribute('id');
  if (usable(id) && g.CSS && typeof g.CSS.escape === 'function') add(`#${g.CSS.escape(id)}`);
  for (const attrName of ['data-testid', 'data-test', 'data-qa']) { const v = el.getAttribute(attrName); if (usable(v)) add(`[${attrName}=${quote(v)}]`); }
  const nameAttr = el.getAttribute('name');
  if (usable(nameAttr)) {
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if ((type === 'radio' || type === 'checkbox') && usable(el.getAttribute('value'))) add(`[name=${quote(nameAttr)}][value=${quote(el.getAttribute('value'))}]`);
    else add(`[name=${quote(nameAttr)}]`);
  }
  // visible text, in the form Playwright resolves: tag:has-text("..."). Uniqueness is checked here by the same rule (same tag, normalized text contains the phrase) and again by the runtime.
  const phrase = mapClean(typeof el.innerText === 'string' ? el.innerText : '', 40);
  if (usable(phrase) && ['a', 'button', 'summary', 'label'].includes(tag)) {
    const same = mapQueryAll(roots, tag).filter((n: any) => norm(n.textContent || '').includes(norm(phrase)));
    if (same.length === 1 && same[0] === el) out.push(`${tag}:has-text(${quote(phrase)})`);
  }
  for (const attrName of ['aria-label', 'placeholder', 'title', 'alt']) { const v = el.getAttribute(attrName); if (usable(v)) add(`${tag}[${attrName}=${quote(v)}]`); }
  if (tag === 'a') { const href = el.getAttribute('href'); if (usable(href)) add(`a[href=${quote(href)}]`); }
  if (tag === 'input') { const v = el.getAttribute('value'); const t = el.getAttribute('type'); if (usable(v) && usable(t)) add(`input[type=${quote(t)}][value=${quote(v)}]`); }
  if (out.length === 0) {
    const root = el.getRootNode ? el.getRootNode() : null;
    if (root && root.host) {
      // inside an open shadow root: a path through the hosts. It cannot be checked here (the check needs the CSS engine that will follow it), so the runtime verifies it.
      out.push(mapStructuralPath(el));
    } else {
      // structural path from the nearest ancestor with a unique id (or the body)
      const parts: string[] = [];
      let node = el;
      while (node && node.parentElement && String(node.tagName).toLowerCase() !== 'body') {
        const parent = node.parentElement;
        const position = Array.from(parent.children as ArrayLike<any>).indexOf(node) + 1;
        parts.unshift(`${String(node.tagName).toLowerCase()}:nth-child(${position})`);
        const pid = parent.getAttribute && parent.getAttribute('id');
        if (usable(pid) && g.CSS && typeof g.CSS.escape === 'function' && mapQueryAll(roots, `#${g.CSS.escape(pid)}`).length === 1) { parts.unshift(`#${g.CSS.escape(pid)}`); break; }
        node = parent;
      }
      if (parts.length > 0 && parts[0].charAt(0) !== '#') parts.unshift('body');
      add(parts.join(' > '));
    }
  }
  return out.slice(0, 4);
}

function mapIsInteractive(el: any, pointerOk: boolean): boolean {
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'head') return false;
  const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  if (tag === 'input') return type !== 'hidden';
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'a') return el.hasAttribute('href') || el.hasAttribute('onclick') || el.hasAttribute('role') || el.hasAttribute('tabindex');
  // a label is a click target only when its control cannot be clicked itself (a custom checkbox with the real input hidden); otherwise the control is the target and the label would only duplicate it
  if (tag === 'label') return Boolean(el.control) && !mapIsVisible(el.control);
  const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
  if (role && ['button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'textbox', 'combobox', 'slider', 'spinbutton', 'searchbox', 'switch', 'menuitemcheckbox', 'menuitemradio', 'listbox', 'treeitem'].includes(role)) return true;
  if (el.hasAttribute('onclick')) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  const editable = el.getAttribute('contenteditable');
  if (editable === '' || editable === 'true') return true;
  return pointerOk;
}

function mapScan(args: { limit: number; query?: string; nodeBudget: number; deadlineMs: number }): { elements: RawMapElement[]; truncated: boolean } {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.body) return { elements: [], truncated: false };
  const startedAt = Date.now();
  const roots = mapRoots();
  const viewportW = g.innerWidth || 0;
  const viewportH = g.innerHeight || 0;
  let truncated = false;

  // With a query, a control is only described in full when something about it could match the query (a cheap, layout-free test: attributes, text content, its label's text). Everything the
  // ranking could have matched passes this test, so a page with thousands of controls is searched in full instead of being cut off after the first few hundred.
  const normalize = (s: string) => String(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const q = args.query ? normalize(args.query) : '';
  const words = q ? q.split(' ').filter(Boolean) : [];
  const mayMatch = (el: any): boolean => {
    if (!q) return true;
    const parts: string[] = [el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('alt') || '', el.getAttribute('value') || '', el.getAttribute('id') || '', el.getAttribute('name') || ''];
    if (el.labels) for (const l of Array.from(el.labels as ArrayLike<any>)) parts.push(l.textContent || '');
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const root = el.getRootNode ? el.getRootNode() : doc;
      for (const id of labelledby.split(/\s+/)) { const ref = root.getElementById ? root.getElementById(id) : null; if (ref) parts.push(ref.textContent || ''); }
    }
    const hay = normalize(parts.join(' '));
    return hay.includes(q) || (words.length >= 2 && words.every((w) => hay.includes(w)));
  };

  const seen = new Set<any>();
  const nodes: any[] = [];
  let gathered = 0;
  const POINTER_CAP = q ? 20000 : 600;
  for (const root of roots) {
    const inRoot: any[] = [];
    const take = (list: ArrayLike<any>, cap: number) => {
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        if (count++ >= cap) { if (cap === POINTER_CAP && !q) break; truncated = true; break; }
        if (gathered >= args.nodeBudget) { truncated = true; break; }
        const n = list[i];
        if (!seen.has(n)) { seen.add(n); inRoot.push(n); gathered++; }
      }
    };
    take(root.querySelectorAll('button, a, input, select, textarea, [role]'), args.nodeBudget);
    take(root.querySelectorAll('summary, label, [tabindex], [onclick], [contenteditable], [data-testid]'), args.nodeBudget);
    take(root.querySelectorAll('div, span, li, img, svg, td, i, p'), POINTER_CAP);
    inRoot.sort((a: any, b: any) => (a.compareDocumentPosition(b) & 4 ? -1 : a === b ? 0 : 1));
    for (const n of inRoot) nodes.push(n);
    if (gathered >= args.nodeBudget) break;
  }

  const out: RawMapElement[] = [];
  let processed = 0;
  for (const el of nodes) {
    if (out.length >= args.limit) { truncated = true; break; }
    if ((processed++ & 31) === 0 && Date.now() - startedAt > args.deadlineMs) { truncated = true; break; }
    if (!mayMatch(el)) continue;
    let pointerOk = false;
    const tag = String(el.tagName || '').toLowerCase();
    if (['div', 'span', 'li', 'img', 'svg', 'td', 'i', 'p'].includes(tag)) {
      const style = g.getComputedStyle(el);
      const parent = mapParentOrHost(el);
      const parentStyle = parent ? g.getComputedStyle(parent) : null;
      pointerOk = Boolean(style && style.cursor === 'pointer' && !(parentStyle && parentStyle.cursor === 'pointer')) && Boolean(mapAccessibleName(el));
    }
    if (!mapIsInteractive(el, pointerOk)) continue;
    const visible = mapIsVisible(el);
    const name = mapAccessibleName(el);
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const rect = el.getBoundingClientRect();
    const inViewport = visible && rect.bottom > 0 && rect.right > 0 && rect.top < viewportH && rect.left < viewportW;
    const root = el.getRootNode ? el.getRootNode() : doc;
    let obscured = false;
    if (visible && inViewport) {
      const finder = root && typeof root.elementFromPoint === 'function' ? root : doc;
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportW - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportH - 1);
      const hit = finder.elementFromPoint(cx, cy);
      obscured = Boolean(hit) && hit !== el && !el.contains(hit) && !hit.contains(el);
    }
    const labelText = el.labels ? mapClean(Array.from(el.labels as ArrayLike<any>).map((l: any) => mapVisibleText(l)).join(' '), 120) : '';
    const isCheckable = tag === 'input' && (type === 'checkbox' || type === 'radio');
    out.push({
      index: out.length,
      selectors: visible ? mapSelectorsFor(el, roots) : [],
      tag,
      role: mapRoleOf(el),
      name,
      // a password field's content is never read; for any other control the visible text is the label/caption, not the typed value
      text: tag === 'input' || tag === 'select' || tag === 'textarea' ? '' : mapVisibleText(el),
      placeholder: mapClean(el.getAttribute('placeholder'), 120),
      label: labelText,
      title: mapClean(el.getAttribute('title'), 120),
      ariaLabel: mapClean(el.getAttribute('aria-label'), 120),
      hint: mapClean([el.getAttribute('id'), el.getAttribute('name')].filter(Boolean).join(' '), 120),
      type,
      visible,
      enabled: mapIsEnabled(el),
      inViewport,
      obscured,
      isFormControl: tag === 'input' || tag === 'textarea' || tag === 'select',
      context: visible ? mapContextOf(el, name) : '',
      ...(root && root.host ? { inShadow: true } : {}),
      ...(isCheckable ? { checked: Boolean(el.checked) } : {}),
      ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}),
    });
  }
  return { elements: out, truncated };
}

// the selectors of one element (an <iframe>, seen from its parent frame)
function mapSelectorsOfElement(el: any): string[] {
  return mapSelectorsFor(el, mapRoots());
}

function mapDescribeOne(el: any): { accessibleName: string; visibleText: string } {
  return { accessibleName: mapAccessibleName(el), visibleText: mapVisibleText(el) };
}

const HELPERS = [mapClean, mapVisibleText, mapAccessibleName, mapRoleOf, mapIsVisible, mapIsEnabled, mapRoots, mapQueryAll, mapParentOrHost, mapContextOf, mapStructuralPath, mapSelectorsFor, mapIsInteractive].map((fn) => fn.toString()).join('\n');

// Playwright sends `String(pageFunction)` to the page and calls it there (over CDP, not through eval(), so the page's Content-Security-Policy does not apply). The helper functions above must travel
// together with the entry point, so the function handed to Playwright is a stand-in whose source text is the composed script. The stand-in itself is never run in Node.
export function asPageFunction<T extends (...args: any[]) => any>(source: string): T {
  const standIn = function pageOnly() { throw new Error('This function runs inside the page only.'); } as unknown as T;
  standIn.toString = () => source;
  return standIn;
}

/** (args) => { elements, truncated } */
export const mapScanInPage = asPageFunction<(args: ElementMapOptions) => { elements: RawMapElement[]; truncated: boolean }>(`(args) => {\n${HELPERS}\n${mapScan.toString()}\nreturn mapScan(args);\n}`);
/** (iframe element) => its verified selectors, as seen from the frame that contains it */
export const mapSelectorsInPage = asPageFunction<(el: unknown) => string[]>(`(el) => {\n${HELPERS}\n${mapSelectorsOfElement.toString()}\nreturn mapSelectorsOfElement(el);\n}`);
/** (element) => { accessibleName, visibleText } */
export const mapDescribeInPage = asPageFunction<(el: unknown) => { accessibleName: string; visibleText: string }>(`(el) => {\n${HELPERS}\n${mapDescribeOne.toString()}\nreturn mapDescribeOne(el);\n}`);

// ----------------------------------------------------------------------------------------------------------------------------------------------
// Ranking: pure Node code.
// ----------------------------------------------------------------------------------------------------------------------------------------------

export interface ScoredMapElement {
  element: RawMapElement;
  score: number;
}

function norm(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** how well one field matches the query: exact 100, prefix 92, whole-word 86, substring 80, all words (any order) 72, else 0 */
export function fieldScore(field: string, query: string): number {
  const f = norm(field);
  const q = norm(query);
  if (!f || !q) return 0;
  if (f === q) return 100;
  if (f.startsWith(q)) return 92;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}($|[^\\p{L}\\p{N}])`, 'u').test(f)) return 86;
  if (f.includes(q)) return 80;
  const words = q.split(' ').filter(Boolean);
  if (words.length >= 2 && words.every((w) => f.includes(w))) return 72;
  return 0;
}

const SECONDARY_PENALTY = 14;
const DISABLED_PENALTY = 25;
const OBSCURED_PENALTY = 10;
const MIN_BEST_SCORE = 60;
const BEST_MARGIN = 10;
const MAX_CANDIDATES = 10;

export function scoreElement(element: RawMapElement, query: string): number {
  const primary = Math.max(fieldScore(element.name, query), fieldScore(element.text, query), fieldScore(element.label, query));
  const secondary = Math.max(fieldScore(element.placeholder, query), fieldScore(element.title, query), fieldScore(element.ariaLabel, query), fieldScore(element.hint, query)) - SECONDARY_PENALTY;
  let score = Math.max(primary, secondary);
  if (score <= 0) return 0;
  if (!element.enabled) score -= DISABLED_PENALTY;
  if (element.obscured) score -= OBSCURED_PENALTY;
  return Math.max(1, score);
}

export function rankMapElements(elements: RawMapElement[], query: string): { ranked: ScoredMapElement[]; hiddenMatches: number } {
  const ranked: ScoredMapElement[] = [];
  let hiddenMatches = 0;
  for (const element of elements) {
    const score = scoreElement(element, query);
    if (score <= 0) continue;
    if (!element.visible) { hiddenMatches++; continue; }
    if (element.selectors.length === 0) continue;
    ranked.push({ element, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.element.index - b.element.index);
  return { ranked: ranked.slice(0, MAX_CANDIDATES), hiddenMatches };
}

/** The suggested element, or none when two candidates are too close to call (the caller then has to choose by context). */
export function pickBest<T extends { score: number }>(ranked: T[]): T | undefined {
  const top = ranked[0];
  if (!top || top.score < MIN_BEST_SCORE) return undefined;
  const second = ranked[1];
  return !second || top.score - second.score >= BEST_MARGIN ? top : undefined;
}
