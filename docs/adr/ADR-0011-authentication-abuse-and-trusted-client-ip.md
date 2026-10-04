# ADR-0011 — Authentication abuse throttling and the trusted client-IP boundary (S2E)

**Status:** Accepted (Security Gate S2E)
**Date:** 2026-10-04
**Related:** post-S2D reconciliation (S0-03, S0-04), ADR-0006 (S1), Trust/Identity/Privacy/Approval §6, Operations and Deployment §7b, MASTER §5 and §7

## Series naming

S2A–S2E belong to the security-hardening sub-series that followed Security Gate S1. The sub-series is **not** equivalent to the broad
S1–S8 phase numbering of the original S0 audit, whose terminology and finding ids (S0-xx) are left as written.

## Context

Reproduced at `543eeae` with isolated synthetic accounts:

- The client address was the **first** value of a client-supplied `X-Forwarded-For` (three copies of the derivation), so every
  per-address limit was escaped by rotating that header: 40 rotated values against one account were all answered `401`, none `429`
  (S0-03). The same value was written to the audit log and to the session record.
- `POST /api/v1/account/reactivate` and `POST /api/v1/account/delete/cancel` are public, take an email and a password, and had **no
  limiter**: 60 wrong guesses were all verified. They also answered a correct password on a wrong-state account (`400
  ACCOUNT_NOT_DISABLED` / `NO_PENDING_DELETION`) differently from a wrong password, a password oracle (S0-04).
- Password verification is synchronous `scryptSync`: every attempt blocked the single event-loop thread (health latency rose from
  ~15 ms to ~290 ms under 40 concurrent wrong-password requests), so unthrottled verification was also a CPU denial-of-service lever.
- The single-key limiter never deleted a key: attacker-chosen keys grew the map without bound.

Deployment chain at the time: Cloudflare tunnel → nginx (`$proxy_add_x_forwarded_for`) → Node on `127.0.0.1`. Node never saw the TCP
peer of the real client, and nothing distinguished a header an operated proxy appended from one the sender typed.

## Decision

1. **The TCP peer is the authoritative client address.** `X-Forwarded-For` is consulted **only** when the immediate peer matches an
   explicitly configured trusted-proxy set (`NAGEX_TRUSTED_PROXIES`, comma-separated IPs/CIDRs — not a hop count). It is then resolved
   **right-to-left** through trusted hops: the first address from the right that is not a trusted proxy is the client; the leftmost
   entry is never trusted by position. A malformed entry, an implausibly long chain (> 32 hops), an invalid or empty configuration, or
   a missing peer fall back to the peer address. `CF-Connecting-IP` (and `X-Real-IP`, `Forwarded`, …) are never read and no
   Cloudflare range is hardcoded; the operator lists whichever proxies actually sit in front of Node.
2. **One resolver, one registry.** `src/http/client-ip.ts` resolves the address once per request in the HTTP layer and records it in a
   WeakMap keyed by the request's header object (the S1 identity pattern); `canonicalizeRequestHeaders` carries it to the canonical
   copy. Routes call `clientIpOf(headers)`. A header object the HTTP layer never resolved (a direct call) has the address
   `unresolved` — a route never falls back to reading a header. Audit `ip` and session `ipAddress` use the same value
   (`AUDIT_IP_USES_TRUSTED_RESOLVER`, `SESSION_IP_USES_TRUSTED_RESOLVER`). IPv6 clients are throttled by their `/64`.
3. **Progressive throttling, never a lockout** (`src/identity/auth-abuse-guard.ts`). Three dimensions per protected scope:
   *ip* (broad abuse across accounts), *account* (guessing one account from rotating addresses; keyed by a digest of the normalized
   email, so existing and unknown accounts behave identically) and *pair* (focused brute force). A bucket that reaches its threshold in
   a 15-minute window starts a cooldown (`429` + `Retry-After`); each further hit after a cooldown re-arms a doubled one up to a cap
   (pair 30 s → 15 min, account 15 s → 5 min, ip 30 s → 15 min); a quiet window clears the history. A request refused during a
   cooldown neither hashes a password nor extends the cooldown. A successful sign-in clears the pair and account history, never the
   ip history. There is no per-account hard lockout (it would let anyone deny the owner access).
4. **One shared password-guess budget.** Login, reactivate and delete-cancel all test the same secret and share the `credential`
   scope. Every check happens **before** any password hashing (`THROTTLED_PASSWORD_HASH_CALLS = 0`), also for signup. Signup, forgot-
   password and resend-verification use the same resolver and guard in their own scopes; forgot/resend keep their uniform
   acknowledgement (a throttled request answers like any other and issues no token).
5. **No account-state oracle on the unauthenticated recovery routes.** Reactivate and delete-cancel answer a wrong password, an unknown
   address and a correct password on a wrong-state account with the same `401 AUTH_INVALID_CREDENTIALS`, and all of them count as a
   failed guess. The legitimate flows (disabled → reactivate, deletion pending → cancel) are unchanged.
6. **Memory is bounded.** Every bucket map has a cap (default 20 000 per dimension): expired buckets are swept opportunistically and,
   at the cap, the oldest bucket is evicted. Keys are normalized addresses or short digests, never attacker-sized strings.
7. **Test-only peer injection.** Tests no longer forge `X-Forwarded-For`. `createServerInstance({ clientIp: { testPeerAddress } })`
   replaces the socket's remote address for a *test* server. It is a programmatic option — not an environment variable, not a header
   the production server reads — and `createServerInstance` throws when `NODE_ENV` is `production`; the real start path never
   passes it. Tests that spawn a real server process (no seam exists there) set `NAGEX_TRUSTED_PROXIES=127.0.0.1,::1`, i.e. they
   act as the trusted front proxy, which is the production configuration path, not a backdoor.

## Consequences

- **Deployment prerequisite.** Behind nginx, Node's TCP peer is the proxy. Without `NAGEX_TRUSTED_PROXIES` (e.g. `127.0.0.1,::1`) every
  client shares the proxy address, so the per-IP and pair buckets are shared by all users. The server logs one structured warning
  (`forwarded_for_ignored_no_trusted_proxy`) when it sees `X-Forwarded-For` from a loopback peer with no trusted proxy configured.
  The nginx hop must **append** the observed address (`proxy_add_x_forwarded_for`, as deployed) and must be the only way to reach
  Node. This is a configuration change on the test server and must be re-verified on the public path after deployment.
- The limiter is **process-local** (single-node). A distributed backend and multi-node coordination are a later decision.
- A determined attacker can still keep a *specific account* in a short cooldown (≤ 5 min) by sustaining failures from many
  addresses; the cap and the absence of a lockout bound that harm. Mitigations such as known-device allowance or CAPTCHA are not
  part of this slice.
- Pre-S2E clients that relied on `400 ACCOUNT_NOT_DISABLED` / `NO_PENDING_DELETION` now receive `401 AUTH_INVALID_CREDENTIALS`.
  The shipped UI shows the server message and was not branching on those codes.
- A signed-in user's own correct login while their account or pair bucket is cooling down is also refused with `429` (no hashing
  happens while throttled); the cooldowns are short by design.

## Not decided here

Session-id exposure in the login response (S0-11), cookie and security headers (S0-12), account enumeration through timing and
status differences (S0-13), social OAuth (S0-14), outbound URL guards, request-size limits, the authenticated password-confirmation
routes (account/password, disable, delete, email change), a distributed limiter backend, and production multi-node coordination.
