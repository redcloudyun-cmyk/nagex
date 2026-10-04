// Security Gate S2E — TEST-ONLY peer-address injection.
//
// Rate limiting is keyed by the client address, which in production is the TCP peer (or, behind a trusted proxy, the first
// untrusted X-Forwarded-For hop). A test that needs several distinct "clients" must NOT forge X-Forwarded-For (an untrusted
// header is ignored by design). It uses the programmatic seam below instead: `createServerInstance({ clientIp: { testPeerAddress } })`,
// which replaces the socket's remote address for a test server only. It is not an environment variable, not a header the
// production server reads, and createServerInstance refuses it when NODE_ENV is "production".
//
//  - in-process server:   createServerInstance(testPeerServerOptions())  + send  { [TEST_PEER_HEADER]: '10.x.y.z' }
//  - direct route call:   handleAuthRoutes(..., headersFromPeer('10.x.y.z'), ...)
//  - spawned server:      no seam exists in a real process; the test declares itself the (trusted) front proxy with
//                         NAGEX_TRUSTED_PROXIES=127.0.0.1,::1 and sends X-Forwarded-For — the production trusted-proxy path.
import type http from 'node:http';
import { attachResolvedClientIp } from '../src/http/client-ip.js';

export const TEST_PEER_HEADER = 'x-test-peer';
export const SPAWNED_SERVER_TRUSTED_PROXIES = '127.0.0.1,::1';

export const testPeerSeam = (req: http.IncomingMessage): string | undefined => {
  const value = req.headers[TEST_PEER_HEADER];
  return typeof value === 'string' && value ? value : undefined;
};

export const testPeerServerOptions = () => ({ clientIp: { trustedProxies: '', testPeerAddress: testPeerSeam } });

export function headersFromPeer(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extra };
  attachResolvedClientIp(headers, ip);
  return headers;
}
