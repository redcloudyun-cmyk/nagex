// A deterministic stand-in for the PLANNING MODEL in the invoice certification. It is not a script of selectors: it decides each next action from what the page shows (the element names, field values,
// visible text and the outcomes of its previous actions) - exactly the information a real planner gets - so NAgex's perception, loop, verification and approval are exercised for real.
// It is used two ways: wrapped as a VisualExecutionModelPort (the loop calls it directly) and behind a scripted model endpoint that parses the Gateway adapter's PROMPT (so the real prompt builder,
// the real JSON validation and the real router are in the path too).
import type { ProposedDeviceAction } from '../src/device-control/device-action.types.js';
import type { ProposeNextActionInput, VisualExecutionModelPort } from '../src/device-control/visual-execution-model.port.js';

export interface PageView {
  url: string;
  text: string;
  elements: Array<{ selector: string; role: string; name: string; near?: string }>;
  fields: Array<{ label: string; value: string }>;
  prior: Array<{ action: string; selector?: string; outcome: string }>;
}

export type InvoiceVariant = 'HAPPY' | 'WRONG_EXPECTED_TOTAL' | 'BAD_QUANTITY_FIRST' | 'GULLIBLE' | 'ISSUE_DIRECTLY';

export interface InvoiceTask {
  customerQuery: string;
  customerName: string;
  date: string;
  taxRate: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
}

export const DEFAULT_TASK: InvoiceTask = {
  customerQuery: 'Hanbit',
  customerName: 'Hanbit Trading Co.',
  date: '2026-11-03',
  taxRate: '10',
  items: [{ description: 'Consulting hours', quantity: 2, unitPrice: 300000 }, { description: 'Setup fee', quantity: 1, unitPrice: 400000 }],
};

const money = (n: number): string => n.toLocaleString('en-US');
export const expectedTotals = (task: InvoiceTask) => {
  const subtotal = task.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const tax = Math.round(subtotal * Number(task.taxRate) / 100);
  return { subtotal, tax, total: subtotal + tax };
};

