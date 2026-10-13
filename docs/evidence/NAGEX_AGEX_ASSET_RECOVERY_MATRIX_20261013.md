# AGEX asset recovery — evidence-linked comparison matrix

**Date:** 2026-10-13
**Branch:** `feat/agex-assets-mcp-20261013` (not merged to `main`, not deployed)
**Sources compared (read-only):** AGEX legacy repository `F:\개발 프로젝트\Agex project` (`redcloudyun-cmyk/agex-ai-os`, HEAD `7480f23`, with uncommitted local changes that were not touched) and NAgex at the commit named in the delivery report.

Classification used: **REUSED** (definition or idea carried into NAgex), **MISSING** (neither side has a real implementation), **SUPERSEDED** (NAgex has a different, real implementation and the AGEX one is unused), **MOCK/UI-ONLY** (static markup or seed data, never provider connectivity), **REAL INTEGRATION** (executing code that talks to the provider, with tests).

Rule applied throughout: a "Connected" badge, an `ENABLED` seed record or a `SecretReference(...)` string is **not** provider connectivity.

## 1. Component matrix

| Area | AGEX evidence | AGEX class | NAgex evidence | NAgex class | Action taken |
|---|---|---|---|---|---|
| Plugin catalog (66 connector rows in 14 categories) | `public/index.html:446-1260` — static gallery; two rows carry a hard-coded green "Connected" badge (Slack `:462`, GitHub `:686`), the other 64 a "Connect" button with no handler | MOCK/UI-ONLY | `src/connectors/connector-catalog.ts` (18 normalized entries), `src/connectors/connector-catalog.service.ts`, `GET /api/v1/connectors/catalog` (`src/http/routes/connector-catalog.routes.ts`), UI `public/connections-ui.js` | REAL (catalog) | 9 of the 66 rows recovered as definitions (Slack, Teams, Gmail, Outlook, Zoom, Google Workspace→Drive, Google Calendar, GitHub, MCP). The other 57 are **excluded** (see section 3). All AGEX state discarded. |
| Data source catalog (7 cards) | `public/index.html:1556-1650` — Similarweb, World Bank DataBank, X, Brand24, Ahrefs, CoinGecko, Morningstar; descriptive text only | MOCK/UI-ONLY | same catalog module; each has an explicit availability (section 2) | REUSED (metadata) | 7 of 7 recovered with truthful `PLANNED` / `UNSUPPORTED` availability and a stated requirement. None can show connected. |
| Plugin framework | `src/plugin/plugin.framework.ts` (56 lines: egress allow-list registry), never wired to a request path | SUPERSEDED idea | NAgex still carries an inherited copy: `src/plugin/plugin.framework.ts`, imported only by the barrel `src/index.ts` and the legacy test `tests/phase5_6_7.test.ts`. Real egress control: `src/mcp/mcp-url-policy.ts` (https-only, SSRF, DNS-rebinding guard, `NAGEX_MCP_ALLOWED_HOSTS`) | REAL (different) | Idea of an operator allow-list REUSED (`NAGEX_MCP_ALLOWED_HOSTS`). Inherited copy left in place (not on any runtime path); recorded in DEBT-0015. |
| Plugin registry seed | `src/server_web.ts:151` — `pluginRegistry` with `status: 'ENABLED'` for Slack/GitHub and `credential_ref: 'SecretReference(sec_...)'` strings | MOCK (seed) | none (no seeded "enabled" records exist in NAgex) | — | Not recovered. NAgex derives every state from the owning store. |
| Agent registry | `src/server_web.ts:76` — `agentRegistry`, four agents with invented `executions_total` (127/89/204/56) and `bound_model` | MOCK (seed) | `GET /api/v1/agents` returns the real skill registry (`src/http/routes/catalog.routes.ts:91`, `src/skills/skill-registry.ts`, 7 skills); `src/agents/*` competitor-pricing agent is real | SUPERSEDED | Not recovered. Invented counters must never appear. |
| Agent executor / tool invoker / multi-agent orchestrator | `src/agent/{agent.executor,tool.invoker,multi-agent.orchestrator}.ts` (PDP check + autonomy gate + side-effect classes READ_ONLY / REVERSIBLE_WRITE / IRREVERSIBLE_WRITE / PRIVILEGED_ACTION) | REAL (small, in-memory) | NAgex carries the same inherited files (`src/agent/*`), imported only by `src/index.ts` and legacy tests. The live path is `CapabilityBroker` + `ActionApprovalStore` + `PolicyDecisionPoint`. The side-effect taxonomy survives as `sideEffectLevel` in `src/tools/tool-registry.ts` | SUPERSEDED (+ taxonomy REUSED) | None; inherited files recorded in DEBT-0015. |
| Workflow integration | `src/workflow/workflow.engine.ts` (12 step types declared, only a few executable) | REAL (minimal) | `src/workflows/workflow-definition.service.ts` + store (plan-based, resolved by `PlanResolver`), tasks runtime `src/tasks/*` | SUPERSEDED | None. |
| Skills | seed strings `bound_skills` only | MOCK | `src/skills/skill-registry.ts` (7 registered skills), resolved by `PlanResolver` | REAL | None. |
| MCP | UI row `public/index.html:1242` "Model Context Protocol (MCP)" and Zapier `:1253`, status badge only, no code | MOCK/UI-ONLY | `src/mcp/*`, `src/http/routes/mcp.routes.ts`, capability-broker integration; 41 unit/security tests (`tests/mcp_runtime.test.ts`), 15 end-to-end tests against an isolated server (`tests/mcp_e2e_isolated_server.test.ts`), 5 planning tests, 8 browser tests | REAL INTEGRATION | Completed (see `NAGEX_MCP_PRODUCTION_CERTIFICATION_20261013.md`). |
| Google Workspace | UI row `:544` (Docs, Sheets, Calendar) + seed plugin `plg_google_workspace` `DISABLED` | MOCK/UI-ONLY | Gmail + Google Calendar: `src/integrations/google/*`, `src/modules/gmail`, `src/modules/calendar`, tests `gmail_live` 30, `google_calendar_live` 41, `google_calendar_connection_state` 29, `google_oauth_persistence` 13. Docs/Sheets: none. Drive: planned | REAL (Gmail, Calendar); MISSING (Docs, Sheets, Drive) | Catalog: Gmail + Calendar `LIVE` with per-scope truth; Drive `PLANNED`; Docs/Sheets not listed. |
| GitHub | UI row `:686` hard-coded Connected + seed plugin `plg_github` (`com.agex.github-plugin`, "Automated PR Reviewer") with no code behind it | MOCK | `src/integrations/github/*`, `src/http/routes/github.routes.ts`, capabilities `github.list_repos / list_directory / read_file` (read-only); `github_connection` 35 tests | REAL INTEGRATION (read-only) | Catalog: `LIVE`, described as read-only. AGEX's "code edits and PR drafts" claim is **not** carried over — NAgex cannot do it. |
| Slack | UI row `:462` hard-coded Connected + seed plugin `plg_slack` (webhook host only) | MOCK | `src/integrations/slack/*`, `src/http/routes/slack.routes.ts` (S2A signed events, S2B ownership-proven account link, S2C self-delivery only); `slack_integration` 4 tests, S2A/B/C security suites | REAL INTEGRATION (chat channel) | Catalog: `LIVE`; real state = not set up on server / not linked / linked. A Link-account dialog was added to the UI. |
| Microsoft integrations | UI rows Teams `:473`, Outlook `:495` (Connect buttons) | MOCK/UI-ONLY | Microsoft is **sign-in only**: `src/http/routes/social-auth.routes.ts`, `src/identity/social-identity.store.ts`, test `auth_google_microsoft_only`. No mailbox, calendar, file or Teams integration exists | MISSING (beyond sign-in) | Catalog: Outlook, OneDrive / SharePoint, Teams `PLANNED`, each saying that Microsoft sign-in does not connect the mailbox. |
| Telegram | not in AGEX | — | `src/integrations/telegram/*`, `telegram_integration` 4 tests | REAL INTEGRATION (chat channel) | Added to the catalog (`LIVE`). |
| Knowledge connectors | UI rows Notion `:555`, Confluence `:566` ("sync pages into the Knowledge Base"), seed `knowledgeBase` at `src/server_web.ts:120` (`kb_001..003`, fake chunk counts) | MOCK/UI-ONLY | `src/context/knowledge.engine.ts`, `src/http/routes/knowledge.routes.ts` (user-uploaded documents; `r24_5c_knowledge_live`). No external knowledge connector. NAgex's own `catalog.routes.ts` still carries unused static `planRegistry` / `knowledgeBase` seeds | MISSING (external connectors) | Not listed in the catalog (no honest requirement text can be written for something nobody built). Dead seeds recorded in DEBT-0015. |

