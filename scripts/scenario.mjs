#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  loadScenarioCatalog,
  findScenario,
  ScenarioRunner,
  buildScenarioMatrix,
  renderScenarioMatrixMarkdown,
  loadBehavioralRuleRegistry,
  buildBehaviorRuleMatrix,
  buildScenarioRuleCoverage,
  renderBehaviorRuleMatrixMarkdown,
} from '../dist/src/scenarios/index.js';

function argValue(args, name, fallback = undefined) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const scenarioId = args.find((arg) => !arg.startsWith('--')) || 'MSG-001';
  const modeRaw = String(argValue(args, '--mode', 'simulation')).toUpperCase();
  const mode = modeRaw === 'REAL' ? 'REAL' : modeRaw === 'SANDBOX' ? 'SANDBOX' : 'SIMULATION';
  const evidenceDir = path.resolve(String(argValue(args, '--evidence-dir', path.join('artifacts', 'scenario-certification'))));
  const resume = argValue(args, '--resume', undefined);
  const deviceId = argValue(args, '--device', undefined);

  const catalog = loadScenarioCatalog();
  const scenario = findScenario(catalog, scenarioId);
  const runner = new ScenarioRunner();
  const approvalGranted = args.includes('--approve') || mode === 'SIMULATION';
  const availablePreconditions = scenario.preconditions;
  const result = await runner.run(scenario, {
    mode,
    runId: resume,
    approvalGranted,
    availablePreconditions,
    executionMode: scenario.supportedExecutionModes[0],
    deviceId,
  });

  fs.mkdirSync(evidenceDir, { recursive: true });
  const resultPath = path.join(evidenceDir, `${result.runId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const matrixRows = buildScenarioMatrix(catalog.scenarios, [result]);
  fs.writeFileSync(path.join(evidenceDir, 'matrix.json'), JSON.stringify(matrixRows, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'matrix.md'), renderScenarioMatrixMarkdown(matrixRows));
  const behaviorRegistry = loadBehavioralRuleRegistry();
  const behaviorRows = buildBehaviorRuleMatrix(behaviorRegistry.rules);
  const coverageRows = buildScenarioRuleCoverage(behaviorRegistry.rules, catalog.scenarios);
  fs.writeFileSync(path.join(evidenceDir, 'behavior-rule-matrix.json'), JSON.stringify(behaviorRows, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'behavior-rule-matrix.md'), renderBehaviorRuleMatrixMarkdown(behaviorRows));
  fs.writeFileSync(path.join(evidenceDir, 'scenario-rule-coverage.json'), JSON.stringify(coverageRows, null, 2));

  console.log(JSON.stringify({
    scenarioId,
    runId: result.runId,
    status: result.status,
    failureCode: result.failureCode,
    resultPath,
    matrixJson: path.join(evidenceDir, 'matrix.json'),
    matrixMarkdown: path.join(evidenceDir, 'matrix.md'),
    behaviorRuleMatrixJson: path.join(evidenceDir, 'behavior-rule-matrix.json'),
    scenarioRuleCoverageJson: path.join(evidenceDir, 'scenario-rule-coverage.json'),
  }, null, 2));

  if (!['PASS', 'SKIPPED', 'WAITING_FOR_PRECONDITION', 'BLOCKED_USER_INTERACTION', 'OUTCOME_UNVERIFIED'].includes(result.status)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
