# NAgex Cross-Platform App Architecture Audit

**Date:** 2026-09-29\
**Mode:** ARCHITECTURE / FEASIBILITY AUDIT ONLY\
**Status:** Planning Directive\
**Purpose:** Determine the production architecture for NAgex Web /
Windows / Android / iOS without implementing platform apps yet.

------------------------------------------------------------------------

## 1. Objective

Determine the production architecture for delivering NAgex as:

-   NAgex Web
-   NAgex Windows Desktop
-   NAgex Android
-   NAgex iOS

while preserving one shared NAgex brain and avoiding four separate
products/codebases.

Target architecture:

``` text
ONE NAGEX BRAIN
      │
      ├── Web
      ├── Windows
      ├── Android
      └── iOS
```

with environment-specific execution capabilities.

------------------------------------------------------------------------

## 2. Product Architecture Principle

NAgex should follow:

``` text
One Brain
Many Interfaces
Many Execution Planes
```

Conceptually:

``` text
                    NAgex Cloud Brain
                           │
          ┌────────────────┼────────────────┐
          │                │                │
         Web            Desktop           Mobile
          │                │                │
      Browser EP       Desktop EP       Mobile EP
```

Shared cloud responsibilities should include:

-   Identity
-   Conversation
-   Memory
-   Personal Context
-   Research
-   Creation Runtime
-   Model Routing
-   Planning
-   Policy
-   Approval
-   Activity
-   Artifact History
-   Execution Coordination

Device apps should primarily provide:

-   UI
-   Device integration
-   Secure credentials/session
-   Local permissions
-   Notifications
-   Voice
-   File access
-   Execution-plane capabilities

Do not duplicate the NAgex brain into every client.

------------------------------------------------------------------------

## 3. Current Repository Audit

Inspect the actual NAgex repository before recommending technology.

Baseline repository:

``` text
Branch:
r23.6m-mobile-voice-action

Current accepted baseline commit:
eacd46e73b3641310568c78c6a2466920a794cc8
```

Verify before audit.

Inspect:

``` text
public/
src/
package.json
tsconfig*
build scripts
server architecture
frontend architecture
mobile-specific UI
desktop-specific UI
voice implementation
execution-plane code
authentication/session code
API client patterns
file upload
browser runtime
notification-related code
```

Determine how much of the current frontend can realistically be reused.

------------------------------------------------------------------------

## 4. Evaluate Candidate Technologies

Evaluate at minimum:

-   Tauri 2
-   Electron
-   Capacitor
-   React Native
-   Native Android
-   Native iOS
-   PWA

Do not pick a technology based on popularity. Evaluate against NAgex
requirements.

------------------------------------------------------------------------

## 5. Windows Desktop Requirements

NAgex Desktop may eventually require:

-   System tray
-   Global shortcut
-   Voice activation
-   Microphone
-   Notifications
-   Clipboard
-   File selection
-   File system access
-   Drag & drop
-   Deep links
-   Browser launching
-   App launching
-   Local execution
-   Background process
-   Auto-start
-   Secure token storage
-   Updater
-   OS integration

Future possibilities:

-   Browser control
-   Local application automation
-   Office integration
-   Screen context
-   Local LLM connector
-   Local file indexing

Some capabilities require explicit user permissions and must remain
security-controlled.

Determine which candidate framework best supports this architecture.

------------------------------------------------------------------------

## 6. Mobile Requirements

Android/iOS NAgex should eventually support:

-   Voice input
-   Microphone
-   Camera
-   Photos
-   Files
-   Notifications
-   Share Sheet
-   Deep Links
-   App Links
-   Biometric authentication
-   Secure credential storage
-   Background tasks
-   Location with explicit permission
-   Calendar integration
-   Contacts integration

Potential Android-specific capabilities:

-   Intent system
-   Installed-app deep links
-   Foreground service where justified
-   Notification actions

Potential iOS-specific capabilities:

-   Share Extension
-   App Intents
-   Siri integration where available
-   Background task limitations
-   Universal Links

Audit feasibility separately. Do not assume Android and iOS allow
identical execution behavior.

------------------------------------------------------------------------

## 7. Execution Plane Architecture

Design how device execution should connect to the existing NAgex
canonical execution architecture.

