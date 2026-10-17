// A page longer than the verification budget must still be CHECKED, not skipped. Found by the first run of the browser agent on a real public site: the model opened the right article and asked NAgex to verify a
// word that the article certainly shows; NAgex answered "NOT SHOWN" - twice - because the page text (far larger than the 60,000-character budget) was dropped whole instead of being clipped, so the check
// looked at nothing. The failure direction was safe (a claimed success was contradicted, never confirmed), but verification was useless on any long page.
//
// The surface reader runs inside the page; here it is called with a stand-in element that has the same read interface, so the budget logic is tested without a browser.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXPECTATION_SURFACE_CHARS, matchExpectation, readExpectationSurface } from '../src/modules/browser/expectation.js';

const root = (text: string) => ({ innerText: text, textContent: text, querySelectorAll: () => [], matches: () => false });
const filler = (chars: number): string => '가나다라마바사 '.repeat(Math.ceil(chars / 8)).slice(0, chars);

describe('the page text budget clips a long page; it never drops it', () => {
  it('a page longer than the budget is read up to the budget, and says it was cut', () => {
    const surface = readExpectationSurface(root(`수도 서울 ${filler(EXPECTATION_SURFACE_CHARS * 3)}`), EXPECTATION_SURFACE_CHARS);
    assert.equal(surface.found, true);
    assert.equal(surface.truncated, true, 'the reader reports that only the first part of the page was read');
    assert.equal(surface.texts.join('').length <= EXPECTATION_SURFACE_CHARS, true, 'never more than the budget');
    assert.ok(surface.texts.length > 0 && surface.texts[0].length > 1000, 'the first part of the page is there (it used to be empty)');
  });

  it('something the long page shows near its start IS found (the real-site failure: 2 characters, article far longer than the budget)', () => {
    const surface = readExpectationSurface(root(`대한민국의 수도는 서울이다. ${filler(EXPECTATION_SURFACE_CHARS * 4)}`), EXPECTATION_SURFACE_CHARS);
    assert.deepEqual(matchExpectation('서울', surface), { found: true, as: 'TEXT' });
  });

  it('something only the unread end of a very long page would show is NOT claimed as found, and the result says the page was cut', () => {
    const surface = readExpectationSurface(root(`${filler(EXPECTATION_SURFACE_CHARS * 2)} 마지막에만 있는 단어`), EXPECTATION_SURFACE_CHARS);
    assert.deepEqual(matchExpectation('마지막에만 있는 단어', surface), { found: false });
    assert.equal(surface.truncated, true, 'so a caller can tell "not on the page" from "not in the part that was read"');
  });

  it('a page within the budget is read whole and not marked as cut', () => {
    const surface = readExpectationSurface(root('Total: 1,100,000'), EXPECTATION_SURFACE_CHARS);
    assert.equal(surface.truncated, false);
    assert.deepEqual(matchExpectation('Total: 1,100,000', surface), { found: true, as: 'TEXT' });
  });

  it('the budget is large enough for a long encyclopedia article (a few hundred thousand characters), not only a form', () => {
    assert.ok(EXPECTATION_SURFACE_CHARS >= 300_000, `budget ${EXPECTATION_SURFACE_CHARS}`);
  });
});
