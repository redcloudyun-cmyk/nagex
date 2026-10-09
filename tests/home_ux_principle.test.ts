import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function readPublic(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', file), 'utf8');
}

test('Home right rail uses one user-facing action lifecycle surface', () => {
  const src = readPublic('personal-home-view.js');
  assert.match(src, /data-home-section', 'action-lifecycle'/);
  assert.match(src, /AWAITING_APPROVAL/);
  assert.match(src, /WORKING/);
  assert.match(src, /VERIFYING/);
  assert.match(src, /COMPLETED/);
  assert.match(src, /FAILED/);
  assert.match(src, /\.\.\.\(model\.approvals \|\| \[\]\), \.\.\.\(model\.working \|\| \[\]\)/);
  assert.doesNotMatch(src, /filter\(\(item\) => !workingKeys\.has\(item\.key\)\)\.slice\(0, 3\)/);
});

test('Normal Home and Activity surfaces do not expose orchestration internals', () => {
  const app = readPublic('app.js');
  const home = readPublic('personal-home-view.js');
  const mobileActivity = readPublic('mobile/mobile-activity.js');
  for (const src of [app, home, mobileActivity]) {
    assert.doesNotMatch(src, />Tool Involved:/);
    assert.doesNotMatch(src, />Route:/);
    assert.doesNotMatch(src, />Command status:/);
    assert.doesNotMatch(src, />Approved state:/);
    assert.doesNotMatch(src, />Source:/);
    assert.doesNotMatch(src, /View technical details/);
  }
});
