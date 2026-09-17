# NAGEX Reference-Guided Generation Principles

**Status:** MANDATORY PRODUCT / GENERATION PRINCIPLE  
**Purpose:** Define how NAGEX should use user-provided prompts, templates, examples, prior outputs, and other references without forcing users to become prompt engineers and without unnecessarily rewriting high-quality reference material.

---

## 1. Core Principle

NAGEX is Intent-first.

> The user should not have to learn how to prompt NAGEX. NAGEX should learn what the user means.

However, when the user already provides a high-quality prompt, template, prior output, example, style guide, document, image, or other useful reference, NAGEX should treat that reference as a valuable user asset rather than discarding it and generating a new structure from scratch.

Therefore NAGEX follows a dual interaction model:

```text
A. INTENT-FIRST MODE
User expresses the desired outcome
→ NAGEX clarifies only when necessary
→ NAGEX structures the task
→ NAGEX creates the execution specification

B. REFERENCE-GUIDED MODE
User provides a useful reference
→ NAGEX analyzes its structure and intent
→ preserves the parts that remain useful
→ changes only what the user asked to change
→ adjusts dependent elements only when necessary
→ creates the execution specification
```

These two modes are complementary, not contradictory.

---

## 2. Product Rule

> Users should never be required to write expert prompts.

But:

> When the user already has a good prompt or reference, NAGEX should not destroy or unnecessarily rewrite it.

The default behavior is:

```text
Preserve what already works.
Change what the user explicitly requested.
Adjust only what must change because of that request.
```

This principle applies beyond prompts.

References may include:

- text prompts
- image prompts
- video prompts
- generated images
- generated videos
- reports
- presentation decks
- document templates
- design references
- brand guides
- emails
- code
- development specifications
- workflows
- structured examples
- previous successful NAGEX results

---

## 3. Reference-Guided Generation

The broader product concept is **Reference-Guided Generation**.

A reference is not merely copied into a model prompt. NAGEX should first understand which elements of the reference are important and which elements the user intends to change.

Canonical flow:

```text
User Intent
   +
Reference Material
   +
Current Context / Constraints
        ↓
Reference Analysis
        ↓
Element Classification
        ↓
Preserve / Change / Dependent Change / Lock / Conflict
        ↓
Execution Specification
        ↓
Model / Tool / Agent Execution
        ↓
Result Validation
```

The original user reference remains distinct from the generated execution specification.

---

## 4. Five Reference Element States

Every meaningful reference element should conceptually fall into one of five states.

### 4.1 PRESERVE

Keep the original behavior, structure, style, or constraint because the user did not request a change and no conflict requires one.

Examples:

- camera movement
- document section order
- writing tone
- aspect ratio
- table structure
- report citation style
- slide visual hierarchy

### 4.2 CHANGE

Explicitly requested by the user.

Examples:

- subject
- location
- product name
- report topic
- dataset
- target audience
- presentation title

### 4.3 DEPENDENT CHANGE

The user did not explicitly request this element to change, but it must change to keep the result coherent or technically feasible.

Example:

```text
Original:
8-second video, one scene

User request:
Change to six distinct scenes

Dependent change candidate:
Duration or shot density may need adjustment
```

Dependent changes should be minimized and, when material, disclosed to the user.

### 4.4 LOCK

An element that must not be changed without explicit user authorization.

Possible locked elements:

- corporate brand rules
- legal disclaimer
- approved wording
- exact product name
- identity-sensitive description
- fixed output dimensions
- approved report structure
- user-designated style

### 4.5 CONFLICT

A reference element conflicts with the new request, another locked element, a technical constraint, policy, or factual requirement.

NAGEX must not silently ignore a conflict.

Depending on impact:

- resolve safely when low-impact and obvious
- disclose an assumption
- ask clarification
- block execution when the conflict cannot be resolved safely

---

## 5. Minimum Necessary Change Principle

NAGEX follows **Minimum Necessary Change**.

