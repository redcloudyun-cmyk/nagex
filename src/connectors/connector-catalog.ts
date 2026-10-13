// Normalized NAgex connector catalog.
//
// What this is: the single, server-side description of every app/service NAgex can show in Settings > Apps & Connections - a stable id, a name,
// a category, an icon key, localized copy, what NAgex can do with it, how it authenticates and, above all, its AVAILABILITY:
//   LIVE        a real integration exists in this codebase (it may still be "not connected" or "setup required" for a given user/deployment);
//   PLANNED     intended, feasible with the credentials a user can bring, but no integration code exists yet;
//   UNSUPPORTED no integration exists and none can be built without a commercial / partner agreement or paid credentials NAgex does not hold.
// What this is NOT: a connection record. A user's connection state is derived at request time from the real stores (token stores, channel link
// stores, the MCP registry) by connector-catalog.service.ts; nothing in this file can say "connected".
//
// Provenance: several definitions were recovered from the AGEX legacy catalog (public/index.html of the AGEX repository, a static gallery whose
// "Connected" badges and seed records were never provider connectivity). Only the descriptive metadata was reused (name, category, purpose); the AGEX
// state was discarded. `agexRef` records the legacy source line so the recovery is auditable.

export type ConnectorCategory = 'COMMUNICATION' | 'PRODUCTIVITY' | 'FILES' | 'DEVELOPER' | 'DATA' | 'CUSTOM';
export type ConnectorAvailability = 'LIVE' | 'PLANNED' | 'UNSUPPORTED';
export type ConnectorAuthMethod = 'GOOGLE_OAUTH' | 'GITHUB_OAUTH' | 'MICROSOFT_OAUTH' | 'CHANNEL_LINK' | 'BEARER_TOKEN' | 'API_KEY' | 'NONE';
// Where a LIVE connector's real connection state is read from.
export type ConnectorStateSource = 'google' | 'github' | 'slack' | 'telegram' | 'mcp' | null;

export interface LocalizedText { en: string; ko: string }

export interface ConnectorDefinition {
  id: string;
  name: string;
  category: ConnectorCategory;
  icon: string;
  provider: string;
  authMethod: ConnectorAuthMethod;
  availability: ConnectorAvailability;
  // What NAgex can do with it, as stable user-level tokens (never internal capability ids).
  capabilities: string[];
  description: LocalizedText;
  // For a connector that is not LIVE: what would be needed. For a LIVE one: what the user/operator must do to connect (null = nothing special).
  setup: LocalizedText | null;
  stateSource: ConnectorStateSource;
  // A LIVE Google connector needs this OAuth scope on the grant.
  requiredScope?: string;
  // Legacy provenance (AGEX repository, public/index.html line).
  agexRef?: string;
}

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Capability token -> the registry capability ids that back it today. A LIVE connector may only claim tokens that appear here, and every id must
// exist in the CapabilityRegistry (enforced by tests/connector_catalog.test.ts), so a card can never advertise something with no engine behind it.
export const CAPABILITY_BACKING: Record<string, string[]> = {
  'email.search': ['gmail.search', 'gmail.read_thread'],
  'email.draft': ['gmail.create_draft'],
  'email.send': ['gmail.send_email', 'gmail.reply'],
  'calendar.read': ['google_calendar.list_events', 'google_calendar.free_slots'],
  'calendar.write': ['google_calendar.create_event', 'google_calendar.update_event', 'google_calendar.cancel_event', 'google_calendar.respond_to_event'],
  'code.read': ['github.list_repos', 'github.list_directory', 'github.read_file'],
  // Channels and custom tools are not registry capabilities of their own: chat goes through the conversation engine, MCP tools register per user.
  'chat.channel': [],
  'notify.self': [],
  'tools.custom': [],
};

const GOOGLE_NEEDS_CONNECTION: LocalizedText = {
  en: 'Connect your Google account in Settings. NAgex asks only for the permissions this app needs.',
  ko: 'Google 계정을 연결해 주세요. 이 앱에 필요한 권한만 요청합니다.',
};

