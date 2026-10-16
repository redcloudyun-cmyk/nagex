# R26-E — Microsoft Integration Assessment (as-built)

**Status:** EVIDENCE (point-in-time, read-only inspection — no Microsoft account, mailbox or calendar was touched)
**Date:** 2026-10-16
**Revision inspected:** `integration/product-completion-20261015` at `f527f4e4766713f2d42bbbf91a8221df97ba9ec0` (R26-D merge)
**Scope:** what exists today for Microsoft OAuth, Microsoft Graph Calendar and Outlook; which parts are implemented, which are not; whether one functional gap can be closed safely and verifiably.

## 1. Verdict

| Capability | State | Evidence |
|---|---|---|
| Sign in with Microsoft (OIDC) | **Implemented, not live-verified here** — enabled only when `NAGEX_MICROSOFT_LOGIN_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI` are set; none is set in this environment, so `GET /api/v1/auth/providers` reports `microsoft.enabled = false` | `src/http/routes/social-auth.routes.ts` |
| Microsoft Graph **Calendar** (read or write) | **Not implemented.** No Graph Calendar client, no token store, no consent flow | no `calendarView`, `/me/events` or any Graph URL other than `oidc/userinfo` exists in `src/` or `public/` |
| **Outlook** mail (read / draft / send) | **Not implemented** | same; catalog entry `outlook` is `PLANNED` |
| OneDrive / SharePoint, Teams | **Not implemented** (`PLANNED` in the catalog) | `src/connectors/connector-catalog.ts` |
| Microsoft connection state shown to the person | **Truthful:** always `UNAVAILABLE` (connections API), "Unavailable in this environment" with a disabled button (Settings), `PLANNED` (catalog). A Microsoft sign-in is never presented as a mailbox or calendar connection | `connections.routes.ts` `withCanonicalStatus`, `public/app.js` connection card, catalog `setup` text |

Nothing in NAgex claims, advertises or simulates a Microsoft mail or calendar capability.

## 2. The implemented path (sign-in only)

* Scopes requested: `openid email profile` — no `offline_access`, no `Calendars.*`, no `Mail.*`, no `Files.*`.
* The authorization code is exchanged at `login.microsoftonline.com/common/oauth2/v2.0/token`; the access token is used **once** for `GET https://graph.microsoft.com/oidc/userinfo` and is then discarded: nothing is stored, there is no refresh token and no per-user Microsoft token record. Identity is bound by the provider subject (`sub`) in `SocialIdentityStore`, never by e-mail alone.
* `state` is single use with a 10-minute expiry; an unknown or expired state redirects to `?auth=provider&status=error`.
* Account lifecycle (disable / delete / recovery) for a Microsoft account uses a fresh provider sign-in plus the typed e-mail (Trust doc, `oauth_account_lifecycle` tests).

## 3. What would be needed for the first Microsoft capability (not built)

The existing, compatible pieces:

* the **Capability Broker** and `ActionApprovalStore` (one approval authority — a Graph adapter would register behind `CapabilityExecutorPort`; a second approval system must not be created);
* `GoogleCapabilityExecutionPipeline` + `CalendarVerification` (read-back verification, deterministic event ids, honest MISMATCH / NOT_VERIFIED outcomes) as the pattern for a Graph write;
* `UpcomingCalendarEvent` (the normalized read shape the Main surface already renders);
* the encrypted per-user token store pattern (`src/integrations/google/token.store.ts`, `NAGEX_TOKEN_ENCRYPTION_KEY`).

Missing and not creatable without the owner:

1. a registered Azure / Entra application (client id and secret) and its redirect URI — **registering one is outside this mission** (no new registrations without approval);
2. a separate, incremental consent (`Calendars.Read`, `offline_access`) — the canonical ecosystem document forbids treating the login consent as Graph authorization;
3. a Microsoft token store and connect / disconnect / reauth routes (the Google ones are Google-specific, not generic);
4. a Graph client with the Graph-specific behaviours (`calendarView` delta windows, `Prefer: outlook.timezone`, `transactionId` for idempotent creates, `immutableId`).

## 4. Findings recorded (not changed)

* **F-1 — Microsoft's `userinfo` carries no `email_verified` claim.** Microsoft's documented OIDC userinfo claim set has no `email_verified` (not verified against a live tenant here; the scripted test below uses exactly that shape), so `verifiedClaims` reads every Microsoft sign-in as "e-mail not verified". Effect today: a legacy local-password account can never be migrated to Microsoft sign-in (`status=link-required`). This is the safe direction. Changing it needs a verified-domain signal (`xms_edov` optional claim) configured in the application registration, so it is not changed here.
* **F-2 — a new social account is created from the provider's `email` claim without a verified-email requirement** (both providers). For Microsoft work/school directories the `email` attribute is not guaranteed to be verified (the "nOAuth" class). Binding is by `sub`, so an existing account cannot be taken over, but an attacker could pre-register an address. Recorded as DEBT-0016 in `docs/debt/TECHNICAL_DEBT_REGISTRY.md` so it is not lost; it belongs to the security track (S2).

## 5. Gap decision

**No functional gap was closed.** The only closable gaps need a registered Microsoft application and incremental consent, neither of which may be created here, and a Graph adapter verified only against a fixture would be presented as live integration — which the mission forbids. `LIVE_E2E = BLOCKED` (no Microsoft credentials and none may be registered).

What was added instead: a regression pin (`tests/microsoft_integration_state.test.ts`, 4 tests, scripted Microsoft, real handlers and stores) that keeps the as-built truth enforceable — Microsoft sign-in requests only identity scopes, the connections API never reports Microsoft as connected, Outlook / OneDrive / Teams stay `PLANNED`, and Microsoft connect / sync / disconnect answer "not supported" rather than success. If a Graph capability is added later, that test must change in the same commit.

## 6. Recommended first increment (when an application registration is available)

Read-only Graph Calendar: Microsoft token store (encrypted, per user) → connect with `Calendars.Read offline_access` → `calendarView` read normalized to `UpcomingCalendarEvent` → shown in Main's Today with the same truthful states as Google → only then writes, behind the existing approval authority, with read-back verification.
