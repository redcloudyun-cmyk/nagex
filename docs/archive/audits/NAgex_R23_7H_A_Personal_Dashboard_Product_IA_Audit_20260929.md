# R23.7H-A — Personal Dashboard Product / IA Audit

Date: 2026-09-29
Status: **AUDIT + DESIGN COMPLETE — REVIEW REQUIRED; NO LARGE UI IMPLEMENTATION AUTHORIZED**

## 1. Current UI and navigation audit

The consumer navigation already has the correct five-item shape: `Home`,
`Inbox`, `Activity`, `Vault`, and `Settings`, on desktop and mobile. Memory,
Tasks/Automations, Connections, Approvals, Skills, Tools, and Knowledge remain
reachable contextually or through Settings, consistent with MASTER.md Section
14.12.

The current Home has much of the required data, but its presentation is split
across `app.js`, desktop/mobile Home modules, Daily Brief, and overlapping
legacy render functions. The service contract is more mature than the visual
hierarchy: `PersonalHomeResponse` already exposes Right Now, Today, attention,
prepared work, active work, recent results, suggestions, upcoming items, source
health, and profile data.

Main gaps:

- Home modules compete instead of forming one daily narrative.
- prepared work and active work are not consistently distinguished.
- memory is mostly inspectable as records, not explained as user value.
- trust-state labels vary; older copy sometimes collapses outcomes into “Done”.
- Approvals is secondary while Inbox/Home are the stronger live surfaces.
- source failure needs local truthfulness rather than a globally empty Home.

## 2. Existing reusable components and routes

| Surface | Existing route/data | Dashboard role |
|---|---|---|
| Personal Home | `GET /api/v1/personal/home` | primary aggregation contract |
| Inbox | workspace Inbox, candidates, approvals | unresolved review queue |
| Activity | `GET /api/v1/activity` | truthful recent outcomes |
| Vault | `/api/v1/workspace/vault` | saved sources and creations |
| Memory | `/api/v1/memory` and candidates | context source and user control |
| Calendar | `/api/v1/calendar/upcoming` | Today commitments |
| Tasks | `/api/v1/tasks` and runs | active/preparing/background work |
| Daily Brief | `/api/v1/daily-brief`, history | daily synthesis |
| Approvals | `/api/v1/approvals` | consequential decisions |
| Notifications | `/api/v1/notifications` | unread attention signal |
| Connections | `/api/v1/connections` | availability and recovery |
| My Space | existing read-only aggregation | composition reference, not a second Home |

Reusable frontend assets include `desktop-home.js`, `mobile-home.js`,
`daily-brief.js`, outcome-first Activity cards, the canonical Inbox view model,
shared tokens/components, approval view models, and existing EN/KR strings.

## 3. Proposed dashboard IA

```text
HOME
├─ Greeting + one command surface
├─ RIGHT NOW
│  └─ single highest-value grounded item
├─ TODAY
│  ├─ commitments timeline
│  ├─ important tasks/deadlines
│  └─ compact Daily Brief summary
├─ NEEDS YOUR ATTENTION
│  └─ approvals, choices, clarifications, actionable failures
├─ NAGEX IS PREPARING
│  └─ drafts, briefs, research, active tasks, watches
├─ FOR YOU
│  └─ memory-grounded suggestions and recommendations
├─ RECENT ACTIVITY
│  └─ truthful outcomes with evidence-aware states
└─ YOUR WORLD
   └─ Inbox, Calendar, Tasks, Memory, Vault, Connections
```

Quiet sections collapse. Failed sources show a local recovery state. Right Now
must not duplicate its source item in lower sections.

## 4. Primary Home layout

Desktop uses a full-width command surface and Right Now card, followed by a
two-column editorial layout. Today and Preparing occupy the wider column;
Attention and For You occupy the narrower column. Recent Activity and Your
World span the lower page. This is content hierarchy, not a metric grid.

Mobile is a single ordered feed: command surface, Right Now, Attention, Today,
Preparing, For You, Recent Activity, Your World. Attention moves ahead of Today
only when the canonical priority service identifies a blocking P0 item.

## 5. Information hierarchy

1. immediate grounded priority;
2. irreversible or blocking user decisions;
3. time-bound commitments;
4. prepared and active assistance;
5. personalized value and recommendations;
6. recent verified outcomes;
7. navigation into the user’s wider information world.

Infrastructure health appears only as contextual recovery copy. Provider,
adapter, registry, tenant, router, runtime, execution-plane, and session-ID
terminology is excluded from consumer cards.

## 6. Today model

Today is a time-oriented model rather than four counters:

```text
TodayItem {
  sourceRef
  kind: MEETING | TASK | DEADLINE | TRAVEL | REMINDER
  title
  startsAt? / dueAt?
  contextLine?
  state
  action?
}
```

Calendar events, active/due tasks, reminders, and grounded Daily Brief items
feed it. Counts may support scanning but never become the primary experience.

## 7. Needs Your Attention model

This section merges, without duplicating, the canonical unresolved queues:

- approval required;
- choice or clarification required;
- failed action with a safe user recovery;
- unavailable connection blocking a requested outcome;
- reviewable candidate or captured item.

Each card answers **who**, **what**, **where**, **how**, and **important
conditions**. Sensitive payloads remain summarized. Detail navigates to the
owning Inbox/approval surface instead of copying unsafe data into Home.

## 8. NAgex Is Preparing model

Use two visibly different families:

- **Prepared:** a grounded artifact exists—meeting brief, email draft, research
  result, or completed creation—and is ready to inspect.
