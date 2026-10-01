import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('M6.1 mobile Create bottom nav opens the mobile-safe Home creation surface, not the desktop Create view', () => {
  const html = readPublic('index.html');
  const app = readPublic('app.js');

  const createNavButtons = [...html.matchAll(/<button[^>]+(?:mob-nav-item|mh-nav-item)[^>]+data-tab="tab-create"[^>]*>/g)].map((m) => m[0]);
  assert.equal(createNavButtons.length, 2, 'both mobile bottom nav Create buttons must be covered');
  for (const button of createNavButtons) {
    assert.match(button, /openMobileCreate\(\)/, 'mobile Create nav must call the mobile-safe route helper');
    assert.doesNotMatch(button, /switchTab\('tab-create'\)/, 'mobile Create nav must not directly expose #view-create');
  }

  assert.match(app, /function openMobileCreate\(\)/, 'mobile-safe Create route helper must exist');
  assert.match(app, /switchTab\('tab-home'\)/, 'mobile Create must route through Home');
  assert.match(app, /getElementById\('mh-section-create'\)/, 'mobile Create must target the existing mobile Home creation section');
  assert.match(app, /openMobileCreate,/, 'mobile-safe Create route helper must be exported on window.NAGEX');
});

test('M6.1 Needs Attention Review routes PROPOSAL items to Approvals without broad proposal matching or mutation', () => {
  const desktopHome = readPublic('desktop/desktop-home.js');
  const handlerMatch = desktopHome.match(/handleHomeItemAction = function \(type, sourceRef, item\) \{([\s\S]*?)\n    \};/);
  assert.ok(handlerMatch, 'handleHomeItemAction router not found');
  const handler = handlerMatch![1];

  assert.match(handler, /upperType === 'PROPOSAL'/, 'PROPOSAL must have an exact routing branch');
  assert.doesNotMatch(handler, /includes\('PROPOSAL'\)/, 'PROPOSAL routing must not be a broad string match');
  assert.match(handler, /upperType === 'PROPOSAL'[\s\S]*?switchTab\('tab-approvals'\)/, 'PROPOSAL Review must route to Approvals');
  assert.match(handler, /upperType\.includes\('APPROVAL'\)[\s\S]*?switchTab\('tab-approvals'\)/, 'existing APPROVAL routing must be preserved');
  assert.doesNotMatch(handler, /handleApprovalAction|approvals\/\$\{id\}\/action|\/api\/v1\/approvals\/.*\/action/, 'Review routing must not approve/reject/mutate inline');
});
