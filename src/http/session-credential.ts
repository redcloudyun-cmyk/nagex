// S1 — the ONE place a session credential is read from a request.
//
// Security Gate S0-02: five route modules each carried their own copy of this
// parser, and every copy called decodeURIComponent() on the raw cookie value.
// A malformed percent-escape ("%E0%A4%A") makes decodeURIComponent throw a
// URIError; at the top of handleAsyncApiRequest that happened OUTSIDE the
// request try/catch, so one anonymous request terminated the whole process.
//
// Rules enforced here, for every caller:
//   - parsing never throws; anything unusable is "no credential" (null);
//   - a malformed credential is therefore indistinguishable from an absent
//     one, which an authenticated route turns into an ordinary 401;
//   - the cookie name is matched as a whole cookie, not as a suffix of another
//     cookie's name;
//   - the value is length-bounded so an oversized header cannot be decoded.
const SESSION_COOKIE_NAME = 'nagex_session';
const MAX_SESSION_CREDENTIAL_CHARS = 256;

type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeaderValue(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function decodeCredential(raw: string): string | null {
  if (!raw || raw.length > MAX_SESSION_CREDENTIAL_CHARS * 3) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  decoded = decoded.trim();
  if (!decoded || decoded.length > MAX_SESSION_CREDENTIAL_CHARS) return null;
  // A session id is an opaque token: reject anything that cannot be one.
  if (/[\s\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded;
}

export function parseSessionCookie(headers: HeaderBag): string | null {
  const cookieHeader = firstHeaderValue(headers, 'cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    return decodeCredential(part.slice(eq + 1).trim());
  }
  return null;
}

export function parseBearerCredential(headers: HeaderBag): string | null {
  const authHeader = firstHeaderValue(headers, 'authorization');
  if (!authHeader || !/^Bearer\s/i.test(authHeader)) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token.length > MAX_SESSION_CREDENTIAL_CHARS || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

// Cookie first (what a browser sends), then an explicit Bearer credential.
export function getSessionIdFromHeaders(headers: HeaderBag): string | null {
  return parseSessionCookie(headers) ?? parseBearerCredential(headers);
}