> Change only the elements explicitly requested by the user, plus the minimum set of dependent elements required to keep the result coherent, safe, and executable.

NAGEX must not perform broad prompt rewrites merely because a model could generate a stylistically different version.

This is especially important when a user says:

- "배경만 바꿔줘"
- "이 구조 그대로 내용만 교체해줘"
- "문체는 유지해줘"
- "이 보고서 형식으로 이번 데이터를 넣어줘"
- "카메라 움직임은 그대로 두고 인물만 바꿔줘"

Such requests imply a preservation boundary.

---

## 6. Prompt Preservation & Controlled Mutation

For prompt-based generation, NAGEX applies **Prompt Preservation & Controlled Mutation**.

A high-quality prompt should be decomposed conceptually into fields such as:

```text
Goal
Subject / Content
Style
Structure
Constraints
Format
Camera / Composition
Lighting
Movement
Tone / Voice
Length / Duration
Output Specification
Locked Elements
```

Example:

```text
User request:
"이 프롬프트에서 배경만 서울 야경으로 바꿔줘."

LOCK / PRESERVE:
- subject
- visual style
- camera movement
- duration
- aspect ratio
- composition

CHANGE:
- background → Seoul night skyline

DEPENDENT CHANGE:
- ambient lighting may need adjustment to remain coherent with the new night setting
```

NAGEX should not regenerate unrelated portions of the prompt without reason.

---

## 7. Image and Video Generation

Image/video generation is a primary use case because output quality often depends on a tightly coupled set of prompt elements.

Common reference dimensions include:

- subject
- environment
- composition
- camera angle
- lens
- depth of field
- camera movement
- lighting
- color treatment
- visual style
- motion
- duration
- frame rate
- aspect ratio
- shot sequence
- negative constraints

If the user changes only one dimension, NAGEX should preserve the others unless a conflict or dependent change exists.

Do not convert every edit request into a complete creative rewrite.

---

## 8. Reports and Documents

Reference-Guided Generation also applies to reports and documents.

Preservable elements may include:

- title hierarchy
- executive summary structure
- section order
- evidence presentation
- table format
- citation convention
- tone
- depth of analysis
- target length
- terminology

Example:

```text
Reference:
A previously approved market-analysis report

User request:
"이 형식으로 이번 분기 데이터를 사용해서 다시 만들어줘."

PRESERVE:
- report structure
- analysis depth
- table conventions
- tone
- evidence style

CHANGE:
- reporting period
- dataset
- findings
- conclusions derived from the new data
```

NAGEX must never preserve factual conclusions that are no longer supported by the new evidence merely for structural consistency.

---

## 9. Presentation Generation

For presentations, reference dimensions can include:

- slide sequence
- storytelling structure
- title pattern
- visual density
- chart style
- speaker-note style
- brand layout
- content depth

The reference deck should guide structure and style, while new facts and conclusions must be independently grounded in the new task context.

---

## 10. Coding and Development Specifications

This principle also applies to software-development work.

A validated development directive may preserve:

- architecture rules
- safety constraints
- testing requirements
- completion gates
- coding conventions
- reporting format

while changing:

- current feature scope
- target module
- acceptance criteria specific to the new task

NAGEX must not weaken governance or safety rules simply because a new task appears similar to an earlier one.

---

## 11. Original Reference vs Execution Specification

NAGEX must distinguish three concepts:

```text
A. USER INTENT
What the user wants to achieve

B. USER REFERENCE
Prompt / template / example / prior artifact supplied or selected by the user

C. NAGEX EXECUTION SPECIFICATION
The final structured instruction sent to the selected model/tool/agent
```

A and B are user-controlled inputs.

C is a NAGEX-generated execution artifact.

NAGEX must not overwrite B merely because C was generated.

Where persistence is implemented, the original reference and derived execution specification should remain distinguishable and auditable.

---

## 12. Conflict Resolution

When the user's requested change conflicts with the reference, use this order:

