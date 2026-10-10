import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityStore } from '../src/governance/activity.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { ProactiveInteractionStore } from '../src/personal/proactive-interaction.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { handleProactiveSuggestionsRoutes } from '../src/http/routes/proactive-suggestions.routes.js';
import { canonicalizeRequestHeaders } from '../src/http/request-identity.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-loop-proactive-'));
}

function makeOwner(root: string) {
  const identityStore = new IdentityStore({ dir: path.join(root, 'identity') });
  const sessionStore = new SessionStore({ dir: path.join(root, 'sessions') });
  const { identity } = identityStore.createAccount('loop@example.com', hashPassword('password123'));
  identityStore.transitionState(identity.userId, 'ACTIVE');
  const tenantId = `ten_${identity.userId}`;
  const session = sessionStore.createAuthSession(tenantId, identity.userId);
  const headers = canonicalizeRequestHeaders({ cookie: `nagex_session=${session.sessionId}` }, { identityStore, sessionStore });
  return { identityStore, sessionStore, tenantId, principalId: identity.userId, headers };
}

const suggestion = {
  id: 'sug_task_continue_tsk_real',
  kind: 'TASK_CONTINUE',
  title: 'Continue launch checklist',
  reason: 'This task is currently running.',
  sourceRefs: [{ type: 'TASK', id: 'tsk_real', label: 'Launch checklist' }],
  action: { type: 'VIEW_TASK', label: 'View', requiresApproval: false },
  generatedAt: '2026-10-11T00:00:00.000Z',
};

describe('final daily operating loop proactive continuity', () => {
  it('accept/dismiss/snooze/dont-suggest persist and silence grants no authority', async () => {
    const root = tmp();
    const owner = makeOwner(root);
    const taskStore = new TaskStore({ dir: path.join(root, 'tasks') });
    const activityStore = new ActivityStore({ dir: path.join(root, 'activity') });
    const notificationStore = new NotificationStore({ dir: path.join(root, 'notifications') });
    const notificationEngine = new NotificationEngine({ store: notificationStore, auditLogger: new AuditLogger() });
    const proactiveInteractionStore = new ProactiveInteractionStore({ dir: path.join(root, 'proactive') });
    const deps = {
      rightNowIntelligenceService: { buildRightNow: async () => ({ generatedAt: suggestion.generatedAt, suggestions: [suggestion] }) } as any,
      proactiveInteractionStore,
      taskStore,
      activityStore,
      notificationEngine,
      modelErrorResult: (error: unknown) => ({ status: 500, data: { error: error instanceof Error ? error.message : String(error) } }),
    };

    assert.equal(taskStore.list(owner.tenantId, owner.principalId).length, 0, 'silence must not create a task');
    assert.equal(proactiveInteractionStore.list(owner.tenantId, owner.principalId).length, 0, 'silence must not create an interaction');

    const accepted = await handleProactiveSuggestionsRoutes('POST', `/api/v1/proactive-suggestions/${suggestion.id}/accept`, {}, owner.headers, {}, deps);
    assert.equal(accepted?.status, 201);
    assert.equal((accepted?.data as any).authorityGranted, false);
    assert.equal(taskStore.list(owner.tenantId, owner.principalId).length, 1);
    assert.equal(activityStore.list(owner.tenantId, owner.principalId).some((item) => item.type === 'PROACTIVE_ACCEPTED'), true);
    assert.equal(notificationStore.list(owner.tenantId, owner.principalId).some((item) => item.metadata?.target === `#tasks/${(accepted?.data as any).task.taskId}`), true);

    const dismissed = await handleProactiveSuggestionsRoutes('POST', `/api/v1/proactive-suggestions/${suggestion.id}/dismiss`, {}, owner.headers, {}, deps);
    assert.equal(dismissed?.status, 200);
    const snoozed = await handleProactiveSuggestionsRoutes('POST', `/api/v1/proactive-suggestions/${suggestion.id}/snooze`, { snoozedUntil: '2026-10-11T03:00:00.000Z' }, owner.headers, {}, deps);
    assert.equal(snoozed?.status, 200);
    const suppressed = await handleProactiveSuggestionsRoutes('POST', `/api/v1/proactive-suggestions/${suggestion.id}/dont-suggest-again`, {}, owner.headers, {}, deps);
    assert.equal(suppressed?.status, 200);

    const interactions = proactiveInteractionStore.list(owner.tenantId, owner.principalId);
    assert.equal(interactions.some((item) => item.decision === 'DISMISSED'), true);
    assert.equal(interactions.some((item) => item.decision === 'SNOOZED' && item.snoozedUntil === '2026-10-11T03:00:00.000Z'), true);
    assert.equal(interactions.some((item) => item.decision === 'DONT_SUGGEST_AGAIN' && item.suppressKey === 'TASK_CONTINUE:VIEW_TASK:TASK'), true);
  });
});
