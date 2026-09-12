// Preloaded via `node --require ./dist/tests/_setup.js` before any test file
// (or server_web.ts, which constructs file-backed singletons at module load)
// runs. Without this, PersistentActionApprovalStore/ExecutionStore/
// SessionStore/TaskStore/TaskRunStore would default to /var/lib/nagex (or
// ~/.local/share/nagex on a dev machine) and litter the real filesystem
// with test data on every `npm test` run. The Google OAuth token store is
// safe by construction (it only ever writes when NAGEX_TOKEN_ENCRYPTION_KEY
// is set, which tests never set), but it's redirected too for defense in
// depth.
import os from 'node:os';
import path from 'node:path';

const dataRoot = path.join(os.tmpdir(), 'nagex-test-data', `${process.pid}-${Date.now()}`);

process.env.NODE_ENV ??= 'test';
process.env.NAGEX_ALLOW_LOCAL_TEST_URLS ??= '1';
process.env.NAGEX_APPROVALS_DIR ??= path.join(dataRoot, 'approvals');
process.env.NAGEX_EXECUTIONS_DIR ??= path.join(dataRoot, 'executions');
process.env.NAGEX_GOOGLE_TOKEN_STORE_PATH ??= path.join(dataRoot, 'google-oauth.json');
process.env.NAGEX_SESSIONS_DIR ??= path.join(dataRoot, 'sessions');
process.env.NAGEX_TASKS_DIR ??= path.join(dataRoot, 'tasks');
process.env.NAGEX_TASK_RUNS_DIR ??= path.join(dataRoot, 'task-runs');
process.env.NAGEX_BROWSER_SESSIONS_DIR ??= path.join(dataRoot, 'browser-sessions');
process.env.NAGEX_BROWSER_PROFILE_DIR ??= path.join(dataRoot, 'browser-profile');
process.env.NAGEX_BROWSER_EVIDENCE_DIR ??= path.join(dataRoot, 'browser-evidence');
process.env.NAGEX_SAFETY_DIR ??= path.join(dataRoot, 'safety');
process.env.NAGEX_ACTIVITY_DIR ??= path.join(dataRoot, 'activity');
process.env.NAGEX_CAPTURES_DIR ??= path.join(dataRoot, 'workspace-captures');
process.env.NAGEX_CANDIDATES_DIR ??= path.join(dataRoot, 'candidates');
process.env.NAGEX_CONVERSATIONS_DIR ??= path.join(dataRoot, 'conversations');
process.env.NAGEX_NOTIFICATIONS_DIR ??= path.join(dataRoot, 'notifications');
process.env.NAGEX_OBJECT_STORAGE_DIR ??= path.join(dataRoot, 'object-storage');
process.env.NAGEX_TELEGRAM_DIR ??= path.join(dataRoot, 'telegram-identities');
process.env.NAGEX_SLACK_DIR ??= path.join(dataRoot, 'slack-identities');
process.env.NAGEX_MEMORIES_DIR ??= path.join(dataRoot, 'memories');
