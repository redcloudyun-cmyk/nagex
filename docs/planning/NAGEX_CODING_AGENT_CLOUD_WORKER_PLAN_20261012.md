# Coding Agent / Cloud Worker — Integration Plan

**Status:** PLAN ONLY — nothing in this document is implemented or advertised. Not a canonical document; it must be reconciled with
`canonical/NAgex_Execution_and_Cross_Platform_Architecture.md` and `canonical/NAgex_Trust_Identity_Privacy_and_Approval.md` before work starts.
**Date:** 2026-10-12

## 1. Starting point (as built)

- GitHub: built-in connection, **read-only** (`github.list_repos`, `github.list_directory`, `github.read_file`), identity-bound through the Capability Broker.
- MCP: user-registered Streamable-HTTP servers; every tool is a per-user `CONSEQUENTIAL` capability with approval `REQUIRED`.
- The API server never runs repository code and never spawns processes for users. That boundary is deliberate and stays.

## 2. Principle

The model reasons; NAgex governs and executes. A coding agent is an **execution plane**, not a new authority: it receives a bounded, approved work order and returns artifacts. It cannot approve, widen scope, or hold the user's GitHub token.

```text
WHAT  = canonical action (e.g. code.change.propose)
WHERE = isolated cloud worker (per task, per user, no shared state)
HOW   = worker executor behind a stable port
```

## 3. Slices (each independent, each approval-gated, each with its own tests)

1. **Change proposal (no execution).** Capability `code.change.propose`: the model produces a unified diff against a read-only checkout fetched with `github.read_file`/tree reads. The diff is stored as an artifact (document type) and shown to the user. No write to GitHub, no code run. *Evidence required:* diff size caps, path allowlist (no `.github/workflows`, no secrets files), untrusted-content tests (repository text cannot widen scope).
2. **Isolated verification worker.** A cloud worker (separate host/container, no inbound access, no NAgex secrets, egress limited to the git host and a package mirror) applies the approved diff to a fresh clone and runs the repository's tests with CPU/memory/time quotas. Output is a signed result record (exit code, truncated logs with secrets redacted). The API server only enqueues and reads results. *Evidence required:* sandbox escape/egress tests, quota tests, per-tenant isolation tests, worker identity (mTLS or signed job tokens).
3. **GitHub write path (separate OAuth scope decision).** `github.create_branch`, `github.push_commit`, `github.open_pull_request` as `CONSEQUENTIAL` / approval `REQUIRED` capabilities executed through the Broker's hash-bound approval; the approved payload is the exact diff hash + target repo/branch. Never push to a default/protected branch; PR only. Requires a narrower credential model than the current `repo` scope (fine-grained token or GitHub App installation) and a re-approval on any change of repo, branch, diff or account. *Evidence required:* approval replay/payload-tamper tests, branch-protection tests, token scope tests.
4. **Agent loop.** Plan → propose → (approve) → verify → (approve) → PR, reusing the task runner's pause/resume on approvals; each step shows real state in the Main agent view (no invented progress). Human handoff is a valid outcome and is reported as such.

## 4. Non-negotiables

- Credentials never enter the worker; the worker gets a short-lived, repo-scoped read token only if a clone is needed, minted per job.
- Repository content, logs and tool output are untrusted data; they cannot grant permission or change the target.
- Every job is bound to tenant + user + approval id; a result for another job/user is rejected.
- Truthful states: queued / running / failed / succeeded with real timestamps; no fake progress percentages.
- A provider (cloud worker vendor) is replaceable behind a port; no vendor identifiers become NAgex artifact identity.

## 5. Open decisions for the owner

1. Worker hosting (own host vs. a managed sandbox provider) and the egress policy.
2. GitHub credential model for writes (fine-grained PAT vs. GitHub App).
3. Whether verification output may be shown in Main or only summarized.
4. Which repositories/organizations may ever be written to (allowlist per user).

## 6. Order

Slice 1 first (no new risk surface), then 2 (needs infrastructure), then 3 (needs the credential decision), then 4.
