import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { ActivityStore } from '../../governance/activity.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { KnowledgeEngine } from '../../context/knowledge.engine.js';
import type { MemoryEngine } from '../../context/memory.engine.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { TaskStore } from '../../tasks/task.store.js';
import type { CaptureStore } from '../../workspace/capture.store.js';
import type { VaultStore } from '../../workspace/vault.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';

export interface SearchRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  captureStore: CaptureStore;
  taskStore: TaskStore;
  knowledgeEngine: KnowledgeEngine;
  memoryEngine: MemoryEngine;
  vaultStore: VaultStore;
  artifactStore: ArtifactStore;
  activityStore: ActivityStore;
}

interface SearchResult {
  id: string;
  source: 'INBOX' | 'TASKS' | 'KNOWLEDGE' | 'MEMORY' | 'VAULT' | 'ARTIFACTS' | 'ACTIVITY';
  title: string;
  snippet: string;
  target: string;
  updatedAt: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function matches(query: string, ...values: unknown[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => text(value).toLowerCase().includes(q));
}

function limitResults(results: SearchResult[], limit: number): SearchResult[] {
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, Math.min(limit, 50)));
}

export const handleSearchRoutes: AsyncRouteRegistrar<SearchRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  if (method !== 'GET' || (pathname !== '/api/v1/search' && pathname !== '/api/v1/workspace/search')) return undefined;
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to search your NAgex workspace.' } } };

  const q = typeof query.q === 'string' ? query.q : typeof query.query === 'string' ? query.query : '';
  const limit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : 20;
  const tenantId = owner.tenantId;
  const ownerId = owner.principalId;
  const prefs = deps.identityStore.getPreferences(owner.userId);
  const privacy = prefs.privacy ?? {};
  const results: SearchResult[] = [];

  for (const item of deps.captureStore.listCaptures(tenantId, ownerId)) {
    if (!matches(q, item.content, item.metadata.extractedTitle, item.metadata.extractedSummary, item.status)) continue;
    results.push({ id: item.captureId, source: 'INBOX', title: item.metadata.extractedTitle || item.content.slice(0, 80) || 'Inbox item', snippet: item.metadata.extractedSummary || item.content.slice(0, 180), target: `#inbox/${item.captureId}`, updatedAt: item.updatedAt });
  }
  for (const task of deps.taskStore.list(tenantId, ownerId)) {
    if (!matches(q, task.name, task.objective, task.status, task.trigger?.type)) continue;
    results.push({ id: task.taskId, source: 'TASKS', title: task.name, snippet: task.objective || task.status, target: `#tasks/${task.taskId}`, updatedAt: task.updatedAt });
  }
  for (const doc of deps.knowledgeEngine.searchDocuments(tenantId, ownerId, q)) {
    results.push({ id: doc.document_id, source: 'KNOWLEDGE', title: doc.title, snippet: doc.content.slice(0, 180), target: `#knowledge/${doc.document_id}`, updatedAt: doc.indexedAt ?? doc.createdAt ?? '' });
  }
  if (privacy.includeMemoryInSearch !== false) {
    for (const memory of deps.memoryEngine.searchMemories(tenantId, ownerId, q)) {
      const value = typeof memory.content.value === 'string' ? memory.content.value : JSON.stringify(memory.content.value);
      results.push({ id: memory.id, source: 'MEMORY', title: memory.content.subject, snippet: value.slice(0, 180), target: `#memory/${memory.id}`, updatedAt: memory.updated_at });
    }
  }
  if (privacy.includeVaultInSearch !== false) {
    for (const item of deps.vaultStore.searchItems(tenantId, ownerId, q)) {
      results.push({ id: item.vaultItemId, source: 'VAULT', title: item.title, snippet: item.type, target: `#vault/${item.vaultItemId}`, updatedAt: item.updatedAt });
    }
  }
  for (const artifact of deps.artifactStore.list(tenantId, ownerId, 50)) {
    if (!matches(q, artifact.title, artifact.preview, artifact.type)) continue;
    results.push({ id: artifact.artifactId, source: 'ARTIFACTS', title: artifact.title, snippet: artifact.preview, target: artifact.openTarget, updatedAt: artifact.updatedAt });
  }
  for (const activity of deps.activityStore.list(tenantId, ownerId, 50)) {
    if (!matches(q, activity.title, activity.description, activity.status, activity.type)) continue;
    results.push({ id: activity.activityId, source: 'ACTIVITY', title: activity.title, snippet: activity.description || activity.status, target: `#activity/${activity.activityId}`, updatedAt: activity.occurredAt });
  }

  return { status: 200, data: { query: q, results: limitResults(results, Number.isFinite(limit) ? limit : 20), searchedSources: ['INBOX', 'TASKS', 'KNOWLEDGE', 'MEMORY', 'VAULT', 'ARTIFACTS', 'ACTIVITY'], externalSourcesSearched: false } };
};
