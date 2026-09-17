# NAGEX Open Source Harvest License Guardrails

**Status:** MANDATORY COMPANION TO `NAGEX_OPEN_SOURCE_HARVEST_PLAN.md`  
**Purpose:** Prevent license contamination when harvesting source code from repositories that mix permissive and non-permissive components.

---

## 0. Prime Directive — First Principle

> **NAGEX MUST NOT copy, adapt, vendor, embed, or depend on any external source code if there is any meaningful possibility of license conflict, commercial-use restriction, source-disclosure obligation, branding obligation, trial restriction, field-of-use restriction, redistribution restriction, or unclear provenance.**

This is the **first and overriding rule** of the NAGEX Open Source Harvest program.

Development-time reduction is always secondary to license certainty.

If there is any doubt, ambiguity, mixed licensing, unclear ownership, uncertain file provenance, uncertain dependency licensing, or a need for legal interpretation beyond straightforward permissive use, the source is **REJECTED for COPY / ADAPT / DEPENDENCY**.

When uncertainty remains:

- do not copy the code
- do not adapt the code
- do not vendor the code
- do not add it as a production dependency
- do not use trial or source-available rights as a substitute for open-source rights
- do not assume a repository-level license covers every subdirectory or file
- use **REFERENCE ONLY** only when no source code is copied or derived from the implementation
- otherwise reimplement independently from public behavior, standards, interfaces, or specifications

The decision order is therefore:

```text
1. LICENSE / PROVENANCE CERTAINTY
2. COMMERCIAL USE SAFETY
3. MODIFICATION / REDISTRIBUTION SAFETY
4. SECURITY / ARCHITECTURE COMPATIBILITY
5. CODE QUALITY / MAINTENANCE CONFIDENCE
6. DEVELOPMENT-TIME SAVINGS
```

If step 1, 2, or 3 is not a clear PASS, the Harvest candidate is rejected regardless of engineering value.

---

## 1. Governing Rule

Repository-level licensing is never sufficient by itself.

NAGEX may only COPY or ADAPT source from paths whose license and provenance have been verified at repository, subdirectory, file, and dependency level.

If any selected path has ambiguous, source-available, trial, reciprocal, commercial-use-restricted, branding-restricted, or otherwise non-permissive terms, that path is **DENY**.

When uncertainty remains, use **REFERENCE ONLY** or do not use the source at all.

---

## 2. Explicit Path-Level Allow / Deny Rules

### 2.1 LangGraph / LangGraphJS

NAGEX must treat the LangGraph ecosystem as a mixed-license ecosystem, not as one uniformly MIT-licensed product.

#### ALLOW — after exact path verification

For `langchain-ai/langgraphjs`, permissively licensed core areas may be evaluated when the exact path contains a valid MIT license, including examples such as:

- `libs/langgraph-core/`
- `libs/langgraph/`
- checkpoint implementations whose own path/license is verified as MIT before use

Allowed Harvest scope is limited to concepts and implementations such as:

- graph/state representation
- checkpointing
- interrupt/resume
- conditional transitions
- human-in-the-loop state handling
- retry/state-persistence patterns

#### DENY BY DEFAULT

Do **not** harvest server/platform/runtime/CLI code merely because another LangGraph package is MIT.

The following are denied unless separately re-reviewed and explicitly added to an allow list:

- Python `langgraph-api`
- LangGraph Platform server/runtime code
- licensed runtime/container components
- platform deployment code
- any package that depends on a separately licensed server/runtime
- any generated server code whose provenance is not independently verified

The Python `langgraph-api` package is licensed under Elastic License 2.0 and is therefore outside the NAGEX Harvest allow list.

Important ecosystem nuance: the current `langchain-ai/langgraphjs` repository also contains JavaScript packages named `langgraph-api` and `langgraph-cli` whose repository/package license may differ from the Python server package. NAGEX does not rely on name-based assumptions in either direction. For legal conservatism, these API/CLI/server areas remain **DENY BY DEFAULT** until an exact-file license review explicitly approves them.

#### Hard rule

> Harvest only verified permissive core graph/checkpoint code. Do not import LangGraph server, hosted-platform, licensed-runtime, or deployment infrastructure into NAGEX by default.

NAGEX must own its own runtime/server boundaries.

---

### 2.2 OpenHands

The OpenHands ecosystem also contains permissive core code and non-open-source enterprise code.