```text
1. User's explicit current instruction
2. User-designated locked elements
3. Safety / policy / legal constraints
4. Factual correctness
5. Technical feasibility
6. Reference preservation
7. Style optimization
```

If a conflict affects a consequential output, ask for clarification rather than silently choosing.

If a low-impact adjustment is obvious and reversible, NAGEX may proceed while disclosing the assumption where useful.

---

## 13. UX Transparency

When meaningful, NAGEX should show what was preserved and what changed.

Example:

```text
Using reference

Preserved
✓ Visual style
✓ Camera movement
✓ Lighting approach
✓ 16:9 aspect ratio

Changed
• Product: coffee → children's science kit
• Location: studio → outdoor park

Adjusted automatically
• Ambient lighting
  Reason: the new outdoor/night setting required a dependent adjustment
```

This transparency should be concise and progressively disclosed rather than shown for every trivial edit.

---

## 14. Relationship to Intent-First UX

This document extends, and does not replace, `NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md`.

Intent-first means users are not required to engineer prompts.

Reference-guided means NAGEX also recognizes when the user already has valuable structure and should preserve it.

Together:

```text
No useful reference exists
→ NAGEX helps structure the user's intent

Useful reference exists
→ NAGEX preserves useful structure and changes only what is necessary
```

---

## 15. Safety and Truthfulness Boundaries

Reference preservation never overrides:

- safety policy
- approval requirements
- Data Disclosure Gate
- privacy rules
- factual correctness
- provenance requirements
- model/tool capability limits
- external mutation authorization

A reference is guidance, not authority over NAGEX security policy.

NAGEX must never preserve:

- false facts known to be false
- stale factual conclusions when new evidence contradicts them
- unsafe instructions that violate policy
- hidden credentials or secrets in remote-model prompts
- obsolete external action parameters after the user has changed the target action

---

## 16. Reference Provenance

When practical, NAGEX should know where a reference came from:

- uploaded by user
- pasted by user
- previous NAGEX result
- user-selected prior artifact
- workspace document
- approved organization template

Reference provenance should not be fabricated.

A user-provided reference must not automatically become a permanent memory unless the applicable Memory policy authorizes it.

---

## 17. Default Decision Policy

```text
IF no reference exists:
    use Intent-first generation

IF a useful reference exists:
    analyze reference
    identify requested changes
    preserve untouched useful elements
    identify dependent changes
    detect conflicts
    respect locked elements
    generate execution specification

IF critical conflict remains unresolved:
    ask clarification

IF consequential external action follows:
    require canonical approval independently of reference acceptance
```

Reference acceptance is not action approval.

---

## 18. Product Design Requirements

Future NAGEX implementations of this capability should support:

- explicit reference selection
- reference preview
- preserve/change/lock semantics
- user correction of inferred changes
- versioned derived execution specs where useful
- comparison between original and derived prompt/spec
- reference reuse across image/video/report/presentation/coding tasks
- mobile-safe review
- KR/EN UX

Do not expose internal complexity unless it benefits the user.

---

## 19. Testing Requirements

When implemented, add tests proving at minimum:

1. a user-requested single-field change does not rewrite unrelated locked fields
2. locked fields cannot be silently modified
3. dependent changes are limited to necessary elements
4. critical conflicts trigger clarification
5. original reference is retained separately from the execution specification
6. stale facts are not preserved merely for structural consistency
7. reference acceptance does not authorize external mutation
8. approval remains canonical for consequential actions
9. EN/KR presentation strings resolve
10. no false success is shown before actual generation/execution succeeds

---

## 20. Canonical Product Statement

> NAGEX does not make users learn prompt engineering.
>
> When users already possess a high-quality prompt, template, example, or prior artifact, NAGEX treats it as a valuable reference, preserves what works, changes only what is necessary, and independently constructs the safest and most effective execution specification.

Short form:

> **Preserve what works. Change only what matters.**
