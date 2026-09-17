# NAGEX Open Source Harvest Plan

**Status:** MANDATORY IMPLEMENTATION ACCELERATION GUIDE  
**Purpose:** Reduce NAGEX development time by selectively absorbing permissively licensed open-source code into NAGEX while preserving NAGEX security, product architecture, approval integrity, and proprietary product identity.

---

## 1. Executive Rule

NAGEX SHOULD NOT rebuild commodity infrastructure that already exists as high-quality permissively licensed source code.

The target is not to adopt another product wholesale. The target is to harvest reusable code at module, component, algorithm, adapter, protocol, or runtime level and absorb it behind NAGEX-owned interfaces.

Core principle:

> Reuse commodity engineering. Keep NAGEX product intelligence, security policy, approval semantics, personal-data policy, and product UX under NAGEX control.

The priority is development-time reduction without creating license, architectural, security, or vendor-lock-in risk.

---

## 2. License Gate — Mandatory Before Any Copy

Only source code with clearly identifiable permissive licenses is eligible for direct NAGEX code absorption.

### 2.1 Default allow list

Preferred licenses:

- MIT
- Apache License 2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC

### 2.2 Default deny list

Do not directly copy code licensed under:

- GPL
- AGPL
- LGPL
- SSPL
- Commons Clause
- BUSL / BSL
- Elastic License
- source-available but non-OSI commercial restriction licenses
- licenses requiring NAGEX source disclosure
- licenses imposing branding restrictions
- licenses imposing commercial-use restrictions
- repositories with no LICENSE file
- code snippets with unclear provenance
- StackOverflow / Gist / blog code where ownership or license is unclear

For maximum legal conservatism, MPL/EPL/CDDL-style reciprocal licenses are also excluded from the default Harvest program unless separately approved.

### 2.3 File-level provenance rule

Repository-level license is not enough.

Before copying any source file, verify:

1. repository LICENSE
2. target file header
3. target subdirectory license
4. bundled third-party code notices
5. generated/vendor code provenance
6. current commit/tag

If any conflict or ambiguity exists, do not copy the file.

### 2.4 Required notice tracking

Every copied/adapted source unit must be recorded in:

`THIRD_PARTY_NOTICES.md`

Minimum record:

```text
Project:
Repository:
Exact commit/tag:
Original path(s):
NAGEX destination path(s):
License:
Original copyright:
Reuse mode: COPY / ADAPT / DEPENDENCY
Modification summary:
Review date:
Reviewer:
```

License headers/notice text required by the original license must be preserved.

---

# 3. Harvest Strategy

Use four reuse modes.

## H1 — COPY

Copy self-contained source/components into NAGEX and modify them directly.

Best for:

- UI components
- small utility modules
- protocol helpers
- parser/normalizer helpers
- isolated action implementations

## H2 — ADAPT

Copy selected implementation logic and rewrite its interfaces around NAGEX architecture.

Best for:

- browser automation
- coding runtime
- provider adapters
- workflow state machines
- synchronization engines

## H3 — DEPENDENCY

Use the open-source package directly instead of copying it when this is safer and faster.

Best for:

- crypto primitives
- CRDT engines
- official protocol SDKs
- DB clients

## H4 — REFERENCE ONLY

Study implementation ideas but do not copy source when coupling, licensing, architecture, or dependency cost makes absorption unattractive.

---

# 4. Highest-Priority Harvest Targets

The following order is chosen primarily by expected NAGEX engineering-time savings.

---

## Priority 1 — Agent / Tool / Approval UI

### Source

`assistant-ui/tool-ui`

Repository:

`https://github.com/assistant-ui/tool-ui`

License:

MIT

The project explicitly describes itself as copy/paste React components for AI tool-call interfaces. It includes components for approvals, forms, tables, charts, media, progress, question flows, terminal output, code diffs, message drafts, and other AI interaction surfaces.

### Why this is first

NAGEX still needs substantial product-grade UI work in:

- universal intent interaction
- clarification UI
- tool execution UI
- approval cards
- plan/progress UI
- artifact display
- result cards
- activity/result presentation
- Inbox review interactions
- Home proactive/result panels

These are time-consuming but not where NAGEX should spend proprietary engineering effort.

### Harvest candidates

Inspect and selectively absorb components for:

- Approval Card
- Plan / Progress Tracker
- Question Flow
- Option List
- Data Table
- Code Block
- Code Diff
- Terminal
- Citation
- Stats Display
- Link Preview
- Message Draft
- Image / Gallery / Video wrappers

