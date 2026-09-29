# NAgex Execution & Cross-Platform Architecture

**Canonical Domain:** Execution / Device / Cross-platform / Messaging
**Status:** CANONICAL architecture; platform implementation maturity remains milestone-specific
**Date:** 2026-09-29

## 1. Core Principle

> **One Brain, Many Interfaces, Many Execution Planes.**

NAgex must separate:

```text
WHAT = Canonical Action
WHERE = Execution Environment / Target
HOW = Execution Route / Platform Executor
```

The same user intent and approval semantics should remain stable while the execution mechanism varies by environment.

## 2. Reasoning Plane vs Execution Plane

The Reasoning Plane may run on cloud or local model infrastructure and is responsible for interpretation, planning, drafting, summarization and policy-aware preparation.

The Execution Plane performs real actions and may be:

```text
SERVER
WEB
BROWSER
ANDROID
IOS
DESKTOP
EXTERNAL_API
```

A cloud model may reason about an action that ultimately executes on the user's phone. Reasoning location does not imply execution authority.

## 3. Canonical Action Layer

Canonical actions remain platform-neutral.

Examples:

```text
SEND_MESSAGE
SEND_EMAIL
CREATE_EVENT
BOOK_RESERVATION
START_NAVIGATION
OPEN_DOCUMENT
UPLOAD_FILE
CREATE_IMAGE
MAKE_PAYMENT
CREATE_TASK
```

Forbidden in canonical action definitions:

- Android `Intent` details;
- package names;
- accessibility nodes;
- ADB commands;
- DOM/CSS selectors;
- browser tab IDs;
- iOS AppIntent implementation details;
- UI coordinates.

Those belong only in platform executors.

## 4. Execution Planning

```text
Canonical Action
    ↓
Environment Resolver
    ↓
Capability Resolver
    ↓
Route Resolver
    ↓
Execution Plan
    ↓
Platform Executor
```

### Environment Resolver
Determines where the action should execute.

### Capability Resolver
Determines what is actually available now, including device state, installed app, connected provider, authentication/session, OS permissions, provider availability and user preference.

### Route Resolver
Selects the eligible mechanism without weakening trust constraints.

## 5. Execution Target

Conceptual target:

```text
environment
deviceId?
provider?
channel?
executionRoute
account/workspace?
```

The execution target is part of the approval-relevant context when it materially changes consequence or trust.

## 6. Approval Binding and Drift

Approval is bound to the material execution version.

Changes to any approval-relevant dimension can require reapproval, including:

- target/recipient;
- payload;
- environment;
- execution route;
- provider/account/workspace;
- price or transaction condition;
- material user-visible consequence.

```text
ENVIRONMENT_DRIFT → REAPPROVAL_REQUIRED
ROUTE_DRIFT       → REAPPROVAL_REQUIRED when material
ACCOUNT_DRIFT     → REAPPROVAL_REQUIRED
WORKSPACE_DRIFT   → REAPPROVAL_REQUIRED
```

Voice never bypasses approval.

## 7. Route Preference

Preferred execution order is capability- and policy-dependent, but generally favors the most direct governed integration:

```text
Official API
→ Deep Link / App Link
→ Authorized device/app execution
→ Browser automation
→ Human handoff
```

This is not a license for silent fallback. A fallback that changes material target, trust, account, provider, cost, or consequence must be surfaced and re-evaluated.

## 8. Human Handoff

Human handoff is a first-class truthful route, not fake automation.

If NAgex can prepare but cannot safely execute, it may return a handoff state with the exact next user action.

Handoff is not `COMPLETED`.

## 9. Platform Responsibilities

### Shared NAgex Brain

Shared cloud/runtime responsibilities include:

- identity;
- conversation;
- memory/personal context;
- research;
- creation runtime;
- model routing;
- planning;
- policy/approval;
- activity;
- artifact history;
- execution coordination.

### Device/App Layer

Clients primarily provide:

