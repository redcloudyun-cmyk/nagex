import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DesktopAppConfig {
  gatewayUrl: string;
  principalId: string;
  tenantId: string;
  hotkey: string;
  alwaysOnTop: boolean;
  openAtLogin: boolean;
  windowBounds?: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  };
}

export const DEFAULT_DESKTOP_CONFIG: DesktopAppConfig = {
  gatewayUrl: process.env.NAGEX_GATEWAY_URL || 'http://localhost:8085',
  principalId: process.env.NAGEX_DEFAULT_PRINCIPAL || 'usr_admin_001',
  tenantId: process.env.NAGEX_DEFAULT_TENANT || 'ten_production_01',
  hotkey: 'Alt+N',
  alwaysOnTop: false,
  openAtLogin: false,
  windowBounds: {
    width: 420,
    height: 680,
  },
};

export class DesktopConfigStore {
  private readonly configPath: string;
  private currentConfig: DesktopAppConfig;

  constructor(customDir?: string) {
    const configDir = customDir || path.join(os.homedir(), '.nagex', 'desktop');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.configPath = path.join(configDir, 'config.json');
    this.currentConfig = this.load();
  }

  public get(): DesktopAppConfig {
    return { ...this.currentConfig };
  }

  public update(patch: Partial<DesktopAppConfig>): DesktopAppConfig {
    this.currentConfig = {
      ...this.currentConfig,
      ...patch,
      windowBounds: patch.windowBounds ? { ...this.currentConfig.windowBounds, ...patch.windowBounds } : this.currentConfig.windowBounds,
    };
    this.save();
    return this.get();
  }

  private load(): DesktopAppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_DESKTOP_CONFIG,
          ...parsed,
        };
      }
    } catch {
      // Fallback on corrupt config
    }
    return { ...DEFAULT_DESKTOP_CONFIG };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2), 'utf8');
    } catch (err) {
      console.error('[DesktopConfigStore] Failed to save desktop config:', err);
    }
  }
}
