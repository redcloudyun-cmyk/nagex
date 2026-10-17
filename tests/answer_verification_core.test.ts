// How an answer is checked after it is written - the CORE, without a server: the level (L0-L3) decided from the structure of the request and from what was observed, never from one keyword or a model's
// mood; the claims of an answer checked against the sources they cite (a figure that is in no source is UNSUPPORTED, a citation to an off-topic page is not support); a second DISTINCT model's reading of the same
// evidence, admitted only through quotes that are in the sources and compared with the answer; sources that give different dates; a bounded extra search; one rewrite; removal of what is still unsupported;
// and the status that follows from the facts. Deterministic, with scripted readers - NOT evidence that a real second model reviewed anything (that is a separate live step and is BLOCKED on this machine:
// only one provider is configured).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideLevel, structuralSignals, answerIsHedged } from '../src/verification/verification-policy.js';
import { checkClaims, extractClaims, datesGiven, detectReleaseDateConflicts, redactClaims } from '../src/verification/claim-checker.js';
import { GatewayReviewReading, compareWithReading, verifiedFacts, type ReviewReadingPort } from '../src/verification/independent-review.js';
import { AnswerVerifier, primaryLike, statusOf } from '../src/verification/answer-verifier.js';
import { parseVerificationPreference, runVerificationFlow, summarizeReport } from '../src/verification/verification-flow.js';
import { JevVerificationAdvisor, buildJevLevelBody } from '../src/verification/jev-verification-advisor.js';
import type { EvidencePack, EvidenceSource } from '../src/research/evidence-pack.types.js';

const src = (id: string, text: string, over: Partial<EvidenceSource> = {}): EvidenceSource => ({ sourceId: id, title: `Title ${id}`, url: `https://example.com/${id}`, snippet: '', retrievedAt: '2026-10-17T00:00:00Z', freshnessStatus: 'CURRENT', fullText: text, ...over });
const pack = (sources: EvidenceSource[], over: Partial<EvidencePack> = {}): EvidencePack => ({ evidencePackId: 'evpack_v', query: 'q', generatedAt: '2026-10-17T00:00:00Z', freshnessRequirement: 'REQUIRED', category: 'PRODUCT', status: 'SUCCESS', sources, ...over });

const FOLD7 = '오로라폴드7 | 출시일 2025-07-09 | 배터리 4400mAh | 디스플레이 8.0인치 | 무게 215g | 카메라 200MP';
const FOLD6 = '오로라폴드6 | 출시일 2024-07-10 | 배터리 4400mAh | 디스플레이 7.6인치 | 무게 239g | 카메라 50MP';

