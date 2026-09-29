# NAgex Personal AI Specification

## 1. Purpose

Personal AI is the central product direction of NAgex.

The system should become more useful over time by retaining relevant context while preserving user visibility and control.

## 2. Memory Classes

NAgex should distinguish at minimum:

### Session Memory
Short-lived context associated with the current interaction or execution.

### User Preference Memory
Stable preferences such as writing style, recurring choices, or workflow conventions.

### Task Memory
Past goals, plans, actions, results, and failures.

### Long-Term Memory
Durable information useful across future sessions.

### Sensitive Memory
Information that requires stronger handling, minimized retention, or explicit user control.

### Execution Memory
Structured agent actions, approvals, tool calls, observations, and outcomes.

## 3. Memory Principles

1. Retain only useful information.
2. Avoid silently storing secrets.
3. Keep memory inspectable.
4. Allow deletion.
5. Distinguish inference from user-provided fact.
6. Keep provenance where practical.
7. Avoid allowing old memory to override current explicit instructions.
8. Apply access control before retrieval.

## 4. Memory Write Policy

A memory write should consider:

```text
Is it useful later?
Is it user-specific?
Is it sensitive?
Did the user ask to retain or forget it?
Is the source trustworthy?
Does it conflict with newer information?
```

## 5. Memory Retrieval

Retrieval should use relevance plus policy.

Possible factors:

- semantic similarity,
- recency,
- importance,
- user scope,
- task scope,
- sensitivity,
- confidence.

## 6. Personal Context Object

A practical runtime context may contain:

```text
user_profile
preferences
active_goals
relevant_memories
recent_executions
current_session
permissions
approval_policy
```

## 7. User Control

The product should ultimately support:

- viewing retained memory,
- deleting individual items,
- clearing categories,
- disabling long-term retention,
- marking information as sensitive,
- correcting inaccurate memory.

## 8. Hackathon Scope

For the hackathon, a smaller real implementation is better than a broad fake memory system.

A strong minimum implementation could include:

- persisted preference memory,
- persisted task history,
- explicit memory retrieval before planning,
- user-visible memory items,
- delete control,
- audit link showing which memory influenced execution.