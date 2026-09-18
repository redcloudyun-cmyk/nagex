import * as fs from 'node:fs';
import * as path from 'node:path';

export type ReminderStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface PersonalReminder {
  reminder_id: string;
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
    const dir = storageDir || path.join(process.cwd(), '.nagex_data');
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
        const list: PersonalReminder[] = JSON.parse(raw);
        for (const item of list) {
          this.reminders.set(item.reminder_id, item);
        }
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

  public getReminder(reminderId: string): PersonalReminder | null {
    return this.reminders.get(reminderId) || null;
  }

  public listReminders(userId: string, status?: ReminderStatus): PersonalReminder[] {
    const list = Array.from(this.reminders.values()).filter((r) => r.user_id === userId);
    if (status) {
      return list.filter((r) => r.status === status);
    }
    return list;
  }

  public updateStatus(reminderId: string, userId: string, status: ReminderStatus): PersonalReminder | null {
    const r = this.reminders.get(reminderId);
    if (!r || r.user_id !== userId) return null;
    r.status = status;
    if (status === 'COMPLETED') {
      r.completed_at = new Date().toISOString();
    }
    this.reminders.set(reminderId, r);
    this.save();
    return r;
  }

  public deleteReminder(reminderId: string, userId: string): boolean {
    const r = this.reminders.get(reminderId);
    if (!r || r.user_id !== userId) return false;
    this.reminders.delete(reminderId);
    this.save();
    return true;
  }

  public getDueReminders(now: Date = new Date()): PersonalReminder[] {
    const iso = now.toISOString();
    return Array.from(this.reminders.values()).filter(
      (r) => r.status === 'ACTIVE' && r.scheduled_at <= iso
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
