#!/usr/bin/env node
// ONE real request to JEV System One, through the same request body the verification advisor sends, with synthetic features (no user data). OPT-IN, because JEV may be billable:
//
//   NAGEX_LIVE_JEV=1 node scripts/jev-live-check.mjs [--jev-env-file /path/to/.env]      (after `npm run build`)
//
// It is never part of a gate or a test run. It prints status facts only: the HTTP status, whether the answer has the verified shape (answers.level.{choice, confidence}) and the latency. It never prints
// the key, a header, or the response body of a successful call; the body of a failed call is shown only after the key is removed from it and cut to 300 characters.
import { resolveJevApiKey } from '../dist/src/model-gateway/jev-config.js';
import { loadJevEnv } from './_jev-env.mjs';
import { runLiveCheck } from './_jev-live.mjs';

if (process.env.NAGEX_LIVE_JEV !== '1') {
  console.log('JEV_LIVE=NOT_RUN');
  console.log('JEV_BLOCKER=LIVE_CHECK_NOT_OPTED_IN (set NAGEX_LIVE_JEV=1 to make ONE real request; JEV may be billable)');
  process.exit(0);
}
const { key } = resolveJevApiKey(loadJevEnv().env);
if (!key) {
  console.log('JEV_LIVE=NOT_RUN');
  console.log('JEV_BLOCKER=NO_API_KEY_IN_INSPECTED_ENVIRONMENT');
  process.exit(0);
}
const result = await runLiveCheck({ key, timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 10_000) });
if (result.http !== null) console.log(`HTTP_STATUS=${result.http}`);
console.log(`LATENCY_MS=${result.latencyMs}`);
if (result.shape) console.log(`ANSWER_SHAPE=${result.shape}`);
if (result.level) { console.log(`ANSWER_LEVEL=${result.level}`); console.log(`ANSWER_CONFIDENCE=${result.confidence}`); }
console.log(`JEV_LIVE=${result.live}`);
console.log(`JEV_BLOCKER=${result.blocker}`);
if (result.errorBody) console.log(`JEV_ERROR_BODY=${result.errorBody}`);
if (result.live !== 'PASS') process.exitCode = 1;