#### ALLOW — after exact path verification

The MIT-licensed OpenHands core may be evaluated for:

- agent/runtime separation
- workspace handling
- shell/command execution lifecycle
- file operations
- repository context handling
- sandbox patterns
- coding action/result models
- long-running command handling
- error recovery

Every copied/adapted path still requires exact-file provenance verification.

#### EXPLICIT DENY

The following are prohibited from NAGEX Harvest:

- `OpenHands/enterprise` repository
- any `enterprise/` subtree in an OpenHands repository or historical source layout
- OpenHands Cloud / Enterprise source-available components
- PolyForm Free Trial licensed files
- authentication, OAuth, RBAC, billing, governance, collaboration, or integration code located in enterprise-only areas

The OpenHands Enterprise source is licensed under the PolyForm Free Trial License and is not treated as open source for NAGEX. Trial-use rights are irrelevant to production NAGEX and must not be used as a basis for copying code.

#### Hard rule

> No file from an OpenHands enterprise path may be copied, adapted, vendored, or used as a dependency in NAGEX.

If an attractive implementation exists only in an enterprise path, reimplement the behavior independently from public interface requirements rather than copying the implementation.

---

### 2.3 `webllm/browser-use`

License status alone is not sufficient for adoption quality.

Current policy:

- License: MIT — potentially eligible
- Project status: independent TypeScript reimplementation/port, not treated as the authoritative upstream Browser Use implementation
- Maintenance/community maturity: lower than the original Python `browser-use` project

Therefore:

- use **ADAPT**, not blind COPY
- perform security and correctness review before importing modules
- compare critical behavior against Playwright and the original Browser Use design
- do not inherit provider key management, telemetry, unsafe defaults, stealth/anti-bot behavior, or autonomous mutation semantics
- prefer small, testable browser primitives over wholesale runtime adoption

#### Hard rule

> `webllm/browser-use` can accelerate TypeScript implementation, but every harvested module requires deeper review than mature official SDKs.

---

## 3. Mandatory Harvest Manifest

Before any external source is copied or adapted, create a Harvest Manifest entry containing:

```text
HARVEST_ID=
PROJECT=
REPOSITORY=
EXACT_COMMIT=
SOURCE_PATH=
DESTINATION_PATH=
REPOSITORY_LICENSE=
PATH_LICENSE=
FILE_HEADER_LICENSE=
THIRD_PARTY_NOTICE_CHECK=
DEPENDENCY_LICENSE_CHECK=
REUSE_MODE=COPY|ADAPT|DEPENDENCY|REFERENCE_ONLY
ALLOW_OR_DENY=
REVIEWER=
REVIEW_DATE=
```

No `ALLOW` entry means no source copy.

---

## 4. Automated Guard Requirements

Before NAGEX begins large-scale Harvest work, add CI/static guards where practical to detect prohibited provenance or dependency introduction.

At minimum check for:

- `PolyForm-Free-Trial`
- `Elastic-2.0`
- `AGPL`
- `GPL`
- `LGPL`
- `SSPL`
- `BUSL` / `BSL`
- `Commons Clause`
- `enterprise/` source paths in harvested provenance records
- dependencies with unapproved licenses

Automation is an additional guard, not a replacement for file-level human/agent review.

---

## 5. Legal-Conservatism Rule

NAGEX optimizes first for development-time reduction, but license certainty is a hard boundary.

Decision order:

```text
1. License/provenance certainty
2. Security and architecture compatibility
3. Code quality/maintenance confidence
4. Development-time savings
```

A source that saves substantial engineering time but fails step 1 is rejected.

---

## 6. Effective Allow / Deny Summary

### ALLOW CANDIDATES

Only after exact-path verification:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC

### DENY

- GPL / AGPL / LGPL
- SSPL
- Elastic License 2.0
- PolyForm Free Trial
- BUSL / BSL
- Commons Clause
- source-available commercial licenses
- enterprise-only code
- trial-only code
- unclear provenance
- files without a clear applicable license

---

## 7. Relationship to the Main Harvest Plan

This document overrides any broad repository-level statement in `NAGEX_OPEN_SOURCE_HARVEST_PLAN.md` when a repository contains mixed licenses.

If the main Harvest Plan says a repository is MIT/Apache but this guardrail file denies a subpath, the **deny rule wins**.

No development agent may infer permission from the repository root license alone.
