# NAgex Trust & Safety Layer — Development Directive

**Document type:** Canonical development directive  
**Product:** NAgex Personal AI  
**Architecture:** NAgex Personal AI Operating System  
**Status:** Required P0 architecture layer  
**Implementation timing:** Immediately after Phase 1 Freeze and **before Capability Broker expansion / new consequential capabilities**  
**Core principle:** **Safety is an execution boundary, not merely a content filter.**

---

## 1. Purpose

NAgex is not only a conversational model. It can understand user intent, retain context, generate Candidates, request approvals, and execute actions through tools and connected services.

Therefore NAgex must apply its own product-level Trust & Safety policy independently of the safety behavior of any underlying model provider.

The safety architecture must govern:

1. what NAgex may answer,
2. what NAgex may recommend,
3. what NAgex may plan,
4. what NAgex may execute,
5. when NAgex must require human approval,
6. when NAgex must refuse,
7. when repeated abuse may restrict service,
8. how severe imminent-harm cases are escalated,
9. what is recorded for audit,
10. what must **not** be automatically reported to external authorities.

---

## 2. Canonical Principles

### 2.1 NAgex policy is the top-level policy

Underlying providers may have different safety standards.

```text
NAgex Trust & Safety Policy
        ↓
Intent / Context / Risk Decision
        ↓
Planner / Model Router
        ↓
OpenAI / Gemini / Nebius / Local Models
        ↓
Capability Broker
        ↓
Approval / Tool / Execution
```

NAgex must not assume a request is safe merely because the selected LLM answers it.

NAgex must not assume an action is safe merely because a Tool or MCP provider allows it.

---

### 2.2 Safety policy applies twice

NAgex must evaluate safety at both:

```text
1. Intent / planning time
2. Immediately before consequential execution
```

A safe-looking conversation can become unsafe when converted into an action.

Example:

```text
User asks about persuasive writing
→ allowed

User then asks NAgex to send targeted threats to 500 recipients
→ external execution blocked
```

---

### 2.3 Topic is not intent

NAgex must distinguish discussion, education, journalism, research, fiction, defense, and prevention from operational harmful intent.

Examples that may be allowed:

- history of terrorism,
- academic analysis of racism,
- malware detection,
- defensive penetration testing in an authorized environment,
- crime fiction,
- discussion of violent events,
- bias research.

Examples that may require restriction or refusal:

- operational instructions to commit serious wrongdoing,
- targeted violent threats,
- phishing or credential theft,
- malicious intrusion,
- evasion designed to enable serious harm,
- targeted hateful harassment,
- exploitation of minors,
- non-consensual privacy invasion.

Safety must not become blanket topic censorship.

---

## 3. Risk Levels

Use a canonical risk classification:

```text
R0 — NORMAL
R1 — SENSITIVE
R2 — RESTRICTED
R3 — PROHIBITED
R4 — CRITICAL
```

### R0 — NORMAL

Normal lawful use.

Examples:

- writing,
- planning,
- summarization,
- coding,
- scheduling,
- research,
- ordinary browsing.

Default:

```text
response = NORMAL
planning = allowed
execution = allowed subject to ordinary approval policy
```

---

### R1 — SENSITIVE

Sensitive or controversial subject matter without clear harmful intent.

Examples:

- political controversy,
- race/religion/gender discussions,
- graphic historical events,
- high-level cybersecurity concepts,
- addiction or self-harm discussion without action intent.

Default:

```text
response = allowed with context
planning = allowed
execution = limited by action-specific policy
```

Do not punish a user merely for discussing a sensitive topic.

---

### R2 — RESTRICTED

Requests that have meaningful misuse potential or elevated harm risk.

Examples:

- dual-use technical guidance that becomes operationally risky,
- invasive personal-data requests,
- targeted manipulation,
- instructions that materially increase harmful capability,
- risky financial/medical/legal actions where automation would be inappropriate.

Default:

```text
response = limited / safe completion
planning = constrained
consequential execution = blocked or requires stricter policy
```

---

