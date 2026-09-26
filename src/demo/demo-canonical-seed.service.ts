// R23.2D — Demo Canonicalization.
//
// Seeds the canonical demo persona's Task/Vault/Approval records into the
// REAL production stores (Memory is already seeded this way — see
// create-nagex-application.ts's ensureSeedMemory) so CurrentPersonalContext
// Service/RightNowIntelligenceService/PersonalHomeService read genuine
// records for the demo tenant through the exact same pipeline every other
// tenant uses (DEMO_FAKE_PERSONAL_HOME=0, DEMO_FAKE_RIGHT_NOW=0). Calendar/
// Gmail are handled separately (see demo-personal-data-source.ts) since
// they are computed, not persisted. This service owns seed/reset only —
// it never builds a Home/Right Now response shape itself.
import fs from 'node:fs';
import path from 'node:path';
import type { TaskStore } from '../tasks/task.store.js';
import type { VaultStore } from '../workspace/vault.store.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';

interface PersonaFixture {
  vault: Array<{ id: string; title: string; content: string }>;
  task: { id: string; title: string };
}

function loadFixture(fixturePath: string): PersonaFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as PersonaFixture;
}

export class DemoCanonicalSeedService {
  private readonly fixture: PersonaFixture;

  constructor(
    private readonly deps: {
      taskStore: TaskStore;
      vaultStore: VaultStore;
      actionApprovals: ActionApprovalStore;
      tenantId: string;
      ownerId: string;
    },
    fixturePath = path.join(process.cwd(), 'demo', 'seed', 'canonical-persona.json'),
  ) {
    this.fixture = loadFixture(fixturePath);
  }

  // Idempotent — safe to call on every server start (mirrors
  // ensureSeedMemory's own idempotent pattern) as well as after reset().
  public seed(): void {
    const { taskStore, vaultStore, actionApprovals, tenantId, ownerId } = this.deps;

    const existingTasks = taskStore.list(tenantId, ownerId);
    if (!existingTasks.some((t) => t.name === this.fixture.task.title)) {
      taskStore.create({
        tenantId,
        ownerId,
        name: this.fixture.task.title,
        objective: this.fixture.task.title,
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
      });
    }

    const existingVaultTitles = new Set(vaultStore.listItems(tenantId, ownerId).map((v) => v.title));
    for (const item of this.fixture.vault) {
      if (existingVaultTitles.has(item.title)) continue;
      vaultStore.saveItem({
        tenantId,
        userId: ownerId,
        type: item.id === 'demo_vault_notes' ? 'SAVED_ANALYSIS' : 'DOCUMENT',
        title: item.title,
        mimeType: item.id === 'demo_vault_notes' ? 'text/markdown' : 'application/pdf',
        storageRef: `demo://vault/${item.id}`,
        source: 'DEMO_SEED',
        // Real provenance metadata (which real email thread this document
        // relates to) — not display text. This is what lets
        // CurrentPersonalContextService's own real nameHint-based Vault
        // search (never re-implemented here) genuinely find it as related
        // to the client meeting's attendee, exactly as it would for any
        // real user's own similarly-tagged document.
        sourceRef: 'sarah.chen@example.test',
        metadata: { summary: item.content },
      });
    }

    if (actionApprovals.listPending(tenantId, ownerId).length === 0) {
      actionApprovals.request({
        toolId: 'GMAIL_REPLY',
        tenantId,
        principalId: ownerId,
        payload: { to: 'sarah.chen@example.test', subject: 'Re: Pricing and timeline for next phase' },
      });
    }
  }

  // Clears this tenant's demo-seeded Task/Vault/Approval records and
  // re-seeds a fresh baseline — DEMO reset must stay deterministic.
  public reset(): void {
    const { taskStore, vaultStore, actionApprovals, tenantId, ownerId } = this.deps;

    for (const task of taskStore.list(tenantId, ownerId)) {
      taskStore.delete(task.taskId, tenantId, ownerId);
    }
    for (const item of vaultStore.listItems(tenantId, ownerId)) {
      vaultStore.deleteItem(item.vaultItemId, tenantId, ownerId);
    }
    // ActionApprovalStore has no delete primitive — reject() is the real,
    // existing way to remove a record from listPending().
    for (const approval of actionApprovals.listPending(tenantId, ownerId)) {
      actionApprovals.reject(approval.approvalId, tenantId, ownerId, 'demo_reset');
    }

    this.seed();
  }
}