- UI;
- secure session/credential access;
- local permissions;
- notifications;
- voice;
- file/device integration;
- platform execution capabilities.

Do not duplicate the full NAgex brain independently in every client.

## 10. Web / Browser

Web provides the main Personal AI experience and server-connected capabilities.

Browser execution is a separate governed plane. Page content is untrusted and cannot become permission authority.

## 11. Windows Desktop

Desktop is valuable for:

- system tray;
- global shortcut/Quick Wake;
- voice;
- notifications;
- clipboard/files;
- drag-and-drop;
- deep links;
- local app launching;
- secure local storage;
- future local execution/indexing/model integration.

The cross-platform audit treats a thin desktop shell over shared web/product logic as preferable to a second independent product codebase.

## 12. Android

Android is the priority mobile execution plane for capabilities that benefit from:

- intents/deep links;
- installed-app routing;
- notification actions;
- contacts/calendar/device integration;
- voice;
- secure device identity;
- background/foreground service where justified.

Android-specific power must remain permission- and approval-controlled.

## 13. iOS

iOS should share product semantics while respecting platform constraints.

Potential integrations include Share Extension, App Intents, Siri-related capabilities, Universal Links, notifications, secure storage and supported background tasks.

Do not assume Android and iOS have identical execution capability.

## 14. Voice

Voice is an invocation modality, not a new authority model.

Canonical flow:

```text
Voice
→ Intent
→ Canonical Action
→ Policy / Approval
→ Execution Route
→ Verified Result
```

Approval semantics are modality-neutral.

## 15. Result Verification

An executor should return a structured, truthful result.

Provider acceptance, app opening, handoff initiation or UI navigation does not automatically prove the intended real-world outcome.

Where verification is possible, distinguish:

- accepted;
- executed;
- delivered/created;
- verified;
- failed;
- unavailable;
- handed off.

## 16. Activity / Transparency

Execution results map into user-facing Activity summaries while retaining deeper audit evidence.

The user sees human meaning first; technical traces remain drill-down material.

## 17. Cross-Platform Sync

Device continuity must use the canonical Personal Data & Sync architecture. Cross-device convenience cannot turn the server into an unnecessary plaintext warehouse.

## 18. Technology Choice

Framework selection for desktop/mobile is an implementation decision subordinate to these contracts.

The 2026-09-29 cross-platform audit evaluated Tauri 2, Electron, Capacitor, React Native, native Android/iOS and PWA. Its recommendations remain planning evidence, not a permanent requirement to use one framework regardless of future constraints.

## 19. Anti-Patterns

Prohibited:

- platform details inside canonical action types;
- separate business logic per client;
- silent route fallback;
- approval bypass through voice/device automation;
- treating app launch as successful execution;
- provider/account drift after approval;
- untrusted browser content becoming authority;
- device-specific UI deriving different semantic truth.

## 20. Invariants

```text
ONE_BRAIN = 1
CANONICAL_ACTION_IS_PLATFORM_NEUTRAL = 1
VOICE_APPROVAL_BYPASS = 0
SILENT_MATERIAL_FALLBACK = 0
HUMAN_HANDOFF_IS_NOT_COMPLETION = 1
EXECUTION_RESULT_MUST_BE_TRUTHFUL = 1
PLATFORM_EXECUTOR_CAN_BYPASS_POLICY = 0
```

## 21. Source Provenance

Consolidated from:

- `NAgex_Multi_Platform_Execution_Architecture_Development_Directive_20260928.md`
- `NAgex_Device_Control_Architecture_and_Product_Strategy_v1.md`
- `NAgex_R23_6M_Mobile_Voice_Action_MVP_and_Roadmap_20260927.md`
- `NAgex_Activity_and_Execution_Transparency_Amendment_v1.md`
- `NAgex_Cross_Platform_App_Architecture_Audit_20260929.md`
- messaging/Gmail execution audits where they validate the shared action/route model

Milestone-specific route support remains evidence/current-state material rather than a permanent architecture claim.
