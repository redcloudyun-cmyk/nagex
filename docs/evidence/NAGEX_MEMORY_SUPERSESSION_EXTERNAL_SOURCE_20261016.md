# Memory conflict handling — external-source analysis and before/after

**Status:** EVIDENCE (point-in-time, 2026-10-16) — not architecture authority. RELEASE remains NO-GO; no production memory was read, migrated or changed.

## 1. NAGEX_GAP (verified on `5a4c362`, synthetic people, isolated stores)

| Observation | Cause |
|---|---|
| The second explicit "기억해줘 …" (a different statement) was **silently lost**: stored as an invisible `CONFLICTED` record, never recalled | `ConversationMemoryExtractor` filed every explicit statement under one key (`User Preference / preference`); `proposeMemory` treats a different value under the same key as a conflict |
| A later correction ("이제 커피 대신 차를 마셔") was lost the same way, and the assistant kept recalling the **outdated** fact | an unconfirmed-or-conflicting write never replaces an ACTIVE memory; `CONFLICTED` is a terminal, hidden state |
| A secret said in Korean ("내 비밀번호는 hunter2") was stored as an ordinary S1 memory and eligible for model context | the S3 detector only knew English `password: …` shapes |

## 2. EXTERNAL_PROJECT / SOURCE_COMMIT (read as text; nothing executed or installed)

| Project | Pinned commit | License | Relevant implementation |
|---|---|---|---|
| `mem0ai/mem0` | `0724291bd864cf807e88ee8981c8226644e8fb42` (2026-10-14) | Apache-2.0 | `mem0/memory/main.py` (`_add_to_vector_store`: extract facts → retrieve similar memories → model decides), `mem0/configs/prompts.py` `DEFAULT_UPDATE_MEMORY_PROMPT` (ADD / UPDATE keeping the id with `old_memory` / DELETE / NONE) |
| `letta-ai/letta` (`archive` branch — the main branch now only points to `letta-code`) | `56ba9c25552605eec89de8ed3dc6394b625c1993` (2026-08-13) | Apache-2.0 | `letta/functions/function_sets/base.py`: `core_memory_replace` (exact-match replace inside a labelled block), `memory_rethink`, `archival_memory_insert` |

## 3. RELEVANT_TECHNIQUE and decision

| Technique | Fit with NAgex | Decision |
|---|---|---|
| Mem0: reconcile every new fact against the most similar existing memories with explicit operations (ADD / UPDATE / DELETE / NONE) and keep a history | the *shape* is right: a correction must update, not pile up or vanish | **REIMPLEMENT** (deterministic) |
| Mem0: a model chooses the operation | probabilistic; no authorization rule; can delete a user's memory on a model's say-so | **REJECT** for authority — a model may *propose*, NAgex decides |
| Mem0: vector similarity search for "similar memory" | would add an embedding service for a problem solved by topic words on a handful of memories | **REJECT** for now (no demonstrated need) |
| Letta: edit by **exact-match** replace of a named block — a mismatch fails loudly | the precondition idea (the target must be exactly what was meant, otherwise refuse) | **ADAPT** as: target must be the person's own, ACTIVE, unambiguous memory |
| Letta/Mem0: agent-managed memory | conflicts with "memory informs reasoning; it does not grant authority" | **REJECT** |

License: both Apache-2.0 — **no code, prompt or data was copied**, no dependency added. The technique credit is in the header of `src/context/memory-supersession.ts`.
**REA_USED: NO** (public source, nothing opaque to analyse).

## 4. IMPLEMENTATION (NAGEX_FILES_CHANGED)

- `src/context/memory-supersession.ts` (new, pure): replacement cues (대신 / 이제 / 더 이상 / 이사했 / no longer / instead of / actually …), topic tokens (Korean particles stripped), `findSupersedeTarget` — a target only when a cue is present **and** exactly one earlier confirmed memory is closest; a tie replaces nothing.
- `memory.engine.ts` (additive): `supersedes` / `supersededBy` / `supersededAt`; `proposeMemory` options `distinctFact` (only an *identical* statement is "the same memory") and `supersedes` (honoured for a confirmed, non-S2 memory only; the target must be the owner's and ACTIVE, otherwise refused); `restoreSuperseded`; `getSupersessionChain`. The generic key-based `CONFLICTED` behaviour for every other caller is unchanged (existing tests untouched).
- `conversation-memory-extractor.ts`: explicit statements are `distinctFact`; a correction passes `supersedes` for the one matching target.
- `sensitivity.detector.ts`: Korean secret shapes are S3.
- Tests: `tests/memory_supersession.test.ts` (17).

## 5. BEFORE_AFTER_METRICS (`scratch/memory-eval/bench.cjs`, 10 scenarios / 16 questions, identical for both builds)

| | before | after |
|---|---|---|
| questions answered with the **current** fact and no stale leak | **8 / 16** | **16 / 16** |
| explicit statements retained | the second one of any pair lost | all kept (10 / 10 scenarios) |
| cross-user and cross-tenant effect (M08, M09) | none | none |
| ambiguous correction (M07), correction without a cue (M06) | n/a (lost) | replaces nothing, nothing lost |

## 6. REMAINING_BLOCKERS / honest limits

- Topic overlap is a small heuristic (shared topic words); an unrelated older memory that happens to share the only topic word with a cue-bearing statement would be replaced — it stays restorable and visible as history, but no UI for the history exists yet.
- Temporal relevance (expiry of obsolete project state) and provenance-weighted ranking were *not* changed.
- The history is available through the engine API only; the Memory screen does not show it.
- Sensitive (S2) corrections wait for confirmation and do not retire the older fact.
