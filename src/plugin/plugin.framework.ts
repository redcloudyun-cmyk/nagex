import { AgexError } from '../common/errors.js';

export interface EgressRule {
  host: string;
  port: number;
  protocol: 'HTTP' | 'HTTPS';
}

export interface PluginManifest {
  package: string;
  version: string;
  egress: EgressRule[];
}

export class PluginFramework {
  private registeredPlugins: Map<string, PluginManifest> = new Map();

  public registerPlugin(manifest: PluginManifest): void {
    this.registeredPlugins.set(manifest.package, manifest);
  }

  public validateEgressAccess(
    packageName: string,
    targetHost: string,
    targetPort: number,
    targetProtocol: 'HTTP' | 'HTTPS'
  ): boolean {
    const plugin = this.registeredPlugins.get(packageName);
    if (!plugin) {
      throw new AgexError({
        code: 'PLUGIN_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Plugin package ${packageName} not registered.`,
        request_id: 'plg_req',
      });
    }

    const allowed = plugin.egress.some(
      rule =>
        (rule.host === '*' || rule.host === targetHost) &&
        rule.port === targetPort &&
        rule.protocol === targetProtocol
    );

    if (!allowed) {
      throw new AgexError({
        code: 'PLUGIN_EGRESS_DENIED',
        category: 'POLICY',
        message: `Plugin ${packageName} denied egress access to ${targetProtocol}://${targetHost}:${targetPort}.`,
        request_id: 'plg_req',
      });
    }

    return true;
  }
}