// ---- 1. the level -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the verification level is decided from structure and observation', () => {
  const level = (over: Partial<Parameters<typeof decideLevel>[0]> = {}) => decideLevel({ question: '피보나치 수열 설명해줘', freshness: 'NONE', category: 'GENERAL', turnKind: 'NEW_QUESTION', ...over });

  it('L0 for a simple task, L1 where sources merely help, L2 for current facts, a comparison, research or a challenge', () => {
    assert.equal(level().level, 'L0');
    assert.equal(level({ freshness: 'OPTIONAL' }).level, 'L1');
    assert.equal(level({ freshness: 'REQUIRED', question: 'Is the Fold7 released yet?' }).level, 'L2');
    assert.equal(level({ question: '오로라폴드6와 오로라폴드7 차이', freshness: 'NONE' }).level, 'L2', 'a comparison of named things is L2 even when freshness was not flagged');
    assert.equal(level({ question: '시장 동향을 조사해줘' }).level, 'L2');
    assert.equal(level({ turnKind: 'CORRECTION' }).level, 'L2');
    assert.ok(level({ freshness: 'REQUIRED' }).wantsIndependentReview);
    assert.equal(level({ freshness: 'OPTIONAL' }).wantsIndependentReview, false);
  });

  it('L3 only for a high-impact domain in a decision frame or with a dosage-like figure - a topic alone is not enough', () => {
    assert.equal(level({ question: '이부프로펜 400mg을 하루에 몇 번 복용해야 하나요?' }).level, 'L3');
    assert.equal(level({ question: 'Should I take out a loan to buy a house?' }).level, 'L3');
    assert.equal(level({ question: 'The history of the mortgage market in Korea' }).level, 'L0');
    assert.equal(level({ question: '이 약의 부작용이 궁금해요' }).level, 'L0', 'a topic without a decision or a dosage is not high impact by itself');
    const l3 = level({ question: 'Is it safe to take 800 mg of ibuprofen with food?' });
    assert.ok(l3.requiresPrimarySource);
    assert.equal(l3.maxExtraRetrievals, 2);
    assert.deepEqual(structuralSignals('Is it safe to take 800 mg of ibuprofen').highImpact, ['HEALTH']);
  });

  it('observed uncertainty and the person\'s request raise the level, and say who raised it; an advisor can only raise, and only when confident', () => {
    const hedged = level({ freshness: 'OPTIONAL', observedUncertainty: true });
    assert.equal(hedged.level, 'L2');
    assert.equal(hedged.basis, 'OBSERVED_UNCERTAINTY');
    const strong = level({ preference: 'STRONG' });
    assert.equal(strong.level, 'L2');
    assert.equal(strong.basis, 'USER_PREFERENCE');
    assert.equal(level({ freshness: 'REQUIRED', question: 'Fold7 released?', preference: 'STRONG' }).level, 'L3');
    assert.equal(level({ freshness: 'REQUIRED', question: 'Fold7 released?', advice: { level: 'L3', confidence: 0.9, provider: 'jev' } }).level, 'L3');
    const lowered = level({ freshness: 'REQUIRED', question: 'Fold7 released?', advice: { level: 'L0', confidence: 0.99, provider: 'jev' } });
    assert.equal(lowered.level, 'L2', 'an advisor cannot lower the level');
    const unsure = level({ freshness: 'REQUIRED', question: 'Fold7 released?', advice: { level: 'L3', confidence: 0.4, provider: 'jev' } });
    assert.equal(unsure.level, 'L2', 'low confidence is no advice');
    assert.ok(answerIsHedged('이 내용은 확인되지 않았습니다.'));
    assert.equal(answerIsHedged('폴드7은 215g입니다.'), false);
  });

  it('the person\'s preference is read as it is sent', () => {
    assert.equal(parseVerificationPreference({ requestMetadata: { verificationPreference: 'STRONG' } }), 'STRONG');
    assert.equal(parseVerificationPreference({ requestMetadata: { verificationPreference: 'weird' } }), 'AUTO');
    assert.equal(parseVerificationPreference(undefined), 'AUTO');
  });
});

