import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GOOGLE_TENANT_ID } from '../integrations/google/token.store.js';

export type ReminderStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

// R23.1H — PersonalReminderStore was user-scoped only, a genuine
// CROSS_TENANT_LEAK: a shared user_id across two tenants could see each
// other's reminders. Every reminder is now explicitly tenant_id-scoped,
// and every read/mutation requires tenant_id + user_id together, never
// user_id alone.
//
// Backward compatibility: an on-disk record from before this migration has
// no tenant_id. There is no other field in a reminder record from which
// its real original tenant could be deterministically recovered, so
// guessing per-record is not an option — the chosen policy (mirroring
// MemoryEngine's own identical legacy-tenant backfill in
// src/context/memory.engine.ts) is to durably backfill any such record to
// the canonical default tenant on load, exactly once, and persist the
// backfill so it never has to be redone. A legacy reminder is therefore
// visible only under that one defined tenant, never under every tenant
// that happens to share its user_id.
const LEGACY_BACKFILL_TENANT_ID = DEFAULT_GOOGLE_TENANT_ID;

export interface PersonalReminder {
  reminder_id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  instruction?: string;
  scheduled_at: string; // ISO string timestamp
  timezone: string;
  status: ReminderStatus;
  source_context?: {
    source_type?: string;
    source_id?: string;
    reference_text?: string;
  };
  created_at: string;
  completed_at?: string;
  triggered_at?: string;
}

export class PersonalReminderStore {
  private reminders: Map<string, PersonalReminder> = new Map();
  private filePath: string;

  constructor(storageDir?: string) {
    const dir = storageDir || process.env.NAGEX_PERSONAL_REMINDERS_DIR || path.join(process.cwd(), '.nagex_data', 'runtime');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, 'personal_reminders.json');
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const list: Array<PersonalReminder & { tenant_id?: string }> = JSON.parse(raw);
        let needsSave = false;
        for (const item of list) {
          if (item.tenant_id === undefined) {
            item.tenant_id = LEGACY_BACKFILL_TENANT_ID;
            needsSave = true;
          }
          this.reminders.set(item.reminder_id, item as PersonalReminder);
        }
        if (needsSave) this.save();
      } catch (err) {
        // Fallback to empty if corrupt
      }
    }
  }

  private save(): void {
    try {
      const list = Array.from(this.reminders.values());
      fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      // Ignore save error
    }
  }

  public createReminder(params: Omit<PersonalReminder, 'reminder_id' | 'created_at' | 'status'> & { status?: ReminderStatus }): PersonalReminder {
    const reminder_id = `rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const reminder: PersonalReminder = {
      reminder_id,
      tenant_id: params.tenant_id,
      user_id: params.user_id,
      title: params.title,
      instruction: params.instruction,
      scheduled_at: params.scheduled_at,
      timezone: params.timezone || 'Asia/Seoul',
      status: params.status || 'ACTIVE',
      source_context: params.source_context,
      created_at: new Date().toISOString(),
    };

    this.reminders.set(reminder_id, reminder);
    this.save();
    return reminder;
  }

  // Ownership-checked, exactly like every other canonical store
  // (MemoryEngine/VaultStore/TaskStore) — a wrong-tenant or wrong-user
  // lookup is indistinguishable from a genuinely nonexistent id.
  public getReminder(reminderId: string, tenantId: string, userId: string): PersonalReminder | null {
    const r = this.reminders.get(reminderId);
    if (!r || r.tenant_id !== tenantId || r.user_id !== userId) return null;
    return r;
  }

  public listReminders(tenantId: string, userId: string, status?: ReminderStatus): PersonalReminder[] {
    const list = Array.from(this.reminders.values()).filter((r) => r.tenant_id === tenantId && r.user_id === userId);
    if (status) {
      return list.filter((r) => r.status === status);
    }
    return list;
  }

  public updateStatus(reminderId: string, tenantId: string, userId: string, status: ReminderStatus): PersonalReminder | null {
    const r = this.reminders.get(reminderId);
    if (!r || r.tenant_id !== tenantId || r.user_id !== userId) return null;
    r.status = status;
    if (status === 'COMPLETED') {
      r.completed_at = new Date().toISOString();
    }
    this.reminders.set(reminderId, r);
    this.save();
    return r;
  }

  public deleteReminder(reminderId: string, tenantId: string, userId: string): boolean {
    const r = this.reminders.get(reminderId);
    if (!r || r.tenant_id !== tenantId || r.user_id !== userId) return false;
    this.reminders.delete(reminderId);
    this.save();
    return true;
  }

  // A background scan across everyone (tenantId/userId omitted) by design
  // — the future proactive scheduler this feeds is expected to dispatch
  // each due reminder per its own real tenant_id/user_id, never assume a
  // single caller's scope. Optional tenantId/userId narrow the scan for
  // a caller that already knows its own scope (e.g. a direct API call),
  // without ever losing or reassigning a result's real tenant_id.
  public getDueReminders(now: Date = new Date(), tenantId?: string, userId?: string): PersonalReminder[] {
    const iso = now.toISOString();
    return Array.from(this.reminders.values()).filter(
      (r) =>
        r.status === 'ACTIVE' &&
        r.scheduled_at <= iso &&
        (tenantId === undefined || r.tenant_id === tenantId) &&
        (userId === undefined || r.user_id === userId)
    );
  }

  public markTriggered(reminderId: string): void {
    const r = this.reminders.get(reminderId);
    if (r) {
      r.triggered_at = new Date().toISOString();
      this.reminders.set(reminderId, r);
      this.save();
    }
  }

  public clear(): void {
    this.reminders.clear();
    this.save();
  }
}
