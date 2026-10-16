import { asPageFunction } from './element-map.js';

// A key press is not always harmless. Enter in a text field submits its form; Enter or Space on a focused button presses it; Enter on a focused link follows it. If the control that would be
// activated is consequential ("Issue invoice", "Pay", a submit button) the key press needs the same approval a click on that control needs - otherwise an Agent could do with the keyboard
// what it may not do with the mouse. This page function says what the key WOULD activate, without pressing it.
//
//   NONE                         the key does nothing beyond typing / moving (Tab, arrows, a letter, Enter in a textarea, Space on a checkbox)
//   CONTROL                      the focused control itself is activated (a button, a link, a role=button element)
//   FORM_SUBMIT                  Enter in a field submits the form through its default submit button (`el`)
//   IMPLICIT_SUBMIT_UNRESOLVED   Enter would submit a form that has no submit button (a single-field form): there is no control to name, so NAgex does not press it
//
// The page function is self-contained (it travels to the page as source text, like the element map), and works on the real focused element, also inside an open shadow root or a
// same-origin iframe. It reads nothing but the element's structure.

export type KeyActivationKind = 'NONE' | 'CONTROL' | 'FORM_SUBMIT' | 'IMPLICIT_SUBMIT_UNRESOLVED';

// the function below runs inside the page, where `document` exists; the Node build has no DOM library
declare const document: any;

function keyActivationTarget(key: string): { kind: KeyActivationKind; el: any } {
  const none = { kind: 'NONE' as KeyActivationKind, el: null };
  const base = String(key || '').split('+').pop() || '';
  const enter = base === 'Enter' || base === 'NumpadEnter';
  const space = base === ' ' || base === 'Space';
  if (!enter && !space) return none;

  let active: any = document.activeElement;
  for (let depth = 0; depth < 8 && active; depth += 1) {
    if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
    if (String(active.tagName).toLowerCase() === 'iframe') {
      let inner: any = null;
      try { inner = active.contentDocument && active.contentDocument.activeElement; } catch (e) { inner = null; }
      if (inner && inner !== active.contentDocument.body) { active = inner; continue; }
    }
    break;
  }
  if (!active || active === document.body || active === document.documentElement) return none;

  const tag = String(active.tagName || '').toLowerCase();
  const attr = (name: string): string => String((active.getAttribute && active.getAttribute(name)) || '').toLowerCase();
  const type = attr('type');
  const role = attr('role');

  const buttonLike = tag === 'button' || tag === 'summary' || role === 'button' || role === 'menuitem' || role === 'tab' || role === 'link'
    || (tag === 'input' && ['button', 'submit', 'image', 'reset'].indexOf(type) >= 0);
  if (buttonLike) return { kind: 'CONTROL', el: active };
  if (tag === 'a' && active.hasAttribute && active.hasAttribute('href') && enter) return { kind: 'CONTROL', el: active };
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return none; // toggling a box activates nothing else

  if (enter && tag === 'input' && ['file', 'color', 'range', 'hidden'].indexOf(type) < 0) {
    const form: any = active.form;
    if (!form) return none;
    const controls: any[] = Array.prototype.slice.call(form.elements);
    const submit = controls.find((c: any) => !c.disabled && ((String(c.tagName).toLowerCase() === 'button' && String(c.getAttribute('type') || 'submit').toLowerCase() === 'submit')
      || (String(c.tagName).toLowerCase() === 'input' && ['submit', 'image'].indexOf(String(c.type).toLowerCase()) >= 0)));
    if (submit) return { kind: 'FORM_SUBMIT', el: submit };
    const image = form.querySelector('input[type="image"]:not([disabled])');
    if (image) return { kind: 'FORM_SUBMIT', el: image };
    const textual = controls.filter((c: any) => String(c.tagName).toLowerCase() === 'input' && !c.disabled && !c.readOnly
      && ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'].indexOf(String(c.type).toLowerCase()) >= 0);
    return textual.length <= 1 ? { kind: 'IMPLICIT_SUBMIT_UNRESOLVED', el: form } : none;
  }
  return none;
}

/** (key) => { kind, el } - evaluate with page.evaluateHandle */
export const keyActivationInPage = asPageFunction<(key: string) => { kind: KeyActivationKind; el: unknown }>(`(key) => {\n${keyActivationTarget.toString()}\nreturn keyActivationTarget(key);\n}`);

export interface KeyActivation {
  kind: KeyActivationKind | 'UNRESOLVED_FRAME';
  /** verified selectors of the control that would be activated (first = preferred); absent for NONE / IMPLICIT_SUBMIT_UNRESOLVED */
  selectors?: string[];
}