### Reuse mode

**COPY + HEAVY NAGEX RESTYLE**

### NAGEX boundary

UI components must be presentation-only.

Forbidden:

- copied UI authorizing mutations directly
- approval logic inside visual components
- provider/tool execution inside components
- replacing NAGEX Approval semantics

Required:

```text
NAGEX state / Approval state
        ↓
NAGEX ViewModel / Adapter
        ↓
Adapted Tool UI component
```

### Expected effect

**VERY HIGH development-time reduction.**

This should be the first UI harvest before NAGEX Home / Inbox / Activity / Settings receive their final product redesign.

---

## Priority 2 — Core AI Chat / Thread Interaction UI

### Source

`assistant-ui/assistant-ui`

Repository:

`https://github.com/assistant-ui/assistant-ui`

License:

MIT

### Harvest candidates

Inspect:

- thread/message rendering
- composer/input handling
- streaming display state
- attachment interaction
- tool-call message presentation
- retry/cancel/regenerate interaction patterns
- accessibility patterns
- message branch/state handling where useful

### Reuse mode

**ADAPT / COPY SELECTIVELY**

Do not replace NAGEX Intent-first UX with a generic chatbot UX.

### NAGEX rule

The conversational shell may be borrowed; the product behavior must remain:

```text
Intent
→ Clarification if required
→ Work
→ Review / Approval when required
→ Result
```

NAGEX should not become a prompt-centric chat clone.

### Expected effect

**HIGH development-time reduction.**

---

## Priority 3 — Browser / Computer Capability

### Preferred source

`webllm/browser-use`

Repository:

`https://github.com/webllm/browser-use`

License:

MIT

Technology:

TypeScript + Playwright

### Why preferred over the Python implementation

NAGEX is heavily TypeScript-oriented. A TypeScript browser automation implementation lowers integration cost and allows code-level adaptation without introducing a Python-only runtime boundary for the core browser capability.

### Harvest candidates

Inspect modules implementing:

- browser lifecycle/session
- page/navigation state
- Playwright integration
- DOM/page extraction
- click/type/scroll/navigation actions
- built-in action registry
- custom action registration
- history/action result model
- browser error recovery
- content extraction
- screenshot/vision support boundaries
- MCP exposure patterns

### Reuse mode

**ADAPT**

### Required NAGEX architecture

```text
Intent / Agent
   ↓
Capability Broker
   ↓
Policy / Approval
   ↓
NAGEX Browser Capability Adapter
   ↓
Adapted browser-use engine
   ↓
Playwright / Browser
```

Never allow harvested browser code to bypass policy or approval.

### Do not copy blindly

Do not inherit:

- provider-specific LLM coupling
- API-key management
- telemetry without review
- unsafe automation defaults
- anti-bot/stealth behavior that conflicts with NAGEX policy

### Expected effect

**VERY HIGH development-time reduction.**

Browser automation should not be implemented from scratch unless Harvest evaluation proves the source unsuitable.

---

## Priority 4 — Multi-Provider Model Adapter Layer

### Preferred source

`vercel/ai`

Repository:

`https://github.com/vercel/ai`

License:

Apache-2.0

### Relevant source areas

Repository structure currently includes:

- `packages/provider`
- `packages/provider-utils`
- provider implementations under `packages/<provider>`
- provider-specific integrations such as OpenAI, Anthropic, Google, Azure, Bedrock, etc.

### Harvest candidates

Inspect and adapt:

- provider interface contracts
- request normalization
- streaming normalization
- structured output handling
- tool-call normalization
- usage extraction
- response metadata normalization
- common provider utilities
- provider error normalization
- secure URL handling patterns

### Reuse mode

**ADAPT / DEPENDENCY / SELECTIVE COPY**

Decision should be per module.

### NAGEX-owned layers — never delegate

The following must remain NAGEX code:

- Data Disclosure Gate
- S0/S1/S2/S3 classification policy
- security eligibility
- privacy eligibility
- regional compliance eligibility
- tenant isolation
- credential pool policy
- capacity manager policy
- cost optimizer policy
- billing / NAGEX Credits
- audit policy
- privacy-safe fallback

Required flow:

```text
NAGEX Disclosure Gate
→ NAGEX Eligible Model Set
→ NAGEX Router
→ NAGEX Provider Adapter interface
→ adapted provider implementation
```

### Expected effect

