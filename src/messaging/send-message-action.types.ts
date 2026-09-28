// R23.6M Phase D1 — Global Messaging Abstraction, canonical domain types.
//
// This is a TAXONOMY layer only — it never widens the certified Phase C
// executable run state (MobileMessageChannel/MobileMessageExecutionRoute
// in mobile-message.types.ts stay exactly 'SMS'/'ANDROID_SMS_MANAGER').
// A value existing here (e.g. 'KAKAOTALK') means the concept is named;
// it does NOT mean any executable path accepts it — that only happens
// once a real adapter is registered in MessagingAdapterRegistry, which
// in D1 holds exactly one entry (SMS). FAKE_SUCCESS_PATHS = 0: nothing
// in this file, by itself, can cause a persisted run record to claim an
// unimplemented channel.
import type { MobileMessageRunRecord, MobileMessageSendResult } from '../mobile/mobile-message.types.js';

// Canonical channel taxonomy — deliberately broader than what Phase C's
// executable types accept today. Widened here first (naming), not in the
// certified run-record types, so D2/D3 can be designed against without
// ever implying KakaoTalk is executable before it has a real adapter.
export type MessagingChannel = 'SMS' | 'KAKAOTALK';

// Execution route is a SEPARATE concept from channel — one channel may
// have more than one possible route (e.g. KakaoTalk's eventual official
// API vs. deep-link vs. UI-automation vs. manual-fallback routes). D1
// only ever resolves ANDROID_SMS_MANAGER, but the taxonomy names the
// other routes now so a future resolver never has to retrofit "channel
// == route" assumptions out of this type.
export type ExecutionRoute =
  | 'ANDROID_SMS_MANAGER'
  | 'KAKAOTALK_OFFICIAL_API'
  | 'KAKAOTALK_DEEP_LINK'
  | 'KAKAOTALK_UI_AUTOMATION'
  | 'MANUAL_FALLBACK';

// The canonical, channel-neutral action. Mirrors the same
// recipientRef/message/device-context shape Phase B3/C already
// established — reused, not reinvented.
export interface SendMessageAction {
  recipientRef: string;
  message: string;
  // Present only when the user (or client) explicitly named a channel.
  // Absent -> ExecutionRouteResolver chooses among registered/available
  // adapters. An explicit value that has no registered adapter must fail
  // closed (CHANNEL_UNAVAILABLE) — it must never be silently substituted
  // for a different channel.
  preferredChannel?: MessagingChannel;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  locale: string;
  requestId: string;
}

export interface CapabilityResult {
  available: boolean;
  // Truthful, never guessed — e.g. "NOT_REGISTERED", "NOT_INSTALLED".
  reason?: string;
}

// Reuses Phase C's exact existing shapes rather than inventing parallel
// ones — the adapter contract is a thin async wrapper around calls that,
// for the SMS adapter, are 1:1 passthroughs to MobileMessageRunService.
export type PreparedMessage = { recipientRef: string; message: string };
export type ExecutionOutcome = MobileMessageRunRecord;
export type SendResult = MobileMessageSendResult;
export type RunSnapshot = MobileMessageRunRecord;
