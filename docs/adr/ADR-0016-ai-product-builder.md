# ADR-0016 — AI Product Builder: a gated, resumable project from a request to a verified deployment

**Status:** ACCEPTED (2026-10-17) · **Builds on:** the Approval Authority (`ActionApprovalStore`), the Model Gateway, the Creation provider ports · **Does not change:** Human Approval semantics, the Permission Decision Service, tenant/owner isolation, `RELEASE = NO-GO` · **Canonical text:** `docs/canonical/NAgex_Creation_Architecture.md` §20

## Context

"Build me a website and put it online" is a request that spends money (models, pictures), writes code, runs it, and finally publishes something to the internet under the person's name. It must not be a chat answer that pretends to be the deliverable,
and it must not be an autonomous agent run that the person only sees at the end. The person has to decide what is built, what it looks like, what NAgex may do to build it, and where it goes - and every one of those decisions has to be about
*exactly* what they were shown.

## Decision

A **project** is a persistent state machine (`src/product-builder/`) with four gates - PLAN, DESIGN (with real generated pictures), BUILD (scope frozen) and DEPLOY (target and files bound) - each decided through the **existing** Approval Authority.

1. **Approvals are bound to artifacts.** An approval carries the artifact's version and hash. A changed artifact is a new version with a new approval; the old one is withdrawn and cannot move the project. An approval is consumed once, against the current artifact.
2. **Nothing runs before its gate.** The service re-checks, immediately before it acts, that the matching gate was passed for the *current* build plan / deployment target.
3. **Blocked, never faked.** A missing credential, an exhausted quota, a refusal, an absent sandbox or engine ends the step in `BLOCKED` with a typed reason and the person resumes it. No placeholder pictures; no silent provider switch (another *authorized* provider is used only when the person picks it).
4. **Generated code is data.** It is validated, written all-or-nothing into an owner-scoped workspace and never executed by Node on the NAgex host. It runs only in an isolated Chromium (network limited to the product's own origin) and in a sandboxed preview served from a signed, short-lived, owner- and workspace-bound link.
5. **"Deployed" is verified.** `DEPLOYED_VERIFIED` requires that the address answers, serves the marker NAgex stamped into the page, and passes the product's checks in an isolated browser. An uncertain deployment (timeout, 5xx after sending, restart while sending) is `BLOCKED` and is never sent again.
6. **Providers are replaceable ports.** Planning, mockups, coding engine, site tester, deployment and verification each sit behind a port; the Gateway stays the only place that knows a model vendor. The coding engine that exists today is a one-shot static-site generator, *not* an agentic coding framework.

## Alternatives rejected

- **A second approval engine for projects.** Rejected: the Approval Authority already binds a payload hash and is consumed once; gate payloads carry the version and hash.
- **Running generated builds (`npm install`, `npm run build`) on the host.** Rejected. Until a container sandbox is available (Docker Desktop is installed on the development host but its daemon was not running), only static, self-contained sites are built.
- **Allowing the preview to share NAgex's origin.** Rejected: generated script would then run with the person's session. The preview is an opaque-origin sandbox reached only through a signed link.
- **An agentic coding engine on the host.** Rejected for the reason above; the port is ready for one that runs in a sandbox.
- **Cloudflare Pages direct upload from memory.** Rejected: the file-hash and upload protocol is not in the API reference page that was read, and an interface is not invented. Vercel's documented inline-file deployment is implemented instead.

## Consequences

- 11 routes added (route inventory 384 → 395); one unauthenticated-by-session route (the sandboxed preview, `GET|HEAD` only) whose credential is the signed link.
- The Model Gateway gains optional per-request `maxOutputTokens` (now honoured by Gemini and OpenAI) and `timeoutMs` (clamped 1 s - 5 min).
- `ResourcePrefix` gains `pbp`; the project store, workspaces, mockups and test pictures live under `resolveNagexDataDir('product-builder', 'NAGEX_PRODUCT_BUILDER_DIR')`.
- Preview links live in process memory: a restart invalidates them (the person asks for a new one). Projects survive a restart; a project that was mid-step is resumed, a deployment whose outcome is unknown is not re-sent.
- **Not done / disclosed:** a live deployment to a real hosting account (no credential), real mockup pictures (the development key has no image quota), a container sandbox and an agentic coding engine, sites that need a server or database, Cloudflare Pages, custom domains, preview that persists what the person types.
