// "Build me a website (and put it online)" - how NAgex routes such a request. Deterministic, no model: a request to build a WEBSITE starts a Product Builder project (a plan for the person's approval; nothing is built
// or deployed by the routing decision) only when the server says a planning model is configured; otherwise it stays an honest 'not available'. A question about building a website, a report ABOUT a website, a
// negated request, and things the Product Builder cannot make (an app, a bot, a game) are not projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRouting } from '../src/workspace/input-router.js';
import { SITE_REQUEST_EN, SITE_REQUEST_KO } from './_product_site_fixture.js';

test('a request to build a website becomes a Product Builder project when it is available, with the approval it needs', () => {
  for (const prompt of [SITE_REQUEST_EN, SITE_REQUEST_KO, 'Create a landing page for my bakery and publish it.', 'Please make a web app for tracking my clients', '우리 가게 홈페이지 만들어줘', '랜딩 페이지를 만들고 배포해줘']) {
    const available = decideRouting(prompt, { productBuilderAvailable: true });
    assert.equal(available.kind, 'ACTION_PLAN', prompt);
    assert.ok(available.reasonCodes.includes('PRODUCT_BUILD'), prompt);
    assert.ok(available.reasonCodes.includes('APPROVAL_REQUIRED'), prompt);
    assert.equal(available.targetArtifactType, 'CODE', prompt);
    assert.equal(available.needs[0].approvalRequired, true, prompt);
    assert.equal(available.permissionRisk, 'EXTERNAL_CONSEQUENTIAL', prompt);
    // without a planning model the answer is the honest one it always was
    const unavailable = decideRouting(prompt, { productBuilderAvailable: false });
    assert.equal(unavailable.kind, 'UNSUPPORTED', prompt);
    assert.ok(unavailable.reasonCodes.includes('CODE_APP_NOT_AVAILABLE'), prompt);
    assert.ok(!unavailable.reasonCodes.includes('PRODUCT_BUILD'), prompt);
    assert.equal(decideRouting(prompt).kind, 'UNSUPPORTED', `${prompt} (availability unknown = not available)`);
  }
});

test('questions, documents ABOUT a website, negations and things the Product Builder cannot make are not projects', () => {
  for (const prompt of [
    'How do I build a website?',
    'What is the best way to create a website for a bakery',
    '웹사이트 만드는 방법을 알려줘',
    '홈페이지 어떻게 만들어?',
    'Write a report about building a website for small businesses',
    '웹사이트 제작 보고서를 써줘',
    "Don't build me a website, just draft the outline in a document",
    '웹사이트 만들지 마, 문서로 정리만 해줘',
  ]) {
    assert.ok(!decideRouting(prompt, { productBuilderAvailable: true }).reasonCodes.includes('PRODUCT_BUILD'), prompt);
  }
  for (const prompt of ['Build me a chatbot', 'Make a game for my kids', '모바일 앱 만들어줘', 'Develop an iOS app']) {
    const d = decideRouting(prompt, { productBuilderAvailable: true });
    assert.equal(d.kind, 'UNSUPPORTED', prompt);
    assert.ok(d.reasonCodes.includes('CODE_APP_NOT_AVAILABLE'), prompt);
  }
});

test('other routes are unchanged: video, desktop, browser and plain conversation do not become projects', () => {
  assert.ok(!decideRouting('Hello, how are you?', { productBuilderAvailable: true }).reasonCodes.includes('PRODUCT_BUILD'));
  assert.ok(!decideRouting('Make a video of a sunrise', { productBuilderAvailable: true, videoAvailable: true }).reasonCodes.includes('PRODUCT_BUILD'));
  assert.ok(!decideRouting('Summarize this document', { productBuilderAvailable: true }).reasonCodes.includes('PRODUCT_BUILD'));
  assert.ok(!decideRouting('Open https://example.com and fill in the form', { productBuilderAvailable: true, browserTaskAvailable: true }).reasonCodes.includes('PRODUCT_BUILD'));
});
