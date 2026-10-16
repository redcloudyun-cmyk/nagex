// One error type for everything a video provider can go wrong with, so the job service turns it into a truthful state instead of guessing from message text.
//
// Codes are stable and provider-neutral; the message is for the audit trail and for a short plain sentence to the person (never the raw provider body, never a credential).

export type VideoProviderErrorCode =
  | 'PROVIDER_UNCONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_BILLING_REQUIRED'
  | 'PROVIDER_INSUFFICIENT_CREDITS'
  | 'PROVIDER_MODEL_NOT_FOUND'
  | 'PROVIDER_REJECTED_REQUEST'
  | 'PROVIDER_UNAVAILABLE_ERROR'
  | 'CONTENT_REJECTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'UNSUPPORTED_REQUEST'
  | 'MEDIA_DOWNLOAD_FAILED'
  | 'MEDIA_INVALID';

export class VideoProviderError extends Error {
  public readonly code: VideoProviderErrorCode;
  public readonly httpStatus?: number;
  /** a later identical attempt could succeed (service busy, network); never true for auth, billing, quota or validation */
  public readonly retryable: boolean;

  constructor(code: VideoProviderErrorCode, message: string, options: { httpStatus?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'VideoProviderError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
  }
}

export function asVideoProviderError(error: unknown, fallbackCode: VideoProviderErrorCode = 'NETWORK_ERROR'): VideoProviderError {
  if (error instanceof VideoProviderError) return error;
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return new VideoProviderError(fallbackCode, message, { retryable: fallbackCode === 'NETWORK_ERROR' || fallbackCode === 'TIMEOUT' });
}
