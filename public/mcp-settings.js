// NAgex Settings > Connections > Additional tools (MCP).
// Every action uses the authenticated NAgex API (owner-scoped on the server). No MCP tool is ever invoked from this UI:
// enabling a tool only exposes it to the existing Capability Broker, where every call still needs a hash-bound approval.
// Credentials are write-only: the bearer token is sent once and is never read back, stored in UI state or displayed.
(function () {
  'use strict';

  const labels = {
    en: {
      title: 'Additional tools (MCP)', note: 'Optional HTTPS servers. Discovered tools stay disabled until you enable them. Every use requires NAgex approval.',
      name: 'Server name', url: 'HTTPS server URL', token: 'Bearer token (optional)', add: 'Add server', busy: 'Connecting and checking the server…',
      empty: 'No additional MCP servers connected.', load: 'Loading MCP servers…', unavailable: 'MCP is unavailable on this server.',
      signIn: 'Sign in to manage additional tools.', refresh: 'Refresh tools', remove: 'Remove server',
      changed: 'Definition changed — review before enabling', rejected: 'Tools not supported', danger: 'Remove this MCP server and disable its tools?',
      failed: 'Could not complete the request.', warning: 'Only connect servers you trust. After approval, a tool can access data or trigger actions.',
      noTools: 'No supported tools discovered.', identity: 'Verified server', httpsRequired: 'The address must start with https://.',
      enableConfirm: 'Enable "{tool}"? NAgex will be able to request this tool. Each use still needs your approval.',
      statusCONNECTED: 'Connected', statusIDENTITY_MISMATCH: 'Server identity changed — tools disabled', statusERROR: 'Needs attention',
      mismatchHelp: 'This server no longer identifies as the one you connected. Its tools are disabled. Remove it and add it again only if you trust it.',
      errors: {
        UNAUTHORIZED: 'Sign in to manage additional tools.', MCP_NOT_AVAILABLE: 'MCP is unavailable on this server.',
        MCP_URL_REJECTED: 'That address is not allowed. Use a public HTTPS address.', MCP_INVALID_REQUEST: 'Check the server name and address.',
        MCP_LIMIT_REACHED: 'You have reached the maximum number of MCP servers.', MCP_UNREACHABLE: 'The server could not be reached.',
        MCP_TIMEOUT: 'The server did not respond in time.', MCP_SERVER_AUTH_FAILED: 'The server rejected the token.',
        MCP_RATE_LIMITED: 'The server is limiting requests. Try again shortly.', MCP_PROTOCOL_ERROR: 'The server did not answer as an MCP server.',
        MCP_SERVER_ERROR: 'The server returned an error.', MCP_RESPONSE_TOO_LARGE: 'The server response was too large.',
        MCP_REDIRECT_BLOCKED: 'The server tried to redirect, which is not allowed.', MCP_NOT_FOUND: 'That server or tool no longer exists.',
        MCP_SERVER_NOT_TRUSTED: 'This server must be removed and added again before its tools can be used.',
        MCP_IDENTITY_MISMATCH: 'This server no longer identifies as the one you connected.', MCP_TOOL_CHANGED: 'This tool changed. Review it before enabling.',
      },
    },
    ko: {
      title: '추가 도구 (MCP)', note: '선택적으로 HTTPS 서버를 연결합니다. 발견된 도구는 사용자가 활성화하기 전까지 꺼져 있으며 사용할 때마다 NAgex 승인이 필요합니다.',
      name: '서버 이름', url: 'HTTPS 서버 주소', token: 'Bearer 토큰 (선택)', add: '서버 추가', busy: '서버 연결 및 검증 중…',
      empty: '추가로 연결한 MCP 서버가 없습니다.', load: 'MCP 서버를 불러오는 중…', unavailable: '이 서버에서는 MCP를 사용할 수 없습니다.',
      signIn: '추가 도구를 관리하려면 로그인하세요.', refresh: '도구 다시 확인', remove: '서버 제거',
      changed: '도구 정의 변경 — 활성화 전 검토 필요', rejected: '지원되지 않는 도구', danger: '이 MCP 서버와 연결된 도구를 제거할까요?',
      failed: '요청을 완료하지 못했습니다.', warning: '신뢰할 수 있는 서버만 연결하세요. 승인 후 도구가 데이터에 접근하거나 작업을 실행할 수 있습니다.',
      noTools: '지원되는 도구를 찾지 못했습니다.', identity: '검증된 서버', httpsRequired: '주소는 https://로 시작해야 합니다.',
      enableConfirm: '"{tool}" 도구를 활성화할까요? NAgex가 이 도구를 요청할 수 있게 됩니다. 사용할 때마다 승인이 필요합니다.',
      statusCONNECTED: '연결됨', statusIDENTITY_MISMATCH: '서버 신원 변경됨 — 도구 비활성화됨', statusERROR: '확인 필요',
      mismatchHelp: '이 서버가 더 이상 연결한 서버로 확인되지 않아 도구가 비활성화되었습니다. 신뢰할 수 있다면 제거 후 다시 추가하세요.',
      errors: {
        UNAUTHORIZED: '추가 도구를 관리하려면 로그인하세요.', MCP_NOT_AVAILABLE: '이 서버에서는 MCP를 사용할 수 없습니다.',
        MCP_URL_REJECTED: '허용되지 않는 주소입니다. 공개 HTTPS 주소를 사용하세요.', MCP_INVALID_REQUEST: '서버 이름과 주소를 확인하세요.',
        MCP_LIMIT_REACHED: 'MCP 서버를 최대 개수까지 연결했습니다.', MCP_UNREACHABLE: '서버에 연결할 수 없습니다.',
        MCP_TIMEOUT: '서버가 제시간에 응답하지 않았습니다.', MCP_SERVER_AUTH_FAILED: '서버가 토큰을 거부했습니다.',
        MCP_RATE_LIMITED: '서버가 요청을 제한하고 있습니다. 잠시 후 다시 시도하세요.', MCP_PROTOCOL_ERROR: '서버가 MCP 서버로 응답하지 않았습니다.',
        MCP_SERVER_ERROR: '서버에서 오류가 반환되었습니다.', MCP_RESPONSE_TOO_LARGE: '서버 응답이 너무 커요.',
        MCP_REDIRECT_BLOCKED: '서버가 리다이렉트를 시도했지만 허용되지 않습니다.', MCP_NOT_FOUND: '해당 서버 또는 도구가 더 이상 없습니다.',
        MCP_SERVER_NOT_TRUSTED: '이 서버를 제거한 뒤 다시 추가해야 도구를 사용할 수 있습니다.',
        MCP_IDENTITY_MISMATCH: '이 서버가 더 이상 연결한 서버로 확인되지 않습니다.', MCP_TOOL_CHANGED: '도구가 변경되었습니다. 활성화 전 검토하세요.',
      },
    },
  };
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ui = () => labels[window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko' : 'en'];
  const REQUEST_TIMEOUT_MS = 45000; // adding a server runs a handshake and a tool listing on the server side
  const STALE_MS = 3000;

  let servers = [];
  let loaded = false;
  let lastLoadAt = 0;
  let loading = false;
  let submitting = false;
  let signedOut = false;
  let unavailable = false;
  let errorCode = '';
  let errorText = '';
  let draft = { name: '', url: '' }; // never the token
  let sequence = 0;

  async function request(endpoint, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, ...options });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        const err = new Error((body.error && body.error.message) || res.statusText || 'request failed');
        err.status = res.status;
        err.code = (body.error && body.error.code) || '';
        throw err;
      }
      return body;
    } catch (err) {
      if (err && err.name === 'AbortError') { const timeout = new Error('timeout'); timeout.code = 'MCP_TIMEOUT'; throw timeout; }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setError(err) {
    errorCode = (err && err.code) || (err && err.status === 401 ? 'UNAUTHORIZED' : '');
    errorText = errorCode ? '' : ui().failed; // server wording is never shown raw
    // only the NAgex session being absent means signed out; an MCP server rejecting our token is a provider error
    if (err && err.status === 401 && (!err.code || err.code === 'UNAUTHORIZED')) signedOut = true;
    if (err && (err.status === 503 || errorCode === 'MCP_NOT_AVAILABLE')) unavailable = true;
  }
  const errorMessage = () => (errorCode ? (ui().errors[errorCode] || ui().failed) : errorText);

  function root() {
    const container = document.getElementById('settings-connections-status');
    if (!container) return null;
    let el = container.querySelector('#nagex-mcp-settings');
    if (!el) {
      el = document.createElement('section');
      el.id = 'nagex-mcp-settings';
      el.className = 'settings-pro-card nagex-mcp-settings';
      container.appendChild(el);
    }
    return el;
  }

  function serverHtml(server, t) {
    const status = server.status || 'ERROR';
    const toolsLocked = submitting || status !== 'CONNECTED';
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const rejected = Array.isArray(server.rejectedTools) ? server.rejectedTools : [];
    return `
      <article class="nagex-mcp-server" data-server-id="${escapeHtml(server.connectionId)}">
        <div class="nagex-mcp-heading">
          <strong>${escapeHtml(server.name)}</strong>
          <span class="settings-state-pill" data-status="${escapeHtml(status)}">${escapeHtml(t['status' + status] || t.statusERROR)}</span>
        </div>
        <p class="setting-sub">${escapeHtml(server.url)} · ${escapeHtml(t.identity)}: ${escapeHtml((server.identity && server.identity.serverName) || '—')}</p>
        ${status === 'IDENTITY_MISMATCH' ? '<p class="setting-sub nagex-mcp-alert" role="alert">' + escapeHtml(t.mismatchHelp) + '</p>' : ''}
        <div class="nagex-mcp-actions">
          <button type="button" data-mcp-action="refresh" data-id="${escapeHtml(server.connectionId)}" ${submitting ? 'disabled' : ''}>${escapeHtml(t.refresh)}</button>
          <button type="button" data-mcp-action="remove" data-id="${escapeHtml(server.connectionId)}" ${submitting ? 'disabled' : ''}>${escapeHtml(t.remove)}</button>
        </div>
        <div class="nagex-mcp-tools">${tools.length ? tools.map((tool) => `
          <label class="nagex-mcp-tool">
            <input type="checkbox" data-mcp-action="toggle" data-id="${escapeHtml(server.connectionId)}" data-tool="${escapeHtml(tool.name)}" ${tool.enabled ? 'checked' : ''} ${toolsLocked ? 'disabled' : ''}>
            <span><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description || '')}</small>${tool.changedSinceEnabled ? '<small class="nagex-mcp-changed">' + escapeHtml(t.changed) + '</small>' : ''}</span>
          </label>`).join('') : '<p class="setting-sub">' + escapeHtml(t.noTools) + '</p>'}</div>
        ${rejected.length ? '<p class="setting-sub">' + escapeHtml(t.rejected) + ': ' + escapeHtml(rejected.map((x) => x.name || '?').join(', ')) + '</p>' : ''}
      </article>`;
  }

  function render() {
    const el = root();
    if (!el) return;
    const t = ui();
    const showForm = !signedOut && !unavailable;
    const message = signedOut ? t.signIn : unavailable ? t.unavailable : (errorMessage() || (loading && !loaded ? t.load : ''));
    el.innerHTML = `
      <h3>${escapeHtml(t.title)}</h3>
      <p class="setting-sub">${escapeHtml(t.note)}</p>
      <p class="setting-sub nagex-mcp-warning">${escapeHtml(t.warning)}</p>
      <form id="nagex-mcp-add" autocomplete="off" ${showForm ? '' : 'hidden'}>
        <div class="nagex-mcp-form-fields">
          <label>${escapeHtml(t.name)}<input name="name" type="text" maxlength="60" required value="${escapeHtml(draft.name)}"></label>
          <label>${escapeHtml(t.url)}<input name="url" type="url" placeholder="https://example.com/mcp" pattern="https://.*" required value="${escapeHtml(draft.url)}"></label>
          <label>${escapeHtml(t.token)}<input name="bearerToken" type="password" autocomplete="new-password"></label>
        </div>
        <button class="settings-primary-action secondary" type="submit" ${submitting ? 'disabled' : ''}>${escapeHtml(submitting ? t.busy : t.add)}</button>
      </form>
      <p class="setting-sub nagex-mcp-status" role="status" aria-live="polite" id="nagex-mcp-status">${escapeHtml(message)}</p>
      <div class="nagex-mcp-list">${showForm && servers.length ? servers.map((server) => serverHtml(server, t)).join('') : showForm && loaded && !loading ? '<p class="setting-sub">' + escapeHtml(t.empty) + '</p>' : ''}</div>`;
    el.querySelector('form').addEventListener('submit', onAdd);
    el.querySelectorAll('[data-mcp-action]').forEach((control) => {
      control.addEventListener(control.type === 'checkbox' ? 'change' : 'click', onAction);
    });
  }

  async function load() {
    const version = ++sequence;
    loading = true;
    errorCode = ''; errorText = ''; unavailable = false;
    render();
    try {
      const result = await request('/api/v1/mcp/servers');
      if (version !== sequence) return;
      servers = Array.isArray(result.servers) ? result.servers : [];
      loaded = true;
      lastLoadAt = Date.now();
    } catch (err) {
      if (version !== sequence) return;
      servers = [];
      loaded = true;
      setError(err);
    } finally {
      if (version === sequence) { loading = false; render(); }
    }
  }

  async function onAdd(event) {
    event.preventDefault();
    if (submitting) return;
    const data = new FormData(event.currentTarget);
    const payload = { name: String(data.get('name') || '').trim(), url: String(data.get('url') || '').trim(), bearerToken: String(data.get('bearerToken') || '') };
    draft = { name: payload.name, url: payload.url };
    if (!/^https:\/\//i.test(payload.url)) { errorCode = ''; errorText = ui().httpsRequired; render(); return; }
    submitting = true;
    errorCode = ''; errorText = '';
    render(); // re-renders the form without the token: it lives only in this request
    try {
      await request('/api/v1/mcp/servers', { method: 'POST', body: JSON.stringify(payload) });
      draft = { name: '', url: '' };
      submitting = false;
      await load();
    } catch (err) {
      setError(err);
      submitting = false;
      render();
    }
  }

  async function onAction(event) {
    if (submitting) return;
    const control = event.currentTarget;
    const action = control.dataset.mcpAction;
    const id = control.dataset.id;
    const tool = control.dataset.tool;
    if (!/^mcp_[a-f0-9]{16}$/.test(id)) return;
    if (action === 'remove' && !window.confirm(ui().danger)) return;
    if (action === 'toggle' && control.checked && !window.confirm(ui().enableConfirm.replace('{tool}', tool || ''))) { render(); return; }
    submitting = true;
    errorCode = ''; errorText = '';
    render();
    try {
      const endpoint = '/api/v1/mcp/servers/' + encodeURIComponent(id);
      if (action === 'remove') await request(endpoint, { method: 'DELETE' });
      if (action === 'refresh') await request(endpoint + '/refresh', { method: 'POST', body: '{}' });
      if (action === 'toggle' && tool) await request(endpoint + '/tools/' + encodeURIComponent(tool), { method: 'POST', body: JSON.stringify({ enabled: control.checked }) });
      submitting = false;
      await load();
    } catch (err) {
      setError(err);
      submitting = false;
      await load(); // show the server's truth (and keep the error message set above)
      setError(err);
      render();
    }
  }

  window.NAGEX_MCP_SETTINGS = Object.freeze({
    // The parent Connections view is rebuilt by the Settings code, so this re-mounts into its current DOM from the cache and
    // only refreshes from the server when the data is missing or stale (avoids a request storm on every parent re-render).
    mount: function (isSignedOut) {
      signedOut = Boolean(isSignedOut);
      if (signedOut) { ++sequence; servers = []; loaded = false; loading = false; unavailable = false; errorCode = ''; errorText = ''; draft = { name: '', url: '' }; render(); return; }
      if (signedOut === false && errorCode === 'UNAUTHORIZED') errorCode = '';
      render();
      if (!loading && (!loaded || Date.now() - lastLoadAt > STALE_MS)) load();
    },
  });
})();