### R3 — PROHIBITED

Requests whose purpose is clearly to facilitate serious wrongdoing or targeted harm.

Examples:

- operational serious crime assistance,
- targeted violence,
- phishing/credential theft,
- malicious cyber intrusion,
- fraud,
- exploitation or sexual abuse of minors,
- targeted hateful abuse or dehumanizing propaganda,
- non-consensual stalking/surveillance,
- weaponization for harmful use.

Default:

```text
response = REFUSE or SAFE_COMPLETION
planning = blocked
execution = blocked
```

---

### R4 — CRITICAL

Credible indication of imminent serious physical harm.

Risk indicators may include combinations of:

- specific target,
- specific plan,
- specific time or imminence,
- stated access to means,
- stated intent to carry out serious physical harm.

Default:

```text
response = CRISIS / SAFETY MODE
planning = blocked
execution = blocked
high-severity safety event = created
human review / escalation = eligible
```

R4 must have a very high threshold.

A single angry sentence must not automatically become R4.

---

## 4. Safety Decision Model

Recommended canonical result:

```ts
type SafetyRiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

type SafetyResponseMode =
  | 'NORMAL'
  | 'LIMITED'
  | 'SAFE_COMPLETION'
  | 'REFUSE'
  | 'CRISIS';

interface SafetyDecision {
  decisionId: string;

  riskLevel: SafetyRiskLevel;

  categories: string[];

  responseMode: SafetyResponseMode;

  responseAllowed: boolean;
  planningAllowed: boolean;
  executionAllowed: boolean;

  requiresActionApproval: boolean;
  requiresHumanReview: boolean;

  enforcementRecommendation?:
    | 'NONE'
    | 'WARN'
    | 'RESTRICT_CAPABILITY'
    | 'TEMPORARY_SUSPENSION_REVIEW'
    | 'ACCOUNT_REVIEW';

  reasonCodes: string[];

  policyVersion: string;

  createdAt: string;
}
```

Do not expose raw internal reasoning to the user.

Expose concise user-safe explanations.

---

## 5. Policy Categories

NAgex should support explicit categories at minimum.

### 5.1 Violence and serious physical harm

Restrict operational assistance that materially facilitates serious physical harm.

Allow contextual, historical, fictional, journalistic, preventive, or protective discussion where appropriate.

---

### 5.2 Serious criminal facilitation

Block operational assistance intended to carry out serious wrongdoing.

Examples include fraud, coercion, kidnapping, extortion, trafficking, or evasion supporting serious harm.

---

### 5.3 Cyber abuse

Distinguish:

```text
authorized defensive/security work
vs
malicious intrusion or credential theft
```

Safe defensive work can remain available.

Consequential attack actions must be blocked.

---

### 5.4 Hate and targeted harassment

Allow analysis of discrimination and hateful ideology.

Block assistance whose purpose is targeted dehumanization, intimidation, or harmful discriminatory abuse.

Protected characteristics must never be used by NAgex to justify inferior treatment.

---

### 5.5 Sexual exploitation and minors

Apply strict blocking for sexual exploitation, grooming, abuse, or sexual content involving minors.

No execution capability may facilitate such conduct.

---

### 5.6 Privacy, stalking, surveillance and identity abuse

Block unsafe assistance involving:

- credential theft,
- doxxing,
- non-consensual tracking,
- stalking,
- unauthorized account access,
- invasive sensitive-person profiling.

Legitimate contact lookup and user-owned data access remain distinct.

---

### 5.7 Self-harm and crisis

Do not assist in optimizing or executing self-harm.

Use supportive, safety-oriented behavior.

Do not automatically notify police or third parties solely based on self-harm language.

Any external escalation policy must be separately governed by law, product policy, geography, human review, and explicit operational controls.

---

### 5.8 High-risk decisions

NAgex should not autonomously make consequential determinations in areas such as:

- employment,
- housing,
- lending,
- insurance,
- education access,
- healthcare eligibility,
- criminal justice,
- legal rights,

when the decision depends on sensitive traits or when human review is legally or ethically necessary.

