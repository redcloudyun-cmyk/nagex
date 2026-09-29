# NAgex Operations & Deployment

**Canonical Domain:** Deployment / Runtime Operations / Persistence / Verification
**Status:** CANONICAL operational baseline; host-specific values remain environment configuration
**Date:** 2026-09-29

## 1. Deployment Principle

Deployment must be reproducible, fail closed, preserve durable user state, and avoid presenting a partially verified release as healthy.

Operational scripts are implementation, not permission to discard local work.

## 2. Deployment Pipeline

The repository deployment notes define a guarded update path conceptually:

```text
Verify repository/branch/state
→ Fetch/update approved revision
→ Install locked dependencies
→ Verify required browser runtime
→ Build
→ Deterministic tests
→ Restart service
→ Safe post-deploy verification where supported
```

A failed pre-restart gate should leave the previous working service running where the deployment mechanism supports that behavior.

## 3. Repository Safety

Production/test deployment automation may require a clean checkout, but developer workspaces may contain unrelated changes.

Never apply destructive server-style cleanup commands to a developer working tree without explicit authorization.

Development Git discipline remains:

```text
NO git add .
NO git add -A
NO git commit -a
NO blind reset --hard
NO blind clean -fd
```

Stage exact milestone files.

## 4. Browser Runtime

Browser capability must fail closed when the required browser runtime is unavailable or cannot launch.

Checking for a cache directory is insufficient; deployment should verify the exact expected executable and real launch behavior.

OS-level browser dependencies are host provisioning concerns, separate from normal application updates.

## 5. Service Runtime

The canonical deployment environment uses a managed service process. Environment configuration and secrets belong outside the repository.

Service restart must not destroy durable approvals, executions, OAuth state, tasks or other data that are defined as persistent.

## 6. Secret and Environment Management

Secrets must not be committed.

Sensitive values belong in controlled environment/secret storage.

Logs must not print:

- OAuth refresh/access tokens;
- client secrets;
- encryption keys;
- credential plaintext;
- protected test tokens.

## 7. Google OAuth Persistence

The deployment baseline stores Google OAuth tokens encrypted outside the Git checkout.

The source deployment notes define `/var/lib/nagex` as the preferred Linux service data location with a user-local fallback for development/non-standard environments.

`NAGEX_TOKEN_ENCRYPTION_KEY` protects persisted token material.

Failure behavior is fail-closed:

- missing token file → disconnected;
- corrupted/wrong-key token file → disconnected;
- revoked refresh → disconnected.

Never report these states as connected.

## 8. Approval and Execution Persistence

Approvals and execution records that must survive restart are stored outside transient process memory.

Writes should be atomic to avoid torn state.

Expired approvals cannot be approved or executed.

Persistence must not include secrets merely because the execution references a credential.

## 9. Safe Verification

Operational verification separates safe checks from external mutations.

### Safe verification
May include:

- repository revision/state;
- build/tests;
- service health;
- OAuth connection status;
- read-only capability probes;
- browser safe navigation/snapshot;
- SSRF/safety checks;
- architecture bypass scans.

### Live external verification
May include explicitly authorized:

- test email send;
- test calendar creation;
- controlled browser submission;
- replay verification.

Live E2E is never silently folded into routine deployment.

## 10. Health and Readiness

Health endpoints and operational checks must reflect actual implementation.

Do not document or rely on a health route that does not exist in the deployed revision.

As routes evolve, deployment docs/scripts must be updated together.

## 11. Rollback / Failure

A deployment failure should produce a clear operational state and avoid security downgrade.

Rollback strategy must preserve compatible durable state and must not silently replay consequential actions.

## 12. Logging and Evidence

Operational logs should support:

- revision identification;
- build/test result;
- service restart status;
- verification result;
- safe failure diagnosis.

Logs are evidence, not a substitute for canonical runtime state.

## 13. Environment-Specific Configuration

Hostnames, ports, filesystem paths, service names, OAuth redirect URIs and provider credentials are environment configuration.

Canonical docs describe the contract; deployment manifests/env files describe the actual host.

## 14. CI

Ephemeral CI runners may provision browser binaries and OS dependencies each run.

Persistent hosts should provision OS dependencies separately from normal app updates unless the host image changes.

CI must not depend on production secrets for deterministic regression.

## 15. Operational Invariants

```text
SECRETS_IN_REPO = 0
SECRET_LOG_LEAK = 0
BROKEN_BROWSER_REPORTED_AVAILABLE = 0
LIVE_EXTERNAL_MUTATION_IN_SAFE_CHECK = 0
DEPLOYMENT_DESTROYS_DURABLE_USER_STATE = 0
OAUTH_CORRUPTION_REPORTED_CONNECTED = 0
EXPIRED_APPROVAL_EXECUTABLE = 0
```

## 16. Source Provenance

Consolidated from:

- `DEPLOYMENT.md`
- `ops/automated-testing.md`
- `DEVELOPMENT.md`
- current repository/server operational principles

Host-specific commands and historical script behavior remain implementation/evidence and should be re-verified against the active deployment revision before operational use.