``` text
Canonical Action
      │
      ↓
Execution Route Resolver
      │
 ┌────┼───────────────┐
 │    │               │
SERVER DESKTOP       MOBILE
 │    │               │
API  Native EP       Native EP
```

Examples:

``` text
SEND_EMAIL
→ SERVER
→ Gmail API

OPEN_FILE
→ DESKTOP
→ Windows native execution

SHARE_ARTIFACT
→ MOBILE
→ OS Share Sheet

OPEN_APP
→ MOBILE
→ Deep Link / App Link
```

Do not create unrelated action semantics per platform.

------------------------------------------------------------------------

## 8. Approval Boundary

Preserve NAgex Human Approval principles.

Native apps must NEVER become approval bypasses.

Required concept:

``` text
Intent
→ Plan
→ Policy
→ Approval if required
→ Environment selection
→ Execution
→ Evidence
→ Activity
```

Switching execution environment after approval must be evaluated for
reapproval.

Example:

``` text
Approved:
SEND via SERVER/GMAIL_API

Changed to:
DESKTOP/browser automation
```

must not silently execute under the old approval.

------------------------------------------------------------------------

## 9. UI Reuse Audit

Determine how much of the current NAgex UI can be shared.

Evaluate:

-   Current HTML/CSS/JS
-   Responsive Home
-   PersonalHomeResponse
-   shared view model
-   desktop-specific presentation
-   mobile-specific presentation

Determine whether the project should:

A. Wrap current web UI\
B. Gradually migrate to a shared component framework\
C. Create native UI\
D. Use a hybrid strategy

Provide migration cost and risk.

Do not recommend a full rewrite unless justified.

------------------------------------------------------------------------

## 10. Tauri 2 Evaluation

Specifically evaluate Tauri 2 for Windows Desktop.

Consider:

-   installer size
-   runtime size
-   memory
-   startup
-   system tray
-   global shortcuts
-   filesystem
-   notifications
-   secure storage
-   deep links
-   background execution
-   auto update
-   Rust boundary
-   WebView2 dependency
-   Windows compatibility
-   code signing

Determine whether Tauri is appropriate for NAgex Desktop.

------------------------------------------------------------------------

## 11. Electron Evaluation

Evaluate Electron as the alternative.

Consider:

-   Chromium bundling
-   Node runtime
-   package size
-   memory
-   ecosystem
-   native modules
-   browser automation
-   developer velocity
-   updater maturity
-   cross-platform desktop

Explicitly compare it with Tauri.

------------------------------------------------------------------------

## 12. Mobile Technology Evaluation

Compare:

-   Capacitor
-   React Native
-   Native Kotlin
-   Native Swift

Evaluate:

-   existing web reuse
-   native APIs
-   background tasks
-   voice
-   camera
-   notifications
-   share extensions
-   deep links
-   biometrics
-   performance
-   maintenance
-   developer complexity
-   plugin maturity
-   long-term flexibility

------------------------------------------------------------------------

## 13. Consider Mixed Architecture

Do NOT assume one framework must serve every platform.

Evaluate architectures such as:

``` text
Web       → current web stack
Windows   → Tauri
Android   → Capacitor
iOS       → Capacitor
```

versus:

``` text
Web       → Web
Desktop   → Tauri
Mobile    → React Native
```

versus:

``` text
Web       → Web
Desktop   → Electron
Mobile    → Native
```

Determine which is most appropriate for NAgex.

------------------------------------------------------------------------

## 14. App Size Estimate

Estimate realistic production package sizes.

Separate:

-   download/package size
-   installed size
-   runtime cache
-   user-generated data
-   optional AI assets

Estimate for:

-   Windows
-   Android
-   iOS

Do not claim exact sizes before real builds exist.

Provide:

-   Best case
-   Expected
-   Upper reasonable bound

------------------------------------------------------------------------

## 15. Local AI Strategy

NAgex should initially remain cloud-brain-first.

Evaluate optional future modules:

-   On-device STT
-   Wake-word engine
-   Small local model
-   Local embeddings
-   Local file index
-   Local OCR
-   Local vision

These should preferably be optional downloads where technically
possible.

Avoid making the base application several GB.

Propose:

``` text
Base NAgex
+
Optional Local AI Pack
```

if appropriate.