NAgex may assist with analysis, drafting, organization, and explanation without becoming the final autonomous decision maker.

---

## 6. Action Safety Policy

This is mandatory because NAgex can act.

The action pipeline must become:

```text
User Intent
    ↓
Intent Risk Evaluation
    ↓
Planner
    ↓
Capability Broker
    ↓
Pre-Execution Safety Check
    ↓
Action Approval Policy
    ↓
Tool / Provider
    ↓
Execution
    ↓
Audit / Activity
```

### Hard rule

No Tool, Skill, Plugin, MCP server, Browser Agent, Calendar integration, Gmail integration, local runtime, or future Computer Use implementation may bypass the pre-execution safety gate.

---

## 7. Response Safety vs Action Safety

These must be separate.

Example:

```text
"How does phishing work?"
```

A high-level educational explanation may be allowed.

But:

```text
"Send this credential-stealing page to these employees."
```

must be blocked at the action layer even if the underlying email tool could technically send it.

---

## 8. Safety Enforcement

Recommended enforcement ladder:

```text
E0 — refusal only
E1 — warning
E2 — risky capability restriction
E3 — temporary account restriction pending review
E4 — account suspension / trust & safety review
```

### Rules

- A single ambiguous request should not automatically suspend an account.
- Sensitive-topic research should not count as abuse by itself.
- Repeated clear attempts to bypass safety controls may increase enforcement severity.
- Enforcement must use durable evidence and policy reason codes.
- Account-level enforcement should be reviewable.
- Severe actions should support an appeal/review process.

---

## 9. Law-Enforcement / External Reporting Policy

### 9.1 Default rule

**NAgex must not automatically report users to police, courts, employers, schools, family members, or other external parties simply because an LLM classified a conversation as dangerous.**

Do not implement:

```text
risk classifier
→ direct police API
```

Do not implement automatic reporting based solely on:

- discussing a crime,
- disturbing fiction,
- controversial politics,
- anger,
- hate-topic analysis,
- self-harm discussion,
- cybersecurity research.

---

### 9.2 Exceptional escalation

A separate high-severity escalation process may be designed only for cases meeting a very high imminent-harm threshold.

Recommended flow:

```text
R4 detection
→ block NAgex execution
→ create High-Severity Safety Event
→ human safety review
→ legal / policy review where required
→ emergency response only if authorized and justified
```

External disclosure must depend on applicable law and formal product/legal policy.

The AI classifier itself must not be the final authority.

---

### 9.3 Legal requests

NAgex infrastructure should be designed so that any response to government/law-enforcement requests follows:

- applicable law,
- valid legal process,
- jurisdiction-specific requirements,
- internal authorization,
- minimum-necessary disclosure,
- audit logging.

Do not build general-purpose surveillance functionality.

---

## 10. Privacy Principles for Safety Systems

Safety monitoring itself creates privacy risk.

Therefore:

- collect the minimum data necessary,
- do not send full user memory to every safety provider,
- keep safety context task-scoped,
- avoid unnecessary retention of sensitive content,
- encrypt durable safety-event records,
- enforce tenant/principal isolation,
- restrict access to high-severity review data,
- record reviewer access,
- never expose another user's safety event.

---

## 11. Model Independence

NAgex may use multiple LLM providers.

Safety decisions must not be delegated entirely to one model.

Recommended layered approach:

```text
deterministic policy rules
+ structured safety classifier
+ context-aware model assessment
+ action-specific policy
+ human review for exceptional cases
```

No single model response should be sufficient to trigger irreversible account punishment or external reporting.

---

## 12. Fail-Closed Behavior

If the safety subsystem is required for a consequential action and is unavailable:

```text
unknown safety state
≠ allowed
```

Required behavior:

```text
consequential execution
→ blocked / retryable safety-service failure
```

Read-only low-risk behavior may degrade according to explicit policy.

Never bypass safety because the classifier timed out.

---

## 13. Audit Model

Recommended technical events:

