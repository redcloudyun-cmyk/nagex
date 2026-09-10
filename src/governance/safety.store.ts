// NAgex Trust & Safety Layer — PersistentSafetyStore (TS-6, TS-7)
// Directive: docs/NAgex_Trust_and_Safety_Layer_Development_Directive_20260908.md

import fs from 'node:fs';
import path from 'node:path';
import { EnforcementLevel, SafetyEvent, SafetyRiskLevel } from './safety.types.js';
import { resolveNagexDataDir } from './file-record.store.js';

export interface UserSafetyStatus {
  tenantId: string;
  userId: string;
  enforcementLevel: EnforcementLevel;
  warningCount: number;
  blockedCount: number;
  lastEventAt?: string;
  requiresHumanReview: boolean;
}

export class PersistentSafetyStore {
  private baseDir: string;

  constructor(options?: { dir?: string; env?: NodeJS.ProcessEnv }) {
    const env = options?.env ?? process.env;
    this.baseDir = options?.dir || resolveNagexDataDir('safety', 'NAGEX_SAFETY_DIR', env);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getEventsFilePath(tenantId: string): string {
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `safety_events_${safeTenant}.json`);
  }

  private getStatusFilePath(tenantId: string, userId: string): string {
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `safety_status_${safeTenant}_${safeUser}.json`);
  }

  public async recordEvent(event: SafetyEvent): Promise<SafetyEvent> {
    const filePath = this.getEventsFilePath(event.tenantId);
    let events: SafetyEvent[] = [];

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        events = JSON.parse(raw);
      } catch (err) {
        events = [];
      }
    }

    events.push(event);
    fs.writeFileSync(filePath, JSON.stringify(events, null, 2), 'utf-8');

    // Update tenant/user enforcement status if event was R3 or R4 or blocked
    if (event.riskLevel === 'R3' || event.riskLevel === 'R4' || event.eventType.includes('blocked')) {
      await this.incrementUserWarning(event.tenantId, event.userId, event.riskLevel);
    }

    return event;
  }

  public async getEvents(tenantId: string): Promise<SafetyEvent[]> {
    const filePath = this.getEventsFilePath(tenantId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      return [];
    }
  }

  public async getUserStatus(tenantId: string, userId: string): Promise<UserSafetyStatus> {
    const filePath = this.getStatusFilePath(tenantId, userId);
    if (!fs.existsSync(filePath)) {
      return {
        tenantId,
        userId,
        enforcementLevel: 'NONE',
        warningCount: 0,
        blockedCount: 0,
        requiresHumanReview: false,
      };
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      return {
        tenantId,
        userId,
        enforcementLevel: 'NONE',
        warningCount: 0,
        blockedCount: 0,
        requiresHumanReview: false,
      };
    }
  }

  private async incrementUserWarning(
    tenantId: string,
    userId: string,
    riskLevel: SafetyRiskLevel
  ): Promise<UserSafetyStatus> {
    const current = await this.getUserStatus(tenantId, userId);
    current.blockedCount += 1;
    current.lastEventAt = new Date().toISOString();

    if (riskLevel === 'R3') {
      current.warningCount += 1;
      if (current.warningCount >= 3) {
        current.enforcementLevel = 'RESTRICT_CAPABILITY';
      } else {
        current.enforcementLevel = 'WARN';
      }
    } else if (riskLevel === 'R4') {
      current.warningCount += 1;
      current.requiresHumanReview = true;
      current.enforcementLevel = 'ACCOUNT_REVIEW';
    }

    const filePath = this.getStatusFilePath(tenantId, userId);
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
    return current;
  }
}