**VERY HIGH development-time reduction.**

Writing and maintaining provider streaming/tool/structured-output adapters independently for every model vendor is low-value duplicated engineering.

---

## Priority 5 — MCP / Plugin Protocol Runtime

### Source

`modelcontextprotocol/typescript-sdk`

Repository:

`https://github.com/modelcontextprotocol/typescript-sdk`

License:

New contributions: Apache License 2.0  
Existing code: MIT

Both licenses are permissive; exact copied files must still be recorded by commit/path.

### Harvest candidates

- MCP client
- MCP server
- stdio transport
- HTTP transport
- tool discovery
- resource discovery
- prompt discovery
- OAuth helpers
- capability negotiation
- request/error schemas
- compatibility handling

### Reuse mode

Prefer **DEPENDENCY** for protocol correctness.

Use **ADAPT** only where NAGEX needs its own lifecycle or policy wrapper.

### NAGEX boundary

```text
External MCP Server
      ↓
Official MCP SDK
      ↓
NAGEX MCP Adapter
      ↓
Capability Registry
      ↓
Policy / Approval
      ↓
Execution
```

MCP tool discovery never implies execution authorization.

### Expected effect

**VERY HIGH development-time reduction.**

Do not implement the MCP wire protocol independently.

---

## Priority 6 — Coding Agent Runtime

### Source candidate

`OpenHands/OpenHands`

Repository:

`https://github.com/OpenHands/OpenHands`

Root license:

MIT

### Important license rule

Because a large coding-agent repository can contain generated, vendored, optional, or separately governed areas, **direct copying is permitted only after path-level provenance verification**.

If a selected path has any ambiguity, switch it to REFERENCE ONLY.

### Harvest candidates

Study and selectively adapt:

- workspace model
- command execution lifecycle
- shell result capture
- file operation flow
- repository context handling
- execution sandbox patterns
- coding action/result model
- long-running command handling
- agent/runtime separation
- error recovery

### Reuse mode

**ADAPT**, not wholesale embedding.

### NAGEX architecture

```text
NAGEX Intent
→ Coding Capability
→ Approval / Policy
→ NAGEX Coding Runtime Adapter
→ adapted workspace/shell runtime
→ sandbox/workspace
```

### Do not import

- product UI
- branding
- account/cloud services
- remote telemetry
- autonomous mutation policy
- any enterprise or unclear-license subcomponent

### Expected effect

**HIGH to VERY HIGH development-time reduction** for NAGEX Coding Capability.

---

## Priority 7 — Durable Agent / Workflow State

### Source

`langchain-ai/langgraphjs`

Repository:

`https://github.com/langchain-ai/langgraphjs`

License:

MIT

### Harvest candidates

Inspect:

- state graph representation
- conditional transitions
- checkpointing
- interrupt/resume
- human-in-the-loop state handling
- retry/state persistence patterns
- graph execution semantics

### Reuse mode

**ADAPT / DEPENDENCY**

### NAGEX rule

Do not replace NAGEX Runtime wholesale.

Harvest only capabilities that would otherwise require substantial custom engineering.

NAGEX remains owner of:

- intent resolution
- policy
- approval
- tool authorization
- memory policy
- data disclosure
- capability routing

### Expected effect

**HIGH development-time reduction** if NAGEX later implements long-lived multi-step agent workflows.

---

## Priority 8 — Document Parsing for Knowledge / Research / RAG

### Source

`docling-project/docling`

and

`docling-project/docling-core`

Repositories:

`https://github.com/docling-project/docling`

`https://github.com/docling-project/docling-core`

License:

MIT for the codebase.

Important: individual model artifacts may have their own model licenses. Model files must be reviewed separately before packaging or redistribution.

### Harvest candidates

- PDF/document structure extraction
- document normalization
- table/layout structures
- DOCX/PPTX/XLSX/HTML conversion pipelines where applicable
- normalized document data model
- chunk-preparation transformations

### Reuse mode

Prefer **DEPENDENCY / SERVICE ADAPTER** rather than porting large Python parsing engines to TypeScript.

### NAGEX boundary

```text
Input Document
→ NAGEX upload/security scan
→ NAGEX document adapter
→ Docling parser
→ normalized NAGEX KnowledgeDocument
→ redaction/classification
→ index/RAG
```

Never send raw parsed sensitive content to a model before NAGEX disclosure policy.

### Expected effect

**VERY HIGH development-time reduction** for multi-format document ingestion.

