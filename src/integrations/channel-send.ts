import { NagexError } from '../common/errors.js';

// Security Gate S2C — what a channel send can truthfully report.
//
// A send is DELIVERED only when the provider accepted it. A missing credential, a provider rejection and a network failure
// are failures: they must never be reported as, or rendered into, a successful delivery (MASTER §7). The adapters
// (TelegramBotClient / SlackClient) return this shape; nothing above them may turn a failure into success.
export type ChannelSendFailureReason = 'NO_PROVIDER_CREDENTIAL' | 'PROVIDER_REJECTION' | 'NETWORK_FAILURE';

// ── User-facing send: SELF-DELIVERY ONLY ──
// The destination of a signed-in caller's send is derived by the server from the caller's OWN ownership-proven channel
// link (S2B). A client-supplied chat/channel is, at most, an assertion that must equal that destination; it never grants one.
export type OwnChannelSendDenial =
  | 'NOT_LINKED'              // the caller has no channel link at all
  | 'LINK_NOT_VERIFIED'       // only a link that predates S2B (never proven) exists
  | 'DESTINATION_NOT_OWNED'   // the asserted destination is not one of the caller's verified destinations
  | 'DESTINATION_AMBIGUOUS'   // several verified destinations and no assertion to choose between them
  | 'WORKSPACE_MISMATCH';     // the verified link belongs to another workspace than the asserted one / the bot's

export type OwnChannelSendResult =
  | { status: 'SENT'; destination: string }
  | { status: 'DENIED'; code: OwnChannelSendDenial }
  | { status: 'FAILED'; reason: ChannelSendFailureReason };

const DENIAL: Record<OwnChannelSendDenial, { code: string; category: 'CONFLICT' | 'AUTHORIZATION' | 'VALIDATION'; message: (channel: string) => string }> = {
  NOT_LINKED: { code: 'CHANNEL_NOT_LINKED', category: 'CONFLICT', message: (c) => `No ${c} account is linked to your NAgex account. Link one first (request a link code and send it from that account).` },
  LINK_NOT_VERIFIED: { code: 'CHANNEL_LINK_NOT_VERIFIED', category: 'CONFLICT', message: (c) => `Your linked ${c} account was never ownership-verified. Unlink it and link it again by proving you control it.` },
  DESTINATION_NOT_OWNED: { code: 'CHANNEL_DESTINATION_NOT_AUTHORIZED', category: 'AUTHORIZATION', message: (c) => `This ${c} destination is not one of your own verified accounts. Messages can only be sent to your own linked ${c} account.` },
  DESTINATION_AMBIGUOUS: { code: 'CHANNEL_DESTINATION_AMBIGUOUS', category: 'VALIDATION', message: (c) => `You have several verified ${c} accounts; name the one to use.` },
  WORKSPACE_MISMATCH: { code: 'CHANNEL_WORKSPACE_MISMATCH', category: 'AUTHORIZATION', message: () => 'The destination belongs to a different workspace than your verified link.' },
};

const FAILURE: Record<ChannelSendFailureReason, { code: string; message: (channel: string) => string }> = {
  NO_PROVIDER_CREDENTIAL: { code: 'CHANNEL_PROVIDER_NOT_CONFIGURED', message: (c) => `The ${c} bot is not configured on this server; nothing was sent.` },
  PROVIDER_REJECTION: { code: 'CHANNEL_PROVIDER_REJECTED', message: (c) => `${c} rejected the message; nothing was delivered.` },
  NETWORK_FAILURE: { code: 'CHANNEL_PROVIDER_UNREACHABLE', message: (c) => `${c} could not be reached; nothing was delivered.` },
};

// A non-success outcome as the NagexError the HTTP layer already maps (403/409/400, provider failures 502). Never a success.
export function ownChannelSendError(result: Exclude<OwnChannelSendResult, { status: 'SENT' }>, channelName: string, requestId: string): NagexError {
  if (result.status === 'DENIED') {
    const d = DENIAL[result.code];
    return new NagexError({ code: d.code, category: d.category, message: d.message(channelName), request_id: requestId });
  }
  const f = FAILURE[result.reason];
  return new NagexError({ code: f.code, category: 'PROVIDER', message: f.message(channelName), request_id: requestId });
}
