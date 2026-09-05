# AGEX Master Documentation Index

AGEX 프로젝트의 전체 문서 체계 및 도메인별 필독 사양 색인입니다.

---

## 1. 최상위 지침 및 통합 명세
- [AGENTS.md](file:///f:/개발%20프로젝트/Agex%20project/AGENTS.md) — AI Coding Agent 최상위 규칙 및 실행 지침
- [CLAUDE.md](file:///f:/개발%20프로젝트/Agex%20project/CLAUDE.md) — Claude / AI Agent 전용 가이드라인
- [MASTER.md](file:///f:/개발%20프로젝트/Agex%20project/MASTER.md) — AGEX Master Specification (LEVEL 0 SSOT)
- [AGEX-UNIFIED-AGENT-PLATFORM.md](file:///f:/개발%20프로젝트/Agex%20project/AGEX-UNIFIED-AGENT-PLATFORM.md) — Personal Agent Runtime 통합 개발 지시서 (2026-08-22 추가). MASTER.md의 LEVEL 0~6 계층에는 속하지 않는 별도 지시서다. Standard/Personal Agent 단일 코드베이스·단일 Runtime Core 통합 지시가 기존 "데스크톱 에이전트는 별도 프로젝트/코드베이스" 결정과 충돌했으나, **2026-08-22 사용자 결정으로 해소됨** — Personal Agent(Antigravity)는 별도 코드베이스로 유지하고, 본 문서는 UX 통일(프론트엔드 자산 공유) 원칙만 적용한다. 상세 내용은 문서 상단의 "적용 범위 제한" 및 [Desktop Agent Initiative memory](file:///C:/Users/redcl/.claude/projects/f----------Agex-project/memory/desktop_agent_initiative.md) 참고.
- [GLOSSARY.md](file:///f:/개발%20프로젝트/Agex%20project/docs/GLOSSARY.md) — AGEX Canonical Glossary (표준 용어집)

---

## 2. 문서 카테고리별 분류

아래 목록은 **실제로 `docs/` 아래 존재하는 파일만** 표시합니다. 각 카테고리 이름(LEVEL 1~6)은
MASTER.md의 12-phase 로드맵이 궁극적으로 채울 것으로 예정된 문서 체계이지만, 대부분은
아직 작성되지 않았습니다 — 존재하지 않는 파일을 여기 나열해 "필독 문서"처럼 보이게
만들지 않도록 의도적으로 뺐습니다. 해당 도메인에 대한 명세가 아래에 없다면, `MASTER.md`
(LEVEL 0 SSOT)와 `specs/schemas/`, `specs/permissions/`, 그리고 기존 구현 코드를
근거로 작업하고, CLAUDE.md의 Specification Gap Behavior에 따라 누락을 명시적으로
보고하세요 — 임의로 명세를 지어내지 마세요.

### 🏛 LEVEL 1: Product Constitution (`docs/constitution/`)
- `01-product-vision.md` — AGEX 비전 및 핵심 가치

### 🧩 LEVEL 3: Domain & Supplemental Specifications (`docs/supplemental/`)
- `S-04-model-gateway.md` — Model Gateway & Router Architecture
- `S-05-iam.md` — Identity & Access Management (IAM) 명세
- `S-06-billing-entitlement.md` — Billing & Entitlement Architecture
- `S-07-billing-ai-provider.md` — Billing & AI Provider Architecture (Managed AI/BYOK/Enterprise/Private Model, Credit Engine). **Phase 1(Managed AI Credit 과금)만 구현됨** — Phase 2~5(BYOK, Enterprise, Private Model, Settlement)는 문서 내 각 섹션에 [미구현]으로 표시.

### 미작성 (Not yet written)
다음 카테고리는 MASTER.md 로드맵상 존재할 예정이지만 아직 문서가 작성되지 않았습니다:
LEVEL 2 System Architecture (`docs/architecture/`), 나머지 LEVEL 3 Domain 문서
(`docs/domains/` — agent-framework, workflow-engine, knowledge-engine, memory-engine,
plugin-framework, marketplace, sdk, api-specification), LEVEL 3의 `S-01`~`S-03`,
LEVEL 4 Execution Planning (`docs/planning/`), LEVEL 5 Commercial (`docs/business/`),
LEVEL 6 Guides (`docs/guides/`). 작성이 필요해지면 이 섹션에서 옮겨 실제 항목으로 추가하세요.

---

## 3. 작업 영역별 필독 문서 매핑 (Quick Reference)

| 작업 영역 | 필독 권장 문서 목록 |
|---|---|
| **Model 연동 / 라우팅** | `S-04-model-gateway.md` |
| **보안 / IAM / 권한** | `S-05-iam.md`, `MASTER.md` |
| **Billing / Entitlement** | `S-06-billing-entitlement.md` |
| **Billing / AI Provider / Credit 과금** | `S-07-billing-ai-provider.md` |
| **그 외 모든 도메인** (에이전트, Runtime, 워크플로우, 플러그인 등) | 전용 도메인 문서가 아직 없으므로 `MASTER.md` + `specs/` + 기존 코드를 근거로 작업하고, 명세 갭을 명시적으로 보고 |