// ---- 2. claims against sources ------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('a claim is supported only by what its cited source says', () => {
  const sources = [src('src_1', FOLD7), src('src_2', FOLD6)];

  it('an answer is cut into claims: sentences and table rows (header and separator are not claims), with the sources each cites', () => {
    const answer = ['오로라폴드7은 215g입니다 [src_1].', '', '| 항목 | 폴드6 | 폴드7 |', '|---|---|---|', '| 무게 | 239g [src_2] | 215g [src_1] |', '분위기가 좋습니다.'].join('\n');
    const claims = extractClaims(answer);
    assert.equal(claims.length, 2);
    assert.deepEqual(claims[0].sourceIds, ['src_1']);
    assert.deepEqual(claims[1].sourceIds, ['src_2', 'src_1']);
    assert.ok(claims[1].figures.includes('239') && claims[1].figures.includes('215'));
    assert.equal(claims.some((c) => /항목/.test(c.text)), false, 'the header row is not a claim');
  });

  it('what counts as a material claim: a figure, a date, a statement that something IS or WAS released - not every sentence that merely contains the word', () => {
    const material = (text: string) => extractClaims(text).map((c) => c.material);
    assert.deepEqual(material('| 출시 색상 | 젯 블랙, 블루 섀도우 | [src_1]'), [false], 'a colour list');
    assert.deepEqual(material('The available source says the screen is larger [src_1].'), [false]);
    assert.deepEqual(material('오로라폴드7은 이미 출시되었습니다 [src_1].'), [true]);
    assert.deepEqual(material('The Switch 2 has been released [src_1].'), [true]);
    assert.deepEqual(material('오로라폴드7은 215g입니다 [src_1].'), [true]);
    assert.deepEqual(material('좋은 제품입니다.'), []);
  });
  it('SUPPORTED when every figure is in the cited source; UNSUPPORTED when a figure is in no source; a supported figure that was cited to the wrong source is supported and says so', () => {
    const [ok, wrong, miscited] = checkClaims([
      { text: '오로라폴드7의 무게는 215g입니다', sourceIds: ['src_1'], figures: ['215'], material: true },
      { text: '오로라폴드7의 배터리는 5000mAh입니다', sourceIds: ['src_1'], figures: ['5000'], material: true },
      { text: '오로라폴드6의 무게는 239g입니다', sourceIds: ['src_1'], figures: ['239'], material: true },
    ], sources);
    assert.equal(ok.status, 'SUPPORTED');
    assert.equal(wrong.status, 'UNSUPPORTED');
    assert.equal(wrong.reason, 'FIGURE_NOT_IN_ANY_SOURCE');
    assert.equal(miscited.status, 'SUPPORTED');
    assert.equal(miscited.reason, 'FIGURE_ONLY_IN_UNCITED_SOURCE');
    assert.ok(miscited.sourceIds.includes('src_2'));
  });

  it('a citation to a page about another product is not support; a claim with nothing checkable is UNCHECKABLE, never "supported"; with no sources nothing is checkable', () => {
    const offTopic = checkClaims([{ text: '오로라폴드8의 무게는 210g입니다', sourceIds: ['src_1'], figures: ['210'], material: true }], sources)[0];
    assert.equal(offTopic.status, 'UNSUPPORTED');
    assert.equal(offTopic.reason, 'CITED_SOURCE_OFF_TOPIC');
    const prose = checkClaims([{ text: '꽤 좋은 제품입니다', sourceIds: ['src_1'], figures: [], material: false }], sources)[0];
    assert.equal(prose.status, 'UNCHECKABLE');
    const none = checkClaims([{ text: '215g입니다', sourceIds: [], figures: ['215'], material: true }], [])[0];
    assert.equal(none.status, 'UNCHECKABLE');
  });

  it('release dates that differ between two sources for the same named thing are a conflict; the same date, or different kinds of date, are not', () => {
    const a = src('src_1', '오로라폴드8은 2026-07-22 에 출시되었다.');
    const b = src('src_2', '오로라폴드8 출시일: 2026년 8월 5일.');
    const conflicts = detectReleaseDateConflicts([a, b], '오로라폴드8 출시일');
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].values.map((v) => v.value).sort(), ['2026-07-22', '2026-08-05']);
    assert.equal(detectReleaseDateConflicts([a, src('src_3', '오로라폴드8은 2026년 7월 22일 출시되었다.')], '오로라폴드8').length, 0);
    assert.equal(detectReleaseDateConflicts([a, src('src_4', '오로라폴드8은 2026년 6월 10일 언팩에서 발표되었다.')], '오로라폴드8').length, 0, 'an announcement date and a release date are different things');
  });

  it('a date is given to a named thing only when it follows the name closely: a sentence with two products gives each its own date; a successor or an unrelated date gives nothing', () => {
    const both = '오로라폴드7은 2025-07-09에 출시되었고 오로라폴드8은 2026-07-22에 출시되었다.';
    assert.deepEqual(datesGiven(both, '오로라폴드7'), [{ kind: 'RELEASE', value: '2025-07-09' }]);
    assert.deepEqual(datesGiven(both, '오로라폴드8'), [{ kind: 'RELEASE', value: '2026-07-22' }]);
    assert.deepEqual(datesGiven('오로라폴드8은 오로라폴드7의 후속작으로 2026-07-22 공개되었다.', '오로라폴드7'), [], 'a relation between the name and the date: nothing is claimed');
    assert.deepEqual(datesGiven('오로라폴드7 사양 안내 문서입니다. 문서 갱신일은 2026-09-01 입니다.', '오로라폴드7'), [], 'a date with no release or announcement word is not a release date');
    assert.deepEqual(datesGiven('오로라폴드7은 2025년 7월 9일 언팩 행사에서 공개되었다.', '오로라폴드7'), [{ kind: 'ANNOUNCE', value: '2025-07-09' }]);
    assert.deepEqual(datesGiven('Helio Watch 4 was released on 2026-05-14 in most regions.', 'watch4'), [{ kind: 'RELEASE', value: '2026-05-14' }]);
  });

  it('one source that lists several dates for a name is not "disagreeing with itself": only two sources that each give one different date are a conflict', () => {
    const one = src('src_1', '오로라폴드7은 2025-07-09에 출시되었다. 오로라폴드7은 2025-07-25에도 출시되었다.');
    const other = src('src_2', '오로라폴드7은 2025-07-09에 출시되었다.');
    assert.equal(detectReleaseDateConflicts([one, other], '오로라폴드7 출시일').length, 0);
  });
  it('a conflict names the thing as the person wrote it and says what kind of date it is (the screen words it in the language of the person)', () => {
    const a = src('src_1', 'Helio Watch 4 was released on 2026-05-14 in most regions.');
    const b = src('src_2', 'The Helio Watch 4 release date: May 20, 2026 - on 2026-05-20 it went on sale.');
    const [conflict] = detectReleaseDateConflicts([a, b], 'When was the Helio Watch 4 released?');
    assert.equal(conflict.kind, 'RELEASE_DATE');
    assert.equal(conflict.subject, 'Helio Watch 4');
  });
});

