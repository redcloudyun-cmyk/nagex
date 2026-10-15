# NAgex D-09 — Outbound IPv6 SSRF Policy Fix: Security Certification

Date: 2026-10-15 KST
Branch: `fix/outbound-ipv6-ssrf-20261015` (base `2140f9e`, head of the PR #16 integration branch), commit `66db0c0`. Independent of the test-isolation branch — no shared files. Not coupled to the Vault UI.
Directive: `NAGEX_D09_LIVE_DATA_CONTAMINATION_RECOVERY_DIRECTIVE_20261015.md`, P0-3.
Status: **CERTIFIED: Windows development machine (§4) and ephemeral Linux runners (§5).** Not merged, not deployed, nothing run on the service host.

## 1. The defect

`new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]` — the WHATWG parser keeps the brackets and rewrites mapped addresses to hex. Node's `isIPv6()` does not accept the bracketed text, so the policy never recognised the host as an address and fell through to `dns.lookup('[::ffff:7f00:1]')`.

- Windows' resolver answers for the bracketed literal, the answer is private, the request is denied: the tests passed.
- Linux's resolver answers `ENOTFOUND` for the same string. The request was denied **only because DNS failed**, with a DNS error instead of the private-network reason — a denial by accident. A resolver (or a future change in the lookup path) that answered for brackets, or an environment where the lookup succeeded, would have fed the destination straight into the connection. The Linux test run on the candidate failed on exactly this classification.

## 2. The fix (`src/security/outbound-url-policy.ts`)

- **Byte-level IPv6 parser** (`parseIPv6`): every textual form — compressed, bracketed, zone id, IPv4 dotted tail — into 16 bytes. Anything it cannot parse as an address is not an address (so host names and malformed text stay the business of the other checks; `isPrivateIPv6` keeps returning `false` for non-IPv6 text, which the browser URL validator relies on).
- **Deny-by-default classifier** (`classifyIPv6`): only global unicast (`2000::/3`) outside the special-purpose ranges is public. Loopback, unspecified, link-local, site-local, ULA, multicast, documentation, benchmarking, discard, `64:ff9b::/96` (NAT64), `64:ff9b:1::/48`, 6to4 (`2002::/16`), Teredo, ORCHID, IPv4-compatible and IPv4-mapped addresses are refused; mapped/NAT64/6to4 forms **carry an IPv4 address that is judged by the IPv4 rules** (so `[::ffff:a00:1]`, `[::ffff:10.0.0.1]`, `[64:ff9b::a9fe:a9fe]`, `[2002:7f00:1::]` are all private), in hex or dotted notation and any letter case.
- **Literal hosts are judged by address, before and never by DNS.** The resolver is not consulted for a literal: private literal → refused with `OUTBOUND_PRIVATE_IPV6`; public literal → allowed without DNS (it used to be refused on Linux only because the lookup failed). The verdict does not depend on what DNS would answer.
- **Names**: every resolved address goes through the same classifier in any textual form (including hex-mapped, which the old check missed). One private answer among public ones refuses the request. Redirect revalidation and the pinned-lookup rebinding check use the same classifier (`OUTBOUND_DNS_REBINDING`).
- **Typed errors**: `OutboundPolicyError` with stable codes (`OUTBOUND_UNSUPPORTED_PROTOCOL`, `OUTBOUND_EMBEDDED_CREDENTIALS`, `OUTBOUND_LOCAL_HOSTNAME`, `OUTBOUND_PRIVATE_IPV4`, `OUTBOUND_PRIVATE_IPV6`, `OUTBOUND_RESOLVED_PRIVATE`, `OUTBOUND_NO_ADDRESSES`, `OUTBOUND_DNS_REBINDING`). Messages unchanged for existing callers.
- **IPv4 ranges widened** (the same class of gap): carrier-grade NAT `100.64/10` (incl. the `100.100.100.200` cloud metadata address), `198.18/15`, `192.0.0/24`, multicast and reserved `224/4`/`240/4`, broadcast.
- **Nothing is weakened.** Everything that was blocked stays blocked (loopback, `localhost`/`.local`/`.internal`/`.lan` names, link-local/metadata, RFC1918, encoded forms `127.1`, `0x7f000001`, `2130706433`, `0177.0.0.1`, trailing-dot names, embedded credentials, non-http(s) protocols). The existing tests are unchanged; 12 new tests were added.

## 3. Tests (`tests/outbound_url_policy.test.ts`, 12/12)

- 37 malicious bracketed literals (loopback in several spellings, mapped hex/dotted/upper-case, RFC1918 and metadata addresses behind the mapped prefix, ULA incl. the AWS IPv6 metadata address, link-local, site-local, multicast, NAT64, 6to4, Teredo, documentation, discard, IPv4-compatible, unassigned space) each run twice — once with a resolver that answers `ENOTFOUND` (Linux) and once with one that answers a **public** address (a platform that resolves brackets): both must produce the same refusal with `OUTBOUND_PRIVATE_IPV6` and a **recorded call list proving DNS was never consulted**.
- The same literals as redirect destinations (including a relative redirect from a literal base) and as `https` hosts with a port.
- Public IPv6 literals allowed without DNS; mapped/NAT64/6to4 forms of a public IPv4 allowed.
- Names resolving to any private form refused (`::ffff:127.0.0.1`, `::ffff:7f00:1`, upper-case, NAT64, 6to4, ULA, link-local with zone id, `::1`, `::`); mixed public+private answers refused.
- IPv4 / local-name class matrix (encoded forms, shared and reserved ranges, `localhost`/`.local`/…, credentials, protocol) and the empty-answer class.
- Pinned lookup: rebound or hex-mapped private answers refused with `OUTBOUND_DNS_REBINDING`.
- Parser/classifier unit checks for every textual form and for the non-IPv6 inputs other callers pass.

## 4. Gate results (development machine, Windows, Node 24)

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm test` (regression) | 2993 tests, **2985 pass, 0 fail, 8 skipped** (pre-existing: 4 POSIX-signal tests, 4 retired password-auth tests) |
| `npm run test:browser-cert` | 324 tests, 318 pass, 0 fail, 6 skipped (clean re-run; see note) |

Browser gate, first run: 324 tests, 316 pass, 2 counted failures that are one navigation timeout (`page.goto` 30 s in `r22_8_personal_home`, "Mobile Render 430x932") while the machine was busy; that file passes 11/11 twice when run alone. A clean re-run of the whole gate on the committed tree: **324 tests, 318 pass, 0 fail, 6 skipped**.

Callers that share this policy (link capture, browser URL validator, evidence pack, browser runtime) are covered by the regression and browser gates above; no caller needed a change.

Not changed on purpose: the separate MCP-specific address classifier (`src/mcp/mcp-url-policy.ts`) is a second implementation of a similar policy. It is outside this fix's scope; it should be converged on this classifier in a follow-up so there is one source of truth.

## 5. Linux validation (GitHub-hosted ephemeral Ubuntu runners — isolated hosts, not the service host)

Throwaway verification branches (never to be merged) ran the build and gates on Linux. Everything below is measured output, not inference.

**Platform fact.** On the Linux runner `dns.lookup('[::1]')`, `dns.lookup('[::ffff:7f00:1]')` and `dns.lookup('[fd00::1]')` all fail with `ENOTFOUND` — the bracketed text is not an address to the resolver. That is the entire mechanism of the original defect.

**Control — the unfixed base (`2140f9e`) on Linux** (run 38689767387, job "control"): the literals `[::1]`, `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`, `[fd00::1]`, `[fe80::1]` were all refused — but with `ENOTFOUND getaddrinfo` (a DNS failure), never as a private IPv6 address. The base's own focused test `outbound_url_policy.test.js` on Linux: 5 tests, 4 pass, **1 fail** ("canonical outbound policy denies … IPv6 private DNS …") — the failure the candidate hit.

**Fixed branch on Linux** (`ci/d09-linux-verify-ipv6-20261015`, fix `66db0c0` + workflow `14c37ea`, same run):

| Check | Result |
|---|---|
| `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.1]`, `[::ffff:169.254.169.254]`, `[fd00::1]`, `[fe80::1]`, `[64:ff9b::7f00:1]`, `[2002:7f00:1::]` | all refused with **`OUTBOUND_PRIVATE_IPV6`** ("Access to private network IPv6 addresses is blocked.") — no DNS involved |
| `[::1]`, `127.0.0.1`, `0x7f000001` | refused (`OUTBOUND_LOCAL_HOSTNAME` — the existing local-name check catches these first) |
| `169.254.169.254` | refused, `OUTBOUND_PRIVATE_IPV4` |
| `https://[2606:4700:4700::1111]/` | allowed, address `2606:4700:4700::1111`, no DNS |
| Focused `outbound_url_policy.test.js` | **12 tests, 12 pass, 0 fail** |
| Regression gate | 2993 tests, 2988 pass, **1 fail**, 4 skipped — the one failure is `task_store` "list() … newest first": two tasks created inside the same millisecond have equal `createdAt` on a fast Linux host. **Unrelated to this fix** (a latent flaky test); fixed separately in `fe12d70` (`fix/task-store-order-test-20261015`, an injected clock — the store already supports one) |

**Combined candidate on Linux** (isolation + this fix + the ordering-test fix; `ci/d09-linux-verify-combined-20261015` at `f287629`, run 38690186374): the five mapped/ULA/link-local/NAT64 literals refused with `OUTBOUND_PRIVATE_IPV6`; **regression 3066 tests, 3062 pass, 0 fail, 4 skipped; browser gate 324 tests, 318 pass, 0 fail, 6 skipped.** The three fix branches merge without conflict (disjoint files).

Verdict for P0-3: **Linux PASS** for the IPv6 classification and for the full gates on the combined candidate.