------------------------------------------------------------------------

## 16. Update Architecture

Evaluate update strategy for:

### Windows

-   signed installer
-   auto updater
-   rollback
-   release channels

### Mobile

-   App Store
-   Google Play
-   server-side feature compatibility
-   minimum supported version

------------------------------------------------------------------------

## 17. Security Architecture

Audit:

-   session/token storage
-   device identity
-   refresh tokens
-   OAuth
-   biometrics
-   local encrypted storage
-   filesystem permission
-   microphone permission
-   camera permission
-   location permission
-   execution permission
-   device revocation
-   remote logout
-   lost device

Never store raw provider secrets unnecessarily on clients.

Prefer scoped credentials/references.

------------------------------------------------------------------------

## 18. Desktop Local Execution Security

Desktop execution introduces a major trust boundary.

Propose controls such as:

-   Explicit device registration
-   Device key
-   Capability declaration
-   Permission grant
-   Action approval
-   Execution binding
-   Evidence
-   Audit
-   Revocation

A compromised web session must not automatically imply unrestricted
local PC execution.

------------------------------------------------------------------------

## 19. Offline Behavior

Define realistic offline behavior.

Possible offline capabilities:

-   view cached conversations
-   view cached artifacts
-   draft prompt
-   local notes
-   limited file browsing

Do not claim full AI functionality offline unless a local model exists.

------------------------------------------------------------------------

## 20. Synchronization

Audit requirements for:

-   conversation sync
-   artifact sync
-   approval sync
-   activity sync
-   memory sync
-   device state
-   notification state

Cloud should remain canonical unless there is a strong reason otherwise.

------------------------------------------------------------------------

## 21. Notifications

Design provider-neutral notification architecture.

Examples:

-   Task finished
-   Research complete
-   Report ready
-   Approval required
-   Scheduled task result
-   Execution failed

Possible delivery:

-   Web Push
-   Windows notification
-   FCM
-   APNs

The notification itself should not become the canonical state.

------------------------------------------------------------------------

## 22. Voice Architecture

Audit how current NAgex voice foundation can map to:

-   Web
-   Desktop
-   Android
-   iOS

Separate:

-   Push-to-talk
-   Wake word
-   Speech-to-text
-   Text-to-speech
-   Voice command
-   Voice confirmation

Voice must not bypass approval.

------------------------------------------------------------------------

## 23. Background Agent

Determine what "NAgex running in the background" realistically means per
platform.

### Windows

Potentially substantial background execution.

### Android

OS-controlled background limits.

### iOS

Strict background execution restrictions.

Do not design iOS as if it were an unrestricted daemon.

Document the differences clearly.

------------------------------------------------------------------------

## 24. Recommended Architecture

Produce a concrete recommended architecture.

Example only:

``` text
                 NAgex Cloud
                     │
       ┌─────────────┼─────────────┐
       │             │             │
      Web         Desktop        Mobile
       │             │             │
 Browser UI      Tauri UI      Mobile UI
                     │
              Desktop Executor
```

Choose based on audit evidence.

------------------------------------------------------------------------

## 25. Shared Code Strategy

Recommend what should be shared:

-   API contracts
-   types
-   i18n
-   PersonalHomeResponse
-   action semantics
-   approval semantics
-   artifact semantics
-   design tokens
-   validation

and what should remain platform-specific:

-   native permissions
-   secure storage
-   notifications
-   deep links
-   device execution
-   background runtime
-   OS integrations

------------------------------------------------------------------------

## 26. Repository Strategy

Recommend whether to use a monorepo and a structure conceptually similar
to:

``` text
apps/
  web/
  desktop/
  mobile/

packages/
  contracts/
  api-client/
  design-system/
  i18n/
  execution-contract/
```

Do NOT restructure the repository during this audit.

------------------------------------------------------------------------

## 27. Development Sequence

Recommend a staged rollout.

Evaluate something similar to:

``` text
Phase A
Architecture + shared contracts

Phase B
Windows Desktop MVP

Phase C
Android MVP

Phase D
iOS MVP

Phase E
Native execution expansion
```

Determine whether Windows should actually come first.

Consider NAgex's Personal AI / Agent execution requirements.

------------------------------------------------------------------------

## 28. MVP Definition

Define what the first Windows/Desktop MVP should include.