---

## Priority 9 — Multi-Device Non-Security State Sync

### Preferred source

`yjs/yjs`

Repository:

`https://github.com/yjs/yjs`

License:

MIT

### Harvest candidates

- CRDT update model
- offline update merge
- state vector patterns
- conflict-free synchronization
- incremental update handling

### Reuse mode

Prefer **DEPENDENCY**.

### Allowed NAGEX usage

Good candidates:

- notes
- collaborative workspace state
- non-sensitive UI preferences
- selected document/editor state

### Forbidden NAGEX usage

Do not use CRDT conflict resolution as authorization truth for:

- approvals
- consumed approvals
- payment state
- secrets
- security policy
- tenant authority
- mutation authorization

### Expected effect

**HIGH development-time reduction** for offline/multi-device sync where CRDT semantics fit.

---

## Priority 10 — Cryptographic Primitives for E2EE

### Source

`jedisct1/libsodium`

Repository:

`https://github.com/jedisct1/libsodium`

License:

ISC

### Reuse mode

**DEPENDENCY ONLY** wherever possible.

Do not copy and modify cryptographic primitives.

### Use for

- authenticated encryption
- key derivation
- hashing/MAC where appropriate
- public-key primitives
- secure random generation

### NAGEX rule

NAGEX may design its protocol, key lifecycle, device trust and envelope structure, but must not invent encryption algorithms.

### Expected effect

**VERY HIGH risk reduction** and moderate development-time reduction.

---

# 5. Secondary Candidates

These are useful, but should be evaluated after the first Harvest wave.

## Qdrant JavaScript client

Repository:

`https://github.com/qdrant/qdrant-js`

License:

Apache-2.0

Use mode:

DEPENDENCY

Value:

- collection operations
- vector upsert/search
- filters
- payload handling

Do not write a custom vector DB HTTP client unless required.

---

## Automerge

Repository family:

`https://github.com/automerge`

License:

MIT for core Automerge projects; verify exact selected repository/file.

Use mode:

DEPENDENCY / compare against Yjs

Rule:

Select one primary CRDT technology unless a real product requirement justifies two.

---

# 6. Sources Explicitly Excluded from the Default Harvest

Do not harvest directly from:

- Open WebUI versions with branding/custom license restrictions
- AGPL/GPL agent platforms
- SSPL databases/services
- source-available products marketed as open source but restricting commercial redistribution
- enterprise folders under otherwise open repositories when separately licensed
- generated source copied from unknown upstream projects
- GitHub repositories without a clear license

The existence of source code on GitHub does **not** make it reusable.

---

# 7. Harvest Wave Plan

The following sequence maximizes near-term development-time savings while keeping architecture risk controlled.

## Wave 0 — Finish Current Architecture Cleanup

Before major source absorption:

1. Finish R10.2-D Increment 5
2. Close DEBT-0004 only if completion gate passes
3. Complete R10.2-E
4. Establish third-party notice/provenance mechanism

Do not mix a large external-source import with an unfinished composition-root refactor.

---

## Wave 1 — UI + Browser + MCP

Highest immediate ROI.

### 1A. Tool / Approval UI

Harvest from `assistant-ui/tool-ui`.

Target outcomes:

- approval card
- progress card
- clarification/question UI
- structured tool result cards
- code/terminal/data displays

Then redesign:

- Home
- Inbox
- Activity
- Settings

using NAGEX Intent-first UX rules.

### 1B. Browser Capability

Harvest browser session/action engine from `webllm/browser-use`.

Build:

`NagexBrowserAdapter`

behind Capability Broker + Approval.

### 1C. MCP

Integrate official TypeScript SDK behind `NagexMcpAdapter`.

### Expected Wave 1 impact

This wave can eliminate large amounts of otherwise custom UI, browser automation, and protocol engineering.

---

## Wave 2 — Model Gateway + Document Pipeline

### 2A. Model providers

Harvest provider contracts/utilities/adapter patterns from `vercel/ai`.

Do **not** copy NAGEX policy logic from anywhere.

### 2B. Documents

Integrate Docling behind a parser adapter/service boundary.

### Expected Wave 2 impact

Avoids maintaining dozens of model-provider protocol variations and building multi-format parsing from zero.

---

## Wave 3 — Coding Runtime + Durable Workflow

### 3A. Coding capability

Perform path-level OpenHands review and adapt only clean MIT source areas.

### 3B. Long-running workflows

