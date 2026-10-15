// "기억해줘: 나는 아침에 커피를 마셔" ... later "기억해줘: 이제 나는 커피 대신 차를 마셔". Measured on the baseline: the SECOND explicit statement was silently lost (every explicit statement was stored under the
// one key "User Preference / preference", so the next one was filed as an invisible CONFLICTED record), and the assistant went on recalling the old, outdated value. A person who corrects a fact
// expects the new fact to be the one NAgex uses, and expects the old one to stay available as history, not to vanish.
//
// This is the deterministic half of that: when a person EXPLICITLY states a fact that clearly replaces one they stated before, which earlier memory does it replace?
//   - only with a replacement cue in their own words ("대신", "이제", "더 이상", "이사했", "no longer", "instead of", "actually"...), and
//   - only when exactly one earlier explicit memory shares the topic more than any other (a tie replaces nothing: both are kept and nothing is guessed).
// The replaced memory is never deleted: it becomes SUPERSEDED, linked to its successor, with its own provenance intact, and can be restored (MemoryEngine.supersedeMemory / restoreSuperseded).
// Idea credit: Mem0 (Apache-2.0, 0724291b) reconciles every new fact against similar existing memories with ADD / UPDATE / DELETE / NONE and keeps a history; Letta's memory blocks are edited
// by exact replace (Apache-2.0, 56ba9c25). NAgex reimplements the reconcile-with-history idea with an explicit authorization rule instead of a model's say-so: nothing here is copied.
import { MEMORY_RELEVANCE_STOPWORDS } from './personal-context.service.js';
import type { MemoryRecord } from './memory.engine.js';

// Words that say "this replaces what I said before". Not a classifier of meaning - just the cues a person actually writes.
const CORRECTION_CUES = /(대신|이제는|이제|이젠|더\s*이상|바꿨|바뀌었|바꿀게|바꿔|아니라|말고|이사했|이사를|옮겼|변경했|변경됐|그만|no\s+longer|not\s+anymore|anymore|instead\s+of|instead|actually|switched\s+to|changed\s+to|moved\s+to|now\s+(?:i|my|we))/i;

export function hasCorrectionCue(text: string): boolean {
  return CORRECTION_CUES.test(text);
}

// Korean particles / endings that stick to a noun or verb stem; stripped so "커피를" and "커피" are the same topic word.
const PARTICLES = ['에서는', '으로는', '에게는', '이에요', '입니다', '이야', '에서', '으로', '에게', '까지', '부터', '처럼', '보다', '이랑', '예요', '랑', '와', '과', '은', '는', '이', '가', '을', '를', '의', '도', '만', '에', '로', '야'];
const SINGLE_CHAR_STOP = new Set(['그', '저', '이', '내', '나', '너', '것', '수', '등', '더', '좀', '꼭', '또']);
const EXTRA_STOPWORDS = new Set([
  '기억해줘', '기억해', '기억', '나는', '내가', '저는', '제가', '이제', '이제는', '이젠', '대신', '더', '이상', '아주', '정말', '항상', '그냥', '있어', '있다', '해요', '합니다', '했어', '하고', '그리고',
  'now', 'actually', 'instead', 'remember', 'please', 'i', 'my', 'me', 'am', 'no', 'longer', 'anymore', 'prefer', 'like', 'use', 'the',
]);

function stem(token: string): string {
  if (!/[가-힣]/.test(token)) return token;
  for (const particle of PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle)) return token.slice(0, token.length - particle.length);
  }
  return token;
}

/** The topic words of a statement: lower-cased, particles stripped, filler removed. */
export function topicTokens(text: string): string[] {
  const raw = (text || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set<string>();
  for (const token of raw) {
    const s = stem(token);
    if (!s || EXTRA_STOPWORDS.has(s) || EXTRA_STOPWORDS.has(token) || MEMORY_RELEVANCE_STOPWORDS.has(s)) continue;
    const hangul = /[가-힣]/.test(s);
    if (hangul ? s.length < 2 && SINGLE_CHAR_STOP.has(s) : s.length < 3) continue;
    out.add(s);
  }
  return [...out];
}

export interface SupersedeTarget {
  memory: MemoryRecord;
  sharedTopics: string[];
}

const SUPERSEDABLE_TYPES = new Set(['PREFERENCE', 'FACT', 'PROJECT_CONTEXT', 'RELATIONSHIP', 'DECISION']);

/**
 * Which earlier memory does this explicit statement replace? One, or none. `candidates` must already be the person's own ACTIVE memories.
 * Only memories the person confirmed or stated themselves can be replaced by a correction (a suggestion that was never confirmed is not "what they said before").
 */
export function findSupersedeTarget(text: string, candidates: readonly MemoryRecord[]): SupersedeTarget | null {
  if (!hasCorrectionCue(text)) return null;
  const mine = new Set(topicTokens(text));
  if (mine.size === 0) return null;
  let best: SupersedeTarget | null = null;
  let tie = false;
  for (const memory of candidates) {
    if (memory.lifecycle !== 'ACTIVE') continue;
    if (memory.type && !SUPERSEDABLE_TYPES.has(memory.type)) continue;
    if (!memory.userConfirmed && memory.memoryOrigin !== 'EXPLICIT_USER') continue;
    const value = typeof memory.content.value === 'string' ? memory.content.value : JSON.stringify(memory.content.value ?? '');
    const theirs = topicTokens(`${memory.content.subject === 'User Preference' ? '' : memory.content.subject} ${value}`);
    const shared = theirs.filter((token) => mine.has(token));
    if (shared.length === 0) continue;
    if (!best || shared.length > best.sharedTopics.length) { best = { memory, sharedTopics: shared }; tie = false; }
    else if (shared.length === best.sharedTopics.length) tie = true;
  }
  return best && !tie ? best : null;
}
