export type ErrorCategory =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'POLICY'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'RUNTIME'
  | 'PROVIDER'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface AgexErrorDetails {
  code: string;
  category: ErrorCategory;
  message: string;
  request_id: string;
  correlation_id?: string | null;
  details?: Record<string, unknown>;
}

export class AgexError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly requestId: string;
  public readonly correlationId?: string | null;
  public readonly details?: Record<string, unknown>;

  constructor(payload: AgexErrorDetails) {
    super(payload.message);
    this.name = 'AgexError';
    this.code = payload.code;
    this.category = payload.category;
    this.requestId = payload.request_id;
    this.correlationId = payload.correlation_id;
    this.details = payload.details;
  }

  public toJSON(): { error: AgexErrorDetails } {
    return {
      error: {
        code: this.code,
        category: this.category,
        message: this.message,
        request_id: this.requestId,
        correlation_id: this.correlationId,
        details: this.details,
      },
    };
  }
}
