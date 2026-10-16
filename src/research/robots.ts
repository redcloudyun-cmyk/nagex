// robots.txt (RFC 9309) for the research fetcher. Pure: parses a robots.txt body and answers "may this crawler fetch this path?". The fetcher decides what a missing or unreachable file means.
//   - a group applies to a crawler when its user-agent value is "*" or is contained in the crawler's own user-agent string; a specific group wins over "*";
//   - the longest matching Allow / Disallow pattern decides, Allow wins a tie; "*" is a wildcard and a trailing "$" anchors the end;
//   - an empty Disallow allows everything. Crawl-delay is not part of the RFC but is honoured (capped) because well-run sites use it.

export interface RobotsRules {
  /** true when the crawler may fetch this path (with query string) */
  allows(pathAndQuery: string): boolean;
  /** seconds the site asked crawlers to wait between requests, capped, or undefined */
  crawlDelaySeconds?: number;
}

interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number }

const MAX_CRAWL_DELAY_SECONDS = 10;

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // an empty Disallow means "nothing is disallowed"; an empty Allow carries no information
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = Math.min(delay, MAX_CRAWL_DELAY_SECONDS);
    }
  }
  return groups;
}

export function parseRobots(text: string, crawlerUserAgent: string): RobotsRules {
  const agent = crawlerUserAgent.toLowerCase();
  const groups = parseGroups(text);
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a.length > 0 && agent.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((g) => g.rules).map((r) => ({ ...r, regexp: patternToRegExp(r.pattern) }));
  const delays = applicable.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  return {
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : undefined,
    allows(pathAndQuery: string): boolean {
      const target = pathAndQuery || '/';
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of rules) {
        if (!rule.regexp.test(target)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { allow: rule.allow, length };
      }
      return best ? best.allow : true;
    },
  };
}

/** A robots.txt that could not be read: nothing may be fetched. */
export const DISALLOW_ALL: RobotsRules = { allows: () => false };
/** No robots.txt exists: everything the site serves publicly may be fetched. */
export const ALLOW_ALL: RobotsRules = { allows: () => true };
