# ADR-0008 — Channel identity ownership: proven from the channel, never declared by the client

**Status:** Accepted (Security Gate S2B)
**Date:** 2026-10-03
**Related:** post-S1 reassessment (S0-06b), ADR-0006, ADR-0007, Trust/Identity/Privacy/Approval §6 and §13, MASTER §5 and §8

## Context

ADR-0007 proved that a webhook request really comes from Telegram or Slack. It did not prove that the person behind the
Telegram/Slack account is the NAgex principal that account is linked to. `POST /integrations/{telegram,slack}/identity/link`
took the external user id from the request body and bound it to the signed-in caller, overwriting any existing link. Reproduced
at `118a9d0`: principal A links Telegram user 424242 / Slack user U_POC_B (B never participates); B's genuine, authentic
messages are then resolved to A and appear in A's conversation; a second principal silently takes the identity over from A.

## Decision

1. **A client-supplied external id is never proof.** The old link routes now answer `400 CHANNEL_LINK_PROOF_REQUIRED` and write
   nothing.
2. **Ownership is proven from the channel.** A signed-in principal asks for a challenge
   (`POST /integrations/{telegram,slack}/identity/link/challenge`). The person sends it to the NAgex bot from the account they
   are linking: Telegram `/start CODE` (the deep-link form) or `/link CODE` in a private chat; Slack `link CODE` in a direct
   message. The S2A-authenticated webhook takes the sender from the platform's own data (Telegram `from.id`; Slack `user` and
   `team_id`) and only then creates the link, bound to the principal and tenant that **issued** the challenge. The browser
   names neither the external account, nor the principal, nor the tenant.
3. **Challenge properties.** `ChannelLinkChallengeStore`: 60 bits from the CSPRNG (12 symbols, typed as `XXXX-XXXX-XXXX`),
   10-minute TTL, single use, bound to issuing principal + tenant + integration + the one operation `LINK_CHANNEL_IDENTITY`,
   one outstanding challenge per principal and integration (a new request replaces the old one), stored only as a SHA-256
   digest, never logged, audited, replied or stored as conversation. `consume()` validates and spends in one synchronous
   step and the service links in the same synchronous step (no `await` between), so concurrent redemptions cannot both
   succeed. A code presented to the wrong integration is refused without being spent. A code that is sent somewhere it can
   be seen (group chat, Slack channel), with extra text, as an edited message or by a bot is treated as exposed and is spent.
   A message that is not exactly a command (`/start CODE`, `link CODE`) is ordinary chat.
4. **No silent rebind.** `link()` on both identity stores throws `CHANNEL_IDENTITY_ALREADY_LINKED` when the external identity
   belongs to a different principal; the existing link is untouched. The channel replies that the account is already linked.
   The only way to free an identity is an explicit unlink by its owner (`DELETE /integrations/{telegram,slack}/identity`),
   which removes only the caller's own links. A principal lists only its own links (`GET .../identities`).
5. **Slack workspace.** A link made through the flow records the workspace from the signed event. An event from a different
   workspace with the same user id resolves to an isolated identity, not to the linked person.
6. **Unlinked senders are unchanged.** An authentic but unlinked sender still gets its isolated `usr_*_<id>` identity and the
   normal pipeline (a separate phase).

## Known limitations (explicit)

- **Challenge storage is PROCESS-LOCAL and in memory.** A challenge is lost on restart and is not shared between server
  processes; the user simply asks for another. Single-use is guaranteed within one process only. A multi-process deployment
  needs a shared store with an atomic consume.
- **Links created before S2B were never ownership-proven** and remain honoured (they carry no proof marker and, for Slack, no
  workspace). They should be reviewed or re-created through the flow. A real account owner whose identity was taken by such a
  link cannot re-link until the holder unlinks; there is no recovery path (out of scope).
- **Social engineering of the channel owner.** A person who is persuaded to send someone else's code from their own Telegram or
  Slack account links that account to the code issuer's principal. The code is shown only to the signed-in issuer, expires in
  ten minutes and is sent only in a private chat/DM, and the UI says to send only codes you created, but nothing technical
  stops a deceived user. An unlink-from-the-channel command was not added.
- Codes have 60 bits of entropy and there is no per-sender attempt limit (rate limiting is a separate phase); redeeming a guess
  requires an authentic Telegram/Slack sender.
- The Slack webhook replay cache (ADR-0007) remains process-local; it is unrelated to the challenge store.
- `POST /integrations/{telegram,slack}/send` (arbitrary destination) and `notifications/dispatch` are not changed here.
