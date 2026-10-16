// TEST-ONLY (not a test file): a LOCAL, deterministic stand-in for the model endpoint and the web-search endpoint, both on 127.0.0.1, so the PRODUCTION server (its real providers, router,
// AiService, evidence service, creation runtime and stores) can be driven end to end without any network or credential. It is a FAKE: a pass here proves NAgex's own chain
// (routing, request language, prompts, validation, persistence, ownership, UI), never that a real model or search provider answered. Real-provider runs are separate, opt-in scripts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LocalModelRequest { kind: 'browser-planner' | 'followups' | 'document' | 'presentation' | 'plan-advice' | 'plan-action' | 'research' | 'research-plan' | 'research-extract' | 'research-report' | 'chat' | 'other'; system: string; user: string; korean: boolean }

export interface LocalAiWorld {
  env: Record<string, string>;
  modelRequests: LocalModelRequest[];
  searchQueries: string[];
  failDocuments: (mode: 'off' | 'http500' | 'empty-content' | 'not-json') => void;
  failSearch: (on: boolean) => void;
  // The search results point at pages served by this world (loopback; the research report path may fetch them behind NAGEX_ALLOW_LOCAL_TEST_URLS) instead of the unreachable example.com addresses.
  useLocalPages: (on: boolean) => void;
  /** the address of a fixture page served by this world */
  pageUrl: (name: 'ai-adoption-survey' | 'ai-investment') => string;
  setChatDelayMs: (ms: number) => void;
  // what an ACTION plan is: the default send-mail plan, or a calendar event (for the next-actions journey)
  setActionPlan: (kind: 'mail' | 'calendar') => void;
  // the browser Agent's planner: given the Gateway adapter's own prompt, answers the next action as JSON (null = the planner says a person must act). Lets the production server's Agent loop run on the local model.
  // returning null makes the endpoint answer HTTP 503 (a model outage)
  setBrowserPlanner: (planner: ((system: string, user: string) => string | null) | null) => void;
  // OPT-IN: slides are not a Nemotron task, so they go to another provider. The Gemini endpoint is a fixed public URL; this redirects ONLY that host to the local model for the
  // IN-PROCESS production server (global fetch, restored on close) and returns the fake key env to start the harness with. Nothing leaves the machine.
  installGeminiBridge: () => Record<string, string>;
  close: () => Promise<void>;
}

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve) => { let data = ''; req.on('data', (c) => { data += c; }); req.on('end', () => resolve(data)); });
const listen = (server: http.Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

export async function startLocalAiWorld(): Promise<LocalAiWorld> {
  const modelRequests: LocalModelRequest[] = [];
  const searchQueries: string[] = [];
  let documentMode: 'off' | 'http500' | 'empty-content' | 'not-json' = 'off';
  let searchDown = false;
  let localPages = false;
  let searchPort = 0;
  let chatDelayMs = 0;
  let browserPlanner: ((system: string, user: string) => string | null) | null = null;
  let actionPlan: 'mail' | 'calendar' = 'mail';

  const model = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    const gemini = /:generateContent/.test(req.url ?? '');
    const messages: Array<{ role: string; content: string }> = gemini
      ? [
          { role: 'system', content: (body.systemInstruction?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('\n') },
          ...(body.contents ?? []).map((c: { role?: string; parts?: Array<{ text?: string }> }) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: (c.parts ?? []).map((p) => p.text ?? '').join('') })),
        ]
      : Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const user = String(messages.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '');
    const korean = /written in Korean|반드시 한국어로|Write in Korean/.test(system);
    const reply = (content: string) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(gemini ? JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }) : JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); };
    // ---- the cited research report: three model steps (the model only proposes; NAgex verifies against the pages it fetched from the search server below)
    if (/You plan web searches for a research question/.test(system)) {
      modelRequests.push({ kind: 'research-plan', system, user, korean });
      reply(JSON.stringify({ queries: ['ai assistant adoption 2026', 'ai tools investment 2026'] }));
      return;
    }
    if (/You extract verifiable facts for a research question/.test(system)) {
      modelRequests.push({ kind: 'research-extract', system, user, korean });
      const claims: Array<Record<string, unknown>> = [];
      for (const m of user.matchAll(/<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)) {
        if (m[2].includes('Adoption of AI assistants grew sharply among knowledge workers')) claims.push({ sourceId: m[1], statement: 'Adoption of AI assistants grew sharply among knowledge workers.', quote: 'Adoption of AI assistants grew sharply among knowledge workers', relevance: 5 });
        if (m[2].includes('Investment in AI tools increased by 18% in 2025')) claims.push({ sourceId: m[1], statement: 'Investment in AI tools increased by 18% in 2025.', quote: 'Investment in AI tools increased by 18% in 2025', relevance: 5 });
        // a statement the page does not contain: it must be refused by NAgex, never reach the report
        claims.push({ sourceId: m[1], statement: 'Every company replaced its staff with assistants in 2025.', quote: 'every company replaced its entire staff with AI assistants during 2025', relevance: 5 });
      }
      reply(JSON.stringify({ claims }));
      return;
    }
    if (/You write a cited research report/.test(system)) {
      modelRequests.push({ kind: 'research-report', system, user, korean });
      const idOf = (re: RegExp) => /^(C\d+) \(.*?\): (.*)$/m.exec(user.split('\n').filter((l) => re.test(l)).join('\n'))?.[1];
      const adoption = idOf(/Adoption of AI assistants/);
      const investment = idOf(/Investment in AI tools/);
      reply(JSON.stringify({
        title: korean ? 'AI 동향 보고서' : 'AI trends report',
        summary: adoption ? { kind: 'FACT', text: 'Adoption of AI assistants grew sharply among knowledge workers.', claimIds: [adoption] } : undefined,
        sections: [
          ...(adoption ? [{ heading: korean ? '도입 현황' : 'Adoption', paragraphs: [{ kind: 'FACT', text: 'Adoption of AI assistants grew sharply among knowledge workers.', claimIds: [adoption] }] }] : []),
          ...(investment ? [{ heading: korean ? '투자 현황' : 'Investment', paragraphs: [{ kind: 'FACT', text: 'Investment in AI tools increased by 18% in 2025.', claimIds: [investment] }] }] : []),
        ],
        conflicts: [],
      }));
      return;
    }
    if (/plans clear presentation decks/.test(system)) {
      modelRequests.push({ kind: 'presentation', system, user, korean });
      const asked = user.replace(/^Presentation Request:\s*/, '');
      const findings = /FINDINGS:/.test(asked);
      const sources = (asked.match(/https?:\/\/\S+/g) ?? []).slice(0, 5).map((s) => s.replace(/[)\]]+$/, ''));
      reply(JSON.stringify({
        title: korean ? '시장 동향 발표' : 'Market trends deck',
        subtitle: korean ? '확인된 출처 기반' : 'Based on verified sources',
        slides: [
          { title: korean ? '핵심 요약' : 'Key takeaways', bullets: [findings ? (korean ? '확인된 조사 결과에만 근거합니다' : 'Grounded only in the verified findings') : (korean ? '일반적인 요점입니다' : 'General points only'), korean ? '다음 단계를 정합니다' : 'Decide the next step'] },
          { title: korean ? '출처' : 'Sources', bullets: sources.length ? sources : [korean ? '출처 없음' : 'No sources'] },
        ],
      }));
      return;
    }
    if (/Return JSON with exact structure: \{"title"/.test(system)) {
      modelRequests.push({ kind: 'document', system, user, korean });
      if (documentMode === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"local model failure"}'); return; }
      if (documentMode === 'not-json') { reply('this is not json at all'); return; }
      const asked = user.replace(/^Document Request:\s*/, '');
      const first = asked.split('\n')[0].slice(0, 80);
      const findings = /FINDINGS:/.test(asked);
      const sources = (asked.match(/https?:\/\/\S+/g) ?? []).slice(0, 5);
      const title = korean ? '회의 보고서' : 'Meeting report';
      const content = documentMode === 'empty-content' ? '   ' : [
        `# ${title}`, '', korean ? '## 요약' : '## Summary', '',
        korean ? `요청 내용: ${first}` : `Request: ${first}`, '',
        findings ? (korean ? '확인된 조사 결과에만 근거해 작성했습니다.' : 'Written only from the verified findings.') : (korean ? '본문입니다. 승인 기반 실행의 핵심은 사람의 승인입니다.' : 'Body text. The core of approval-based execution is the human approval.'),
        ...(sources.length ? ['', korean ? '## 출처' : '## Sources', ...sources.map((s, i) => `- [${i + 1}] ${s.replace(/[)\]]+$/, '')}`)] : []),
      ].join('\n');
      reply(JSON.stringify({ title, summary: korean ? '한 페이지 요약 보고서입니다.' : 'A one-page summary report.', content }));
      return;
    }
    // the next actions of a conversation (todos/the follow-ups request): two things NAgex can do and one thing the person has to do themselves
    if (/You turn a conversation into the NEXT ACTIONS/.test(system)) {
      const ko = korean || /[가-힣]/.test(user);
      modelRequests.push({ kind: 'followups', system, user, korean: ko });
      reply(JSON.stringify({
        todos: [
          { title: ko ? '분기 계획 리뷰 회의 일정 잡기' : 'Schedule the quarterly plan review', prompt: ko ? '내일 오후 3시에 30분짜리 분기 계획 리뷰 회의 일정을 만들어줘' : 'Create a 30 minute quarterly plan review meeting tomorrow at 3 PM' },
          { title: ko ? 'AI 동향 조사하기' : 'Research AI trends', prompt: ko ? '최근 AI 동향을 조사해서 출처와 함께 알려줘' : 'Research the latest AI trends and cite sources' },
          { title: ko ? '홍보 영상 만들기' : 'Make a promo video', prompt: ko ? '30초짜리 홍보 영상을 만들어줘' : 'Make a 30 second promo video' },
        ],
        recommendations: [ko ? '리뷰 전에 팀원들과 안건을 먼저 공유해 두세요' : 'Share the agenda with the team before the review.'],
      }));
      return;
    }
    if (/You are the NAgex planning model/.test(system)) {
      const advisory = /ADVISORY ANSWER:/.test(system);
      modelRequests.push({ kind: advisory ? 'plan-advice' : 'plan-action', system, user, korean });
      if (advisory) {
        reply(JSON.stringify({ responseKind: 'ADVISORY', goal: korean ? '회의 준비' : 'Prepare the meeting', summary: korean ? '안건을 정하고 사전 자료를 공유하세요.' : 'Set the agenda and share the material first.', reasoningSummary: 'r', steps: [], suggestions: korean ? ['회의 전날까지 안건을 세 가지로 정리해 참석자에게 공유하세요.', '각 안건의 담당자와 소요 시간을 미리 정해 두세요.'] : ['Fix three agenda items and share them with attendees the day before.', 'Name an owner and a time box for each item in advance.'] }));
        return;
      }
      if (actionPlan === 'calendar') {
        reply(JSON.stringify({ goal: 'Create the meeting', summary: korean ? '분기 계획 리뷰 회의 일정을 만듭니다.' : 'Create the quarterly plan review meeting.', reasoningSummary: 'r', suggestions: [],
          steps: [{ title: korean ? '회의 일정 만들기' : 'Create the meeting', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { calendarId: 'primary', summary: korean ? '분기 계획 리뷰' : 'Quarterly plan review' } }] }));
        return;
      }
      const tool = /id="(mcp\.[^"]+)"/.exec(system)?.[1];
      const message = /"([^"]{1,200})"/.exec(user)?.[1];
      reply(JSON.stringify(tool && message
        ? { goal: 'Send a message', summary: korean ? '연결된 도구에 메시지를 보냅니다.' : 'Send the message to the connected tool.', reasoningSummary: 'r', suggestions: [], steps: [{ title: korean ? '메시지 보내기' : 'Send the message', reasoning: 'asked', skill: 'skill.planning', tool, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { message } }] }
        : { goal: 'Send mail', summary: korean ? '메일을 보냅니다.' : 'Send the mail.', reasoningSummary: 'r', suggestions: [], steps: [{ title: 'Send', reasoning: 'asked', skill: 'skill.email_drafting', tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { to: ['alex@example.com'], subject: 'Report', body: 'Ready.' } }] }));
      return;
    }
    if (/action planner of a personal assistant that operates a web browser/.test(system)) {
      modelRequests.push({ kind: 'browser-planner', system, user, korean });
      const answer = browserPlanner ? browserPlanner(system, user) : JSON.stringify({ action: 'STOP', value: 'BLOCKED', expectedResult: 'No planner is scripted for this test.' });
      if (answer === null) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"overloaded"}'); return; }
      reply(answer);
      return;
    }
    if (/evidence-grounded research assistant/.test(system)) {
      modelRequests.push({ kind: 'research', system, user, korean });
      reply(korean ? '최근 AI 도입은 빠르게 늘고 있습니다 [src_1]. 투자도 증가했습니다 [src_2].' : 'AI adoption is growing fast [src_1]; investment also rose [src_2].');
      return;
    }
    modelRequests.push({ kind: /personal AI assistant/.test(system) ? 'chat' : 'other', system, user, korean });
    if (chatDelayMs) await new Promise((r) => setTimeout(r, chatDelayMs));
    // a meeting-summary question gets a realistic multi-line answer (the demo's "save that summary to my Vault" needs real text with line breaks)
    if (/회의|meeting/i.test(user) && /요약|summar/i.test(user)) {
      reply(korean
        ? '## 주간 회의 요약\n\n- 출시일은 다음 주 금요일로 확정했습니다.\n- 담당자: 민수\n\n다음 회의는 목요일 오후 3시입니다.'
        : '## Weekly meeting summary\n\n- The launch date is confirmed for next Friday.\n- Owner: Dana\n\nThe next meeting is Thursday at 3 PM.');
      return;
    }
    reply(korean ? '안녕하세요. 질문에 답변드립니다.' : 'Hello. Here is the answer.');
  });

  const PAGES: Record<string, string> = {
    '/pages/ai-adoption-survey': '<html><head><title>AI Adoption Survey 2026</title><meta name="date" content="2026-09-01"></head><body><article><h1>AI Adoption Survey 2026</h1><p>Adoption of AI assistants grew sharply among knowledge workers. The survey covered several thousand respondents across many industries.</p><p>Respondents described faster drafting, better preparation for meetings and fewer repetitive tasks as the main benefits of daily assistant use.</p></article></body></html>',
    '/pages/ai-investment': '<html><head><title>AI Investment Report</title><meta name="date" content="2026-08-20"></head><body><article><h1>AI Investment Report</h1><p>Investment in AI tools increased by 18% in 2025 according to the fixture report, with most of the growth coming from small and medium businesses.</p><p>The report also notes that spending shifted from experiments toward assistants that are used every day.</p></article></body></html>',
  };
  const search = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (PAGES[url.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[url.pathname]); return; }
    if (url.pathname === '/robots.txt') { res.writeHead(404); res.end('none'); return; }
    searchQueries.push(url.searchParams.get('q') ?? '');
    if (searchDown) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { title: 'AI Adoption Survey 2026', url: localPages ? `http://127.0.0.1:${searchPort}/pages/ai-adoption-survey` : 'https://example.com/ai-adoption-survey', snippet: 'Adoption of AI assistants grew sharply among knowledge workers.', publishedAt: new Date(Date.now() - 5 * 86400_000).toISOString(), source: 'example.com' },
      { title: 'AI Investment Report', url: localPages ? `http://127.0.0.1:${searchPort}/pages/ai-investment` : 'https://example.org/ai-investment', snippet: 'Investment in AI tools increased again this year.', publishedAt: new Date(Date.now() - 9 * 86400_000).toISOString(), source: 'example.org' },
    ] }));
  });

  const modelPort = await listen(model);
  searchPort = await listen(search);
  const realFetch = globalThis.fetch;
  let bridged = false;
  return {
    installGeminiBridge: () => {
      if (!bridged) {
        bridged = true;
        globalThis.fetch = ((input: any, init?: any) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
          if (url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(`http://127.0.0.1:${modelPort}${new URL(url).pathname}`, init);
          return realFetch(input, init);
        }) as typeof fetch;
      }
      return { GEMINI_API_KEY: 'local-fake-gemini-key-not-a-secret', NAGEX_GEMINI_MODEL: 'gemini-local', NAGEX_PROVIDER_PRIORITY: 'nebius,gemini' };
    },
    env: {
      NEBIUS_API_KEY: 'local-fake-key-not-a-secret',
      NAGEX_NEBIUS_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      NAGEX_NEBIUS_MODEL: 'nvidia/Nemotron-3_5-Lightning',
      NAGEX_PROVIDER_PRIORITY: 'nebius',
      NAGEX_WEB_SEARCH_PROVIDER: 'custom_http',
      NAGEX_WEB_SEARCH_ENDPOINT: `http://127.0.0.1:${searchPort}/search`,
      // the established test-only switch: loopback fixture pages may be fetched by the research report path
      NAGEX_ALLOW_LOCAL_TEST_URLS: '1',
    },
    modelRequests,
    searchQueries,
    failDocuments: (mode) => { documentMode = mode; },
    failSearch: (on) => { searchDown = on; },
    useLocalPages: (on) => { localPages = on; },
    pageUrl: (name) => `http://127.0.0.1:${searchPort}/pages/${name}`,
    setChatDelayMs: (ms) => { chatDelayMs = ms; },
    setActionPlan: (kind) => { actionPlan = kind; },
    setBrowserPlanner: (planner) => { browserPlanner = planner; },
    close: async () => { globalThis.fetch = realFetch; model.closeAllConnections?.(); search.closeAllConnections?.(); await Promise.all([new Promise((r) => model.close(() => r(null))), new Promise((r) => search.close(() => r(null)))]); },
  };
}