## 2. Provider status requested by the product (Phase 6)

| Provider | Availability | Real connection state source | Basis |
|---|---|---|---|
| Slack | **LIVE** (chat channel) | channel-link store + server bot configuration | real integration with signed events and ownership-proven linking |
| Microsoft Teams | PLANNED | — | no Teams bot / Graph code; needs a bot registration for this server and a verified account link |
| Zoom | PLANNED | — | no Zoom code; needs a Zoom app approved for the server and user authorization |
| World Bank | PLANNED | — | public data API, no account needed; a research tool must be built |
| CoinGecko | PLANNED | — | public/keyed API; research tool + user API key needed |
| X (Twitter) | UNSUPPORTED | — | paid developer plan and approval NAgex does not hold |
| Similarweb | UNSUPPORTED | — | commercial data contract |
| Ahrefs | UNSUPPORTED | — | paid API plan |
| Brand24 | UNSUPPORTED | — | paid account and API access |
| Morningstar | UNSUPPORTED | — | licensed data agreement |

None of these was implemented merely because AGEX showed its logo; no credentials or API access for any of them exist in this environment.

Built-in integrations audited first (state at this commit, all offline/stubbed provider calls — **no live OAuth account was authorized, so no live provider success is claimed**):

| Integration | Tests run | Result |
|---|---|---|
| Google account / Gmail / Calendar | `gmail_live` 30, `gmail_approval_ui` 13, `google_calendar_live` 41, `google_calendar_connection_state` 29, `google_oauth_persistence` 13, `r23_4v_credential_broker` 11 | all pass (provider HTTP is scripted) |
| GitHub | `github_connection` 35 | all pass (provider HTTP is scripted) |
| Microsoft | `auth_google_microsoft_only` 2 | sign-in only; no integration to certify |
| Custom MCP servers | see MCP certification | pass against an isolated server |

