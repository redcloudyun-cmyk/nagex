// NAgex Settings > Connections > Additional MCP servers.
// All server and tool actions use the authenticated NAgex API. No MCP tools
// are invoked from this UI; enable only exposes capabilities to the existing
// hash-bound approval authority. Credentials are never read back or displayed.
(function () {
  'use strict';

  const labels = {
    en: {
      title: 'Additional tools (MCP)', note: 'Optional HTTPS servers. Discovered tools stay disabled until you enable them. Every invocation requires NAgex approval.',
      name: 'Server name', url: 'HTTPS server URL', token: 'Bearer token (optional)', add: 'Add server', busy: 'Connecting and checking the server…',
      empty: 'No additional MCP servers connected.', load: 'Loading MCP servers…', unavailable: 'MCP is unavailable on this server.',
      signIn: 'Sign in to manage additional tools.', refresh: 'Refresh tools', remove: 'Remove server',
      enabled: 'Enabled', disabled: 'Disabled', changed: 'Changed — review required', rejected: 'Rejected tools',
      danger: 'Remove this MCP server and disable its tools?', failed: 'Could not complete the request.',
      verified: 'Server verified', warning: 'Only connect servers you trust. A tool can access data or trigger actions after approval.',
      noTools: 'No supported tools discovered.', retry: 'Retry', identity: 'Verified identity'
    },
    ko: {
      title: '추가 도구 (MCP)', note: '선택적으로 HTTPS 서버를 연결합니다. 발견된 도구는 사용자가 활성화하기 전까지 꺼져 있으며 실행할 때마다 NAgex 승인이 필요합니다.',
      name: '서버 이름', url: 'HTTPS 서버 주소', token: 'Bearer 토큰 (선택)', add: '서버 추가', busy: '서버 연결 및 검증 중…',
      empty: '추가로 연결한 MCP 서버가 없습니다.', load: 'MCP 서버 불러오는 중…', unavailable: '이 서버에서는 MCP를 사용할 수 없습니다.',
      signIn: '추가 도구를 관리하려면 로그인하세요.', refresh: '도구 다시 확인', remove: '서버 제거',
      enabled: '활성', disabled: '비활성', changed: '도구 정의 변경 — 재검토 필요', rejected: '거부된 도구',
      danger: '이 MCP 서버와 연결된 도구를 제거할까요?', failed: '요청을 완료하지 못했습니다.',
      verified: '서버 검증 완료', warning: '신뢰할 수 있는 서버만 연결하세요. 승인 후 도구가 데이터에 접근하거나 작업을 실행할 수 있습니다.',
      noTools: '지원되는 도구를 찾지 못했습니다.', retry: '다시 시도', identity: '검증된 서버'
    }
  };
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const ui = () => labels[window.NAGEX_I18N?.getLocale?.() === 'ko' ? 'ko' : 'en'];
  let mount = null;
  let servers = [];
  let error = '';
  let loading = false;
  let submitting = false;
  let signedOut = false;
  let sequence = 0;

  async function request(endpoint, options) {
    const res = await fetch(endpoint, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const detail = body.error?.message || res.statusText || ui().failed;
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return body.data && typeof body.data === 'object' ? body.data : body;
  }

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

  function render() {
    const el = root();
    if (!el) return;
    mount = el;
    const t = ui();
    el.innerHTML = `
      <h3>${escapeHtml(t.title)}</h3>
      <p class="setting-sub">${escapeHtml(t.note)}</p>
      <p class="setting-sub nagex-mcp-warning">${escapeHtml(t.warning)}</p>
      <form id="nagex-mcp-add" autocomplete="off" ${signedOut ? 'hidden' : ''}>
        <div class="nagex-mcp-form-fields">
          <label>${escapeHtml(t.name)}<input name="name" type="text" maxlength="80" required></label>
          <label>${escapeHtml(t.url)}<input name="url" type="url" placeholder="https://example.com/mcp" pattern="https://.*" required></label>
          <label>${escapeHtml(t.token)}<input name="bearerToken" type="password" autocomplete="new-password"></label>
        </div>
        <button class="settings-primary-action secondary" type="submit" ${submitting ? 'disabled' : ''}>${escapeHtml(submitting ? t.busy : t.add)}</button>
      </form>
      <p class="setting-sub" role="status" aria-live="polite" id="nagex-mcp-status">${escapeHtml(signedOut ? t.signIn : (error || (loading ? t.load : '')))}</p>
      <div class="nagex-mcp-list">${servers.length
        ? servers.map(server => `
          <article class="nagex-mcp-server">
            <div class="nagex-mcp-heading">
              <strong>${escapeHtml(server.name)}</strong>
              <span class="settings-state-pill">${escapeHtml(server.status)}</span>
            </div>
            <p class="setting-sub">${escapeHtml(server.url)} · ${escapeHtml(t.identity)}: ${escapeHtml(server.identity?.serverName || '—')}</p>
            <div class="nagex-mcp-actions">
              <button type="button" data-mcp-action="refresh" data-id="${escapeHtml(server.connectionId)}" ${submitting ? 'disabled' : ''}>${escapeHtml(t.refresh)}</button>
              <button type="button" data-mcp-action="remove" data-id="${escapeHtml(server.connectionId)}" ${submitting ? 'disabled' : ''}>${escapeHtml(t.remove)}</button>
            </div>
            <div class="nagex-mcp-tools">${server.tools?.length ? server.tools.map(tool => `
              <label class="nagex-mcp-tool">
                <input type="checkbox" data-mcp-action="toggle" data-id="${escapeHtml(server.connectionId)}" data-tool="${escapeHtml(tool.name)}" ${tool.enabled ? 'checked' : ''} ${submitting || server.status !== 'CONNECTED' ? 'disabled' : ''}>
                <span><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description || '')}</small>${tool.changedSinceEnabled ? '<small>' + escapeHtml(t.changed) + '</small>' : ''}</span>
              </label>`).join('') : '<p class="setting-sub">' + escapeHtml(t.noTools) + '</p>'}</div>
            ${server.rejectedTools?.length ? '<p class="setting-sub">' + escapeHtml(t.rejected) + ': ' + escapeHtml(server.rejectedTools.map(x => x.name).join(', ')) + '</p>' : ''}
          </article>`).join('')
        : !loading ? '<p class="setting-sub">' + escapeHtml(t.empty) + '</p>' : ''}
      </div>`;
    el.querySelector('form').addEventListener('submit', onAdd);
    el.querySelectorAll('[data-mcp-action]').forEach(control => {
      control.addEventListener(control.type === 'checkbox' ? 'change' : 'click', onAction);
    });
  }

  async function load() {
    const version = ++sequence;
    loading = true;
    error = '';
    render();
    try {
      const result = await request('/api/v1/mcp/servers');
      if (version !== sequence) return;
      servers = Array.isArray(result.servers) ? result.servers : [];
    } catch (err) {
      if (version !== sequence) return;
      servers = [];
      error = err.status === 401 ? ui().signIn : err.status === 503 ? ui().unavailable : err.message;
    } finally {
      if (version === sequence) { loading = false; render(); }
    }
  }

  async function onAdd(event) {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      url: String(data.get('url') || '').trim(),
      bearerToken: String(data.get('bearerToken') || ''),
    };
    if (!payload.url.startsWith('https://')) { error = 'HTTPS required'; render(); return; }
    // The token is used only in this request. It is not retained in UI state.
    form.reset();
    submitting = true;
    error = '';
    render();
    try {
      await request('/api/v1/mcp/servers', { method: 'POST', body: JSON.stringify(payload) });
      await load();
    } catch (err) { error = err.message; }
    finally { submitting = false; render(); }
  }

  async function onAction(event) {
    if (submitting) return;
    const control = event.currentTarget;
    const action = control.dataset.mcpAction;
    const id = control.dataset.id;
    const tool = control.dataset.tool;
    if (!/^mcp_[a-f0-9]{16}$/.test(id)) return;
    if (action === 'remove' && !window.confirm(ui().danger)) return;
    submitting = true;
    error = '';
    render();
    try {
      const endpoint = '/api/v1/mcp/servers/' + encodeURIComponent(id);
      if (action === 'remove') await request(endpoint, { method: 'DELETE' });
      if (action === 'refresh') await request(endpoint + '/refresh', { method: 'POST', body: '{}' });
      if (action === 'toggle' && tool) await request(endpoint + '/tools/' + encodeURIComponent(tool), { method: 'POST', body: JSON.stringify({ enabled: control.checked }) });
      await load();
    } catch (err) { error = err.message; }
    finally { submitting = false; render(); }
  }

  window.NAGEX_MCP_SETTINGS = Object.freeze({
    mount: function (isSignedOut) {
      signedOut = Boolean(isSignedOut);
      // The parent Connections view is rebuilt by the existing Settings code.
      // Always mount into its current DOM and load owner-scoped server status.
      servers = [];
      if (signedOut) { ++sequence; loading = false; error = ''; render(); return; }
      load();
    },
  });
})();
