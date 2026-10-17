#!/usr/bin/env node
// Is the JEV credential configured where NAgex reads it, and would the JEV advisors exist in a process that has it? NO NETWORK, NO CALL TO JEV. Prints facts, never a key (not a character of it, not its length).
//
//   node scripts/jev-config-check.mjs                                   (after `npm run build`) this process's environment
//   node scripts/jev-config-check.mjs --jev-env-file /path/to/.env          the JEV names in a .env file (repeatable)
//   NAGEX_CERT_ENV_FROM_PID=<service pid> node scripts/jev-config-check.mjs   (Linux) the JEV names of the running service
import { describeJevConfig, resolveJevApiKey } from '../dist/src/model-gateway/jev-config.js';
import { JevVerificationAdvisor } from '../dist/src/verification/jev-verification-advisor.js';
import { loadJevEnv } from './_jev-env.mjs';

const { env, locations, problems } = loadJevEnv();
const status = describeJevConfig(env);
const { key, source } = resolveJevApiKey(env);
// the advisor object, built exactly as the application builds it, reports whether it holds a usable credential (no request is made)
const runtimeAccess = Boolean(key) && new JevVerificationAdvisor({ apiKey: key }).configured();

console.log(`JEV_ENV_KEY=${status.keyConfigured ? 'FOUND' : 'NOT_FOUND'}`);
if (source) console.log(`JEV_KEY_VARIABLE=${source}`);
if (source) console.log(`JEV_KEY_LOCATION=${locations[source]}`);
console.log(`JEV_SECRET_RESOLVER=${status.keyConfigured ? 'CONNECTED' : 'NOT_CONNECTED'}`);
console.log(`JEV_DECISION_ENABLED=${status.decisionEnabled}`);
console.log(`JEV_PROVIDER=${status.advisorsActive ? 'READY' : 'NOT_READY'}`);
console.log(`JEV_RUNTIME_KEY_ACCESS=${runtimeAccess ? 'PASS' : 'FAIL'}`);
console.log('JEV_LIVE=NOT_RUN');
console.log(`JEV_BLOCKER=${status.blocker ?? 'NONE'}`);
console.log('NEW_KEY_REQUIRED=NO');
for (const problem of problems) console.log(`CHECK_PROBLEM=${problem}`);
if (!status.keyConfigured) console.log('HINT=No JEV credential was found in the environment inspected. Point the check at where the service keeps it: --jev-env-file <the service .env> or NAGEX_CERT_ENV_FROM_PID=<service pid>.');
else if (!status.decisionEnabled) console.log('HINT=The credential is present; the JEV advisors stay off until NAGEX_JEV_DECISION_ENABLED=true is set for the service.');
else console.log('HINT=Configured. A live request is a separate, explicit step: NAGEX_LIVE_JEV=1 node scripts/jev-live-check.mjs (JEV may be billable - ask first).');
