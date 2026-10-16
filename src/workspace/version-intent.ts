// "지난번 보고서 수정 전 버전과 지금 버전을 비교해줘" / "compare the earlier version of the deck with the current one" / "이전 버전으로 되돌려줘".
// Pure and side-effect free. It only recognises that the person is talking about the VERSIONS of a document or a deck they made: the comparison itself is computed by NAgex from stored text, and
// restoring is a button in the Versions tab (it creates a new version), so nothing here changes anything. A request that merely contains "version" and "compare" ("compare Python 2 and 3 versions")
// is not a version request unless a document or a deck is in play.

export type VersionAction = 'COMPARE' | 'RESTORE';
export type VersionTarget = 'DOCUMENT' | 'PRESENTATION';

export interface VersionIntent {
  action: VersionAction;
  /** null when the words do not say (the client then uses what is open, or the newest report) */
  target: VersionTarget | null;
}

const VERSION_WORD_KO = /(버전|수정\s*전|변경\s*전|고치기\s*전|고친\s*(전|후)|수정\s*후|수정본|개정\s*(본|판)?|이전\s*(본|판|것)|예전\s*(본|판|것))/;
const COMPARE_WORD_KO = /(비교|차이|달라진|바뀐|변경된|변경\s*사항|달라졌|바뀌었|\bdiff\b)/i;
const CHANGED_QUESTION_KO = /(뭐가|무엇이|어디가|어떤\s*부분이?)\s*(달라졌|바뀌었|변경됐|바뀐|달라진)/;
const RESTORE_WORD_KO = /(되돌려|되돌리|돌려\s*(놔|줘|주)|복원|복구|되살려)/;
const EARLIER_WORD_KO = /(이전|지난|예전|원래|처음|수정\s*전)/;

const VERSION_WORD_EN = /\b(versions?|before (the |my )?(edit|edits|change|changes|revision|revisions)|earlier (draft|copy|one)|previous (draft|copy|one|revision)|prior (draft|version)|original)\b/i;
const COMPARE_WORD_EN = /\b(compare|comparison|differences?|diff|what (has )?changed|changed between)\b/i;
const RESTORE_WORD_EN = /\b(restore|revert|roll ?back|go back to|bring back)\b/i;
const EARLIER_WORD_EN = /\b(previous|earlier|prior|original|before|last time|older)\b/i;

const DECK_NOUN = /(슬라이드|프레젠테이션|프리젠테이션|발표\s*자료|발표자료|피티|파워\s*포인트|파워포인트|\bppt\b|\bpptx\b|\b(slides?|slide deck|deck|presentation|powerpoint|keynote)\b)/i;
const DOCUMENT_NOUN = /(보고서|리포트|문서|기획서|제안서|회의록|요약서|소개서|계획서|명세서|설계서|\b(report|document|doc|proposal|brief|minutes|write-?up)\b)/i;
const MAKE_VERB = /(만들|만드|작성|생성|제작|\b(make|create|write|draft|generate|produce|build)\b)/i;

export function detectVersionIntent(text: string, options: { activeArtifact?: 'DOCUMENT' | 'PRESENTATION' | null } = {}): VersionIntent | null {
  const t = String(text || '').normalize('NFC');
  if (!t.trim()) return null;
  const deck = DECK_NOUN.test(t);
  const document = DOCUMENT_NOUN.test(t);
  // something of the person's own must be in play: a named document / deck or the one that is open
  if (!deck && !document && !options.activeArtifact) return null;
  // "make a report that compares ..." is a request to create, not to look at versions
  if (MAKE_VERB.test(t)) return null;
  const target: VersionTarget | null = deck ? 'PRESENTATION' : document ? 'DOCUMENT' : null;

  const restore = (RESTORE_WORD_KO.test(t) && (VERSION_WORD_KO.test(t) || EARLIER_WORD_KO.test(t))) || (RESTORE_WORD_EN.test(t) && (VERSION_WORD_EN.test(t) || EARLIER_WORD_EN.test(t)));
  if (restore) return { action: 'RESTORE', target };

  const compare =
    (COMPARE_WORD_KO.test(t) && VERSION_WORD_KO.test(t)) ||
    (CHANGED_QUESTION_KO.test(t) && (deck || document)) ||
    (COMPARE_WORD_EN.test(t) && VERSION_WORD_EN.test(t));
  if (compare) return { action: 'COMPARE', target };
  return null;
}
