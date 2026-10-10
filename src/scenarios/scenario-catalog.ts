import fs from 'node:fs';
import path from 'node:path';
import { NagexError } from '../common/errors.js';
import type { ScenarioDefinition } from './scenario.types.js';
import { assertScenarioDefinition } from './scenario.validation.js';

export interface ScenarioCatalog {
  schemaVersion: number;
  scenarios: ScenarioDefinition[];
}

export function loadScenarioCatalog(catalogPath = path.join(process.cwd(), 'scenarios', 'catalog.v1.json')): ScenarioCatalog {
  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { scenarios?: unknown }).scenarios)) {
    throw new NagexError({ code: 'SCENARIO_CATALOG_INVALID', category: 'VALIDATION', message: 'Scenario catalog must contain a scenarios array.' });
  }
  const schemaVersion = Number((raw as { schemaVersion?: unknown }).schemaVersion);
  const scenarios = ((raw as { scenarios: unknown[] }).scenarios).map((item) => assertScenarioDefinition(item));
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.scenarioId)) {
      throw new NagexError({ code: 'SCENARIO_DUPLICATE_ID', category: 'VALIDATION', message: `Duplicate scenarioId ${scenario.scenarioId}.` });
    }
    ids.add(scenario.scenarioId);
  }
  return { schemaVersion, scenarios };
}

export function findScenario(catalog: ScenarioCatalog, scenarioId: string): ScenarioDefinition {
  const scenario = catalog.scenarios.find((item) => item.scenarioId === scenarioId);
  if (!scenario) {
    throw new NagexError({ code: 'SCENARIO_NOT_FOUND', category: 'NOT_FOUND', message: `Scenario ${scenarioId} was not found.` });
  }
  return scenario;
}
