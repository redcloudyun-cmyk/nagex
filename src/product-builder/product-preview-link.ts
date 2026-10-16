// A signed, short-lived link to the SANDBOXED preview of one project's current build.
//
// The preview is generated content: it is served inside a sandboxed frame without script access to NAgex (see the route's Content-Security-Policy). The frame loads the page and its files by plain
// requests that carry no NAgex session, so the link itself is the credential: it names exactly one project and one workspace for exactly one owner, expires, and is signed with a key that exists only
// in this process (a link minted before a restart stops working - the person asks for a new one). A tampered link, another project's, an expired one, or one for a workspace that has since been
// replaced all fail the same way: there is nothing to see.
import crypto from 'node:crypto';

export interface PreviewLinkClaims { projectId: string; workspaceId: string; tenantId: string; ownerId: string }

const DEFAULT_TTL_MS = 30 * 60_000;

export class PreviewLinkSigner {
  private readonly key: Buffer;

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs: number = DEFAULT_TTL_MS, key?: Buffer) {
    this.key = key ?? crypto.randomBytes(32);
  }

  private mac(payload: string): string {
    return crypto.createHmac('sha256', this.key).update(`preview|${payload}`).digest('base64url');
  }

  public issue(claims: PreviewLinkClaims): { token: string; expiresAt: string } {
    const expiresAtMs = this.now() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({ p: claims.projectId, w: claims.workspaceId, t: claims.tenantId, o: claims.ownerId, e: expiresAtMs, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** The claims, or null for anything that is not a valid, unexpired link made by this process. */
  public verify(token: string): PreviewLinkClaims | null {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.mac(payload));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { p?: unknown; w?: unknown; t?: unknown; o?: unknown; e?: unknown };
      if (typeof claims.p !== 'string' || typeof claims.w !== 'string' || typeof claims.t !== 'string' || typeof claims.o !== 'string' || typeof claims.e !== 'number') return null;
      if (claims.e <= this.now()) return null;
      return { projectId: claims.p, workspaceId: claims.w, tenantId: claims.t, ownerId: claims.o };
    } catch { return null; }
  }
}

/** The headers every preview response carries: the document runs in an opaque-origin sandbox, loads nothing from anywhere else and cannot be embedded outside NAgex. */
export const PREVIEW_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  // the sandboxed document has an opaque origin: its own files are cross-origin to it, so they must say they may be read. They are already scoped by the unguessable link.
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
});