// ---- 3. the second reading ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('a second, distinct model reads the same evidence; only what survives NAgex\'s own quote check is admitted', () => {
  const sources = [src('src_1', FOLD7)];
  const goodRaw = [{ sourceId: 'src_1', statement: '오로라폴드7의 배터리는 4400mAh이다', quote: '오로라폴드7 | 출시일 2025-07-09 | 배터리 4400mAh | 디스플레이 8.0인치' }];

  it('a fact whose quote is not in the source, or whose figure is not in the quote, is refused', () => {
    const raw = [...goodRaw, { sourceId: 'src_1', statement: '오로라폴드7의 배터리는 5000mAh이다', quote: '오로라폴드7 | 출시일 2025-07-09 | 배터리 5000mAh | 디스플레이 8.0인치' }, { sourceId: 'src_9', statement: '오로라폴드7은 215g이다', quote: '오로라폴드7 | 출시일 2025-07-09 | 무게 215g | 카메라 200MP' }];
    const facts = verifiedFacts(raw, sources);
    assert.equal(facts.length, 1);
    assert.match(facts[0].statement, /4400/);
  });

  it('the reading disagrees with an unsupported figure: the claim becomes CONTRADICTED by a verified fact; an agreement is counted; a supported claim is never overruled', () => {
    const facts = verifiedFacts(goodRaw, sources);
    const claims = checkClaims([
      { text: '오로라폴드7의 배터리는 5000mAh입니다', sourceIds: ['src_1'], figures: ['5000'], material: true },
      { text: '오로라폴드7의 배터리는 4400mAh입니다', sourceIds: ['src_1'], figures: ['4400'], material: true },
    ], sources);
    const compared = compareWithReading(claims, facts);
    assert.equal(compared.claims[0].status, 'CONTRADICTED');
    assert.equal(compared.claims[0].reason, 'INDEPENDENT_READING_DIFFERS');
    assert.match(compared.claims[0].found ?? '', /4400mAh/);
    assert.equal(compared.claims[1].status, 'SUPPORTED');
    assert.equal(compared.agreements, 1);
    assert.equal(compared.disagreements.length, 1);
  });

  it('independence is a property of the PROVIDER: a distinct one is independent, the same one is SELF_REVIEW (and only allowed when asked), none is unavailable', () => {
    const model = { researchExtractClaims: async () => ({ data: { claims: [] }, provider: 'x', model: 'm' }) };
    const reading = new GatewayReviewReading({ statuses: () => [{ provider: 'nebius', configured: true, status: 'LIVE' }, { provider: 'gemini', configured: true, status: 'LIVE' }] }, model);
    assert.deepEqual(reading.plan('nebius', false), { mode: 'INDEPENDENT_MODEL_REVIEW', provider: 'gemini' });
    const single = new GatewayReviewReading({ statuses: () => [{ provider: 'nebius', configured: true, status: 'LIVE' }, { provider: 'openai', configured: false, status: 'UNCONFIGURED' }] }, model);
    assert.equal(single.plan('nebius', false), null);
    assert.deepEqual(single.plan('nebius', true), { mode: 'SELF_REVIEW', provider: 'nebius' });
    assert.equal(new GatewayReviewReading({ statuses: () => [] }, model).plan('nebius', true), null);
  });
});

