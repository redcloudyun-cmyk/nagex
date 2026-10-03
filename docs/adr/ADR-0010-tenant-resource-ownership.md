# ADR-0010 — Tenant resource ownership: execution history and uploaded objects (S2D)

**Status:** Accepted (Security Gate S2D)
**Date:** 2026-10-03
**Related:** post-S2C reconciliation (S0-08, S0-10), ADR-0006 (S1), ADR-0009 (S2C), Trust/Identity/Privacy/Approval §6 and §13, MASTER §5 and §8

## Series naming

S2A, S2B, S2C and S2D belong to the security-hardening sub-series that followed Security Gate S1 (webhook authenticity, channel
identity ownership, outbound recipient authority, tenant resource ownership). The sub-series is **not** equivalent to the broad
S1–S8 phase numbering of the original S0 audit, whose terminology and finding ids (S0-xx) are left as written; in particular
the original audit's "S3" (authorization / tenant isolation) is a different label from S2D.

## Context

Reproduced at `f30f643` with isolated synthetic principals:

- `GET /api/v1/executions` returned one process-wide array to every signed-in caller, so any user read every tenant's execution
  `objective` text and `tenant_id`. The shipped UI calls this route (S0-08).
- `POST /api/v1/workspace/uploads/complete` took `objectKey` from the request and read it from storage before it even looked at
  the capture. With another tenant's key the caller (a) created a capture of its own that points at the other tenant's object,
  (b) could overwrite that object by sending `data`, and (c) deleted that object by deleting its own capture. A server-side read
  through the caller's capture key returned the other tenant's bytes. (Another capture-processing path would also ingest those
  bytes into the caller's capture when a model is configured.) Reaching it requires the other tenant's key, which embeds the
  tenant and principal ids and a 64-bit random capture id, so it is not guessable, but nothing bound the key to the caller (S0-10).
- A latent defect made this reachable even in the normal flow: `uploads/init` created the capture record under a *different* id
  than the one returned to the client and used in the object key, so `complete` could never find the initiated record and always
  created a new capture from the client-supplied key.

## Decision

1. **Execution history is scoped to the caller's tenant AND principal.** New records carry `principal_id` (the authenticated
   caller). `GET /api/v1/executions` keeps its route and response shape (the UI feed is kept) but returns only records whose
   `tenant_id` and `principal_id` equal the caller's. A record with no owner (the legacy demo seed) belongs to nobody and is never
   listed. The shared in-memory array is an implementation detail; the filter is the isolation boundary.
2. **An upload is completed only by the caller that initiated it, on the key the server derived.**
   - `uploads/init` now creates the capture under the very id the object key was derived from (`createCapture` accepts a
     server-generated `captureId`, validated as `cap_` + 16 hex).
   - `completeUpload` decides ownership **before any storage access**: it looks up the capture by id **scoped to the caller's
     tenant and principal**, requires it to be `UPLOADING`, and takes the object key from that record. A `captureId` that is
     unknown or belongs to anyone else is the same `404 UPLOAD_NOT_FOUND`; a completed upload is `409 UPLOAD_NOT_PENDING`.
   - A request `objectKey` is only an assertion: if present it must equal the record's key, otherwise
     `403 UPLOAD_OBJECT_KEY_MISMATCH`, before storage is touched. Refusals never echo identifiers or keys.
   - The "create a capture from a client-supplied key" fallback is removed. An upload therefore requires `uploads/init` first.
3. **One ownership guard for every storage access that follows a record.** `isCanonicalObjectKeyFor(key, tenant, principal)`
   (`vault-security.ts`) accepts only a key of exactly the shape the server generates, under that tenant's and principal's own
   prefix, checked on the raw key (so a spelling a storage provider would fold onto the same stored object, a traversal, an
   absolute path or another tenant's prefix is not owned). `QuickCaptureService.ownedObjectKey()` applies it before delete,
   download/preview URL and retry reads, and the capture processor applies it before reading a PDF. A record that fails the
   guard (data created by the old route, pointing at another owner's object) never reaches storage: no read, no signed URL, no
   delete, and the violation is audited with a reason code. Deleting such a record removes the record only.

## Consequences

- Clients must call `uploads/init` before `uploads/complete` and use the returned `captureId`. The shipped UI already does; its
  fallback to a fabricated id when init failed now fails honestly.
- Pre-S2D captures created by the old complete route that point at another owner's object become unreadable/undeletable through
  the service (the right outcome) instead of being repaired; no data migration is performed here.
- The legacy `executionHistory` seed and the public `/api/v1/health` `active_executions` count (a process-wide number) are left
  unchanged.

## Not decided here

Authentication abuse controls (S0-03, S0-04, S0-13), session/cookie/header hardening and social login (S0-11, S0-12, S0-14), outbound
URL guards (SSRF), request-size limits and the other open findings; legacy-link and legacy-capture migration.
