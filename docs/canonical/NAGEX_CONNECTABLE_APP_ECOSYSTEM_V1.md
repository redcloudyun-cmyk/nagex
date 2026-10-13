# NAgex Connectable App Ecosystem — Implementation Contract (2026-10-13)

Status: **IMPLEMENTATION CONTRACT / NOT CERTIFIED**  
Baseline: `integration/r23.7-agex-mcp-20261013` (`faf38cc` at review time)  
Product: **Modern Everyday Personal AI** — English canonical, natural Korean UX  
Scope: first-party app catalog, user consent, universal MCP/OAuth, and real action execution.

## 1. Product rule

A person must not need to obtain an LLM API key, know an MCP endpoint, or configure a developer application to use everyday NAgex features. **NAgex pays for and operates AI-provider API credentials**. For external personal data, the user selects an app, signs in with the official provider, and grants precise permission. Custom server URL/Bearer Token belongs only in Advanced.

The UI must never claim *Connected* based on a static listing, mock state, or successful OAuth sign-in to NAgex itself.

## 2. Four separate catalog concepts

1. **NAgex built-in**: the data/AI capability is available under NAgex's own service account and approved commercial or public-data terms. No user connection.
2. **One-click connectable**: NAgex has a configured, verified provider application and a working authorization start/callback. The user initiates OAuth and consents; the provider issues user-bound credentials. A successful OAuth callback must not bypass NAgex execution approval.
3. **Advanced MCP**: remote HTTPS MCP servers with secure discovery, precise schema and tool enablement. Currently static Bearer auth exists; generic OAuth-protected MCP servers remain a gap.
4. **Discovery only**: a researched app listing; no Connect button until a genuine working auth and capability adapter exist.

A large catalog must not inflate the count of *usable connections*. Report `CATALOG_COUNT`, `AUTH_START_VERIFIED`, `USER_CONNECTED`, `E2E_TOOL_CERTIFIED` separately.

## 3. Current code baseline

- `src/connectors/connector-catalog.ts`: six categories, 18 catalog definitions, `LIVE|PLANNED|UNSUPPORTED`.
- `src/connectors/connector-catalog.service.ts`: user/tenant scoped state and Google scope checks.
- `src/http/routes/connector-catalog.routes.ts`: signed-in catalog endpoint.
- `public/connections-ui.js`: Google/GitHub OAuth connection paths, Slack/Telegram channel flow, custom HTTPS MCP advanced form.
- `src/mcp/*`: HTTPS Streamable HTTP, discovery, scope/owner security, schema pinning and hash-bound approvals.
- `scripts/mcp-remote-check.mjs`: external server read-only handshake/discovery verifier.

**Not yet certified**: remote third-party MCP connection; generic MCP OAuth; real Google/GitHub OAuth test account on deployment; 60–100 real app connectors.

## 4. Minimum server contract per listing

A catalog definition may include name, category, localized text and provider icon for discovery. An action is **computed at request time**, never hardcoded based on a display label.

Recommended new server projection (preserve current fields):

```ts
type ConnectionAction =
  | { kind: 'NONE'; reason: string }
  | { kind: 'BUILT_IN'; capability: string }
  | { kind: 'OAUTH'; startPath: string; provider: string; scopes: string[] }
  | { kind: 'CHANNEL_LINK'; startPath: string; provider: string }
  | { kind: 'ADVANCED_MCP'; path: string };
```

Restrictions:
- `OAUTH` must be emitted only if the specific provider is configured and the OAuth start route accepts a real signed-in NAgex session. Never permit a catalog-supplied arbitrary redirect URL. Start paths are server-owned allowlisted relative paths.
- Scope upgrades are requested only when needed. NAgex login's Google/Microsoft consent must not silently count as Gmail/Calendar/Microsoft Graph authorization.
- `BUILT_IN` applies only to a real, deployed, tested NAgex-owned capability.
- `NONE` is the default for PLANNED/UNSUPPORTED, missing provider contract, missing admin credentials, regional restrictions, failed certification.
- Every connection action must have a stable user-facing state: Available/Connected/Connect/Needs attention/Unavailable/Coming later and a truthful reason.
- Revalidate server configuration and identity on callback and before execution. No capability may be activated solely from optimistic browser state.
- Provider redirect targets must be fixed and allowlisted; no open redirects.

## 5. MCP OAuth design gate (not presently implemented)

