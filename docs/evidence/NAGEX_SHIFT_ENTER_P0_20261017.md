# NAgex — Shift+Enter "no response" (P0) · investigation and fix (2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_UX_and_Interaction_Architecture.md` ("Composer keys") · **Release posture:** `RELEASE = NO-GO` · Staging was not touched, `main` untouched.

Report from the real Staging (`4beb835`): English Enter PASS · Korean Enter PASS · Korean IME composition guard PASS · **Shift+Enter FAIL - no response** (neither sent nor a line break).

## 1. Result

```text
BASE_SHA               = 4beb835
INPUT_ELEMENT_TYPE     = Main composer: <textarea>  ·  ambient Ask sheet (Alt+N): <input type=text>  ·  Quick Wake: <input type=text>
                         Canvas Ask: <input type=text>  ·  header live search: <input type=search>
ROOT_CAUSE             = the ambient Ask sheet and Quick Wake were one-line <input>s: a line break cannot exist in them. Their handlers (correctly) did not send on Shift+Enter, and the field
                         ignores the key -> "no response". REPRODUCED in real Chromium on the 4beb835 code (2 failing tests: text stays "abcdef", expected "abc\ndef", nothing sent).
                         The Main composer (a <textarea>) was NOT reproduced as failing: Shift+Enter inserts the line break there (trace below).
PREVENT_DEFAULT_CAUSE  = none. No handler calls preventDefault() on a Shift+Enter keydown (event trace: no keydown/keypress is default-prevented; a <textarea> turns it into beforeinput/insertLineBreak).
                         The defect was the element type, not an event handler.
WHICH BOX THE OPERATOR USED = NOT CONFIRMED. If the failure was in the Main composer, it is not explained by this work - see section 4.
FIX                    = the ambient Ask sheet and Quick Wake become auto-growing <textarea>s (Enter still sends through the same handler; Shift+Enter is the browser's own line break).
```

## 2. How it was reproduced, and why the tests were green

Event trace of Shift+Enter in the Main composer on `4beb835` (real Chromium, English and with a Korean composition, `defaultPrevented` read after dispatch):

```text
keydown:Shift  keydown:Enter+Shift  keypress:Enter+Shift  beforeinput/insertLineBreak  input/insertLineBreak  keyup:Enter+Shift  keyup:Shift      (no keydown prevented)
value "hello\nworld" · "a\nline0\nline1\nline2" · Korean "안녕하세요\n두번째 줄" · after a composition "…\n…"  ·  nothing sent
```

The same keystroke in the two `<input>` boxes: the value stays as it was and nothing is sent.

**Why the suite was green while the service "did nothing":**
1. The test written for these boxes (`composer_enter_browser`, the previous turn) asserted only *"nothing was sent and the typed text is still there"* after Shift+Enter - which a field that **ignores** the key satisfies. It never required the line break itself.
2. The real-browser Shift+Enter test existed only for Main (`enter_to_send_browser`), where it passes.
3. An older source-assertion test (`ambient_composer.test.ts`) pinned the *shape* "single-line input" as the expected state.
4. The canonical text I wrote last turn claimed Shift+Enter works in **every** box - false for the one-line ones. Corrected.

## 3. The fix

| Piece | Change |
|---|---|
| `public/index.html`, `public/desktop-quickwake.html` | the Ask sheet box and the Quick Wake box: `<input type="text">` → `<textarea rows="1" enterkeyhint="send">` |
| `public/style.css`, `public/desktop-quickwake.css` | one line tall at rest like the input it replaces; grows to 160 px; then scrolls inside (`box-sizing: border-box`, `overflow-y: auto`) |
| `public/composer-keys.js` | `autoGrow(element, maxPx)` |
| `public/app.js`, `public/desktop-quickwake.js` | grow while typing; reset the height after the code clears or sets the value (3 sites in `app.js`); Quick Wake's button and Enter still run one function |
| Not changed | the Enter / IME rule (`isSubmitEnter`), Main's handler, the Send paths, approvals. **Canvas Ask and the header live search stay one-line** (below) |

**Policy, not decided here:** Canvas Ask is a one-line question field, and the header search is a live search. In both, Shift+Enter still does nothing - there is no line break to insert. That is today's behaviour, pinned by a test, and **not a product decision**; whether Canvas Ask should become multi-line belongs to the product owner. The canonical document says so.

## 4. If it still fails on Staging after a deployment

Run this in the browser console on the page where it failed, press **Shift+Enter** once in the box, and send the single line it prints (it logs no text, only the element type and the key state):

```js
(() => { addEventListener('keydown', e => { if (e.key === 'Enter') { const a = document.activeElement; setTimeout(() => console.log(JSON.stringify({ shift: e.shiftKey, prevented: e.defaultPrevented, composing: e.isComposing, keyCode: e.keyCode, element: a.tagName + '#' + a.id + (a.type ? ':' + a.type : '') })), 0); } }, true); console.log('listening for Enter'); })();
```
`element: INPUT#…:text` → a one-line box (this fix covers the Ask sheet and Quick Wake); `TEXTAREA#main-surface-input` with `prevented: true` → a handler is blocking it (not seen in the code or the traces); `prevented: false` and no line break → the browser or the input method consumed the key.

## 5. Verification (real Chromium, real keyboard events; CDP IME composition)

| Required scenario | Result |
|---|---|
| Shift+Enter → line break **at the caret** (mid-text), repeated, in an empty box | PASS - Main, Ask sheet, Quick Wake |
| Shift+Enter → nothing sent | PASS - all three |
| multi-line text then Enter → the whole text sent, line breaks kept | PASS - all three |
| English Enter → send · Korean Enter → send · composition-confirming Enter → no send | PASS - Main (`enter_to_send_browser`), Ask sheet, Quick Wake, Canvas Ask (`composer_enter_browser`) |
| empty message Enter → nothing sent · Shift+Enter then Enter in an empty box → nothing sent | PASS - all |
| five quick Enters → one send | PASS - all |
| the box grows with its lines and scrolls inside past its limit | PASS - all three (Main ≤ 220 px, others ≤ 160 px) |
| 360 / 390 / 430 px: no horizontal overflow, Send visible and sends the multi-line text; Main's phone layout and on-screen-keyboard rule | PASS (Ask sheet: 3 widths; Main: existing 3 widths) |
| mouse Send button = Enter (same requests); the action-request plan preview, no approval bypass | PASS (existing + `composer_enter_browser`) |
| Canvas Ask (one-line by policy): Shift+Enter changes nothing, sends nothing | PASS (pinned) |
| **Failing reproduction before the fix** | **2 FAIL** on the `4beb835` front end (Ask sheet, Quick Wake): `'abcdef'` vs expected `'abc\ndef'` |

### Gates (local, Windows)

```text
npm run build              exit 0
npm test (regression)      3881 tests · 3873 pass · 0 fail · 8 skipped
npm run test:browser-cert  495 tests · 489 pass · 0 fail · 6 skipped   (the 6 skips are older "superseded" markers)
```
CI (Windows and Ubuntu) is reported separately after the merge.

Not tested: real Safari, a physical Korean keyboard/IME, a phone. Chromium's CDP composition models Chrome's event order, not every browser's.