export function nextInvoiceAction(view: PageView, variant: InvoiceVariant, baseUrl: string, task: InvoiceTask = DEFAULT_TASK): ProposedDeviceAction {
  const byName = (re: RegExp, role?: RegExp) => view.elements.find((e) => re.test(e.name) && (!role || role.test(e.role)));
  const field = (label: string) => view.fields.find((f) => f.label.toLowerCase() === label.toLowerCase());
  const did = (action: string, re?: RegExp) => view.prior.filter((p) => p.action === action && (!re || re.test(p.outcome))).length;
  const verified = (needle: string) => view.prior.some((p) => p.action === 'VERIFY' && /^VERIFIED/.test(p.outcome) && p.outcome.includes(needle));
  const { subtotal, tax, total } = expectedTotals(task);
  const path = (() => { try { return new URL(view.url).pathname; } catch { return ''; } })();

  if (!view.url || view.url === 'about:blank') return { action: 'NAVIGATE', value: baseUrl + '/' };
  if (path === '/login') return { action: 'STOP', value: 'BLOCKED', expectedResult: 'The site asks for a sign-in. A person has to sign in; I did not enter any password.' };

  if (path === '/') {
    const link = byName(/^New invoice$/i, /link/);
    if (!link) return { action: 'OBSERVE' };
    return { action: 'CLICK', target: { selector: link.selector, description: 'New invoice' }, expectedResult: 'The new-invoice form opens' };
  }

  if (path === '/invoices/new') {
    const chosen = /Selected customer:\s*(.+?)\s*\(/.exec(view.text)?.[1] ?? '';
    if (chosen !== task.customerName) {
      const search = byName(/^Customer$/i);
      const option = byName(new RegExp('^' + task.customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\('), /option|button/);
      const typed = (field('Customer')?.value ?? '').length > 0;
      if (option) return { action: 'CLICK', target: { selector: option.selector, description: task.customerName }, expectedResult: 'The customer is selected' };
      if (!typed && search) return { action: 'TYPE', target: { selector: search.selector, description: 'Customer search' }, value: task.customerQuery, expectedResult: 'Matching customers are listed' };
      if (did('WAIT') < 6) return { action: 'WAIT', value: '300' };
      return { action: 'STOP', expectedResult: 'The customer could not be found in the list.' };
    }
    const dateBox = byName(/^Invoice date$/i);
    if (dateBox && !field('Invoice date')?.value) return { action: 'TYPE', target: { selector: dateBox.selector, description: 'Invoice date' }, value: task.date };
    const taxBox = byName(/^Tax rate$/i);
    const taxValue = field('Tax rate')?.value ?? '';
    // a dropdown that still shows its placeholder ("Choose a tax rate") has not been chosen yet
    if (taxBox && (!taxValue || /^choose/i.test(taxValue)) && did('SELECT') < 3) return { action: 'SELECT', target: { selector: taxBox.selector, description: 'Tax rate' }, value: task.taxRate };

    for (let i = 0; i < task.items.length; i += 1) {
      const row = i + 1;
      const item = task.items[i];
      const desc = byName(new RegExp('^Description ' + row + '$', 'i'));
      if (!desc) { const add = byName(/^Add line item$/i); return add ? { action: 'CLICK', target: { selector: add.selector, description: 'Add line item' } } : { action: 'OBSERVE' }; }
      if (!field('Description ' + row)?.value) return { action: 'TYPE', target: { selector: desc.selector, description: 'Description ' + row }, value: item.description };
      const qty = byName(new RegExp('^Quantity ' + row + '$', 'i'))!;
      const currentQty = field('Quantity ' + row)?.value ?? '';
      // a first attempt with an invalid quantity is corrected after the page complains (input validation, recovery)
      if (variant === 'BAD_QUANTITY_FIRST' && row === 1 && currentQty === '' && did('TYPE', /characters/) < 99 && !view.prior.some((p) => /quantity must be/i.test(p.outcome)) && !/quantity must be/i.test(view.text)) {
        return { action: 'TYPE', target: { selector: qty.selector, description: 'Quantity 1' }, value: '0' };
      }
      if (currentQty !== String(item.quantity)) return { action: 'TYPE', target: { selector: qty.selector, description: 'Quantity ' + row }, value: String(item.quantity) };
      const price = byName(new RegExp('^Unit price ' + row + '$', 'i'))!;
      if (field('Unit price ' + row)?.value !== String(item.unitPrice)) return { action: 'TYPE', target: { selector: price.selector, description: 'Unit price ' + row }, value: String(item.unitPrice) };
    }

    const expectedOnForm = variant === 'WRONG_EXPECTED_TOTAL' ? total - 100000 : total;
    if (!verified('expected text')) {
      const wasChecked = view.prior.some((p) => p.action === 'VERIFY');
      if (!wasChecked) return { action: 'VERIFY', value: 'Total: ' + money(expectedOnForm), expectedResult: 'The total on the form is right' };
      if (variant === 'WRONG_EXPECTED_TOTAL') return { action: 'STOP', expectedResult: 'The totals on the form are checked and correct.' };
    }
    // the form is not ready until the page shows the expected total: look again instead of pressing a button that is not enabled
    if (!verified('expected text')) return { action: 'OBSERVE' };
    const next = byName(/^Continue to review$/i);
    if (next) {
      // after pressing Continue the page may take a moment to move on: look again (a bounded number of times) instead of pressing the same button on an unchanged page
      let lastContinue = -1;
      for (let i = view.prior.length - 1; i >= 0; i -= 1) { if (view.prior[i].action === 'CLICK' && /continue/i.test(view.prior[i].selector ?? '')) { lastContinue = i; break; } }
      const waitsSince = lastContinue < 0 ? 0 : view.prior.slice(lastContinue + 1).filter((p) => p.action === 'WAIT').length;
      if (lastContinue >= 0 && waitsSince < 8) return { action: 'WAIT', value: '400' };
      return { action: 'CLICK', target: { selector: next.selector, description: 'Continue to review' }, expectedResult: 'The review page opens' };
    }
    return { action: 'WAIT', value: '300' };
  }

  if (path.startsWith('/invoices/review/')) {
    if (variant === 'ISSUE_DIRECTLY' || variant === 'GULLIBLE') {
      const issue = byName(/^Issue invoice$/i);
      if (issue) return { action: 'CLICK', target: { selector: issue.selector, description: 'Issue invoice' }, expectedResult: 'The invoice is issued' };
    }
    const save = byName(/^Save draft$/i);
    // where this review page began: the last click that NAVIGATED here (the observation says so: the address changed); a click on Save draft stays on the page
    // (a click that leads here reports URL_CHANGED only if the page had navigated by the time the click was judged; on a slow machine it reports DOM_CHANGED_ONLY while the page is still the form, so the
    // press of the form's own "Continue" button counts as the arrival too - otherwise the form's total check would be mistaken for a check of this page)
    const arrivedAt = (() => { for (let i = view.prior.length - 1; i >= 0; i -= 1) { const p = view.prior[i]; if (p.action === 'CLICK' && (/URL_CHANGED|NAVIGATED_TO_LINK_TARGET/.test(p.outcome) || /continue/i.test(p.selector ?? ''))) return i; } return -1; })();
    const checksHere = view.prior.slice(arrivedAt + 1).filter((p) => p.action === 'VERIFY').length;
    if (checksHere === 0) return { action: 'VERIFY', value: 'Total: ' + money(total), expectedResult: 'the review page shows the total' };
    if (checksHere === 1) return { action: 'VERIFY', value: task.customerName, expectedResult: 'the review page shows the customer' };
    if (!/Draft saved/.test(view.text)) {
      const alreadyClicked = view.prior.slice(arrivedAt + 1).some((p) => p.action === 'CLICK' && p.selector === save?.selector);
      if (save && !alreadyClicked) return { action: 'CLICK', target: { selector: save.selector, description: 'Save draft' }, expectedResult: 'Draft saved' };
      if (did('WAIT') < 5) return { action: 'WAIT', value: '300' };
    }
    return { action: 'STOP', expectedResult: `The invoice is prepared as a saved draft (subtotal ${money(subtotal)}, tax ${money(tax)}, total ${money(total)}); I stopped before issuing it, as asked.` };
  }

  if (path.startsWith('/invoices/issued/')) return { action: 'STOP', expectedResult: 'The invoice was issued.' };
  return { action: 'OBSERVE' };
}

/** the loop calls it directly */
export class InvoiceStandInPlanner implements VisualExecutionModelPort {
  public readonly calls: ProposeNextActionInput[] = [];
  constructor(private readonly baseUrl: string, private readonly variant: InvoiceVariant = 'HAPPY', private readonly task: InvoiceTask = DEFAULT_TASK) {}

  public async proposeNextAction(input: ProposeNextActionInput): Promise<ProposedDeviceAction> {
    this.calls.push(input);
    const snapshot = input.structuredSnapshot;
    return nextInvoiceAction({
      url: snapshot.url,
      text: snapshot.text,
      elements: (snapshot.interactive ?? []).map((e) => ({ selector: e.selector, role: e.role, name: e.name, ...(e.context ? { near: e.context } : {}) })),
      fields: (snapshot.interactive ?? []).filter((e) => /textbox|combobox|select|spinbutton|searchbox|listbox/.test(e.role) || e.type === 'date').map((e) => ({ label: e.name, value: e.value ?? '' })),
      prior: input.priorActions.map((p) => ({ action: p.action.action, ...(p.action.target?.selector ? { selector: p.action.target.selector } : {}), outcome: p.outcome })),
    }, this.variant, this.baseUrl, this.task);
  }
}

/** behind a scripted model endpoint: reads the Gateway adapter's own prompt and answers with the same decision as JSON */
export function planFromPrompt(system: string, user: string, variant: InvoiceVariant, baseUrl: string, task: InvoiceTask = DEFAULT_TASK): string {
  const line = (label: string): string => {
    const start = user.indexOf(label);
    if (start < 0) return '';
    const end = user.indexOf('\n', start);
    return user.slice(start + label.length, end < 0 ? undefined : end).trim();
  };
  const json = <T,>(label: string, fallback: T): T => { try { return JSON.parse(line(label)) as T; } catch { return fallback; } };
  const prior = json<Array<{ action: string; selector?: string; outcome: string }>>('PRIOR ACTIONS:', []);
  const view: PageView = {
    url: line('URL:'),
    text: json<string>('VISIBLE TEXT:', ''),
    elements: json<PageView['elements']>('ELEMENTS (with the value each field holds now):', []),
    fields: json<Array<{ name: string; role: string; value?: string }>>('ELEMENTS (with the value each field holds now):', []).map((e) => ({ label: e.name, value: e.value ?? '' })),
    prior: Array.isArray(prior) ? prior : [],
  };
  void system;
  return JSON.stringify(nextInvoiceAction(view, variant, baseUrl, task));
}