Potential minimum:

-   Sign in
-   Home
-   Conversation
-   Research
-   Analyze
-   Artifacts
-   Approvals
-   Activity
-   Notifications
-   File upload
-   Voice input
-   System tray
-   Deep links

Do NOT include every future local automation capability in MVP.

Also define Android/iOS MVP separately.

------------------------------------------------------------------------

## 29. Size Budget

Propose explicit budgets.

Example targets:

``` text
Windows base installed:
< 200 MB preferred

Android base download:
< 80 MB preferred

iOS base download:
< 100 MB preferred
```

These are targets, not facts.

Determine realistic targets from the chosen architecture.

------------------------------------------------------------------------

## 30. Performance Budget

Recommend measurable targets for:

-   cold launch
-   warm launch
-   idle memory
-   Home first meaningful paint
-   API reconnect
-   notification-to-open

Do not invent benchmark results.

Set future certification targets.

------------------------------------------------------------------------

## 31. Final Decision Matrix

Provide a matrix:

  Area              Option A    Option B       Option C   Recommended
  ----------------- ----------- -------------- ---------- -------------
  Windows           Tauri       Electron       PWA
  Android           Capacitor   React Native   Native
  iOS               Capacitor   React Native   Native
  Shared UI
  Execution Plane
  Update

Include rationale.

------------------------------------------------------------------------

## 32. Required Output Document

Create:

``` text
docs/NAgex_Cross_Platform_App_Architecture_Audit_20260929.md
```

Required sections:

1.  Executive Summary
2.  Current NAgex Architecture
3.  Product Requirements
4.  Web Reuse Assessment
5.  Windows Requirements
6.  Mobile Requirements
7.  Tauri Evaluation
8.  Electron Evaluation
9.  Capacitor Evaluation
10. React Native Evaluation
11. Native Evaluation
12. Execution Plane Architecture
13. Approval & Trust Boundary
14. Security Architecture
15. Voice
16. Notifications
17. Background Execution
18. Storage & Synchronization
19. Local AI Strategy
20. App Size Estimates
21. Performance Budgets
22. Shared Code Strategy
23. Repository Strategy
24. Technology Decision Matrix
25. Recommended Architecture
26. MVP Definitions
27. Development Sequence
28. Risks
29. Final Recommendation

------------------------------------------------------------------------

## 33. Safety

AUDIT ONLY.

Do NOT:

-   create Tauri app
-   create Electron app
-   create React Native app
-   create Capacitor app
-   modify package.json
-   install dependencies
-   modify runtime code
-   modify current UI
-   commit
-   push

Allowed new file only:

``` text
docs/NAgex_Cross_Platform_App_Architecture_Audit_20260929.md
```

Preserve all existing unrelated working-tree changes.

------------------------------------------------------------------------

## 34. Final Report

Return:

``` text
CROSS-PLATFORM AUDIT = COMPLETE / INCOMPLETE
RUNTIME CODE MUTATED = YES / NO
```

Then:

``` text
Recommended Windows stack:
Recommended Android stack:
Recommended iOS stack:

Shared UI strategy:
Execution Plane strategy:
Local AI strategy:
```

Provide estimated:

``` text
Windows package / installed size:
Android download / installed size:
iOS download / installed size:
```

Use ranges, not false precision.

Then:

``` text
Recommended first platform:
Recommended MVP:
Recommended implementation sequence:
```

Finally return:

``` text
git status --short
```

and STOP.

Do not start implementation.

------------------------------------------------------------------------

## Decision Principle

The audit must not reduce the decision to "which framework gives the
highest code reuse."

NAgex is intended to become a Personal AI capable of acting through the
user's devices. Therefore platform architecture must be evaluated
against:

1.  secure local execution,
2.  OS integration,
3.  user approval and trust,
4.  background behavior,
5.  maintainability,
6.  package/resource efficiency,
7.  UI/code reuse.

The likely starting hypothesis is:

``` text
Web       → Existing NAgex Web architecture
Windows   → Tauri 2 candidate
Android   → Capacitor vs React Native audit
iOS       → Capacitor vs React Native audit
Cloud     → Canonical NAgex Brain
```

This is a hypothesis only. The audit must confirm or reject it using
repository evidence and platform constraints.