Evaluate LangGraphJS state/checkpoint/interrupt implementation against current NAGEX runtime.

Only adopt portions that measurably remove custom work.

---

## Wave 4 — Sync + E2EE

### 4A. Sync

Choose Yjs or Automerge based on actual NAGEX data semantics.

### 4B. E2EE

Use libsodium/binding as crypto primitive dependency.

Implement NAGEX trusted-device/key lifecycle above it.

---

# 8. Mandatory Harvest Procedure for Development Agents

Every AI or human developer must use this sequence before absorbing external code.

```text
1. Identify exact NAGEX task
2. Identify candidate open-source repository
3. Pin exact commit/tag
4. Verify repository license
5. Verify target directory/file license/provenance
6. Inspect dependencies of selected source
7. Select COPY / ADAPT / DEPENDENCY / REFERENCE
8. Define NAGEX adapter boundary
9. Copy only the minimum required source
10. Remove unrelated provider/account/cloud/telemetry coupling
11. Rename/restructure only after provenance is recorded
12. Add THIRD_PARTY_NOTICES entry
13. Add architecture guard where security boundary matters
14. Run build/tests
15. Run NAGEX Safety Harness
16. Commit with source provenance noted
```

No development agent may perform a large wholesale copy of an external repository directly into `src/`.

---

# 9. Security Boundaries That Harvested Code Must Never Own

Regardless of license or source quality, external code must not become authoritative for:

- approval authorization
- tenant identity
- principal identity
- secret classification
- mutation authorization
- S0/S1/S2/S3 classification
- Data Disclosure Gate
- provider privacy eligibility
- sensitive-data minimization
- NAGEX billing truth
- credit ledger
- approval replay prevention
- security audit truth

These remain NAGEX-controlled canonical layers.

---

# 10. Adapter-First Integration Rule

Every substantial harvested subsystem must sit behind a NAGEX-owned interface.

Examples:

```text
NagexBrowserAdapter
NagexMcpAdapter
NagexModelProviderAdapter
NagexDocumentParserAdapter
NagexCodingRuntimeAdapter
NagexSyncAdapter
NagexCryptoProvider
```

Benefits:

- external source can be replaced later
- dependency upgrades remain isolated
- security checks remain NAGEX-owned
- tests can mock external implementation
- product behavior does not inherit upstream assumptions

---

# 11. Copy Less, Reuse More

Direct copying is not automatically the fastest option.

Use this decision rule:

### COPY when

- component is small and self-contained
- NAGEX must heavily restyle/rework it
- dependency overhead would exceed copied code size
- the source project is specifically designed for copy/paste use

### DEPENDENCY when

- protocol correctness matters
- cryptography is involved
- complex algorithms are maintained upstream
- security patches matter
- upstream compatibility matters

### ADAPT when

- implementation is useful but architecture must remain NAGEX-owned
- source has provider/business logic coupling
- security policy differs

This usually produces more time savings than indiscriminate source copying.

---

# 12. Initial Harvest Ranking

| Rank | Area | Source | License | Mode | Time-Saving Potential | Integration Risk |
|---:|---|---|---|---|---|---|
| 1 | Tool/Approval UI | assistant-ui/tool-ui | MIT | COPY | VERY HIGH | LOW |
| 2 | Browser Agent | webllm/browser-use | MIT | ADAPT | VERY HIGH | MEDIUM |
| 3 | Model Adapters | vercel/ai | Apache-2.0 | ADAPT/DEPENDENCY | VERY HIGH | MEDIUM |
| 4 | MCP Runtime | modelcontextprotocol/typescript-sdk | Apache-2.0 + MIT | DEPENDENCY | VERY HIGH | LOW |
| 5 | Document Parsing | Docling | MIT | DEPENDENCY/SERVICE | VERY HIGH | MEDIUM |
| 6 | Coding Runtime | OpenHands | MIT root; path-level check mandatory | ADAPT | HIGH–VERY HIGH | HIGH |
| 7 | Chat/Thread UI | assistant-ui | MIT | ADAPT/COPY | HIGH | LOW–MEDIUM |
| 8 | Workflow State | LangGraphJS | MIT | ADAPT/DEPENDENCY | HIGH | MEDIUM |
| 9 | Multi-device Sync | Yjs | MIT | DEPENDENCY | HIGH | MEDIUM |
| 10 | E2EE primitives | libsodium | ISC | DEPENDENCY | MEDIUM time / VERY HIGH risk reduction | LOW |

