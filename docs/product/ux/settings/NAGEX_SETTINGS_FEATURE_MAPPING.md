# NAGEX Settings Feature Mapping

Status: Settings commercial UX implementation map

| Setting | User purpose | Current backend/API | Implementation status | UI action | Persistence | Known limitation |
|---|---|---|---|---|---|---|
| Account profile | Manage NAgex identity | Existing account renderer | REAL | Render shared account panel | Existing account APIs | Depends on signed-in session |
| Sign-in methods | Understand available sign-in options | Auth/OAuth routes | PARTIAL | User-facing cards | Existing auth/OAuth stores | Microsoft sign-in is surfaced as available only where configured |
| Google connection | Connect Gmail/Calendar/Drive style services | `/api/v1/oauth/google/status` | REAL | Connect/disconnect Google | OAuth token store | Drive is shown as a service family, not a separate live toggle yet |
| Microsoft connection | Connect Outlook/Calendar/OneDrive | None in current web runtime | NOT_IMPLEMENTED | Truthful not-connected card | None | No fake connection flow |
| Communication/apps | Future app integrations | Channel link routes where available | PARTIAL | User-facing grouping | Existing integration stores where present | Not every app has a settings control |
| Devices list | Identify enrolled devices | `/api/v1/device-agent/devices` | REAL | Real device cards | Device identity store | Empty state shown when no registered devices exist |
| Device nickname | Rename a device | `PUT /api/v1/device-agent/devices/:id/nickname` | REAL | Rename action | Device identity store | Internal `deviceId` is used only for API addressing, not normal UI display |
| System device name | Show OS-reported identity | Device enrollment metadata, environment fallback | PARTIAL | Read-only display | Device identity store | Older enrolled records may use runtime fallback until the agent re-enrolls |
| Device capabilities | Explain what NAgex can control | `capabilityInventory` | REAL | Capability chips | Device identity store | Raw capability IDs are mapped to user labels |
| Permissions | Explain standing access/action policy | Policy model scattered across approval/runtime | PARTIAL | Read-only commercial policy summary | Existing policy behavior | Does not imply approval bypass |
| Notifications | Configure notification preferences | Quick Wake/proactive prefs | REAL/PARTIAL | Existing preference controls in new shell | Preferences APIs | Channel-specific delivery internals are hidden |
| Personalization | User work style preferences | Quick Wake/autonomy prefs, language UI | PARTIAL | User-facing cards | Existing prefs where wired | Raw model selection is intentionally absent |
| Privacy & Security | Protect context, trusted devices, approvals | Account/memory/task surfaces | PARTIAL | Safe summary cards | Existing stores | Deep controls remain in their canonical areas |
| Appearance | Visual preferences | Existing layout/theme behavior | PARTIAL | Supported theme/density/sidebar choices only | Existing UI state where present | No fake persistence for unsupported preferences |
| Advanced | Developer diagnostics and experiments | Provider health and diagnostics APIs | PARTIAL | Secondary advanced panel | Existing diagnostics | Model/tools/skills/MCP details are not normal Settings IA |