// ---- 4. the verifier ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the verifier: claims, the second reading, one bounded search, the status', () => {
  const sources = [src('src_1', FOLD7), src('src_2', FOLD6)];
  const decide = (level: 'L1' | 'L2' | 'L3') => ({ level, basis: 'RULES' as const, reasons: [], requiresPrimarySource: level === 'L3', wantsIndependentReview: level !== 'L1', maxExtraRetrievals: level === 'L3' ? 2 : level === 'L2' ? 1 : 0 });
  const readerOf = (provider: string, raw: unknown[], plan: 'INDEPENDENT_MODEL_REVIEW' | 'SELF_REVIEW' = 'INDEPENDENT_MODEL_REVIEW'): ReviewReadingPort & { calls: number } => {
    const port = { calls: 0, plan: () => ({ mode: plan, provider }), read: async () => { port.calls += 1; return { claims: raw, provider, model: 'm' }; } };
    return port;
  };
  const input = (answer: string, extra: Record<string, unknown> = {}) => ({ question: '오로라폴드6와 오로라폴드7 스펙 차이', language: 'ko' as const, answer, pack: pack(sources), decision: decide('L2'), answerProvider: 'nebius', ...extra });

  it('every material claim supported -> VERIFIED, and the independent reading is recorded as such', async () => {
    const reader = readerOf('gemini', [{ sourceId: 'src_1', statement: '오로라폴드7의 무게는 215g이다', quote: '오로라폴드7 | 출시일 2025-07-09 | 배터리 4400mAh | 디스플레이 8.0인치 | 무게 215g' }]);
    const { report } = await new AnswerVerifier({ reading: reader }).verify(input('오로라폴드7의 무게는 215g입니다 [src_1]. 오로라폴드6의 무게는 239g입니다 [src_2].'));
    assert.equal(report.status, 'VERIFIED');
    assert.equal(report.review.mode, 'INDEPENDENT_MODEL_REVIEW');
    assert.equal(report.review.reviewerProvider, 'gemini');
    assert.equal(report.counts.supported, 2);
    assert.equal(reader.calls, 1);
  });

  it('a reviewer that turns out to be the provider that wrote the answer is SELF_REVIEW - the label follows who really answered', async () => {
    const { report } = await new AnswerVerifier({ reading: readerOf('nebius', []) }).verify(input('오로라폴드7의 무게는 215g입니다 [src_1].'));
    assert.equal(report.review.mode, 'SELF_REVIEW');
  });

  it('with no distinct provider the check still runs, deterministically, and says the independent reading was UNAVAILABLE; at L3 that caps the status', async () => {
    const none: ReviewReadingPort = { plan: () => null, read: async () => { throw new Error('no'); } };
    const l2 = await new AnswerVerifier({ reading: none }).verify(input('오로라폴드7의 무게는 215g입니다 [src_1].'));
    assert.equal(l2.report.review.mode, 'UNAVAILABLE');
    assert.equal(l2.report.status, 'VERIFIED');
    const l3 = await new AnswerVerifier({ reading: none }).verify(input('오로라폴드7의 무게는 215g입니다 [src_1].', { decision: decide('L3') }));
    assert.equal(l3.report.status, 'PARTIALLY_VERIFIED');
    assert.ok(l3.report.statusReasons.includes('NO_INDEPENDENT_REVIEW_AT_L3'));
    assert.ok(l3.report.statusReasons.includes('NO_PRIMARY_LIKE_SOURCE'));
  });

  it('an unsupported figure -> not VERIFIED; the reading that found a different figure in the sources -> DISPUTED, never "the majority"', async () => {
    const reader = readerOf('gemini', [{ sourceId: 'src_1', statement: '오로라폴드7의 배터리는 4400mAh이다', quote: '오로라폴드7 | 출시일 2025-07-09 | 배터리 4400mAh | 디스플레이 8.0인치' }]);
    const bad = await new AnswerVerifier({ reading: reader }).verify(input('오로라폴드7의 배터리는 5000mAh입니다 [src_1]. 오로라폴드7의 무게는 215g입니다 [src_1].'));
    assert.equal(bad.report.status, 'DISPUTED');
    assert.equal(bad.report.counts.contradicted, 1);
    assert.equal(bad.report.review.disagreements.length, 1);
    const none: ReviewReadingPort = { plan: () => null, read: async () => { throw new Error('no'); } };
    const partial = await new AnswerVerifier({ reading: none }).verify(input('오로라폴드7의 배터리는 5000mAh입니다 [src_1]. 오로라폴드7의 무게는 215g입니다 [src_1].'));
    assert.equal(partial.report.status, 'PARTIALLY_VERIFIED');
  });

  it('no sources -> UNVERIFIED; nothing material to check -> UNVERIFIED; L0 -> NOT_REQUIRED', async () => {
    const v = new AnswerVerifier({});
    assert.equal((await v.verify(input('215g입니다.', { pack: pack([]) }))).report.status, 'UNVERIFIED');
    assert.equal((await v.verify(input('좋은 제품이라고 생각합니다.'))).report.status, 'UNVERIFIED');
    assert.equal((await v.verify(input('아무 말', { decision: { ...decide('L1'), level: 'L0' as const } }))).report.status, 'NOT_REQUIRED');
  });

  it('sources that disagree on a release date and an answer that does not say so are DISPUTED; an answer that names both is not', async () => {
    const a = src('src_1', '오로라폴드8은 2026-07-22 에 출시되었다.');
    const b = src('src_2', '오로라폴드8 출시일: 2026년 8월 5일.');
    const v = new AnswerVerifier({});
    const silent = await v.verify({ ...input('오로라폴드8은 2026년 7월 22일에 출시되었습니다 [src_1].'), question: '오로라폴드8 출시일', pack: pack([a, b]) });
    assert.equal(silent.report.status, 'DISPUTED');
    assert.equal(silent.report.conflicts.length, 1);
    const open = await v.verify({ ...input('출처에 따라 다릅니다: 2026년 7월 22일 [src_1] 또는 2026년 8월 5일 [src_2]입니다.'), question: '오로라폴드8 출시일', pack: pack([a, b]) });
    assert.notEqual(open.report.status, 'DISPUTED');
  });

  it('one bounded extra search for what is in dispute: its sources are checked like the others; a failing search changes nothing; Web off allows none', async () => {
    const more = pack([src('src_1', '오로라폴드7 | 배터리 4400mAh | 보충 자료', { url: 'https://example.org/extra' })]);
    let searches = 0;
    const retrieve = async () => { searches += 1; return more; };
    const bad = '오로라폴드7의 배터리는 4400mAh입니다 [src_2].';
    const v = new AnswerVerifier({ retrieve });
    const out = await v.verify({ ...input(bad), pack: pack([src('src_1', '오로라폴드7 | 무게 215g')]) });
    assert.equal(searches, 1);
    assert.equal(out.report.extraRetrievals, 1);
    assert.equal(out.addedSources.length, 1);
    assert.equal(out.addedSources[0].sourceId, 'src_2', 'ids continue after the existing ones');
    await v.verify({ ...input(bad), pack: pack([src('src_1', '오로라폴드7 | 무게 215g')]), allowRetrieval: false });
    assert.equal(searches, 1, 'Web off: no extra search');
    const failing = new AnswerVerifier({ retrieve: async () => { throw new Error('down'); } });
    const survived = await failing.verify({ ...input(bad), pack: pack([src('src_1', '오로라폴드7 | 무게 215g')]) });
    assert.equal(survived.report.status === 'VERIFIED', false);
  });

  it('a primary-like source is judged by its address, as a heuristic: an authority\'s own area, not an encyclopedia', () => {
    assert.equal(primaryLike(src('a', '', { url: 'https://www.fda.gov/drugs/x' })), true);
    assert.equal(primaryLike(src('a', '', { url: 'https://news.samsung.example/newsroom/x' })), false);
    assert.equal(primaryLike(src('a', '', { url: 'https://newsroom.example.com/x' })), true);
    assert.equal(primaryLike(src('a', '', { url: 'https://ko.wikipedia.org/wiki/X' })), false);
  });

  it('statusOf: stale evidence for a LIVE value (a price) caps the status; for a product specification it does not', () => {
    const stale = [src('src_1', FOLD7, { freshnessStatus: 'STALE' })];
    const result = statusOf({ decision: decide('L2'), claims: checkClaims([{ text: '215g', sourceIds: ['src_1'], figures: ['215'], material: true }], stale), sources: stale, freshnessRequired: true, category: 'PRODUCT_PRICE', review: { mode: 'NOT_REQUIRED', answerProvider: null, reviewerProvider: null, independentFacts: 0, disagreements: [] }, conflicts: [], answer: '215g [src_1]' });
    assert.equal(result.status, 'PARTIALLY_VERIFIED');
    assert.deepEqual(result.reasons, ['EVIDENCE_NOT_CURRENT']);
  });
});