---

# 13. First Concrete Implementation Package

After R10.2-E, the first Harvest implementation should be deliberately small and measurable.

## Harvest Package H-001

### Scope

`assistant-ui/tool-ui`

### Goal

Replace hand-built commodity Agent UI building blocks with NAGEX-owned adapted copies.

### Initial components

- Approval Card
- Plan / Progress Tracker
- Question Flow
- Option List
- Data Table
- Code Block / Code Diff
- Terminal
- Citation

### Acceptance criteria

- no upstream branding
- NAGEX design tokens applied
- accessibility retained or improved
- NAGEX Approval state remains canonical
- no action execution inside UI component
- responsive mobile behavior
- KR/EN ready
- provenance/notice recorded
- full build/test passes

Do not redesign the entire NAGEX interface inside the Harvest commit. First establish the reusable component foundation, then use it in the product UX redesign milestone.

---

# 14. Second Concrete Implementation Package

## Harvest Package H-002

### Scope

`webllm/browser-use`

### Goal

Accelerate NAGEX Browser Capability without weakening safety controls.

### Required outputs

- `NagexBrowserAdapter`
- isolated browser engine integration
- action schema mapping
- session lifecycle
- browser result normalization
- approval classification for mutating actions
- deny/confirm rules for destructive actions
- tests proving no direct execution bypass

### Required architecture test

Harvested browser modules must not import or invoke NAGEX Approval internals to self-authorize actions.

---

# 15. Third Concrete Implementation Package

## Harvest Package H-003

### Scope

Official MCP TypeScript SDK

### Goal

Finish standards-based tool/plugin transport without custom protocol reinvention.

### Required outputs

- `NagexMcpAdapter`
- client lifecycle
- server/tool discovery
- transport abstraction
- normalized capability descriptors
- policy/approval boundary tests

---

# 16. Fourth Concrete Implementation Package

## Harvest Package H-004

### Scope

Vercel AI SDK provider layer

### Goal

Accelerate Global Model Gateway provider implementation.

### Required outputs

- provider contract mapping
- streaming normalization
- tool-call normalization
- structured-output normalization
- usage metadata normalization
- provider-error normalization

### Mandatory rule

Provider reuse starts **after** NAGEX Data Disclosure Gate and eligibility policy are enforced.

No provider adapter may receive S3 data.

---

# 17. Completion Report Template for Each Harvest Package

```text
HARVEST_ID=
NAGEX_TASK=
UPSTREAM_PROJECT=
UPSTREAM_REPOSITORY=
UPSTREAM_COMMIT=
LICENSE=
FILES_REVIEWED=
FILES_COPIED=
FILES_ADAPTED=
DEPENDENCIES_ADDED=
PROVENANCE_VERIFIED=YES/NO
THIRD_PARTY_NOTICE_UPDATED=YES/NO

NAGEX_FILES_ADDED=
NAGEX_FILES_CHANGED=
LOC_REUSED_ESTIMATE=
LOC_NEW_NAGEX_GLUE=

SECURITY_BOUNDARY_CHANGED=YES/NO
APPROVAL_BOUNDARY_CHANGED=YES/NO
DATA_DISCLOSURE_BOUNDARY_CHANGED=YES/NO

BUILD=
TESTS=
ARCHITECTURE_GUARDS=
SAFETY_HARNESS=

ESTIMATED_CUSTOM_BUILD_EFFORT=
ACTUAL_HARVEST_INTEGRATION_EFFORT=
ESTIMATED_TIME_SAVED=

HARVEST_RESULT=PASS/FAIL
```

---

# 18. Final Policy

NAGEX is not an open-source assembly project.

It is a proprietary AI Agent product that should aggressively reuse high-quality permissive commodity engineering where doing so reduces development time and risk.

Harvest external code for:

- UI primitives
- browser mechanics
- provider protocol mechanics
- MCP protocol mechanics
- document parsing
- coding runtime mechanics
- workflow checkpoint mechanics
- synchronization algorithms
- cryptographic primitives

Keep NAGEX-native:

- Intent Resolution
- Human Approval semantics
- policy decisions
- mutation authorization
- personal-data classification
- Data Disclosure Gate
- security eligibility
- privacy fallback rules
- tenant isolation
- NAGEX Memory behavior
- billing/credit semantics
- product information architecture
- final user experience

The goal is not maximum external-code volume.

The goal is maximum **verified development-time reduction per unit of integration risk**.
