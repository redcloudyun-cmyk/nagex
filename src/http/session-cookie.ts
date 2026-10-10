const SESSION_COOKIE_NAME = 'nagex_session';

function secureCookieEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NAGEX_INSECURE_COOKIES_FOR_LOCAL_DEV !== '1';
}

export function sessionCookieHeader(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const secure = secureCookieEnabled(env) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

export function clearSessionCookieHeader(env: NodeJS.ProcessEnv = process.env): string {
  const secure = secureCookieEnabled(env) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}