// ---- 5. correcting an answer -------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('a failed check gets one rewrite from the sources, then removal - and the report says what happened', () => {
  const sources = [src('src_1', FOLD7)];
  const flowInput = (answer: string, revise: (p: string[], a: string) => Promise<string | null>, reading: ReviewReadingPort | null = null) => ({
    verifier: new AnswerVerifier({ reading }), question: '오로라폴드7 스펙', language: 'ko' as const, answer, pack: pack(sources), turnKind: 'NEW_QUESTION' as const,
    preference: 'AUTO' as const, allowRetrieval: true, answerProvider: 'nebius', revise: async (p: string[], a: string) => revise(p, a),
  });

  it('a rewrite that fixes the problem is delivered as REWRITTEN with the better status', async () => {
    let asked: string[] = [];
    const out = await runVerificationFlow(flowInput('오로라폴드7의 배터리는 5000mAh입니다 [src_1]. 무게는 215g입니다 [src_1].', async (problems) => { asked = problems; return '오로라폴드7의 배터리는 4400mAh입니다 [src_1]. 무게는 215g입니다 [src_1].'; }));
    assert.equal(asked.length, 1);
    assert.match(asked[0], /5000mAh/);
    assert.equal(out.report.revision, 'REWRITTEN');
    assert.equal(out.report.status, 'VERIFIED');
    assert.ok(out.message.includes('4400mAh'));
  });

  it('a rewrite that does not help is not trusted: the unsupported statements are removed and the answer says so; the status is not VERIFIED by pretending', async () => {
    const out = await runVerificationFlow(flowInput('오로라폴드7의 배터리는 5000mAh입니다 [src_1]. 오로라폴드7의 무게는 215g입니다 [src_1].', async () => '오로라폴드7의 배터리는 5100mAh입니다 [src_1]. 오로라폴드7의 무게는 215g입니다 [src_1].'));
    assert.equal(out.report.revision, 'REDACTED');
    assert.equal(out.message.includes('5000') || out.message.includes('5100'), false);
    assert.ok(out.message.includes('215g'));
    assert.ok(out.message.includes('※ 근거로 확인되지 않은 내용은 뺐습니다.'));
    assert.equal(out.report.counts.unsupported, 0);
  });

  it('a model that cannot rewrite (throws, returns nothing) still ends with the unsupported statements removed - one rewrite, never a loop', async () => {
    let calls = 0;
    const out = await runVerificationFlow(flowInput('오로라폴드7의 배터리는 5000mAh입니다 [src_1].', async () => { calls += 1; throw new Error('down'); }));
    assert.equal(calls, 1);
    assert.equal(out.report.revision, 'REDACTED');
    assert.equal(out.message.includes('5000'), false);
  });

  it('a clean answer is never rewritten, and a level below L2 never asks for a rewrite', async () => {
    let calls = 0;
    const clean = await runVerificationFlow(flowInput('오로라폴드7의 무게는 215g입니다 [src_1].', async () => { calls += 1; return null; }));
    assert.equal(clean.report.revision, 'NONE');
    assert.equal(clean.report.status, 'VERIFIED');
    const l1 = await runVerificationFlow({ ...flowInput('오로라폴드7의 배터리는 5000mAh입니다 [src_1].', async () => { calls += 1; return null; }), pack: pack(sources, { freshnessRequirement: 'OPTIONAL', category: 'TECHNOLOGY' }), question: 'a plain topic' });
    assert.equal(calls, 0);
    assert.equal(l1.report.level, 'L1');
  });

  it('removal keeps a table whole when only some rows go, and drops a table that lost every row', () => {
    const answer = ['| 항목 | 값 |', '|---|---|', '| 배터리 | 5000mAh [src_1] |', '| 무게 | 215g [src_1] |'].join('\n');
    const some = redactClaims(answer, new Set(['| 배터리 | 5000mAh |']), 'ko');
    assert.ok(some.includes('| 무게 | 215g'));
    assert.equal(some.includes('5000'), false);
    assert.ok(some.includes('| 항목 | 값 |'));
    const all = redactClaims(answer, new Set(['| 배터리 | 5000mAh |', '| 무게 | 215g |']), 'ko');
    assert.equal(all.includes('|'), false);
  });

  it('the summary for the client carries counts and the statements that need attention - no provider name, no internal id of a reviewer', async () => {
    const reader = readerOfProvider('gemini');
    const out = await runVerificationFlow({ ...flowInput('오로라폴드7의 배터리는 5000mAh입니다 [src_1].', async () => null, reader) });
    const summary = summarizeReport(out.report);
    const text = JSON.stringify(summary);
    assert.equal(text.includes('gemini'), false);
    assert.equal(text.includes('nebius'), false);
    assert.ok(Array.isArray(summary.claimsNeedingAttention));
    function readerOfProvider(provider: string): ReviewReadingPort { return { plan: () => ({ mode: 'INDEPENDENT_MODEL_REVIEW', provider }), read: async () => ({ claims: [], provider, model: 'm' }) }; }
  });
});