```text
safety.intent.evaluated
safety.action.evaluated
safety.action.blocked
safety.safe_completion
safety.human_review.requested
safety.enforcement.warning
safety.enforcement.restricted
safety.high_severity_event.created
safety.high_severity_event.reviewed
```

Audit fields:

```text
decisionId
tenantId
principalId
requestId
candidateId?
executionId?
riskLevel
categories
reasonCodes
policyVersion
actionTaken
timestamp
```

Do not log secrets.

Do not expose internal classifier prompts or chain-of-thought.

---

## 14. User Experience

Safety UX must be calm and specific.

Avoid accusatory copy such as:

```text
"You are a criminal."
```

Prefer:

```text
"I can't help carry out that action."
```

or:

```text
"I can help with prevention, safety, or a lawful alternative."
```

For restricted actions, explain what can still be done safely.

---

## 15. Candidate / Review Integration

Candidate generation must respect the safety decision.

Rules:

```text
R0/R1
→ Candidate may be proposed normally

R2
→ Candidate may be suppressed, limited, or marked non-executable

R3
→ harmful Candidate must not be created for execution

R4
→ no consequential Candidate / Plan / Tool execution
```

A user accepting a Candidate must never override a hard safety block.

---

## 16. Capability Broker Integration

The Capability Broker must receive a safety decision/context.

Provider resolution occurs only after policy allows the capability.

```text
Intent
→ Safety
→ Capability Resolution
```

not:

```text
Intent
→ provider selected
→ action attempted
→ safety checked afterward
```

Every provider adapter must inherit the same NAgex policy.

---

## 17. Action Approval Integration

Human action approval is not a replacement for safety.

```text
Safety block
≠ user can override by pressing Approve
```

The hierarchy is:

```text
Safety Policy
        ↓
Action allowed?
        ↓
Approval Policy
        ↓
User Approval
        ↓
Execution
```

A prohibited action cannot become executable simply because the user approves it.

---

## 18. Initial Implementation Components

Recommended implementation:

```text
src/safety/
  safety.types.ts
  safety-policy.ts
  safety-classifier.ts
  safety-engine.ts
  action-safety-policy.ts
  enforcement.service.ts
  safety-event.store.ts
```

Potential server/API surfaces:

```text
POST /api/v1/safety/evaluate        // internal/admin only unless specifically needed
GET  /api/v1/safety/policy-version  // optional
```

Do not expose a public endpoint that becomes an abuse-policy probing oracle unless necessary.

---

## 19. SafetyEngine Responsibilities

Suggested API:

```ts
evaluateIntent(context): Promise<SafetyDecision>

evaluateAction({
  intentDecision,
  capabilityId,
  candidate,
  plan,
  toolArguments
}): Promise<SafetyDecision>
```

The engine must be side-effect free except for explicit audit/event recording.

It must not execute tools.

---

## 20. Deterministic Rules vs Model Classifier

### Deterministic rules

Use for:

- explicit blocked capability classes,
- known policy invariants,
- authorization/tenant boundaries,
- hard execution restrictions.

### Model/classifier

Use for:

- contextual intent assessment,
- dual-use ambiguity,
- nuanced classification.

### Human review

Use for:

- severe enforcement,
- exceptional R4 cases,
- uncertain high-impact decisions,
- external disclosure/escalation decisions.

---

## 21. Required Tests

Add tests at minimum for:

1. normal intent → R0 / allowed
2. sensitive research → not automatically prohibited
3. historical hate analysis → allowed
4. targeted hateful harassment → execution blocked
5. authorized defensive cybersecurity → not automatically prohibited
6. credential theft / malicious intrusion intent → blocked
7. crime fiction → not treated as real crime execution
8. explicit serious criminal facilitation → blocked
9. targeted violent action → blocked
10. R4 requires strong evidence / high threshold
11. vague angry language does not automatically become R4
12. unsafe email send blocked before Gmail tool
13. unsafe browser consequence blocked before Browser Agent action
14. unsafe calendar/tool action blocked before provider
15. user approval cannot override R3/R4
16. model-provider permissiveness cannot override NAgex safety
17. safety-service unavailable → consequential action fails closed
18. R2 safe-completion path
19. cross-tenant safety-event isolation
20. enforcement event persistence
21. repeated abuse can escalate enforcement recommendation
22. one ambiguous event does not automatically suspend account
23. no automatic police/reporting side effect exists
24. high-severity event requires human-review state
25. no external disclosure occurs from classifier alone
26. audit stores policy version + reason codes
27. safety decision survives restart where needed
28. action safety runs again immediately before execution
29. Capability Broker cannot bypass SafetyEngine
30. Tool invocation cannot bypass SafetyEngine

