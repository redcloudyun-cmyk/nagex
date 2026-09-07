import { NagexError } from '../../common/errors.js';

type FetchFn = typeof fetch;

// ── Compose payload (frozen exactly as approved — see tools/gmail.service.ts) ──

export interface GmailAttachmentMetadata {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GmailComposePayload {
  from: string; // the connected account, always "me" for Sprint scope — frozen explicitly for audit/review transparency
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  // Metadata only (filename/type/size) — real attachment upload (embedding
  // file bytes into the outgoing MIME message) is not implemented yet. This
  // is an honest scope limit, not a bug: see MASTER.md Section 8.
  attachments: GmailAttachmentMetadata[];
  threadId: string | null; // set for a reply
  replyToMessageId: string | null; // set for a reply — the RFC 2822 Message-Id of the message being replied to
}

export interface SentGmailMessage {
  externalId: string;
  externalUrl: string;
  threadId: string;
}

export interface GmailThreadSummary {
  threadId: string;
  snippet: string;
}

export interface GmailMessageSummary {
  id: string;
  snippet: string;
}

export interface GmailThreadDetail {
  threadId: string;
  messages: GmailMessageSummary[];
}

export interface CreatedGmailDraft {
  draftId: string;
  messageId: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeaderValue(value: string): string {
  // MIME-encode a header value that might contain non-ASCII characters
  // (RFC 2047), so a Korean subject/name never corrupts the raw message.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildRawMimeMessage(payload: GmailComposePayload): string {
  const headers: string[] = [];
  if (payload.to.length) headers.push(`To: ${payload.to.join(', ')}`);
  if (payload.cc.length) headers.push(`Cc: ${payload.cc.join(', ')}`);
  if (payload.bcc.length) headers.push(`Bcc: ${payload.bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(payload.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 8bit');
  if (payload.replyToMessageId) {
    headers.push(`In-Reply-To: ${payload.replyToMessageId}`);
    headers.push(`References: ${payload.replyToMessageId}`);
  }
  const message = `${headers.join('\r\n')}\r\n\r\n${payload.body}`;
  return base64UrlEncode(message);
}

async function gmailApiRequest(
  url: string,
  method: 'GET' | 'POST',
  accessToken: string,
  body: unknown,
  fetchFn: FetchFn,
  requestId: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NagexError({
      code: 'GMAIL_NETWORK_ERROR',
      category: 'PROVIDER',
      message: 'Could not reach the Gmail API.',
      request_id: requestId,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const category = response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'PROVIDER';
    const message = (payload?.error as { message?: string } | undefined)?.message || `Gmail API request failed with HTTP ${response.status}.`;
    throw new NagexError({ code: `GMAIL_HTTP_${response.status}`, category, message, request_id: requestId });
  }

  return payload;
}

export async function sendGmailMessage(accessToken: string, payload: GmailComposePayload, fetchFn: FetchFn, requestId: string): Promise<SentGmailMessage> {
  const raw = buildRawMimeMessage(payload);
  const body: Record<string, unknown> = { raw };
  if (payload.threadId) body.threadId = payload.threadId;

  const result = await gmailApiRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 'POST', accessToken, body, fetchFn, requestId);
  const externalId = typeof result.id === 'string' ? result.id : null;
  const threadId = typeof result.threadId === 'string' ? result.threadId : null;
  if (!externalId || !threadId) {
    throw new NagexError({ code: 'GMAIL_MALFORMED_RESPONSE', category: 'PROVIDER', message: 'Gmail did not return a message ID or thread ID.', request_id: requestId });
  }
  return { externalId, threadId, externalUrl: `https://mail.google.com/mail/u/0/#all/${externalId}` };
}

export async function createGmailDraft(accessToken: string, payload: GmailComposePayload, fetchFn: FetchFn, requestId: string): Promise<CreatedGmailDraft> {
  const raw = buildRawMimeMessage(payload);
  const message: Record<string, unknown> = { raw };
  if (payload.threadId) message.threadId = payload.threadId;

  const result = await gmailApiRequest('https://gmail.googleapis.com/gmail/v1/users/me/drafts', 'POST', accessToken, { message }, fetchFn, requestId);
  const draftId = typeof result.id === 'string' ? result.id : null;
  const inner = result.message as Record<string, unknown> | undefined;
  const messageId = inner && typeof inner.id === 'string' ? inner.id : null;
  if (!draftId || !messageId) {
    throw new NagexError({ code: 'GMAIL_MALFORMED_RESPONSE', category: 'PROVIDER', message: 'Gmail did not return a draft ID.', request_id: requestId });
  }
  return { draftId, messageId };
}

export async function searchGmailThreads(accessToken: string, query: string, fetchFn: FetchFn, requestId: string): Promise<GmailThreadSummary[]> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}`;
  const result = await gmailApiRequest(url, 'GET', accessToken, null, fetchFn, requestId);
  const threads = Array.isArray(result.threads) ? (result.threads as Array<Record<string, unknown>>) : [];
  return threads
    .filter((t) => typeof t.id === 'string')
    .map((t) => ({ threadId: t.id as string, snippet: typeof t.snippet === 'string' ? t.snippet : '' }));
}

export async function getGmailThread(accessToken: string, threadId: string, fetchFn: FetchFn, requestId: string): Promise<GmailThreadDetail> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`;
  const result = await gmailApiRequest(url, 'GET', accessToken, null, fetchFn, requestId);
  const messages = Array.isArray(result.messages) ? (result.messages as Array<Record<string, unknown>>) : [];
  return {
    threadId: typeof result.id === 'string' ? result.id : threadId,
    messages: messages
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ id: m.id as string, snippet: typeof m.snippet === 'string' ? m.snippet : '' })),
  };
}
