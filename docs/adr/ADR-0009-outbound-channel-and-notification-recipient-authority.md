# ADR-0009 — Outbound channel & notification recipient authority (S2C)

**Status:** Accepted (Security Gate S2C)
**Date:** 2026-10-03
**Related:** ADR-0006 (S1), ADR-0007 (S2A), ADR-0008 (S2B), post-S1 reassessment (S0-06 residual, S0-09), Trust/Identity/Privacy/Approval §6 and §13, MASTER §5 and §7

## Series naming

The security-hardening sub-series is:

| Phase | Boundary |
|---|---|
| **S2A** | webhook authenticity (ADR-0007) |
| **S2B** | channel identity ownership proof (ADR-0008) |
| **S2C** | outbound recipient authority (this ADR) |

This S2A/S2B/S2C sequence is a sub-series of the security-hardening work that followed Security Gate S1. It is **not** equivalent to
the broad phase numbering of the original S0 audit (S1 Identity Boundary … S8 Certification), whose terminology and finding ids
(S0-xx) are left as written. In particular, the original audit's "S3" (authorization / tenant isolation) is a different thing
from S2C; S2C closes only the findings named below.

## Context

After S1–S2B the server knows who the caller is, that a webhook is authentic, and which Telegram/Slack account really belongs to
which NAgex principal. Two outbound authority gaps remained (confirmed at `02546c4`, reproduced against a recording fake
provider):

- `POST /integrations/telegram/send` and `/slack/send` took the destination (`chatId` / `channel`) from the request body and
  used the **server's bot credential**, so any signed-in user could post to any chat/channel (including another user's DM)
  with no approval — S0-06 residual.
- `POST /notifications/dispatch` took the recipient from the body `principalId` / `tenantId` (the caller was only the
  fallback). The notification was written into the target's feed and fanned out to the target's linked Telegram/Slack — S0-09.
- When the bot credential was missing, both adapters returned a successful result without sending anything (and the
  notification engine therefore recorded `DELIVERED`).

## Decision

1. **User-facing channel delivery is SELF-DELIVERY ONLY.** The destination of a signed-in caller's send is derived by the
   server from the caller's **own ownership-proven link** (S2B), never from the request. For Telegram it is the linked
   Telegram user (the private chat); for Slack the linked Slack user, in the workspace the link was proven in. A body
   `chatId` / `channel` / `slackTeamId` is **only an assertion**: it must equal a destination derived from the caller's
   verified links, otherwise the request is refused before the provider is invoked. There is no fallback to an arbitrary id,
   to another user's link, to another tenant's link or to another workspace. With several verified links the caller must name
   one of its own. An optional `SLACK_TEAM_ID` (the bot's workspace) must also equal the link's workspace.
2. **Proven links only.** A link record carries `ownershipProof: 'CHANNEL_CHALLENGE'` only when it was created by the S2B
   redemption. Links that predate S2B were never proven and are **not** a trusted outbound destination for a signed-in caller
   (`CHANNEL_LINK_NOT_VERIFIED`). No migration of such links is done here.
3. **Notification recipient.** `NotificationEngine` has two entry points. `dispatch()` is
   `INTERNAL_SERVER_DISPATCH_AUTHORITY`: trusted server code (daily brief, task runners) names the recipient and is unchanged.
   `dispatchForCaller()` is `EXTERNAL_HTTP_USER_AUTHORITY`: the recipient **is** the authenticated caller; a body principal /
   tenant is a redundant assertion, and a different one is refused (`403 NOTIFICATION_RECIPIENT_NOT_AUTHORIZED`) before any
   notification is written or any channel is invoked. Because the content is chosen by the user, its external channels are
   the caller's own proven links only. There is no flag, header or body field that moves an HTTP request onto the internal
   path: the HTTP routes simply do not reference `dispatch()`.
4. **Truthful results.** The Telegram and Slack adapters return a normalised result. A missing credential
   (`NO_PROVIDER_CREDENTIAL`), a provider rejection (`PROVIDER_REJECTION`) and a network failure (`NETWORK_FAILURE`) are
   failures, never `ok`. The routes answer them with the existing error conventions (`502 CHANNEL_PROVIDER_NOT_CONFIGURED` /
   `…_REJECTED` / `…_UNREACHABLE`); authority refusals are `403` / `409` / `400`. The notification engine records such a
   channel as `FAILED` with the reason. Adapters do not log the error object (the request URL carries the bot token); neither
   tokens nor message text reach a response, audit event or log.
5. **Order.** Every authority decision precedes the provider call, any notification write and any audit success event; a
   refusal may be audited with a reason code only.

## Consequences

- Required test migrations (superseded contracts): tests that seeded another principal's notification through the HTTP route
  now seed through the internal engine API; tests that relied on the mock adapter returning success now use a configured
  client with a fake provider; the manifest of route counts is unchanged (no route added or removed).
- Operationally: the Telegram/Slack send routes return failure until the bot credential is configured; they previously
  reported success while sending nothing. Notification channels show `FAILED` (not `DELIVERED`) while no credential is set.
- A person whose link predates S2B must re-link (prove ownership) before they can use the send routes or receive
  user-originated notification content on a channel. Internal system notifications still reach pre-S2B links; migrating or
  retiring those links is a separate decision.

## Not decided here

An approval workflow for sending to arbitrary recipients; the unlinked-sender model policy; legacy-link migration;
executions / upload-object ownership (S0-08, S0-10); authentication, session, SSRF and resource-bound hardening.