---

## 22. Abuse Tests / Red-Team Set

Create a dedicated red-team test corpus covering:

- violent wrongdoing,
- fraud,
- phishing,
- credential theft,
- malware abuse,
- authorized security research,
- privacy invasion,
- stalking,
- targeted hate,
- discrimination,
- self-harm,
- minors,
- dangerous dual-use,
- fictional/educational benign contexts,
- jailbreak/policy-evasion attempts,
- cross-turn escalation from benign to harmful intent.

The corpus must include both positive and negative examples to avoid overblocking.

---

## 23. Metrics

Track at minimum:

```text
false positive rate
false negative rate
R0/R1/R2/R3/R4 distribution
blocked execution count
safe-completion count
human-review count
appeal/reversal count
provider/classifier latency
safety-service availability
```

Do not optimize only for block rate.

Overblocking legitimate use is also a product failure.

---

## 24. Policy Versioning

Every safety decision must record:

```text
policyVersion
classifierVersion
```

Policy changes must be testable and auditable.

Do not silently change enforcement semantics without versioning.

---

## 25. Development Sequence

Implement **after STEP 10 Phase 1 Freeze** and **before expanding Capability Broker execution**.

Recommended sequence:

```text
TS-1 Safety types + taxonomy + policy version
TS-2 SafetyEngine + deterministic rules
TS-3 intent classifier integration
TS-4 pre-execution action safety gate
TS-5 Candidate / Planner integration
TS-6 Capability Broker integration
TS-7 enforcement + safety-event persistence
TS-8 R4 high-severity human-review workflow
TS-9 red-team test corpus
TS-10 E2E / restart / tenant isolation / fail-closed verification
```

---

## 26. P0 Acceptance Gate

Trust & Safety Layer = PASS only if:

- NAgex has an independent policy layer,
- all consequential action paths pass through action safety,
- R3/R4 actions cannot be user-approved into execution,
- multiple model providers cannot bypass NAgex policy,
- safety outage fails closed for consequential writes,
- R4 does not automatically report users externally,
- high-severity cases require explicit human-review state,
- tenant/principal isolation is enforced,
- policy decisions are versioned and auditable,
- red-team and benign-context tests both pass,
- no fake or hidden reporting behavior exists.

---

## 27. Explicit Non-Goals for Initial Version

Do NOT initially build:

- direct police API integration,
- automated law-enforcement reporting,
- universal content surveillance,
- automated account termination based on one model classification,
- biometric/personality risk scoring,
- political ideology scoring,
- predictive policing,
- hidden user reputation scoring,
- broad employee/school reporting,
- safety decisions based on protected traits.

---

## 28. Canonical Product Position

NAgex should be:

> A Personal AI that can act with the user, but not blindly act on every instruction.

The correct architecture is:

```text
Intent is the interface.
Safety is the boundary.
Approval is the control.
Capability is the execution infrastructure.
```

NAgex must remain useful for legitimate research, creativity, security work, controversial discussion, and personal productivity while refusing or constraining actions that materially facilitate serious harm.

---

## 29. Freeze Rule

After this directive is adopted:

- no new consequential capability is considered production-ready without SafetyEngine integration,
- no new Tool/MCP/provider adapter may bypass the safety pre-check,
- any bypass discovered is a release blocker,
- safety and approval remain separate layers,
- external reporting remains an exceptional human/legal process, not an autonomous AI action.
