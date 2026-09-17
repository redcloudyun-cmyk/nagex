// R16 §15-18 — Domain ownership verification via real DNS TXT lookup
// (dns.promises.resolveTxt — the first DNS-based verification anywhere in
// this codebase, per the R16 investigation; a stable Node core API, no
// dependency needed).
import crypto from 'node:crypto';
import dns from 'node:dns';
import { NagexError } from '../common/errors.js';

export function generateVerificationToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function hashVerificationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const TXT_RECORD_PREFIX = 'nagex-verification=';

// Real, non-mocked DNS TXT lookup — resolves the domain's real TXT
// records and checks for an exact `nagex-verification=<rawToken>` entry.
// Never persists the raw token; callers pass it in fresh (it only ever
// lives hashed at rest, per §16).
export async function checkDnsTxtVerification(domain: string, rawToken: string, resolveTxtFn: typeof dns.promises.resolveTxt = dns.promises.resolveTxt): Promise<boolean> {
  let records: string[][];
  try {
    records = await resolveTxtFn(domain);
  } catch (error) {
    throw new NagexError({ code: 'DOMAIN_DNS_LOOKUP_FAILED', category: 'PROVIDER', message: `Could not resolve TXT records for ${domain}: ${error instanceof Error ? error.message : String(error)}` });
  }
  const expected = `${TXT_RECORD_PREFIX}${rawToken}`;
  return records.some((chunks) => chunks.join('') === expected);
}

export function formatTxtRecordValue(rawToken: string): string {
  return `${TXT_RECORD_PREFIX}${rawToken}`;
}
