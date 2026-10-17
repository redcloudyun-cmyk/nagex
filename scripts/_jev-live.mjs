// The one request of scripts/jev-live-check.mjs, separated from the opt-in / environment handling so it can be exercised with an injected fetch (tests never reach the real service).
// Returns facts only. The key never appears in the result: a failed call's body is returned after the key and any bearer token are removed, cut to 300 characters.
import { buildJevLevelBody } from '../dist/src/verification/jev-verification-advisor.js';
import { JEV_SYSTEMONE_ENDPOINT } from '../dist/src/model-gateway/jev-provider.js';
import { VERIFICATION_LEVELS } from '../dist/src/verification/verification.types.js';

/** Synthetic: enumerated kinds and buckets only. No question, answer, source or name. */
export const LIVE_CHECK_FEATURES = { freshness: 'CURRENT', category: 'PRODUCT', turnKind: 'NEW_QUESTION', comparison: true, research: true, highImpact: [], hedged: false, sourcesBucket: 'SEVERAL', baseLevel: 'L2' };

export function scrubBody(text, key) {
  return String(text).split(key).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').slice(0, 300);
}

export async function runLiveCheck({ key, fetchFn = fetch, endpoint = JEV_SYSTEMONE_ENDPOINT, timeoutMs = 10_000, now = Date.now }) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify(buildJevLevelBody(LIVE_CHECK_FEATURES)),
    });
    const latencyMs = now() - started;
    if (!response.ok) {
      const blocker = response.status === 401 || response.status === 403 ? 'KEY_REJECTED_BY_JEV' : response.status === 422 ? 'REQUEST_SHAPE_REJECTED' : response.status === 429 ? 'RATE_LIMITED_OR_QUOTA' : `HTTP_${response.status}`;
      return { live: 'FAIL', http: response.status, latencyMs, blocker, errorBody: scrubBody(await response.text().catch(() => ''), key) };
    }
    const payload = await response.json().catch(() => null);
    const answer = payload?.answers?.level;
    const choice = typeof answer?.choice === 'string' ? answer.choice.trim().toUpperCase() : '';
    const confidence = typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : NaN;
    const shapeOk = VERIFICATION_LEVELS.includes(choice) && confidence >= 0 && confidence <= 1;
    return shapeOk
      ? { live: 'PASS', http: response.status, latencyMs, blocker: 'NONE', shape: 'VALID', level: choice, confidence }
      : { live: 'FAIL', http: response.status, latencyMs, blocker: 'ANSWER_SHAPE_NOT_AS_EXPECTED', shape: 'INVALID' };
  } catch (error) {
    return { live: 'FAIL', http: null, latencyMs: now() - started, blocker: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}