- **In progress:** a real Task/run/watch is active, with persisted progress or
  a truthful qualitative state. Never invent percentage progress.

Scheduled work shows its next run. Waiting on approval belongs in Attention.
Failed work moves to Attention when actionable or Activity when terminal.

## 9. Daily Brief integration

Daily Brief becomes the lead For You card and a compact Today summary, backed
by the same persisted record. It displays freshness, unavailable/partial
sources, last successful generation, and explicit refresh. Suggested actions
remain proposals until separately accepted and approved. Full detail/history
remain expandable; Home does not duplicate the entire brief.

## 10. Memory-to-value UX

Memory appears as the reason for useful behavior, with an inspect/control path,
not as a database identifier.

1. **Preference → recommendation:** “You prefer morning departures, so I
   prioritized the 09:10 option.”
2. **Relationship/context → preparation:** “Your last discussion with Mina
   focused on launch risk, so I included the open decisions in today’s brief.”
3. **Prior decision → next action:** “You decided to wait for the revised quote.
   It arrived, so the comparison is ready.”

Each explanation offers “Why this?” and “Manage memory.” Proposed or sensitive
memory must never be presented as an established fact.

## 11. Activity integration

Home shows recent high-value outcomes; Activity remains the complete history
and evidence drill-down. Cards use the strongest truthful state: **Prepared**,
**Needs approval**, **In progress**, **Completed**, **Needs your action**,
**Failed**, or **Unavailable**. Provider acceptance is not delivery/read, and
human handoff is not completed execution.

## 12. Mobile/web responsive behavior

Web, Android, and future desktop/iOS share source identity and status while
copy describes continuity in user terms: “The message sent from your phone is
complete” or “The brief prepared on the web is available here.”

Desktop supports side-by-side context and inline detail. Mobile uses stacked
cards, bottom navigation, 44px minimum targets, concise summaries, and explicit
detail screens. Device labels appear only when they help explain where an
action occurred.

## 13. EN/KR considerations

- Translate intent, not word order.
- Short labels: Prepared/준비됨, Needs approval/승인 필요, In progress/진행 중,
  Completed/완료, Needs your action/조치 필요, Failed/실패,
  Unavailable/사용 불가.
- Korean layouts need flexible height and cannot reuse fixed English line caps.
- Date, time, timezone, and relative-time formatting must be locale-aware.
- Consumer copy must not leak untranslated infrastructure nouns.

## 14. Visual design direction

Use a calm editorial day-planner aesthetic: strong typography, whitespace,
restrained semantic color, and one dominant Right Now focal point. Cards group
narrative outcomes instead of imitating analytics widgets. Use color with text
and icons, never alone. Motion is limited to meaningful state transitions and
respects reduced-motion. Reuse existing NAgex tokens and brand assets.

## 15. Exact files likely to change in R23.7H-B

- `public/index.html`
- `public/app.js`
- `public/style.css`
- `public/i18n.js`
- `public/desktop/desktop-home.js`
- `public/desktop/desktop-home.css`
- `public/mobile/mobile-home.js`
- `public/mobile/mobile-home.css`
- `public/daily-brief.js`
- `public/shared/components.css`
- `src/home/personal-home.service.ts`
- `src/http/routes/personal-home.routes.ts`
- focused Home, context, Activity, Daily Brief, mobile, i18n, accessibility,
  and real-browser tests plus their registry entries

No new top-level navigation item or second dashboard API is recommended.

## 16. Implementation phases

1. **H-B1 Contract consolidation:** freeze section/state view models and remove
   duplicate Home derivation without visual redesign.
2. **H-B2 Desktop shell:** apply the hierarchy using existing data and tokens.
3. **H-B3 Mobile composition:** same semantics with mobile density/interaction.
4. **H-B4 Memory-to-value:** grounded explanation objects and control links.
5. **H-B5 Trust/state polish:** empty/error/recovery states, accessibility,
   EN/KR consistency.
6. **H-B6 Certification:** deterministic tests, real-browser breakpoints,
   truthfulness checks, and demo-path rehearsal.

R23.7G may run in parallel. H-B3/H-B5 must not claim uncertified recovery
behavior before R23.7G closes.

## 17. Risks

- duplicate Home renderers can diverge between desktop and mobile;
- aggregating many stores can create stale or conflicting snapshots;
- personalization can expose sensitive memory or overstate inferred facts;
- “preparing” can become fake progress without durable Task/run state;
- dense cards can regress mobile readability;
- Daily Brief, Right Now, and suggestions can duplicate the same fact;
- connection outages can look like an empty day;
- approval summaries can omit material conditions;
- visual polish can outrun data truthfulness or the hackathon critical path.

Mitigations: one Home contract, source-reference dedupe, memory provenance and
sensitivity gates, persisted status only, section-level availability, shared
semantic components, and staged real-browser review.

## 18. Recommendation for R23.7H-B

Approve **H-B1 Contract Consolidation plus a thin desktop/mobile shell
prototype**. Do not start with a visual rewrite. First make
`PersonalHomeResponse` the single semantic source for Home, define the seven
trust states once, and map each card to an existing owning surface. Then build
one vertical slice:

```text
Right Now
→ Needs Your Attention
→ Today
→ NAgex Is Preparing
→ Recent Activity
```

Acceptance requires real data, zero duplicate items, localized empty/error
states, no infrastructure vocabulary, and no fake completion or progress.
Memory-to-value explanations follow after this composition contract is proven.
