export function baseSecurityHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (env.NAGEX_PUBLIC_HTTPS === '1' || env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}
