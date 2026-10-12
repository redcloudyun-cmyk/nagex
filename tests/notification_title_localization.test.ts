// Server-generated notification titles are English strings; the Main attention center shows them through localizeAppText(). Every title the task runtime and the
// daily brief produce must therefore have a Korean rendering, so a Korean user never sees an English lifecycle title there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('task lifecycle notification titles have a pattern with English and Korean text', () => {
  const finalizer = read('src/tasks/task-run-finalizer.ts');
  const main = read('public/main-surface.js');
  const i18n = read('public/i18n.js');

  const prefixes = [...finalizer.matchAll(/title: `([A-Z][A-Za-z ]+): \$\{task\.name\}`/g)].map((m) => m[1]);
  assert.ok(prefixes.length >= 4, `expected the lifecycle titles (Approval Required, Task Completed, Condition Met, Task Failed), found: ${prefixes.join(', ')}`);

  for (const prefix of prefixes) {
    const pattern = new RegExp(`\\[/\\^${prefix}: \\(\\.\\+\\)\\$/, '(mainPattern\\.[a-z_]+)'\\]`).exec(main);
    assert.ok(pattern, `Main has no localization pattern for the notification title "${prefix}: <task>"`);
    const key = pattern![1];
    assert.equal(count(i18n, `'${key}':`), 2, `${key} must be defined once for English and once for Korean`);
  }
});

test('the daily brief ready notification title has English and Korean text', () => {
  const runner = read('src/tasks/runners/daily-brief.runner.ts');
  const i18n = read('public/i18n.js');
  const title = /title: '(Your Daily Brief is ready)'/.exec(runner);
  assert.ok(title, 'the daily brief runner title changed: update this test and the localization together');
  const key = 'mainText.' + title![1].replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  assert.equal(count(i18n, `'${key}':`), 2, `${key} must be defined once for English and once for Korean`);
});
