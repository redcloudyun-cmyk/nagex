// Reads ONE turn in the light of the conversation it belongs to.
//
// A person does not repeat the subject in every message: "make it a table" is about the comparison two turns ago, and "isn't that wrong, X is on sale now" is about an earlier ANSWER. Judged alone
// (the way the freshness classifier and the web search used to see them) such a turn has no subject, so nothing is looked up and the model answers from memory.
//
// This module is deterministic and conservative:
//   - it only ever ADDS context (the earlier question's words) to what is retrieved; it never changes the person's message and never sends the earlier ANSWER to a search engine;
//   - it recognises a challenge to an earlier answer, so the answer can be checked and corrected explicitly instead of defended or repeated;
//   - when it is unsure the turn is a NEW_QUESTION and behaves exactly as before.
import { QuestionClassificationService } from './question-classification.service.js';

export interface ConversationTurn { role: 'user' | 'assistant'; content: string }

export type TurnKind = 'NEW_QUESTION' | 'FOLLOW_UP' | 'CORRECTION';

export interface TurnAnalysis {
  kind: TurnKind;
  /** what the freshness classifier and the search see: the message alone for a new question; the earlier question's subject plus the message for a follow-up or a correction */
  retrievalQuery: string;
  /** a challenge: the earlier assistant answer it is about (bounded), so the model can find the disputed claim */
  disputedAnswer: string | null;
  /** the earlier user question(s) whose subject the retrieval query borrowed */
  borrowedFrom: string[];
}

const MAX_QUERY_CHARS = 360;
const MAX_DISPUTED_CHARS = 2400;
const MAX_LOOKBACK_USER_TURNS = 4;

// "that is wrong / isn't it / are you sure / actually ..." - the person says an earlier statement is not right
const CORRECTION_KO = /(잘못|틀렸|틀린|틀리|아닌가|아니지\s*않|아닌데|아니야|사실과\s*다|사실이\s*아니|오류|정정|그건\s*아니|맞지\s*않|확실해|확실한가|다시\s*확인|재확인|거짓|왜곡)/;
const CORRECTION_EN = /\b(wrong|incorrect|mistaken|mistake|that'?s not (right|true|correct)|not true|not correct|are you sure|you said|you claimed|isn'?t that|aren'?t you|double-?check|re-?check)\b/i;

// a turn that leans on an earlier one: pronouns, "in a table", "in more detail", "and ...", very short requests
const REFERENTIAL_KO = /^(그럼|그러면|그리고|그래서|또|그건|그것|이건|이것|위|방금|앞서|아까|더|다시|표|비교표|정리|요약|자세히|왜|어떻게|그중|그\s*중)|(표로|비교표|표\s*로|도표|요약해|정리해|더\s*자세히|자세히\s*(설명|알려)|그것|그거|이거|그게|이게|위\s*내용|방금\s*(내용|답)|앞의)/;
const REFERENTIAL_EN = /^(and|so|then|also|what about|how about|why|how|make it|put it|show it|turn (it|that|this)|summari[sz]e|compare (them|those|these|it))\b|\b(in a table|as a table|table form|more detail|them|those|these|that one|the same|above)\b/i;

const SELF_CONTAINED_MIN_CHARS = 14;

export function isCorrectionChallenge(message: string): boolean {
  const text = String(message ?? '');
  return CORRECTION_KO.test(text) || CORRECTION_EN.test(text);
}

const classifier = new QuestionClassificationService();

// A short message that carries its own current-facts question ("서울 날씨 어때") has a subject of its own and borrows nothing; one that points back with a pronoun or a "…as a table" always does.
function leansOnEarlierTurn(message: string): boolean {
  const text = String(message ?? '').trim();
  if (text.length === 0) return false;
  if (REFERENTIAL_KO.test(text) || REFERENTIAL_EN.test(text)) return true;
  return text.length < SELF_CONTAINED_MIN_CHARS && classifier.classify(text).freshness === 'NONE';
}

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

export function analyzeTurn(message: string, conversation: ConversationTurn[] | undefined): TurnAnalysis {
  const text = String(message ?? '').trim();
  const alone: TurnAnalysis = { kind: 'NEW_QUESTION', retrievalQuery: text, disputedAnswer: null, borrowedFrom: [] };
  if (!text) return alone;

  // the current message is already stored in the context: look only at what came before it
  const history = (conversation ?? []).slice();
  while (history.length > 0 && history[history.length - 1].role === 'user' && history[history.length - 1].content.trim() === text) history.pop();
  if (history.length === 0) return alone;

  const lastAssistant = [...history].reverse().find((turn) => turn.role === 'assistant');
  const priorUsers = history.filter((turn) => turn.role === 'user').map((turn) => turn.content.trim()).filter(Boolean);
  if (priorUsers.length === 0) return alone;

  const correction = isCorrectionChallenge(text) && Boolean(lastAssistant);
  const followUp = !correction && leansOnEarlierTurn(text);
  if (!correction && !followUp) return alone;

  // walk back to the nearest question that stands on its own, keeping the follow-ups that came after it (they may carry the words "table", "cheaper" ...)
  const borrowed: string[] = [];
  for (let index = priorUsers.length - 1, taken = 0; index >= 0 && taken < MAX_LOOKBACK_USER_TURNS; index -= 1, taken += 1) {
    borrowed.unshift(priorUsers[index]);
    if (!leansOnEarlierTurn(priorUsers[index])) break;
  }
  const retrievalQuery = clip([...borrowed, text].join(' ').replace(/\s+/g, ' ').trim(), MAX_QUERY_CHARS);
  return {
    kind: correction ? 'CORRECTION' : 'FOLLOW_UP',
    retrievalQuery,
    disputedAnswer: correction && lastAssistant ? clip(lastAssistant.content.trim(), MAX_DISPUTED_CHARS) : null,
    borrowedFrom: borrowed,
  };
}