// ---- 6. the advisor ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('JEV may ask for deeper checking - through the interface the repository already uses, and never more than that', () => {
  const features = { freshness: 'REQUIRED', category: 'PRODUCT', turnKind: 'NEW_QUESTION', comparison: true, research: false, highImpact: [], hedged: false, sourcesBucket: 'SEVERAL' as const, baseLevel: 'L2' as const };

  it('one choice question over L0-L3 in the System One shape; nothing the person wrote is in the request', () => {
    const body = buildJevLevelBody({ ...features, highImpact: ['HIGH_IMPACT_HEALTH'] });
    const text = JSON.stringify(body);
    assert.equal((body.questions as any).level.type, 'choice');
    assert.deepEqual((body.questions as any).level.choices, ['L0', 'L1', 'L2', 'L3']);
    assert.match(text, /answer-verification-depth/);
    assert.equal(/오로라|Fold|password|http/i.test(text), false);
  });

  it('a simulated service answers; garbage, errors and slow answers are no advice, and a failing advisor is given up on after two failures', async () => {
    const answer = (choice: unknown, confidence: unknown) => (async () => ({ ok: true, json: async () => ({ answers: { level: { choice, confidence } } }) })) as unknown as typeof fetch;
    assert.deepEqual(await new JevVerificationAdvisor({ apiKey: 'k', fetchFn: answer('L3', 0.9) }).advise(features), { level: 'L3', confidence: 0.9, provider: 'jev' });
    assert.equal(await new JevVerificationAdvisor({ apiKey: 'k', fetchFn: answer('L9', 0.9) }).advise(features), null);
    assert.equal(await new JevVerificationAdvisor({ apiKey: 'k', fetchFn: answer('L3', 7) }).advise(features), null);
    assert.equal(await new JevVerificationAdvisor({ fetchFn: answer('L3', 0.9) }).advise(features), null, 'no key: no call');
    let calls = 0;
    const broken = new JevVerificationAdvisor({ apiKey: 'k', fetchFn: (async () => { calls += 1; throw new Error('down'); }) as unknown as typeof fetch });
    await broken.advise(features); await broken.advise(features); await broken.advise(features);
    assert.equal(calls, 2, 'after two failures it is not asked again');
    const slow = new JevVerificationAdvisor({ apiKey: 'k', deadlineMs: 20, fetchFn: ((_u: unknown, init: any) => new Promise((_r, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); })) as unknown as typeof fetch });
    assert.equal(await slow.advise(features), null);
  });

  it('through the flow: advice raises the level, a lowering or failing advisor changes nothing, and correctness does not depend on it', async () => {
    const sources = [src('src_1', FOLD7)];
    const base = { verifier: new AnswerVerifier({}), question: 'Is the fold7 released?', language: 'ko' as const, answer: '오로라폴드7의 무게는 215g입니다 [src_1].', pack: pack(sources), turnKind: 'NEW_QUESTION' as const, preference: 'AUTO' as const, allowRetrieval: true, answerProvider: 'nebius', revise: async () => null };
    assert.equal((await runVerificationFlow({ ...base, advisor: { advise: async () => ({ level: 'L3', confidence: 0.9, provider: 'jev' }) } })).report.level, 'L3');
    assert.equal((await runVerificationFlow({ ...base, advisor: { advise: async () => ({ level: 'L0', confidence: 0.9, provider: 'jev' }) } })).report.level, 'L2');
    assert.equal((await runVerificationFlow({ ...base, advisor: { advise: async () => { throw new Error('jev down'); } } })).report.level, 'L2');
    assert.equal((await runVerificationFlow(base)).report.status, 'VERIFIED');
  });
});

