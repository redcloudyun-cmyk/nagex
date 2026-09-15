# NAgex Device Control Architecture & Product Strategy v1

**Project:** NAgex  
**Purpose:** Device-control architecture decision, development guidance, and long-term product direction  
**Status:** Canonical design guidance for Device Control roadmap

---

# 1. Executive Decision

NAgex should **not** choose between:

```text
A. NAgex directly controlling desktop/mobile
B. Astra controlling desktop/mobile
```

as mutually exclusive alternatives.

The recommended architecture is:

```text
Structured execution first
→ NAgex-owned execution runtime
→ Visual model only where needed
```

Core rule:

```text
Model proposes.
NAgex governs.
NAgex executes.
NAgex verifies.
```

Astra or another visual model is a reasoning/observation provider, not the execution authority.

---

# 2. Execution Priority

NAgex should always choose the cheapest, fastest, and most deterministic control path first:

```text
1. API / native connector / MCP
2. Structured browser automation (DOM / Playwright)
3. OS accessibility automation
4. Visual AI reasoning (Astra or equivalent)
5. Human takeover where required
```

Visual AI is a fallback/augmentation layer, not the default for every action.

---

# 3. Direct NAgex Control vs Astra-Assisted Control

## 3.1 NAgex Direct Control

Typical architecture:

```text
NAgex Planner
→ Capability Broker
→ Local Device Agent / Browser Runtime
→ OS or application primitive
```

Examples:

```text
browser.navigate()
browser.click()
browser.type()
Windows UI Automation
Android Accessibility Service
ADB / Appium
```

### Advantages

```text
- deterministic
- low latency
- low marginal cost
- high auditability
- precise approval boundaries
- strong tenant/owner enforcement
- easy replay/reproduction
- provider independent
```

### Disadvantages

```text
- selector/UI changes can break automation
- adapters must be implemented per application/platform
- unknown UI states are harder
- canvas/remote-desktop/visual-only surfaces are difficult
```

---

## 3.2 Astra-Assisted Visual Control

Typical architecture:

```text
Screenshot + Structured Snapshot
→ Astra
→ one proposed action
→ NAgex policy / approval
→ NAgex executor
```

### Advantages

```text
- strong adaptation to changing UI
- usable where stable selectors are absent
- useful for native desktop apps
- useful for Canvas / Electron / VDI / legacy systems
- can interpret visual context and semantics
```

### Disadvantages

```text
- probabilistic
- slower than direct structured execution
- API cost per observation/reasoning step
- prompt-injection and visual-deception risk
- harder to reproduce exactly
- provider dependency if tightly coupled
```

---

# 4. Product Position

NAgex must not become:

```text
"an Astra remote-control wrapper"
```

NAgex should instead become:

```text
Any Model
Any Device
Any Application
```

NAgex owns:

```text
execution
policy
approval
identity
tenant isolation
device authorization
audit
recovery
verification
```

Visual-model providers supply:

```text
observation
reasoning
proposal
```

---

# 5. Provider-Neutral Architecture

Required abstraction:

```text
VisualExecutionModelPort
        |
        +-- FakeVisualExecutionModelAdapter
        +-- AstraVisualExecutionModelAdapter
        +-- GeminiVisualExecutionModelAdapter
        +-- ClaudeVisualExecutionModelAdapter
        +-- LocalVLMVisualExecutionModelAdapter
```

No provider may bypass:

```text
Capability Broker
DeviceExecutionSession
risk policy
approval
allowed-domain rules
allowed-action rules
tenant/owner boundary
post-action verification
```

---

# 6. Desktop Strategy

Desktop is a high-priority device-control target.

Recommended architecture:

```text
NAgex Cloud
    |
    | authenticated encrypted channel
    v
NAgex Local Device Agent
    |
    +-- Browser control
    +-- Windows UI Automation
    +-- Accessibility tree
    +-- Keyboard
    +-- Mouse
    +-- Clipboard
    +-- Screen capture
```

Visual model use:

```text
structured path succeeds
→ no visual model needed

structured path insufficient
→ screenshot / accessibility context
→ visual model proposal
→ NAgex execution
```

The Local Device Agent is a strategic NAgex asset and must remain provider-neutral.

---

# 7. Android Strategy

Android is technically feasible and strategically valuable.

Recommended bridge:

```text
NAgex Android Device Bridge
    |
    +-- Accessibility Service
    +-- Screen capture
    +-- Tap
    +-- Swipe
    +-- Type
    +-- Android Intent
    +-- App-state observation
```

Visual model can locate and interpret UI, but actual action execution must remain inside the NAgex bridge.

The critical product asset is not Astra itself; it is the secure Device Bridge.

---

# 8. iOS Strategy

iOS is more restricted.

Priority should be:

```text
App Intents
Shortcuts
URL schemes
Share extensions
supported system integrations
```

before attempting general-purpose visual device automation.

Do not promise Android-equivalent arbitrary cross-app control on iOS without explicit technical proof.

---

# 9. Cost / Performance Guidance

Recommended target distribution:

```text
70–80% structured/native execution
20–30% visual-model-assisted execution
```

This is a product-direction ratio, not a hard runtime quota.

Use visual reasoning only when it adds value.

Example:

```text
URL navigation
→ direct browser.navigate()

stable button
→ structured click

unknown legacy UI
→ visual reasoning

unstructured desktop dialog
→ visual reasoning + NAgex execution
```

---

# 10. Security Model

A visual model must never independently decide that an action is safe.

Model outputs such as:

```text
riskHint
confidence
reason
```

are advisory only.

NAgex remains authoritative for:

```text
READ_ONLY
LOW
CONSEQUENTIAL
RESTRICTED
approval required / conditional / none
```

Sensitive actions must fail closed.

---

# 11. Approval / High-Risk Actions

For actions such as:

```text
submit
send
reservation confirmation
purchase
payment
delete
account change
```

the flow must be:

```text
model proposal
→ NAgex risk classification
→ freeze exact action
→ human approval when required
→ execute exactly once
→ post-action observation
→ verify
```

No re-planning under an old approval.

---

# 12. Provider Failure Strategy

Provider unavailable:

```text
do not silently fake success
do not silently use test adapter
```

Preferred fallback order:

```text
structured execution
→ alternate configured visual provider
→ human takeover
```

Fake adapters are test-only.

---

# 13. Roadmap

Recommended sequence:

```text
DC0  Browser Ownership Isolation                 FROZEN
DC1  Device Control Foundation
DC2  Visual Model Adapter / Astra
DC3  Desktop Local Device Agent
DC4  Android Device Bridge
DC5  Reservation Execution
DC6  Payment Preparation / Execution
DC7  iOS Integration / Feasibility
```

Reservation/payment should not precede a robust device-control and approval layer.

---

# 14. Acceptance Principles

Every Device Control phase must preserve:

```text
bounded execution
tenant isolation
owner isolation
no secret leakage
explicit provider availability
no false LIVE state
auditability
post-action verification
safe restart behavior
human approval for consequential actions
```

---

# 15. Canonical Product Principle

The NAgex device-control layer should be designed around this permanent principle:

```text
Use structure when structure exists.
Use vision when structure is insufficient.
Keep execution authority inside NAgex.
```

This document should be treated as a standing architectural constraint for all future Device Control development.