export const CONNECTOR_CATEGORIES: Array<{ id: ConnectorCategory; label: LocalizedText }> = [
  { id: 'COMMUNICATION', label: { en: 'Communication', ko: '커뮤니케이션' } },
  { id: 'PRODUCTIVITY', label: { en: 'Productivity', ko: '생산성' } },
  { id: 'FILES', label: { en: 'Files & storage', ko: '파일 및 저장소' } },
  { id: 'DEVELOPER', label: { en: 'Developer', ko: '개발' } },
  { id: 'DATA', label: { en: 'Data & research', ko: '데이터 및 리서치' } },
  { id: 'CUSTOM', label: { en: 'Custom tools', ko: '사용자 지정 도구' } },
];

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  // ── LIVE: real integrations in this codebase ────────────────────────────────────────────────────────────────────────
  {
    id: 'gmail', name: 'Gmail', category: 'COMMUNICATION', icon: 'gmail', provider: 'Google', authMethod: 'GOOGLE_OAUTH', availability: 'LIVE',
    capabilities: ['email.search', 'email.draft', 'email.send'], stateSource: 'google', requiredScope: GMAIL_SCOPE, agexRef: 'public/index.html:484',
    description: { en: 'Search your mail, draft replies, and send only after you approve.', ko: '메일을 검색하고 답장 초안을 만들며, 보내기 전에는 반드시 승인을 받습니다.' },
    setup: GOOGLE_NEEDS_CONNECTION,
  },
  {
    id: 'google-calendar', name: 'Google Calendar', category: 'PRODUCTIVITY', icon: 'calendar', provider: 'Google', authMethod: 'GOOGLE_OAUTH', availability: 'LIVE',
    capabilities: ['calendar.read', 'calendar.write'], stateSource: 'google', requiredScope: CALENDAR_SCOPE, agexRef: 'public/index.html:577',
    description: { en: 'See your schedule and find free time; changes to events need your approval.', ko: '일정을 확인하고 빈 시간을 찾습니다. 일정 변경은 승인 후에만 이루어집니다.' },
    setup: GOOGLE_NEEDS_CONNECTION,
  },
  {
    id: 'github', name: 'GitHub', category: 'DEVELOPER', icon: 'github', provider: 'GitHub', authMethod: 'GITHUB_OAUTH', availability: 'LIVE',
    capabilities: ['code.read'], stateSource: 'github', agexRef: 'public/index.html:686',
    description: { en: 'Browse your repositories and read files (read-only).', ko: '저장소를 둘러보고 파일을 읽습니다(읽기 전용).' },
    setup: { en: 'Connect your GitHub account in Settings. Access is read-only.', ko: 'GitHub 계정을 연결해 주세요. 읽기 전용으로만 접근합니다.' },
  },
  {
    id: 'slack', name: 'Slack', category: 'COMMUNICATION', icon: 'slack', provider: 'Slack', authMethod: 'CHANNEL_LINK', availability: 'LIVE',
    capabilities: ['chat.channel', 'notify.self'], stateSource: 'slack', agexRef: 'public/index.html:462',
    description: { en: 'Talk to NAgex from Slack and get notifications there. You prove the account is yours from Slack itself.', ko: 'Slack에서 NAgex와 대화하고 알림을 받습니다. 내 계정임을 Slack에서 직접 확인합니다.' },
    setup: { en: 'Needs the NAgex Slack app on this server. Then link your Slack user by sending the one-time code to the app.', ko: '이 서버에 NAgex Slack 앱이 설정되어 있어야 합니다. 그런 다음 앱에 일회용 코드를 보내 Slack 계정을 연결합니다.' },
  },
  {
    id: 'telegram', name: 'Telegram', category: 'COMMUNICATION', icon: 'telegram', provider: 'Telegram', authMethod: 'CHANNEL_LINK', availability: 'LIVE',
    capabilities: ['chat.channel', 'notify.self'], stateSource: 'telegram',
    description: { en: 'Talk to NAgex from Telegram and get notifications there. You prove the account is yours from Telegram itself.', ko: 'Telegram에서 NAgex와 대화하고 알림을 받습니다. 내 계정임을 Telegram에서 직접 확인합니다.' },
    setup: { en: 'Needs the NAgex Telegram bot on this server. Then link your Telegram user by sending the one-time code to the bot.', ko: '이 서버에 NAgex Telegram 봇이 설정되어 있어야 합니다. 그런 다음 봇에 일회용 코드를 보내 Telegram 계정을 연결합니다.' },
  },
  {
    id: 'mcp-custom', name: 'Custom MCP server', category: 'CUSTOM', icon: 'mcp', provider: 'Model Context Protocol', authMethod: 'BEARER_TOKEN', availability: 'LIVE',
    capabilities: ['tools.custom'], stateSource: 'mcp', agexRef: 'public/index.html:1242',
    description: { en: 'Bring your own tools from any remote MCP server (HTTPS). Every tool starts off, and every use needs your approval.', ko: '원격 MCP 서버(HTTPS)의 도구를 직접 연결합니다. 모든 도구는 꺼진 상태로 시작하며, 사용할 때마다 승인이 필요합니다.' },
    setup: { en: 'Add the server address and, if it needs one, an access token (Advanced).', ko: '서버 주소와 필요한 경우 액세스 토큰을 입력하세요(고급).' },
  },

  // ── PLANNED: feasible, nothing built yet ────────────────────────────────────────────────────────────────────────────
  {
    id: 'google-drive', name: 'Google Drive', category: 'FILES', icon: 'drive', provider: 'Google', authMethod: 'GOOGLE_OAUTH', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:544',
    description: { en: 'Find and read your documents.', ko: '문서를 찾고 읽습니다.' },
    setup: { en: 'Not available yet. It will use the same Google connection with an added Drive permission.', ko: '아직 사용할 수 없습니다. 같은 Google 연결에 Drive 권한을 추가해 사용할 예정입니다.' },
  },
  {
    id: 'outlook', name: 'Outlook', category: 'COMMUNICATION', icon: 'outlook', provider: 'Microsoft', authMethod: 'MICROSOFT_OAUTH', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:495',
    description: { en: 'Read and draft email in your Microsoft account.', ko: 'Microsoft 계정의 메일을 읽고 초안을 작성합니다.' },
    setup: { en: 'Not available yet. Signing in with Microsoft does not connect your mailbox; a separate mail permission and integration are needed.', ko: '아직 사용할 수 없습니다. Microsoft로 로그인하는 것만으로는 메일함이 연결되지 않으며, 별도의 메일 권한과 연동이 필요합니다.' },
  },
  {
    id: 'onedrive', name: 'OneDrive / SharePoint', category: 'FILES', icon: 'onedrive', provider: 'Microsoft', authMethod: 'MICROSOFT_OAUTH', availability: 'PLANNED',
    capabilities: [], stateSource: null,
    description: { en: 'Find and read files in OneDrive and SharePoint.', ko: 'OneDrive와 SharePoint의 파일을 찾고 읽습니다.' },
    setup: { en: 'Not available yet. It needs a Microsoft file permission and its own integration.', ko: '아직 사용할 수 없습니다. Microsoft 파일 권한과 별도의 연동이 필요합니다.' },
  },
  {
    id: 'microsoft-teams', name: 'Microsoft Teams', category: 'COMMUNICATION', icon: 'teams', provider: 'Microsoft', authMethod: 'MICROSOFT_OAUTH', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:473',
    description: { en: 'Talk to NAgex from Teams and get notifications there.', ko: 'Teams에서 NAgex와 대화하고 알림을 받습니다.' },
    setup: { en: 'Not available yet. It needs a Teams bot registration for this server and a verified account link, like Slack.', ko: '아직 사용할 수 없습니다. 이 서버용 Teams 봇 등록과 Slack처럼 본인 확인된 계정 연결이 필요합니다.' },
  },
  {
    id: 'zoom', name: 'Zoom', category: 'COMMUNICATION', icon: 'zoom', provider: 'Zoom', authMethod: 'API_KEY', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:506',
    description: { en: 'Summaries and notes from your meetings.', ko: '회의 요약과 메모를 가져옵니다.' },
    setup: { en: 'Not available yet. It needs a Zoom app approved for this server and your authorization.', ko: '아직 사용할 수 없습니다. 이 서버용으로 승인된 Zoom 앱과 사용자 인증이 필요합니다.' },
  },
  {
    id: 'world-bank', name: 'World Bank data', category: 'DATA', icon: 'data', provider: 'World Bank', authMethod: 'NONE', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1575',
    description: { en: 'Official country statistics such as GDP, inflation and population.', ko: 'GDP, 물가상승률, 인구 등 국가별 공식 통계를 가져옵니다.' },
    setup: { en: 'Not available yet. The data is public and needs no account; a research tool still has to be built.', ko: '아직 사용할 수 없습니다. 공개 데이터라 계정은 필요 없지만, 리서치 도구를 먼저 만들어야 합니다.' },
  },
  {
    id: 'coingecko', name: 'CoinGecko', category: 'DATA', icon: 'data', provider: 'CoinGecko', authMethod: 'API_KEY', availability: 'PLANNED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1627',
    description: { en: 'Crypto prices and market data.', ko: '암호화폐 가격과 시장 데이터를 가져옵니다.' },
    setup: { en: 'Not available yet. It needs a research tool and, for reliable limits, your own CoinGecko API key.', ko: '아직 사용할 수 없습니다. 리서치 도구가 필요하며, 안정적인 사용을 위해 본인의 CoinGecko API 키가 필요합니다.' },
  },

  // ── UNSUPPORTED: no integration, none possible without commercial credentials ───────────────────────────────────────
  {
    id: 'x', name: 'X (Twitter)', category: 'DATA', icon: 'data', provider: 'X', authMethod: 'API_KEY', availability: 'UNSUPPORTED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1588',
    description: { en: 'Public posts and accounts.', ko: '공개 게시물과 계정 정보를 조회합니다.' },
    setup: { en: 'Not supported. X requires a paid developer plan and approval that NAgex does not hold.', ko: '지원하지 않습니다. X는 유료 개발자 플랜과 승인이 필요하며 NAgex에는 해당 자격이 없습니다.' },
  },
  {
    id: 'similarweb', name: 'Similarweb', category: 'DATA', icon: 'data', provider: 'Similarweb', authMethod: 'API_KEY', availability: 'UNSUPPORTED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1562',
    description: { en: 'Website traffic and ranking data.', ko: '웹사이트 트래픽과 순위 데이터를 조회합니다.' },
    setup: { en: 'Not supported. It needs a commercial Similarweb data contract.', ko: '지원하지 않습니다. Similarweb 상용 데이터 계약이 필요합니다.' },
  },
  {
    id: 'ahrefs', name: 'Ahrefs', category: 'DATA', icon: 'data', provider: 'Ahrefs', authMethod: 'API_KEY', availability: 'UNSUPPORTED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1614',
    description: { en: 'SEO performance, rankings and keyword research.', ko: 'SEO 성과, 순위, 키워드 리서치를 제공합니다.' },
    setup: { en: 'Not supported. It needs a paid Ahrefs API plan.', ko: '지원하지 않습니다. 유료 Ahrefs API 플랜이 필요합니다.' },
  },
  {
    id: 'brand24', name: 'Brand24', category: 'DATA', icon: 'data', provider: 'Brand24', authMethod: 'API_KEY', availability: 'UNSUPPORTED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1601',
    description: { en: 'Brand mentions and sentiment.', ko: '브랜드 언급량과 감정 분석을 제공합니다.' },
    setup: { en: 'Not supported. It needs a paid Brand24 account and API access.', ko: '지원하지 않습니다. 유료 Brand24 계정과 API 접근 권한이 필요합니다.' },
  },
  {
    id: 'morningstar', name: 'Morningstar', category: 'DATA', icon: 'data', provider: 'Morningstar', authMethod: 'API_KEY', availability: 'UNSUPPORTED',
    capabilities: [], stateSource: null, agexRef: 'public/index.html:1640',
    description: { en: 'Investment research and securities data.', ko: '투자 리서치와 증권 분석 데이터를 제공합니다.' },
    setup: { en: 'Not supported. The data is licensed and needs a Morningstar agreement.', ko: '지원하지 않습니다. 라이선스 데이터로 Morningstar와의 계약이 필요합니다.' },
  },
];

export function getConnectorDefinition(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOG.find((connector) => connector.id === id);
}
