# NAgex Project Index

**Status:** CANONICAL DOCUMENT ROUTER
**Date:** 2026-09-29

## 1. Purpose

This file tells humans and AI agents **what to read for a task**.

Do not read the entire `docs/` tree by default.

Default read order:

```text
MASTER.md
→ NAGEX_PROJECT_INDEX.md
→ NAgex_AI_Development_Governance.md
→ task-relevant canonical docs
→ relevant ADR / current milestone
→ relevant code/tests
```

## 2. Canonical Documents

| Domain | Canonical document | Read when |
|---|---|---|
| Product / brand / principles | `canonical/NAgex_Product_Brand_and_Principles.md` | positioning, product scope, brand, product principle |
| Core runtime | `canonical/NAgex_Core_Runtime_Architecture.md` | goal/plan/runtime/state/capability architecture |
| AI/model/decision | `canonical/NAgex_AI_Model_and_Decision_Architecture.md` | ModelGateway, ModelRouter, Nemotron, decision/JEV questions |
| Creation | `canonical/NAgex_Creation_Architecture.md` | document/image/slides/video creation, provider ports, artifacts |
| Execution / cross-platform | `canonical/NAgex_Execution_and_Cross_Platform_Architecture.md` | actions, routes, device/browser/mobile/desktop execution |
| Memory/data/sync | `canonical/NAgex_Memory_Data_and_Sync_Architecture.md` | memory, personal data, sync, sensitivity, provenance |
| Trust/identity/privacy/approval | `canonical/NAgex_Trust_Identity_Privacy_and_Approval.md` | auth, permissions, credentials, approval, privacy |
| UX/interaction | `canonical/NAgex_UX_and_Interaction_Architecture.md` | Home, mobile, desktop, voice, status vocabulary, interaction |
| Testing/quality | `canonical/NAgex_Testing_and_Quality_Gates.md` | tests, browser certification, quality gates, test contracts |
| Operations/deployment | `canonical/NAgex_Operations_and_Deployment.md` | deployment, persistence, safe checks, secrets, service ops |
| Development roadmap | `canonical/NAgex_Development_Roadmap.md` | current milestone sequence and status |
| Hackathon plan | `canonical/NAgex_Hackathon_Current_Plan.md` | submission-specific scope, freeze, evidence |

## 3. Task Loading Matrix

### Product / UX task
Read:
`MASTER` + Product + UX + relevant runtime domain + current Roadmap.

### Creation task
Read:
`MASTER` + Creation + AI/Decision + Trust + Testing + current R23.7C milestone evidence.

### Execution / device / browser task
Read:
`MASTER` + Execution/Cross-platform + Trust + Testing + relevant ADR/evidence.

### Memory / personal context task
Read:
`MASTER` + Memory/Data/Sync + Trust + UX + relevant code/tests.

### Model/provider task
Read:
`MASTER` + AI/Decision + Trust + relevant provider contract + Testing.
Add Creation only when the provider is a creation provider.

### Security/auth/approval task
Read:
`MASTER` + Trust + relevant ADR/debt + Testing.

### Deployment task
Read:
`MASTER` + Operations + Testing + current deployment scripts/config.
Do not rely on archived host commands without verifying the active revision.

### Roadmap / development directive
Read:
`MASTER` + all canonical domain docs materially affected + current Roadmap + active/open milestone evidence + latest relevant closed milestone evidence.

Do not derive a new roadmap from memory alone.

## 4. ADR

`docs/adr/` contains accepted architectural decisions.

ADRs refine a specific decision. They do not automatically replace Level-0 or an entire canonical domain.

If an ADR conflicts with a later canonical decision, surface the conflict and update/supersede the ADR explicitly.

## 5. Debt

`docs/debt/` contains unresolved known debt.

Debt is not a desired architecture. It records a gap that must remain visible until resolved.

## 6. Evidence

`docs/evidence/` or archived evidence contains point-in-time certification and closure proof.

Evidence answers:

- what was tested;
- at what revision;
- with what result.

Evidence does not define permanent product architecture.

## 7. Archive

`docs/archive/` is searchable provenance, not default reading.

Subfolders:

```text
audits/
directives/
handoffs/
milestones/
superseded/
historical-roadmaps/
reference/
evidence/
```

AI agents should not recursively read archive unless the current task requires historical provenance or conflict resolution.

## 8. Current-State Rule

When a status conflicts:

1. verify committed implementation/test evidence;
2. check latest accepted closure evidence;
3. compare with current roadmap;
4. surface discrepancy;
5. do not silently reopen or close the milestone.

## 9. Memory Rule

AI memory and prior conversation are context-recovery aids only.

They are not specification authority and must not replace repository documents when a development decision depends on exact current state.