describe('what the answer itself revealed raises the level only as far as L2', () => {
  it('a hedged answer to an ordinary question is checked harder (L1 -> L2); a hedged L2 answer is not turned into a high-impact one', () => {
    const base = { question: '노바OS 5 출시 여부', freshness: 'REQUIRED' as const, category: 'PRODUCT', turnKind: 'NEW_QUESTION' as const };
    assert.equal(decideLevel({ ...base, observedUncertainty: true }).level, 'L2');
    assert.equal(decideLevel({ question: '일반 질문', freshness: 'OPTIONAL', category: 'TECHNOLOGY', turnKind: 'NEW_QUESTION', observedUncertainty: true }).level, 'L2');
    assert.equal(decideLevel({ question: '일반 질문', freshness: 'NONE', category: 'GENERAL', turnKind: 'NEW_QUESTION', observedUncertainty: true }).level, 'L1');
  });
});

describe('what the answer itself revealed raises the level only as far as L2', () => {
  it('a hedged answer to an ordinary question is checked harder (L1 -> L2); a hedged L2 answer is not turned into a high-impact one', () => {
    const base = { question: '노바OS 5 출시 여부', freshness: 'REQUIRED' as const, category: 'PRODUCT', turnKind: 'NEW_QUESTION' as const };
    assert.equal(decideLevel({ ...base, observedUncertainty: true }).level, 'L2');
    assert.equal(decideLevel({ question: '일반 질문', freshness: 'OPTIONAL', category: 'TECHNOLOGY', turnKind: 'NEW_QUESTION', observedUncertainty: true }).level, 'L2');
    assert.equal(decideLevel({ question: '일반 질문', freshness: 'NONE', category: 'GENERAL', turnKind: 'NEW_QUESTION', observedUncertainty: true }).level, 'L1');
  });
});
