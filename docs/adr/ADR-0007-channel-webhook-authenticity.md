# ADR-0007 — Channel webhooks: authenticity before trust

**Status:** Accepted (Security Gate S2A)
**Date:** 2026-10-03
**Related:** Security Gate S0 audit (S0-06, S0-07 residual), post-S1 reassessment (P0), ADR-0006, Trust/Identity/Privacy/Approval §6 and §13, MASTER §5 and §8

## Context

The post-S1 reassessment proved that `POST /api/v1/integrations/telegram/webhook` and `POST /api/v1/integrations/slack/events`
accepted any HTTP request that merely claimed to come from Telegram or Slack. The sender id in the body selected the
principal and tenant (a linked victim, or an isolated per-sender identity), and the request then wrote the attacker's text
into that user's conversation and audit trail, read their memories and called the model. There was no secret-token check,
no signing-secret check, no timestamp window, no replay control and no throttle. S1 left these two routes in the
`ANONYMOUS_PRESERVED` list because a webhook must stay reachable without a session.

## Decision

1. **A webhook request is not an authenticated caller; it must prove it came from the platform.** The two routes are a new
   access class, `SIGNED_WEBHOOK` (`src/http/route-access.ts`): reachable without a session, and refused by the handler
   unless the platform's credential is valid. The verification is the **first** thing the handler does, so nothing in the
   request (sender id, chat, team, text) reaches identity lookup, memory, conversation or audit writes, plan resolution, the
   model or any outbound send before it is authenticated.
2. **Telegram** uses the mechanism Telegram defines for `setWebhook`: the `secret_token` is echoed in
   `X-Telegram-Bot-Api-Secret-Token`. The header must be present, single-valued, match Telegram's character set and equal the
   configured secret.
3. **Slack** uses Slack's signed-request contract: `X-Slack-Signature` is `v0=` + HMAC-SHA256 of
   `v0:{X-Slack-Request-Timestamp}:{raw body}` with the signing secret, and the timestamp must be within 300 seconds
   (past or future). The HTTP layer registers the **original request bytes** (`src/http/raw-body.ts`); the verifier uses those
   bytes and refuses when they are unavailable. A re-serialisation of the parsed JSON is never treated as the signed body.
   This applies to the `url_verification` challenge too. A delivery whose signature was already accepted inside the window is
   acknowledged but not processed again (bounded in-process cache).
4. **Secrets come only from server configuration**, through the same environment mechanism as the bot tokens:
   `TELEGRAM_WEBHOOK_SECRET` and `SLACK_SIGNING_SECRET`. They are compared in constant time (both sides hashed to a fixed width
   / `timingSafeEqual`), never accepted from a request body or query, never returned, and never logged. No new secret store
   was introduced.
5. **Fail closed.** A missing, empty or unusable secret answers every request `503 WEBHOOK_VERIFICATION_UNAVAILABLE`; it never
   means "verification disabled". This intentionally removes the old behavior where an unconfigured integration silently
   accepted unauthenticated requests. A rejected credential answers one generic `401 WEBHOOK_AUTHENTICATION_FAILED`; the
   reason code goes only to a throttled operator log line (no secrets, no request content).

## Operational consequence

Both integrations stop accepting webhooks until the operator sets the secret and registers it with the platform
(Telegram `setWebhook` with the same `secret_token`; Slack app "Signing Secret").

## Not decided here (later phases)

- Proof that a Telegram/Slack account belongs to the NAgex user it is linked to, link overwrite, and the global identity listing (S2B).
- What an authenticated-but-unlinked sender may do (it still resolves to an isolated per-sender identity and reaches the model).
- Slack workspace/team allow-listing, per-sender and per-source rate limits, and request-size limits (S2G).
- Telegram has no signed timestamp, so a captured authentic request can be replayed by whoever can read the TLS stream or the secret; the secret is the only credential.
- The replay cache is per process.

## Consequences

- An unauthenticated or incorrectly authenticated webhook request cannot cause a conversation write, memory read, model call, tool/plan resolution or outbound reply.
- Tests that need an accepted webhook configure the secrets and sign the request (`tests/_s2a_webhooks.ts`).
