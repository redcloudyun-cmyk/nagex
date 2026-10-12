// NAgex Settings > Apps & Connections.
// An icon-first app connection experience on top of the EXISTING authenticated APIs (Google OAuth status, GitHub connection, MCP
// servers). Nothing here invents state: every card is derived from backend evidence, and no control exists unless it does something.
// Security properties kept from the engine: credentials are write-only (the MCP token is read from the field once, cleared at
// once, and never stored in state or storage); tools are never invoked from this UI (enabling only exposes them to the Capability
// Broker, where every use still needs a hash-bound approval); server-supplied text is always escaped; icons are static NAgex-drawn
// SVG (no remote or server-provided images).
(function () {
  'use strict';

  const API = { google: '/api/v1/oauth/google/status', googleVerify: '/api/v1/connections/google-calendar?verify=1', googleDisconnect: '/api/v1/oauth/google/disconnect', github: '/api/v1/connections/github', githubDisconnect: '/api/v1/connections/github/disconnect', mcp: '/api/v1/mcp/servers' };
  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  const REQUEST_TIMEOUT_MS = 45000; // adding an MCP server runs a handshake and a tool listing server-side
  const STALE_MS = 5000;

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function t(key, vars) {
    let text = window.NAGEX_I18N && window.NAGEX_I18N.t ? window.NAGEX_I18N.t(key) : key;
    if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
    return text;
  }
  const locale = () => (window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko' : 'en');
  function fmtTime(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    try { return new Intl.DateTimeFormat(locale() === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date); } catch { return date.toISOString(); }
  }

  async function request(endpoint, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, ...options });
      const body = await res.json().catch(() => ({}));
      const error = body && body.error ? body.error : null;
      const code = error ? (typeof error === 'string' ? error : error.code || '') : '';
      return { ok: res.ok && !error, status: res.status, body: body || {}, code };
    } catch (err) {
      return { ok: false, status: 0, body: {}, code: err && err.name === 'AbortError' ? 'MCP_TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── icons: NAgex-drawn glyphs on a coloured tile (static trusted markup only) ───────────────────────────────────────
  const ICONS = {
    gmail: { bg: '#d93025', glyph: '<path d="M3.5 6.5h17v11h-17z"/><path d="m3.5 7 8.5 6.5L20.5 7"/>' },
    calendar: { bg: '#1a73e8', glyph: '<path d="M4.5 6.5h15v13h-15z"/><path d="M4.5 10.5h15M8.5 4v4M15.5 4v4"/><path d="M8.5 14h2M13.5 14h2M8.5 17h2"/>' },
    drive: { bg: '#0f9d58', glyph: '<path d="M9 4.5h6l5.5 9.5-3 5H6.5l-3-5z"/><path d="M9 4.5 14.5 14M15 4.5 9.5 14M6.5 19h11"/>' },
    github: { bg: '#24292f', glyph: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3-4 3-8.5 5.5"/>' },
    outlook: { bg: '#0f6cbd', glyph: '<path d="M3.5 7h13v10h-13z"/><path d="m3.5 7.5 6.5 5 6.5-5"/><path d="M16.5 9.5h4v8h-9v-.5"/>' },
    onedrive: { bg: '#0f78d4', glyph: '<path d="M7.5 18.5a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.4 9.6a4.5 4.5 0 0 1 .1 8.9z"/>' },
    google: { bg: '#ffffff', text: 'G', color: '#4285f4' },
    mcp: { bg: '#5b4bd5', glyph: '<path d="M4.5 5.5h15v5h-15zM4.5 13.5h15v5h-15z"/><path d="M8 8h.01M8 16h.01"/>' },
  };
  function iconHtml(name) {
    const icon = ICONS[name] || ICONS.mcp;
    const inner = icon.text
      ? `<span class="nagex-conn-glyph-text" style="color:${icon.color}">${escapeHtml(icon.text)}</span>`
      : `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">${icon.glyph}</svg>`;
    return `<span class="nagex-conn-icon" aria-hidden="true" style="--icon-bg:${icon.bg}">${inner}</span>`;
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const data = { googleVerifiedAt: null, loaded: false, loading: false, lastLoadAt: 0, signedOut: false, google: null, github: null, mcp: { servers: [], unavailable: false, errorCode: '' }, loadFailed: false };
  const ui = { query: '', filter: 'ALL', drawer: null, modal: null, live: '' };
  let layer = null; // { el, opener, openerKey }
  let sequence = 0;

  // The built-in catalog: apps NAgex supports by default. `source` says where its connection state really comes from.
  const CATALOG = [
    { id: 'gmail', name: 'Gmail', provider: 'Google', source: 'google', cap: 'conn.cap.gmail', icon: 'gmail', needs: GMAIL_SCOPE },
    { id: 'google-calendar', name: 'Google Calendar', provider: 'Google', source: 'google', cap: 'conn.cap.calendar', icon: 'calendar', needs: CALENDAR_SCOPE },
    { id: 'google-drive', name: 'Google Drive', provider: 'Google', source: 'planned', cap: 'conn.cap.drive', icon: 'drive' },
    { id: 'github', name: 'GitHub', provider: 'GitHub', source: 'github', cap: 'conn.cap.github', icon: 'github' },
    { id: 'outlook', name: 'Outlook', provider: 'Microsoft', source: 'planned', cap: 'conn.cap.outlook', icon: 'outlook' },
    { id: 'onedrive', name: 'OneDrive / SharePoint', provider: 'Microsoft', source: 'planned', cap: 'conn.cap.onedrive', icon: 'onedrive' },
  ];

  // Google: ONE grant behind Gmail and Calendar (and later Drive); the cards show per-capability truth from the granted scopes.
  function googleBase() {
    const g = data.google;
    if (!g || g.error) return { state: 'ERROR', reason: 'PROVIDER_ERROR', scopes: [], connectPath: null, verifiedAt: null };
    const connection = g.connection || {};
    const scopes = Array.isArray(g.scopes) ? g.scopes : (connection.scopes || []);
    if (g.configured === false || connection.state === 'UNAVAILABLE') return { state: 'SETUP_REQUIRED', reason: 'OAUTH_NOT_CONFIGURED', scopes, connectPath: null, verifiedAt: null };
    const state = connection.state || (g.connected ? 'CONNECTED' : 'NOT_CONNECTED');
    return { state, reason: connection.reason || null, scopes, connectPath: connection.connectPath || '/api/v1/oauth/google/start', verifiedAt: connection.verifiedAt || data.googleVerifiedAt || null };
  }
  function githubBase() {
    const c = data.github;
    if (!c) return { state: 'ERROR', reason: 'PROVIDER_ERROR', account: null, connectPath: null, verifiedAt: null, privateAccess: false };
    if (c.state === 'UNAVAILABLE') return { state: 'SETUP_REQUIRED', reason: 'OAUTH_NOT_CONFIGURED', account: null, connectPath: null, verifiedAt: null, privateAccess: false };
    return { state: c.state, reason: c.reason || null, account: c.account ? c.account.login : null, connectPath: c.connectPath || '/api/v1/oauth/github/start', verifiedAt: c.verifiedAt || null, privateAccess: Boolean(c.privateAccess) };
  }
  function appState(item) {
    if (item.source === 'planned') return { state: 'UNAVAILABLE', reason: 'COMING_LATER' };
    if (item.source === 'github') return githubBase();
    const base = googleBase();
    if (item.needs && base.state === 'CONNECTED' && !base.scopes.includes(item.needs)) return { ...base, state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE' };
    return base;
  }
  const needsAttention = (state) => state === 'REAUTH_REQUIRED' || state === 'ERROR';

  // "My connections": the Google grant (once), GitHub, and every MCP server the user added. Only real connections appear.
  function myConnections() {
    const items = [];
    const google = googleBase();
    if (!data.signedOut && data.google && !data.google.error && google.state !== 'NOT_CONNECTED' && google.state !== 'SETUP_REQUIRED') {
      const caps = [google.scopes.includes(GMAIL_SCOPE) ? 'Gmail' : '', google.scopes.includes(CALENDAR_SCOPE) ? 'Calendar' : ''].filter(Boolean);
      items.push({ kind: 'google', id: 'google', name: 'Google', icon: 'google', state: google.state, account: '', summary: caps.length ? caps.join(' · ') : t('conn.cap.google'), search: 'google gmail calendar drive ' + t('conn.cap.google') });
    }
    const gh = githubBase();
    if (data.github && gh.state !== 'NOT_CONNECTED' && gh.state !== 'SETUP_REQUIRED') {
      items.push({ kind: 'github', id: 'github', name: 'GitHub', icon: 'github', state: gh.state, account: gh.account ? '@' + gh.account : '', summary: t('conn.cap.github'), search: 'github ' + t('conn.cap.github') + ' ' + (gh.account || '') });
    }
    for (const server of data.mcp.servers) {
      const tools = Array.isArray(server.tools) ? server.tools : [];
      const enabled = tools.filter((tool) => tool.enabled).length;
      const state = server.status === 'CONNECTED' ? 'CONNECTED' : server.status === 'IDENTITY_MISMATCH' ? 'REAUTH_REQUIRED' : 'ERROR';
      items.push({ kind: 'mcp', id: server.connectionId, name: server.name, icon: 'mcp', state, account: (server.identity && server.identity.serverName) || '', summary: t('conn.cap.mcpCount', { enabled, total: tools.length }), search: [server.name, server.url, ...(tools.map((tool) => tool.name))].join(' ') });
    }
    return items;
  }

  // ── filtering ────────────────────────────────────────────────────────────────────────────────────────────────────
  function matches(haystack, state) {
    const q = ui.query.trim().toLowerCase();
    if (q && !haystack.toLowerCase().includes(q)) return false;
    if (ui.filter === 'CONNECTED') return state === 'CONNECTED';
    if (ui.filter === 'AVAILABLE') return state === 'NOT_CONNECTED';
    if (ui.filter === 'ATTENTION') return needsAttention(state);
    return true;
  }

  // ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────────
  const stateLabel = (state) => t('conn.status.' + state);
  function badge(state) {
    return `<span class="nagex-conn-badge" data-state="${escapeHtml(state)}">${escapeHtml(stateLabel(state))}</span>`;
  }
  const reasonText = (state, reason) => {
    if (state === 'SETUP_REQUIRED') return t('conn.hint.SETUP_REQUIRED');
    if (state === 'UNAVAILABLE') return t('conn.hint.UNAVAILABLE');
    if (!reason) return '';
    const key = 'conn.reason.' + reason;
    const text = t(key);
    return text === key ? '' : text;
  };

  function primaryAction(item, st) {
    // no button unless it does something: setup-required / coming-later apps have none
    if (st.state === 'CONNECTED') return { act: 'manage', label: t('conn.action.manage'), aria: t('conn.aria.manage', { app: item.name }) };
    if (st.state === 'NOT_CONNECTED') return { act: 'connect', label: t('conn.action.connect'), aria: t('conn.aria.connect', { app: item.name }), primary: true };
    if (st.state === 'REAUTH_REQUIRED') return { act: 'connect', label: t('conn.action.reconnect'), aria: t('conn.aria.reconnect', { app: item.name }), primary: true };
    if (st.state === 'ERROR') return { act: 'retry', label: t('conn.action.retry'), aria: t('conn.aria.retry', { app: item.name }) };
    return null;
  }

  function appCardHtml(item) {
    const st = appState(item);
    const action = primaryAction(item, st);
    const hint = reasonText(st.state, st.reason);
    const shared = item.source === 'google' ? t('conn.uses.google') : '';
    return `
      <article class="nagex-conn-card" data-conn-key="app:${escapeHtml(item.id)}" data-app="${escapeHtml(item.id)}" data-state="${escapeHtml(st.state)}" aria-labelledby="nagex-app-${escapeHtml(item.id)}">
        <div class="nagex-conn-card-top">${iconHtml(item.icon)}<div class="nagex-conn-card-title"><h4 id="nagex-app-${escapeHtml(item.id)}">${escapeHtml(item.name)}</h4><p>${escapeHtml(t(item.cap))}</p></div></div>
        <div class="nagex-conn-card-meta">${badge(st.state)}${hint || shared ? `<p class="nagex-conn-hint">${escapeHtml(hint || shared)}</p>` : ''}</div>
        <div class="nagex-conn-card-actions">${action ? `<button type="button" class="nagex-conn-btn ${action.primary ? 'primary' : ''}" data-act="${action.act}" data-source="${escapeHtml(item.source)}" data-app="${escapeHtml(item.id)}" aria-label="${escapeHtml(action.aria)}" ${ui.busyApp === item.id ? 'disabled aria-busy="true"' : ''}>${escapeHtml(action.label)}</button>` : ''}</div>
      </article>`;
  }

  function myItemHtml(item) {
    const detail = [item.account, item.summary].filter(Boolean).join(' · ');
    const manage = t('conn.action.manage');
    return `
      <article class="nagex-conn-card mine" data-conn-key="mine:${escapeHtml(item.kind)}:${escapeHtml(item.id)}" data-kind="${escapeHtml(item.kind)}" data-state="${escapeHtml(item.state)}" aria-labelledby="nagex-mine-${escapeHtml(item.id)}">
        <div class="nagex-conn-card-top">${iconHtml(item.icon)}<div class="nagex-conn-card-title"><h4 id="nagex-mine-${escapeHtml(item.id)}">${escapeHtml(item.name)}</h4><p>${escapeHtml(detail)}</p></div></div>
        <div class="nagex-conn-card-meta">${badge(item.state)}</div>
        <div class="nagex-conn-card-actions"><button type="button" class="nagex-conn-btn" data-act="manage-item" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('conn.aria.manage', { app: item.name }))}">${escapeHtml(manage)}</button></div>
      </article>`;
  }

  function bodyHtml() {
    if (data.signedOut) {
      return `<div class="nagex-conn-empty" role="status"><p>${escapeHtml(t('conn.signedOut'))}</p><button type="button" class="nagex-conn-btn primary" data-act="sign-in">${escapeHtml(t('conn.signIn'))}</button></div>`;
    }
    if (!data.loaded) return `<p class="nagex-conn-loading" role="status">${escapeHtml(t('conn.loading'))}</p>`;
    const mine = myConnections().filter((item) => matches(item.search + ' ' + item.name + ' ' + item.summary, item.state));
    const allMine = myConnections();
    const builtin = CATALOG.filter((item) => {
      const st = appState(item);
      return matches([item.name, item.provider, t(item.cap)].join(' '), st.state);
    });
    const filtering = Boolean(ui.query.trim()) || ui.filter !== 'ALL';
    const sections = [];
    const failed = data.loadFailed ? `<div class="nagex-conn-banner" role="alert"><span>${escapeHtml(t('conn.loadError'))}</span><button type="button" class="nagex-conn-btn" data-act="reload">${escapeHtml(t('conn.action.retry'))}</button></div>` : '';
    sections.push(failed);
    // My connections
    sections.push(`<section class="nagex-conn-section" aria-labelledby="nagex-sec-mine"><h3 id="nagex-sec-mine">${escapeHtml(t('conn.section.mine'))}</h3>${
      mine.length ? `<div class="nagex-conn-grid">${mine.map(myItemHtml).join('')}</div>`
        : `<p class="nagex-conn-empty-line">${escapeHtml(allMine.length === 0 ? t('conn.mine.empty') : t('conn.noMatch'))}</p>`}</section>`);
    // Built-in apps
    if (builtin.length || !filtering) {
      sections.push(`<section class="nagex-conn-section" aria-labelledby="nagex-sec-builtin"><h3 id="nagex-sec-builtin">${escapeHtml(t('conn.section.builtin'))}</h3><div class="nagex-conn-grid">${builtin.map(appCardHtml).join('')}</div></section>`);
    } else {
      sections.push(`<section class="nagex-conn-section" aria-labelledby="nagex-sec-builtin"><h3 id="nagex-sec-builtin">${escapeHtml(t('conn.section.builtin'))}</h3><p class="nagex-conn-empty-line">${escapeHtml(t('conn.noMatch'))}</p></section>`);
    }
    // Explore & add
    sections.push(`<section class="nagex-conn-section" aria-labelledby="nagex-sec-explore"><h3 id="nagex-sec-explore">${escapeHtml(t('conn.section.explore'))}</h3>
      <div class="nagex-conn-explore">
        ${iconHtml('mcp')}
        <div class="nagex-conn-card-title"><h4>${escapeHtml(t('conn.mcp.cardTitle'))}</h4><p>${escapeHtml(t('conn.explore.desc'))}</p></div>
        ${data.mcp.unavailable ? `<span class="nagex-conn-hint">${escapeHtml(t('conn.mcp.unavailable'))}</span>` : `<button type="button" class="nagex-conn-btn primary" data-act="add-mcp" id="nagex-conn-add">${escapeHtml(t('conn.addMcp'))}</button>`}
      </div></section>`);
    return sections.join('');
  }

  function toolbarHtml() {
    const filters = [['ALL', 'conn.filter.all'], ['CONNECTED', 'conn.filter.connected'], ['AVAILABLE', 'conn.filter.available'], ['ATTENTION', 'conn.filter.attention']];
    return `
      <div class="nagex-conn-toolbar" ${data.signedOut ? 'hidden' : ''}>
        <label class="nagex-conn-search"><span class="nagex-conn-sr">${escapeHtml(t('conn.search.label'))}</span>
          <input type="search" id="nagex-conn-search" placeholder="${escapeHtml(t('conn.search.label'))}" value="${escapeHtml(ui.query)}" autocomplete="off" spellcheck="false"></label>
        <div class="nagex-conn-filters" role="group" aria-label="${escapeHtml(t('conn.filter.label'))}">${filters.map(([id, key]) => `<button type="button" class="nagex-conn-chip" data-act="filter" data-filter="${id}" aria-pressed="${ui.filter === id}">${escapeHtml(t(key))}</button>`).join('')}</div>
      </div>`;
  }

  let root = null;
  function rootEl() {
    const container = document.getElementById('settings-connections-status');
    if (!container) return null;
    let el = container.querySelector('#nagex-connections');
    if (!el) {
      container.textContent = '';
      el = document.createElement('div');
      el.id = 'nagex-connections';
      el.className = 'nagex-conn';
      el.innerHTML = `<div id="nagex-conn-toolbar"></div><div id="nagex-conn-body"></div><div class="nagex-conn-sr" id="nagex-conn-live" role="status" aria-live="polite"></div>`;
      container.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('input', (event) => { if (event.target && event.target.id === 'nagex-conn-search') { ui.query = event.target.value; renderBody(); } });
    }
    root = el;
    return el;
  }
  function renderToolbar() { const el = rootEl(); if (el) el.querySelector('#nagex-conn-toolbar').innerHTML = toolbarHtml(); }
  function renderBody() {
    const el = rootEl();
    if (!el) return;
    const body = el.querySelector('#nagex-conn-body');
    const focusKey = document.activeElement && document.activeElement.closest ? (document.activeElement.closest('[data-conn-key]') || {}).getAttribute?.('data-conn-key') : null;
    body.innerHTML = bodyHtml();
    body.setAttribute('aria-busy', String(data.loading && !data.loaded));
    if (focusKey) { const again = body.querySelector(`[data-conn-key="${CSS.escape(focusKey)}"] button`); if (again && layer == null) again.focus(); }
  }
  function renderAll() { renderToolbar(); renderBody(); renderLayer(); }
  function announce(message) { ui.live = message; const el = document.getElementById('nagex-conn-live'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = message; }, 30); } }

  // ── data loading ─────────────────────────────────────────────────────────────────────────────────────────────────
  async function loadAll(options) {
    const version = ++sequence;
    data.loading = true;
    if (!data.loaded) renderBody();
    const [g, gh, m] = await Promise.all([request(API.google), request(options && options.verify ? API.github + '?verify=1' : API.github), request(API.mcp)]);
    if (version !== sequence) return;
    const unauthorized = (r) => r.status === 401 && (!r.code || r.code === 'UNAUTHORIZED');
    data.signedOut = unauthorized(g) && unauthorized(gh) && unauthorized(m);
    if (!data.signedOut) {
      data.google = g.ok ? g.body : (unauthorized(g) ? null : { error: true });
      data.github = gh.body && gh.body.connection ? gh.body.connection : null;
      data.mcp = { servers: m.ok && Array.isArray(m.body.servers) ? m.body.servers : [], unavailable: m.status === 503 || m.code === 'MCP_NOT_AVAILABLE', errorCode: m.ok ? '' : m.code };
      data.loadFailed = !g.ok || !(gh.body && gh.body.connection) || (!m.ok && !data.mcp.unavailable);
    }
    data.loaded = true;
    data.loading = false;
    data.lastLoadAt = Date.now();
    renderAll();
  }

  // ── layers (modal + drawer) ──────────────────────────────────────────────────────────────────────────────────────
  function focusables(el) { return [...el.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null || n === document.activeElement); }
  function openLayer(kind, opener) {
    closeLayer(true);
    const el = document.createElement('div');
    el.className = 'nagex-conn-layer ' + kind;
    el.id = 'nagex-conn-layer';
    el.innerHTML = `<div class="nagex-conn-backdrop" data-act="close-layer"></div><div class="nagex-conn-panel" role="dialog" aria-modal="true" aria-labelledby="nagex-layer-title" tabindex="-1"></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onLayerKey);
    el.addEventListener('submit', onSubmit);
    layer = { el, opener: opener || null, openerKey: opener && opener.closest ? ((opener.closest('[data-conn-key]') || {}).getAttribute?.('data-conn-key') || (opener.id || '')) : '' };
    document.body.classList.add('nagex-conn-open');
    renderLayer(true);
  }
  function closeLayer(silent) {
    if (!layer) return;
    const { el, opener, openerKey } = layer;
    el.remove();
    layer = null;
    document.body.classList.remove('nagex-conn-open');
    ui.drawer = null; ui.modal = null;
    if (silent) return;
    // focus returns to the control that opened the layer (or its replacement after a re-render)
    let target = opener && document.body.contains(opener) ? opener : null;
    if (!target && openerKey) target = document.getElementById(openerKey) || (root && root.querySelector(`[data-conn-key="${CSS.escape(openerKey)}"] button`));
    if (!target && root) target = root.querySelector('#nagex-conn-add') || root.querySelector('#nagex-conn-search');
    if (target && target.focus) target.focus();
  }
  function onLayerKey(event) {
    if (event.key === 'Escape') { if (ui.modal && ui.modal.busy) return; event.stopPropagation(); closeLayer(); return; }
    if (event.key !== 'Tab' || !layer) return;
    const nodes = focusables(layer.el.querySelector('.nagex-conn-panel'));
    if (!nodes.length) { event.preventDefault(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === layer.el.querySelector('.nagex-conn-panel'))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function renderLayer(initial) {
    if (!layer) return;
    const panel = layer.el.querySelector('.nagex-conn-panel');
    const active = document.activeElement && panel.contains(document.activeElement) ? (document.activeElement.getAttribute('data-focus') || document.activeElement.id || '') : '';
    panel.innerHTML = ui.modal ? modalHtml() : ui.drawer ? drawerHtml() : '';
    if (!panel.innerHTML) { closeLayer(true); return; }
    let target = null;
    if (active) target = panel.querySelector(`[data-focus="${CSS.escape(active)}"], #${CSS.escape(active)}`);
    if (!target && initial) target = panel.querySelector('[data-autofocus]') || panel.querySelector('button, input');
    if (!target && ui.modal && ui.modal.step === 'review') target = panel.querySelector('[data-autofocus]');
    (target || panel).focus();
  }

  // ── MCP: modal (add + review) ────────────────────────────────────────────────────────────────────────────────────
  const REJECT_KEYS = { INVALID_NAME: 'conn.reject.name', DUPLICATE_NAME: 'conn.reject.duplicate', SCHEMA_TOO_LARGE: 'conn.reject.complex', SCHEMA_TOO_DEEP: 'conn.reject.complex', ROOT_SCHEMA_NOT_OBJECT: 'conn.reject.schema', NOT_AN_OBJECT: 'conn.reject.schema' };
  const rejectText = (reason) => t(REJECT_KEYS[String(reason).split(':')[0]] || (String(reason).startsWith('UNSUPPORTED') ? 'conn.reject.unsupported' : 'conn.reject.generic'));
  function errorText(code) {
    if (!code) return '';
    const key = 'conn.err.' + code;
    const text = t(key);
    return text === key ? t('conn.err.generic') : text;
  }

  function serverById(id) { return data.mcp.servers.find((server) => server.connectionId === id); }

  function toolsHtml(server, scope) {
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const locked = server.status !== 'CONNECTED' || (scope.busy === true);
    const rejected = Array.isArray(server.rejectedTools) ? server.rejectedTools : [];
    const rows = tools.map((tool) => {
      const confirming = scope.toolConfirm === tool.name;
      const switchId = `nagex-tool-${server.connectionId}-${tool.name}`;
      return `
        <li class="nagex-conn-tool" data-tool-row="${escapeHtml(tool.name)}">
          <div class="nagex-conn-tool-main"><strong>${escapeHtml(tool.name)}</strong>${tool.description ? `<span>${escapeHtml(tool.description)}</span>` : ''}${tool.changedSinceEnabled ? `<em class="nagex-conn-changed">${escapeHtml(t('conn.tool.changed'))}</em>` : ''}</div>
          <button type="button" role="switch" id="${escapeHtml(switchId)}" class="nagex-conn-switch" aria-checked="${tool.enabled ? 'true' : 'false'}" aria-label="${escapeHtml(t(tool.enabled ? 'conn.aria.toolOff' : 'conn.aria.toolOn', { tool: tool.name }))}" data-act="tool-toggle" data-tool="${escapeHtml(tool.name)}" data-focus="${escapeHtml(switchId)}" ${locked ? 'disabled' : ''}><span class="nagex-conn-switch-label">${escapeHtml(t(tool.enabled ? 'conn.tool.on' : 'conn.tool.off'))}</span></button>
          ${confirming ? `<div class="nagex-conn-confirm" role="alertdialog" aria-label="${escapeHtml(t('conn.tool.confirmTitle'))}"><p>${escapeHtml(t('conn.tool.confirm', { tool: tool.name }))}</p><div><button type="button" class="nagex-conn-btn primary" data-act="tool-confirm" data-tool="${escapeHtml(tool.name)}" data-autofocus>${escapeHtml(t('conn.tool.turnOn'))}</button><button type="button" class="nagex-conn-btn" data-act="tool-cancel">${escapeHtml(t('conn.action.cancel'))}</button></div></div>` : ''}
        </li>`;
    }).join('');
    return `
      <h4 class="nagex-conn-subtitle">${escapeHtml(t('conn.mcp.tools'))} <span class="nagex-conn-count">${tools.length}</span></h4>
      ${tools.length ? `<ul class="nagex-conn-tools">${rows}</ul>` : `<p class="nagex-conn-empty-line">${escapeHtml(t('conn.mcp.noTools'))}</p>`}
      ${rejected.length ? `<h4 class="nagex-conn-subtitle">${escapeHtml(t('conn.mcp.rejected'))}</h4><ul class="nagex-conn-rejected">${rejected.map((r) => `<li><strong>${escapeHtml(r.name || '?')}</strong> <span>${escapeHtml(rejectText(r.reason))}</span></li>`).join('')}</ul>` : ''}`;
  }

  function modalHtml() {
    const m = ui.modal;
    const closeBtn = `<button type="button" class="nagex-conn-close" data-act="close-layer" aria-label="${escapeHtml(t('conn.action.close'))}" ${m.busy ? 'disabled' : ''}>×</button>`;
    if (m.step === 'review') {
      const server = serverById(m.serverId) || m.server;
      return `
        <header class="nagex-conn-panel-head">${iconHtml('mcp')}<div><h2 id="nagex-layer-title">${escapeHtml(t('conn.mcp.review.title'))}</h2><p>${escapeHtml(t('conn.mcp.review.sub'))}</p></div>${closeBtn}</header>
        <div class="nagex-conn-panel-body">
          <dl class="nagex-conn-facts">
            <div><dt>${escapeHtml(t('conn.mcp.name'))}</dt><dd>${escapeHtml(server.name)}</dd></div>
            <div><dt>${escapeHtml(t('conn.mcp.identity'))}</dt><dd>${escapeHtml((server.identity && server.identity.serverName) || '—')}</dd></div>
            <div><dt>${escapeHtml(t('conn.mcp.origin'))}</dt><dd>${escapeHtml((server.identity && server.identity.origin) || server.url)}</dd></div>
          </dl>
          ${toolsHtml(server, m)}
        </div>
        <footer class="nagex-conn-panel-foot"><button type="button" class="nagex-conn-btn primary" data-act="close-layer" data-autofocus>${escapeHtml(t('conn.action.done'))}</button></footer>`;
    }
    const field = (name, label, type, extra) => `<label class="nagex-conn-field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" ${extra || ''} ${m.busy ? 'disabled' : ''} ${m.errors && m.errors[name] ? 'aria-invalid="true" aria-describedby="nagex-mcp-err"' : ''}></label>`;
    return `
      <form novalidate autocomplete="off" id="nagex-mcp-form">
        <header class="nagex-conn-panel-head">${iconHtml('mcp')}<div><h2 id="nagex-layer-title">${escapeHtml(t('conn.mcp.title'))}</h2><p>${escapeHtml(t('conn.mcp.intro'))}</p></div>${closeBtn}</header>
        <div class="nagex-conn-panel-body">
          ${field('name', t('conn.mcp.name'), 'text', `maxlength="60" data-autofocus data-focus="mcp-name" value="${escapeHtml(m.name || '')}"`)}
          ${field('url', t('conn.mcp.url'), 'url', `placeholder="https://example.com/mcp" inputmode="url" data-focus="mcp-url" value="${escapeHtml(m.url || '')}"`)}
          ${field('bearerToken', t('conn.mcp.token'), 'password', 'autocomplete="new-password" data-focus="mcp-token"')}
          <p class="nagex-conn-help">${escapeHtml(t('conn.mcp.tokenHelp'))}</p>
          <p class="nagex-conn-error" id="nagex-mcp-err" role="alert">${escapeHtml(m.error || '')}</p>
          <p class="nagex-conn-progress" role="status">${m.busy ? escapeHtml(t('conn.mcp.connecting')) : ''}</p>
        </div>
        <footer class="nagex-conn-panel-foot"><button type="button" class="nagex-conn-btn" data-act="close-layer" ${m.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.cancel'))}</button><button type="submit" class="nagex-conn-btn primary" ${m.busy ? 'disabled aria-busy="true"' : ''}>${escapeHtml(m.busy ? t('conn.mcp.connectingShort') : t('conn.action.connect'))}</button></footer>
      </form>`;
  }

  async function onSubmit(event) {
    if (!event.target || event.target.id !== 'nagex-mcp-form') return;
    event.preventDefault();
    const m = ui.modal;
    if (!m || m.busy) return;
    const form = event.target;
    const name = String(form.elements.name.value || '').trim();
    const url = String(form.elements.url.value || '').trim();
    const tokenField = form.elements.bearerToken;
    const bearerToken = String(tokenField.value || '');
    tokenField.value = ''; // the credential lives only in this local variable and the request below
    m.name = name; m.url = url; m.errors = {}; m.error = '';
    if (!name) { m.errors.name = true; m.error = t('conn.mcp.nameRequired'); }
    else if (!url) { m.errors.url = true; m.error = t('conn.mcp.urlRequired'); }
    else if (!/^https:\/\//i.test(url)) { m.errors.url = true; m.error = t('conn.mcp.httpsRequired'); }
    if (m.error) { renderLayer(); announce(m.error); const bad = layer.el.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); return; }
    m.busy = true;
    renderLayer();
    const res = await request(API.mcp, { method: 'POST', body: JSON.stringify({ name, url, bearerToken }) });
    if (!ui.modal || ui.modal !== m) return;
    m.busy = false;
    if (res.ok && res.body.server) {
      m.step = 'review'; m.serverId = res.body.server.connectionId; m.server = res.body.server; m.toolConfirm = null;
      data.mcp.servers = [...data.mcp.servers.filter((s) => s.connectionId !== m.serverId), res.body.server];
      announce(t('conn.msg.added'));
      renderBody();
      renderLayer(true);
      return;
    }
    m.error = res.status === 401 && (!res.code || res.code === 'UNAUTHORIZED') ? t('conn.signedOut') : errorText(res.code || (res.status === 0 ? 'MCP_UNREACHABLE' : ''));
    renderLayer();
    announce(m.error);
    const nameInput = layer && layer.el.querySelector('input[name="bearerToken"]');
    if (nameInput) nameInput.focus();
  }

  // ── detail drawer (Google, GitHub, MCP) ──────────────────────────────────────────────────────────────────────────
  function factsHtml(rows) {
    return `<dl class="nagex-conn-facts">${rows.filter(Boolean).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  }
  function drawerHtml() {
    const d = ui.drawer;
    const closeBtn = `<button type="button" class="nagex-conn-close" data-act="close-layer" aria-label="${escapeHtml(t('conn.action.close'))}">×</button>`;
    let title = ''; let icon = 'mcp'; let state = 'CONNECTED'; let body = ''; let foot = '';
    const secure = `<p class="nagex-conn-note">${escapeHtml(t('conn.detail.securityText'))}</p>`;
    const confirmBlock = (kind, text) => d.confirm === kind
      ? `<div class="nagex-conn-confirm" role="alertdialog" aria-label="${escapeHtml(text)}"><p>${escapeHtml(text)}</p><div><button type="button" class="nagex-conn-btn danger" data-act="confirm-${kind}" data-autofocus>${escapeHtml(t('conn.action.confirm'))}</button><button type="button" class="nagex-conn-btn" data-act="cancel-confirm">${escapeHtml(t('conn.action.cancel'))}</button></div></div>` : '';
    const yes = escapeHtml(t('conn.detail.allowed')); const no = escapeHtml(t('conn.detail.notAllowed'));
    const verified = (iso) => iso ? escapeHtml(fmtTime(iso)) : escapeHtml(t('conn.detail.neverVerified'));
    if (d.kind === 'google') {
      const g = googleBase(); title = 'Google'; icon = 'google'; state = g.state;
      body = factsHtml([[t('conn.detail.status'), badge(g.state)], [t('conn.detail.capabilities'), `Gmail: ${g.scopes.includes(GMAIL_SCOPE) ? yes : no}<br>Calendar: ${g.scopes.includes(CALENDAR_SCOPE) ? yes : no}`], [t('conn.detail.lastVerified'), verified(g.verifiedAt)]]) + (reasonText(g.state, g.reason) ? `<p class="nagex-conn-hint">${escapeHtml(reasonText(g.state, g.reason))}</p>` : '') + secure + confirmBlock('disconnect', t('conn.disconnect.confirm', { app: 'Google' }));
      foot = `${g.state === 'REAUTH_REQUIRED' ? `<button type="button" class="nagex-conn-btn primary" data-act="drawer-reconnect">${escapeHtml(t('conn.action.reconnect'))}</button>` : ''}<button type="button" class="nagex-conn-btn" data-act="drawer-check" ${d.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.check'))}</button><button type="button" class="nagex-conn-btn danger" data-act="ask-disconnect" ${d.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.disconnect'))}</button>`;
    } else if (d.kind === 'github') {
      const gh = githubBase(); title = 'GitHub'; icon = 'github'; state = gh.state;
      body = factsHtml([[t('conn.detail.status'), badge(gh.state)], gh.account ? [t('conn.detail.account'), escapeHtml('@' + gh.account)] : null, [t('conn.detail.capabilities'), escapeHtml(t('conn.detail.githubAccess')) + '<br>' + escapeHtml(t(gh.privateAccess ? 'conn.detail.privateYes' : 'conn.detail.privateNo'))], [t('conn.detail.lastVerified'), verified(gh.verifiedAt)]]) + (reasonText(gh.state, gh.reason) ? `<p class="nagex-conn-hint">${escapeHtml(reasonText(gh.state, gh.reason))}</p>` : '') + secure + confirmBlock('disconnect', t('conn.disconnect.confirm', { app: 'GitHub' }));
      foot = `${gh.state === 'REAUTH_REQUIRED' ? `<button type="button" class="nagex-conn-btn primary" data-act="drawer-reconnect">${escapeHtml(t('conn.action.reconnect'))}</button>` : ''}<button type="button" class="nagex-conn-btn" data-act="drawer-check" ${d.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.check'))}</button><button type="button" class="nagex-conn-btn danger" data-act="ask-disconnect" ${d.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.disconnect'))}</button>`;
    } else {
      const server = serverById(d.id);
      if (!server) return '';
      title = server.name; icon = 'mcp'; state = server.status === 'CONNECTED' ? 'CONNECTED' : server.status === 'IDENTITY_MISMATCH' ? 'REAUTH_REQUIRED' : 'ERROR';
      const tools = Array.isArray(server.tools) ? server.tools : [];
      body = (server.status === 'IDENTITY_MISMATCH' ? `<p class="nagex-conn-alert" role="alert">${escapeHtml(t('conn.mcp.mismatch'))}</p>` : '')
        + factsHtml([[t('conn.detail.status'), badge(state)], [t('conn.mcp.identity'), escapeHtml((server.identity && server.identity.serverName) || '—') + (server.identity && server.identity.serverVersion ? ' ' + escapeHtml(server.identity.serverVersion) : '')], [t('conn.mcp.origin'), escapeHtml((server.identity && server.identity.origin) || server.url)], [t('conn.mcp.toolsEnabled'), escapeHtml(t('conn.cap.mcpCount', { enabled: tools.filter((x) => x.enabled).length, total: tools.length }))], [t('conn.detail.lastVerified'), verified(server.discoveredAt)]])
        + toolsHtml(server, d) + secure + confirmBlock('remove', t('conn.remove.confirm'));
      foot = `<button type="button" class="nagex-conn-btn" data-act="mcp-refresh" ${d.busy ? 'disabled aria-busy="true"' : ''}>${escapeHtml(t('conn.action.refresh'))}</button><button type="button" class="nagex-conn-btn danger" data-act="ask-remove" ${d.busy ? 'disabled' : ''}>${escapeHtml(t('conn.action.removeServer'))}</button>`;
    }
    return `
      <header class="nagex-conn-panel-head">${iconHtml(icon)}<div><h2 id="nagex-layer-title">${escapeHtml(title)}</h2><p>${escapeHtml(t(d.kind === 'mcp' ? 'conn.kind.mcp' : 'conn.kind.builtin'))}</p></div>${closeBtn}</header>
      <div class="nagex-conn-panel-body">${body}<p class="nagex-conn-error" role="alert">${escapeHtml(d.error || '')}</p><p class="nagex-conn-success" role="status">${escapeHtml(d.message || '')}</p></div>
      <footer class="nagex-conn-panel-foot">${foot}</footer>`;
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // A real read through the existing Calendar connection check; only a CONNECTED answer stamps a verification time.
  async function verifyGoogle() {
    const res = await request(API.googleVerify);
    const connection = res.body && res.body.connection;
    data.googleVerifiedAt = connection && connection.state === 'CONNECTED' && connection.verifiedAt ? connection.verifiedAt : null;
  }
  function applyServer(server) {
    if (!server) return;
    const index = data.mcp.servers.findIndex((s) => s.connectionId === server.connectionId);
    if (index >= 0) data.mcp.servers[index] = server; else data.mcp.servers.push(server);
  }
  async function toolToggle(scope, name, enabled) {
    const id = ui.modal ? ui.modal.serverId : ui.drawer && ui.drawer.id;
    if (!id) return;
    scope.busy = true; scope.error = ''; renderLayer();
    const res = await request(`${API.mcp}/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ enabled }) });
    scope.busy = false; scope.toolConfirm = null;
    if (res.ok && res.body.server) { applyServer(res.body.server); scope.error = ''; announce(t(enabled ? 'conn.msg.toolOn' : 'conn.msg.toolOff', { tool: name })); }
    else scope.error = errorText(res.code);
    renderBody(); renderLayer();
  }

  async function onClick(event) {
    const target = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
    if (!target) return;
    const act = target.getAttribute('data-act');
    const scope = ui.modal || ui.drawer;
    switch (act) {
      case 'filter': ui.filter = target.getAttribute('data-filter') || 'ALL'; renderToolbar(); renderBody(); return;
      case 'sign-in': if (window.NAGEX && window.NAGEX.showAuthModal) window.NAGEX.showAuthModal('signin'); return;
      case 'reload': data.loaded = false; loadAll(); return;
      case 'connect': {
        const src = target.getAttribute('data-source');
        const path = src === 'github' ? githubBase().connectPath : googleBase().connectPath;
        if (path) window.location.href = path;
        return;
      }
      case 'retry': {
        const src = target.getAttribute('data-source');
        ui.busyApp = target.getAttribute('data-app'); renderBody();
        if (src === 'google') await verifyGoogle();
        await loadAll({ verify: src === 'github' });
        ui.busyApp = null; renderBody();
        return;
      }
      case 'manage': {
        const app = CATALOG.find((item) => item.id === target.getAttribute('data-app'));
        if (!app) return;
        ui.drawer = { kind: app.source === 'github' ? 'github' : 'google', id: app.source, confirm: null, busy: false, error: '', message: '' };
        openLayer('drawer', target); return;
      }
      case 'manage-item': {
        ui.drawer = { kind: target.getAttribute('data-kind'), id: target.getAttribute('data-id'), confirm: null, busy: false, error: '', message: '', toolConfirm: null };
        openLayer('drawer', target); return;
      }
      case 'add-mcp': ui.modal = { step: 'form', name: '', url: '', error: '', errors: {}, busy: false, toolConfirm: null }; openLayer('modal', target); return;
      case 'close-layer': if (ui.modal && ui.modal.busy) return; closeLayer(); return;
      case 'tool-toggle': {
        if (!scope) return;
        const name = target.getAttribute('data-tool');
        const server = serverById(ui.modal ? ui.modal.serverId : ui.drawer.id);
        const tool = server && server.tools.find((x) => x.name === name);
        if (!tool) return;
        if (tool.enabled) await toolToggle(scope, name, false); // turning off needs no confirmation
        else { scope.toolConfirm = name; renderLayer(); }
        return;
      }
      case 'tool-cancel': if (scope) { scope.toolConfirm = null; renderLayer(); } return;
      case 'tool-confirm': if (scope) await toolToggle(scope, target.getAttribute('data-tool'), true); return;
      case 'ask-disconnect': ui.drawer.confirm = 'disconnect'; renderLayer(); return;
      case 'ask-remove': ui.drawer.confirm = 'remove'; renderLayer(); return;
      case 'cancel-confirm': ui.drawer.confirm = null; renderLayer(); return;
      case 'drawer-reconnect': { const path = ui.drawer.kind === 'github' ? githubBase().connectPath : googleBase().connectPath; if (path) window.location.href = path; return; }
      case 'drawer-check': {
        const d = ui.drawer; d.busy = true; d.error = ''; d.message = ''; renderLayer();
        if (d.kind === 'google') await verifyGoogle();
        await loadAll({ verify: d.kind === 'github' });
        d.busy = false;
        const st = d.kind === 'github' ? githubBase().state : googleBase().state;
        if (st === 'CONNECTED') { d.message = t('conn.msg.checked'); announce(d.message); } else d.error = reasonText(st, d.kind === 'github' ? githubBase().reason : googleBase().reason) || stateLabel(st);
        renderLayer(); return;
      }
      case 'confirm-disconnect': {
        const d = ui.drawer; const github = d.kind === 'github'; d.busy = true; d.confirm = null; renderLayer();
        const res = await request(github ? API.githubDisconnect : API.googleDisconnect, { method: 'POST', body: '{}' });
        d.busy = false;
        if (res.ok) { announce(t('conn.msg.disconnected', { app: github ? 'GitHub' : 'Google' })); await loadAll(); closeLayer(); }
        else { d.error = t('conn.err.generic'); renderLayer(); }
        return;
      }
      case 'mcp-refresh': {
        const d = ui.drawer; d.busy = true; d.error = ''; d.message = ''; renderLayer();
        const res = await request(`${API.mcp}/${encodeURIComponent(d.id)}/refresh`, { method: 'POST', body: '{}' });
        d.busy = false;
        if (res.ok && res.body.server) { applyServer(res.body.server); d.message = t('conn.msg.refreshed'); announce(d.message); } else d.error = errorText(res.code);
        renderBody(); renderLayer(); return;
      }
      case 'confirm-remove': {
        const d = ui.drawer; d.busy = true; d.confirm = null; renderLayer();
        const res = await request(`${API.mcp}/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
        d.busy = false;
        if (res.ok) { data.mcp.servers = data.mcp.servers.filter((s) => s.connectionId !== d.id); announce(t('conn.msg.removed')); renderBody(); closeLayer(); }
        else { d.error = errorText(res.code); renderLayer(); }
        return;
      }
      default:
    }
  }

  // ── public mount ─────────────────────────────────────────────────────────────────────────────────────────────────
  // Called by Settings every time the Connections panel is (re)built. The panel DOM is replaced by Settings, so this re-mounts into
  // it from cached data and only asks the server again when the data is missing or stale.
  function mount(options) {
    const el = rootEl();
    if (!el) return;
    if (options && options.signedOut) { data.signedOut = true; data.loaded = true; renderAll(); return; }
    if (data.signedOut) { data.signedOut = false; data.loaded = false; }
    renderAll();
    if (!data.loading && (!data.loaded || Date.now() - data.lastLoadAt > STALE_MS)) loadAll();
  }

  window.addEventListener('nagex:localechange', () => { if (document.getElementById('nagex-connections')) renderAll(); });
  window.NAGEX_CONNECTIONS_UI = Object.freeze({ mount });
})();
