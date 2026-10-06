import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_SCENARIO_FIXTURES, HOME_SCENARIO_FIXTURES_DEFAULT_ENABLED } from './_home_scenario_fixtures.js';

test('D8 Home scenario fixtures are test-only and default-off', () => {
  assert.equal(HOME_SCENARIO_FIXTURES_DEFAULT_ENABLED, false);
  assert.equal(process.env.NAGEX_HOME_SCENARIO_FIXTURE, undefined);
});

test('D8 Home scenario fixtures use canonical PersonalHomeResponse shape', () => {
  assert.equal(HOME_SCENARIO_FIXTURES.length, 10);
  for (const fixture of HOME_SCENARIO_FIXTURES) {
    const home = fixture.response;
    assert.match(fixture.id, /^S(?:10|[1-9])_/);
    assert.equal(typeof home.generatedAt, 'string');
    assert.ok(Array.isArray(home.upcoming));
    assert.ok(Array.isArray(home.needsAttention));
    assert.ok(Array.isArray(home.preparedForYou));
    assert.ok(Array.isArray(home.workingForYou));
    assert.ok(Array.isArray(home.recentResults));
    assert.ok(Array.isArray(home.memoryContext));
    assert.deepEqual(home.creationActions.map((item) => item.id), ['RESEARCH', 'ANALYZE']);
    assert.ok(home.today && Array.isArray(home.today.meetings));
    assert.ok(home.sourceStatus && typeof home.sourceStatus.calendar === 'string');
  }
});

test('D8 Home scenario fixtures contain no executable/provider/memory-write hooks', () => {
  const serialized = JSON.stringify(HOME_SCENARIO_FIXTURES);
  assert.doesNotMatch(serialized, /apiKey|Authorization|JEVMODEL_API_KEY|OPENAI_API_KEY|NEBIUS/i);
  assert.doesNotMatch(serialized, /WRITE_MEMORY|CREATE_APPROVAL|APPROVE_NOW|REJECT_NOW|EXECUTE_ACTION|CALL_PROVIDER|MODEL_CALL/i);
  for (const fixture of HOME_SCENARIO_FIXTURES) {
    for (const item of [...fixture.response.needsAttention, ...fixture.response.workingForYou, ...fixture.response.recentResults]) {
      assert.ok(!item.action || ['OPEN_TASK', 'REVIEW_APPROVAL', 'OPEN_ARTIFACT', 'OPEN_CALENDAR_ITEM'].includes(item.action.type));
    }
  }
});

test('D8 mixed lifecycle keeps running, approval, and completed states in separate canonical buckets', () => {
  const fixture = HOME_SCENARIO_FIXTURES.find((item) => item.id === 'S5_MIXED_LIFECYCLE');
  assert.ok(fixture);
  const home = fixture.response;
  assert.equal(home.workingForYou.length, 1);
  assert.equal(home.needsAttention.length, 1);
  assert.equal(home.recentResults.length, 1);
  const workingIds = new Set(home.workingForYou.map((item) => item.id));
  const approvalIds = new Set(home.needsAttention.map((item) => item.id));
  const resultIds = new Set(home.recentResults.map((item) => item.id));
  assert.equal([...workingIds].some((id) => approvalIds.has(id) || resultIds.has(id)), false);
  assert.equal([...approvalIds].some((id) => resultIds.has(id)), false);
});