Known limitation recorded: a Gmail card shows **Connected** when the Google grant includes the Gmail scope; the "Check connection" action performs a live read for Calendar only, so Gmail's "last verified" time is not independently proven (DEBT-0015).

## 3. AGEX connector rows deliberately NOT recovered (57)

Productivity: Notion, Confluence, Granola, Fireflies, Linear. Creative: Canva, Figma, HeyGen, Runway, Magnific. Developer: GitLab, Jira, Vercel, Supabase, Neon Postgres, Datadog. Business: Salesforce, HubSpot, Shopify, Webflow, Apollo.io, Zoho CRM. Data: Google BigQuery, PostHog, Mixpanel, MotherDuck, Firecrawl. Security: Vanta, Malwarebytes, Bitdefender, Codex Security. Education: Elicit, Consensus, Readwise, SciSpace. Finance: Stripe, Interactive Brokers, Alpaca, Quartr. Health: Health, Calorie Tracker, COROS, Fitness AI. Travel: Skyscanner, Trip.com, komoot, eDreams. Entertainment: Spotify, Apple Music, Shazam, Chessy. Other: LinkedIn, Indeed, Tarot, idealista, Superhuman, Zapier.

Reason: each was a static "Connect" button copied from a third-party gallery with no integration behind it, and NAgex has no roadmap item, credential or API access for them. Listing them would advertise unsupported capability (MASTER invariant `UNSUPPORTED_CAPABILITY_ADVERTISED = 0`). Users who need one of them can bring its own remote MCP server through the Custom MCP flow; no vendor-specific MCP presets are shipped because none could be verified.

## 4. How to reproduce

```text
(the AGEX extraction is a read of public/index.html lines 446-1260 and 1556-1650; nothing in the AGEX repository was modified)
npm run build
node --require ./dist/tests/_setup.js --test dist/tests/connector_catalog.test.js
node --require ./dist/tests/_setup.js --test dist/tests/connections_catalog_browser.test.js
```
