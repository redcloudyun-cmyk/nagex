export const GLOBAL_DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
export const DIRECT_UPLOAD_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

export function requestBodyLimitFor(pathname: string): number {
  if (pathname === '/api/v1/workspace/upload') return DIRECT_UPLOAD_BODY_LIMIT_BYTES;
  if (pathname === '/api/v1/workspace/uploads/complete') return DIRECT_UPLOAD_BODY_LIMIT_BYTES;
  return GLOBAL_DEFAULT_BODY_LIMIT_BYTES;
}
