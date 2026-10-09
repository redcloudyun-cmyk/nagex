# NAgex Sidebar Feature Mapping

Status: Sidebar IA v1 implementation reference.

| Current feature | Current route/surface | Canonical destination | Implementation status | Action taken | Known limitation |
|---|---|---|---|---|---|
| Home composer, Your Day, Active Work, recommendations | `#home`, `tab-home` | Home | Available | Kept as primary start surface with Right Execution Rail | None for this slice |
| Current-context approval card | Home Right Execution Rail | Right Execution Rail | Available | Preserved as live lifecycle state, not a nav item | Depends on existing Home data |
| Deferred/background approvals | `#approvals`, approval list | Inbox > Approvals | Available | Removed from primary sidebar; legacy `#approvals` routes to Inbox | Legacy approval view remains for compatibility only |
| Inbox captures and decisions | `#inbox`, `tab-inbox` | Inbox > Needs Attention / Suggestions / Notifications | Available | Grouped with approval access as the attention center | Group counts depend on live data |
| Create image and intent launchers | `#create`, Home shortcuts | Create | Available/Beta/Coming later | Added grouped Create capability map | Some launchers open the existing intent overlay until dedicated flows exist |
| Canvas artifact editing | `#canvas`, embedded canvas | Canvas | Available/Beta | Kept as artifact editing destination | Capability depth varies by artifact type |
| Tasks and automations | `#tasks`, settings links | Tasks | Available | Kept as primary navigation destination | Existing runtime uses current task store/projection |
| Vault, files, knowledge search | `#knowledge`, `#vault` | Knowledge | Available | Kept Knowledge primary and Vault reachable from Knowledge | Connected sources are shown only where real |
| Activity / execution history | `#activity`, `tab-executions` | Activity | Available | Promoted to primary sidebar as concise history | Technical audit detail stays out of normal Activity rows |
| Settings categories | `#settings` | Settings | Available/Partial | Kept under Settings; internal tool/skill links removed from normal Advanced drawer | Some canonical categories still reuse existing panels |
| Skills / Tools / Models / Router / Planner | Settings advanced and debug internals | Developer/Audit only | Internal | Not exposed as primary sidebar destinations | Existing direct routes are retained for compatibility |
| Mobile bottom navigation | `.mobile-bottom-nav`, `.mh-bottom-nav` | Same IA as desktop | Available | Preserved Home/Create/Canvas/Inbox/Settings primary mobile subset with overflow destinations reachable through Settings | Compact mobile bottom nav cannot fit all eight labels at once |

Canonical primary menu:

```text
Home
Inbox
Create
Canvas
Tasks
Knowledge
Activity
Settings
```

Placement rule:

```text
Start work -> Home / Create
Needs user attention -> Inbox
Live approval / execution -> Right Execution Rail
Deferred approvals -> Inbox > Approvals
Edit existing artifact -> Canvas
Do later / recur / conditional / background -> Tasks
Manage information / context -> Knowledge
Review past action -> Activity
Manage product / account / device -> Settings
```