Implement a standards-compliant OAuth client for remote MCP authorization, including:
- server resource metadata discovery and authorization server discovery (not guessing issuer from server URL);
- authorization code + PKCE and state/nonce or equivalent session-bound CSRF protections;
- correct resource/audience binding of access tokens;
- registered client metadata or securely supported registration flows; provider-specific integration when general registration is unavailable;
- callback URI allowlisting and exact redirect checking;
- per-user/per-tenant encrypted tokens, expiry detection, revocation/disconnect and reconnect;
- bounded HTTP calls, SSRF checks on *all* discovered metadata and token endpoints, no private-network/redirect escape;
- privilege minimization and explicit consent separate from action approval.

Do **not** ship a browser-embedded client secret or assume all remote MCP providers support dynamic registration.

## 6. User journeys (must work before labeling LIVE)

**A — Google Calendar:** icon → Connect → Google consent (when needed) → NAgex callback validates state, user, scopes → real connection verified → user asks a schedule question → scoped Google API call → factual result.

**B — GitHub:** icon → Connect → GitHub OAuth → NAgex callback → read-only repo list and file read. Display missing operator configuration as Setup Required, not as a user error.

**C — MCP OAuth:** icon → provider-based OAuth start → consent → discovery/enable tool → natural language task → user approval → tool call → truthful provider response. A provider's `tools/call` answer is never proof a real-world side effect was independently verified.

**D — Public World Bank data:** ask a question without any connection → first-party bounded World Bank API client → normalized statistics with geographic unit, year, source and missing-data disclaimer. Do not claim this works until implemented and tested.

**E — Custom MCP advanced:** user supplies explicit HTTPS URL/token; only trust a successfully contacted server after identity pinning, tool validation, owner binding, approval; no stdio process spawning on API server.

## 7. Catalog expansion policy

Plan a **100-service curated directory**, grouped by everyday tasks. Focus on household, communication, calendar, files, travel, shopping, research, media, productivity and creators; do not optimize merely for enterprise or developer apps. For each app record:

`provider, official website, auth/transport, price/licensing, country/availability, capability adapter, integration owner, verification evidence, human-approved launch status`.

Discovery candidates are never treated as connection-capable. Use licensed/trusted local brand imagery or validated provider assets, never arbitrary remote logos.

Prioritize actual functioning **Google Calendar/Gmail, GitHub, public World Bank**, then user-value-driven Microsoft Graph and MCP OAuth. Other products require independently verified API access and contracts.

A third-party automation bridge (e.g. Zapier) cannot automatically be marketed as thousands of certified NAgex connectors. Their authorization, fees, scope and approval boundaries must be verified.

## 8. Required implementation sequence

1. Audit live authentication paths, server-side availability and authorization policy; add truthful `ConnectionAction` contract and test cases.
2. Build icon-click routing in Apps & Connections, with no technical form in normal path; preserve advanced custom MCP drawer.
3. Complete MCP OAuth in a separate bounded security slice (resource metadata + PKCE + callback + token store + SSRF/approval tests).
4. Add real first-party public-data integration as a bounded source adapter; do not route untrusted data directly to action execution.
5. Validate at least one authorized external MCP provider, and one actual OAuth provider using a dedicated test account.
6. Only after real E2E certification, add a connector to the clickable production Connect catalog.
7. Expand catalog with search, categories and truthful count/status; preserve 360/390/430, EN/KR.
8. Validate production-configured providers and actual deployed authenticated browser, separate from isolated Playwright harness.

## 9. Test gates and reporting

- Automated: missing provider config, forged OAuth state, invalid redirect, scope downgrade, token expiry, callback replay, owner/tenant isolation, SSRF metadata, tool schema change, approval replay, reconnect and disconnect.
- Browser: EN/KR on desktop and phone, icon click launches the correct *real* path, no Connect on discovery-only entries, focus/keyboard support, auth errors are understandable.
- Live: actual account consent + provider response, one non-destructive end-to-end tool execution with a recorded approval.
- Security: provider credentials are never shown in JSON, DOM, logs, prompts or client storage; server-held encrypted secrets rotate separately from user OAuth credentials.

Report `CATALOG_COUNT`, `PROVIDER_CONFIGURED`, `CLICK_TO_AUTH_VERIFIED`, `CONNECTED_ACCOUNTS_VERIFIED`, `REAL_PROVIDER_E2E`, `MCP_OAUTH`, `CUSTOM_MCP_E2E`, `BROWSER_EN_KR`, `SECURITY`, `DEPLOY_SHA`, and `HUMAN_ACCEPTANCE`.

**No screen or integration may be declared production-ready merely because mocked tests pass.**
