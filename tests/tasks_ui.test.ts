import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('the Tasks tab is wired into navigation, the Control Center view, and data loading', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /data-tab="tab-tasks"/);
    assert.match(html, /id="view-tasks"/);
    assert.match(html, /id="tasks-list-container"/);
    assert.match(html, /id="task-create-form"/);
    assert.match(html, /id="task-name"/);
    assert.match(html, /id="task-objective"/);
    assert.match(html, /id="task-type"/);
    assert.match(html, /id="task-trigger-type"/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /function renderTasks\(/);
    assert.match(appJs, /apiFetch\('\/api\/v1\/tasks'\)/);
    assert.match(appJs, /state\.activeTab === 'tab-tasks'\) renderTasks\(\)/);
    assert.match(appJs, /pauseTask:/);
    assert.match(appJs, /resumeTask:/);
    assert.match(appJs, /runTaskNow:/);
    assert.match(appJs, /deleteTask:/);
    assert.match(appJs, /\/api\/v1\/tasks\/\$\{taskId\}\/pause/);
    assert.match(appJs, /\/api\/v1\/tasks\/\$\{taskId\}\/resume/);
    assert.match(appJs, /\/api\/v1\/tasks\/\$\{taskId\}\/run/);
  });
});

test('the task creation form never bypasses the real POST /api/v1/tasks endpoint', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const start = appJs.indexOf('function renderTasks(');
    const next = appJs.indexOf('\n  function renderSkills(', start + 1);
    const body = next > start ? appJs.slice(start, next) : appJs.slice(start);
    assert.match(body, /apiFetch\('\/api\/v1\/tasks', \{/);
    assert.match(body, /method: 'POST'/);
  });
});

test('Conditional Watch (item 07): the form exposes watchUrl + checkIntervalMinutes for CONDITION, and never invents them', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /id="task-watch-url"/);
    assert.match(html, /id="task-check-interval"/);
    // The old "evaluation not yet implemented" label must be gone now that
    // it is — leaving it would misrepresent implementation status (MASTER.md
    // Section 8).
    assert.doesNotMatch(html, /evaluation not yet implemented/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /trigger\.watchUrl = document\.getElementById\('task-watch-url'\)\.value\.trim\(\)/);
    assert.match(appJs, /trigger\.checkIntervalMinutes = Number\(document\.getElementById\('task-check-interval'\)\.value\) \|\| 15/);
  });
});
