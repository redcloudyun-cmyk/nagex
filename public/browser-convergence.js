(function () {
  'use strict';

  const COPY = {
    en: {
      searchTitle: 'Search NAgex',
      searchPlaceholder: 'Search tasks, artifacts, knowledge, vault, and activity',
      searchEmpty: 'No matching results.',
      searchUnavailable: 'Search is unavailable right now.',
      close: 'Close',
      revisionTitle: 'Revise this document',
      revisionPlaceholder: 'Describe the bounded change to make...',
      revise: 'Revise',
      revisionUnavailable: 'Document revision is unavailable right now.',
      revisionCreated: 'Revision saved. Opening the latest version.',
    },
    ko: {
      searchTitle: 'NAgex 검색',
      searchPlaceholder: '작업, 아티팩트, 지식, 보관함, 활동 검색',
      searchEmpty: '일치하는 결과가 없습니다.',
      searchUnavailable: '지금은 검색을 사용할 수 없습니다.',
      close: '닫기',
      revisionTitle: '문서 수정',
      revisionPlaceholder: '반영할 변경 내용을 입력하세요...',
      revise: '수정',
      revisionUnavailable: '지금은 문서 수정을 사용할 수 없습니다.',
      revisionCreated: '수정본을 저장했습니다. 최신 버전을 엽니다.',
    },
  };

  function locale() {
    try {
      return (localStorage.getItem('nagex_locale') || '').startsWith('ko') ? 'ko' : 'en';
    } catch {
      return 'en';
    }
  }

  function t(key) {
    return (COPY[locale()] || COPY.en)[key] || COPY.en[key] || key;
  }

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function apiFetch(path, options) {
    if (window.NAGEX && typeof window.NAGEX.apiFetch === 'function') return window.NAGEX.apiFetch(path, options);
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options || {})).then((r) => r.json());
  }

  function ensureSearchPanel() {
    ensureStyles();
    let panel = document.getElementById('nagex-real-search-panel');
    if (panel) return panel;
    panel = document.createElement('aside');
    panel.id = 'nagex-real-search-panel';
    panel.className = 'nagex-real-search-panel';
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="nagex-real-search-shell" role="dialog" aria-modal="false" aria-labelledby="nagex-real-search-title">',
      `  <div class="nagex-real-search-head"><h2 id="nagex-real-search-title">${esc(t('searchTitle'))}</h2><button type="button" data-search-close>${esc(t('close'))}</button></div>`,
      `  <input id="nagex-real-search-input" type="search" autocomplete="off" placeholder="${esc(t('searchPlaceholder'))}" />`,
      '  <div id="nagex-real-search-results" class="nagex-real-search-results" aria-live="polite"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(panel);
    panel.querySelector('[data-search-close]')?.addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('#nagex-real-search-input')?.addEventListener('input', debounce(runSearch, 180));
    return panel;
  }

  function ensureStyles() {
    if (document.getElementById('nagex-browser-convergence-style')) return;
    const style = document.createElement('style');
    style.id = 'nagex-browser-convergence-style';
    style.textContent = `
      .nagex-real-search-panel{position:fixed;inset:72px auto auto 50%;transform:translateX(-50%);width:min(720px,calc(100vw - 32px));z-index:2200}
      .nagex-real-search-shell{background:#fff;border:1px solid #d7dde8;box-shadow:0 18px 48px rgba(15,23,42,.18);border-radius:8px;padding:16px;display:grid;gap:12px}
      .nagex-real-search-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .nagex-real-search-head h2{font-size:16px;line-height:1.2;margin:0;color:#111827}
      .nagex-real-search-head button,.nagex-document-revision-control button{border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:6px;padding:8px 10px;cursor:pointer}
      #nagex-real-search-input,.nagex-document-revision-control textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:10px;font:inherit}
      .nagex-real-search-results{display:grid;gap:8px;max-height:52vh;overflow:auto}
      .nagex-real-search-row{text-align:left;border:1px solid #e2e8f0;background:#fff;border-radius:6px;padding:10px;display:grid;gap:4px;cursor:pointer}
      .nagex-real-search-row:hover{border-color:#2563eb;background:#f8fbff}
      .nagex-real-search-row span{font-size:11px;font-weight:700;color:#2563eb}
      .nagex-real-search-row strong{font-size:14px;color:#0f172a}
      .nagex-real-search-row small,.nagex-real-search-empty{font-size:12px;color:#64748b;margin:0}
      .nagex-document-revision-control{margin-top:12px;border-top:1px solid #e2e8f0;padding-top:12px;display:grid;gap:8px}
      .nagex-document-revision-control h3{font-size:13px;line-height:1.3;margin:0;color:#111827}
      .nagex-document-revision-control p{min-height:18px;margin:0;font-size:12px;color:#64748b}
      @media (max-width:640px){.nagex-real-search-panel{inset:56px 12px auto 12px;transform:none;width:auto}.nagex-document-revision-control{padding:12px}}
    `;
    document.head.appendChild(style);
  }

  function debounce(fn, wait) {
    let id = 0;
    return function () {
      clearTimeout(id);
      id = setTimeout(() => fn.apply(this, arguments), wait);
    };
  }

  async function runSearch() {
    const input = document.getElementById('nagex-real-search-input');
    const list = document.getElementById('nagex-real-search-results');
    if (!input || !list) return;
    try {
      const q = input.value.trim();
      const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=20`);
      const results = res && Array.isArray(res.results) ? res.results : [];
      if (!results.length) {
        list.innerHTML = `<p class="nagex-real-search-empty">${esc(t('searchEmpty'))}</p>`;
        return;
      }
      list.innerHTML = results.map((item) => `
        <button type="button" class="nagex-real-search-row" data-source="${esc(item.source)}" data-id="${esc(item.id)}" data-target="${esc(item.target)}">
          <span>${esc(item.source)}</span>
          <strong>${esc(item.title)}</strong>
          <small>${esc(item.snippet)}</small>
        </button>
      `).join('');
      list.querySelectorAll('.nagex-real-search-row').forEach((row) => row.addEventListener('click', () => openSearchResult(row)));
    } catch {
      list.innerHTML = `<p class="nagex-real-search-empty">${esc(t('searchUnavailable'))}</p>`;
    }
  }

  async function openSearchResult(row) {
    const source = row.getAttribute('data-source');
    const id = row.getAttribute('data-id');
    const target = row.getAttribute('data-target') || '';
    document.getElementById('nagex-real-search-panel').hidden = true;
    if (source === 'ARTIFACTS') {
      const res = await apiFetch(`/api/v1/artifacts/${encodeURIComponent(id)}`);
      if (res && res.projection && window.NAGEX?.openArtifactInCanvas) {
        window.NAGEX.openArtifactInCanvas(res.projection.artifactId, res.projection.artifactType, res.projection.canvasTarget, res.projection.openTarget, res.projection);
      }
      return;
    }
    if (source === 'TASKS') return window.NAGEX?.switchTab?.('tab-tasks');
    if (source === 'KNOWLEDGE') {
      window.NAGEX?.switchTab?.('tab-knowledge');
      setTimeout(() => document.querySelector(`[data-knowledge-id="${CSS.escape(id)}"]`)?.click(), 250);
      return;
    }
    if (source === 'VAULT') {
      window.NAGEX?.switchTab?.('tab-vault');
      setTimeout(() => window.NAGEX?.previewVaultItem?.(id), 250);
      return;
    }
    if (source === 'ACTIVITY') {
      window.NAGEX?.switchTab?.('tab-executions');
      setTimeout(() => window.NAGEX?.toggleActivityDetail?.(id), 250);
      return;
    }
    if (source === 'INBOX') return window.NAGEX?.switchTab?.('tab-inbox');
    if (target.startsWith('#')) window.location.hash = target;
  }

  function openSearchPanel() {
    const panel = ensureSearchPanel();
    panel.hidden = false;
    const input = panel.querySelector('#nagex-real-search-input');
    if (input) {
      input.placeholder = t('searchPlaceholder');
      input.focus();
      runSearch();
    }
  }

  function documentIdFromCanvasState() {
    const state = window.NAGEX && window.NAGEX._canvasState;
    const openTarget = state && (state.openTarget || state.artifactProjection?.openTarget);
    const match = typeof openTarget === 'string' ? openTarget.match(/\/api\/v1\/creations\/documents\/([^/?#]+)/) : null;
    return match ? decodeURIComponent(match[1]) : null;
  }

  function ensureRevisionControl() {
    const panel = document.querySelector('#view-canvas .canvas-agent-panel, #mobile-view-canvas .mh-canvas-agent-input');
    if (!panel || document.getElementById('nagex-document-revision-control')) return;
    const box = document.createElement('section');
    box.id = 'nagex-document-revision-control';
    box.className = 'nagex-document-revision-control';
    box.innerHTML = `
      <h3>${esc(t('revisionTitle'))}</h3>
      <textarea id="nagex-document-revision-input" rows="3" placeholder="${esc(t('revisionPlaceholder'))}"></textarea>
      <div><button type="button" id="nagex-document-revision-submit">${esc(t('revise'))}</button></div>
      <p id="nagex-document-revision-status" role="status" aria-live="polite"></p>
    `;
    panel.appendChild(box);
    box.querySelector('#nagex-document-revision-submit')?.addEventListener('click', submitRevision);
  }

  async function submitRevision() {
    const documentId = documentIdFromCanvasState();
    const input = document.getElementById('nagex-document-revision-input');
    const status = document.getElementById('nagex-document-revision-status');
    const instruction = input ? input.value.trim() : '';
    if (!documentId || !instruction) return;
    try {
      const result = await apiFetch(`/api/v1/creations/documents/${encodeURIComponent(documentId)}/revisions`, {
        method: 'POST',
        body: JSON.stringify({ instruction, locale: locale() }),
      });
      if (!result || result.error || result.status !== 'SUCCESS') {
        if (status) status.textContent = result?.message || t('revisionUnavailable');
        return;
      }
      if (status) status.textContent = t('revisionCreated');
      if (result.artifactId) {
        const art = await apiFetch(`/api/v1/artifacts/${encodeURIComponent(result.artifactId)}`);
        if (art && art.projection && window.NAGEX?.openArtifactInCanvas) {
          window.NAGEX.openArtifactInCanvas(art.projection.artifactId, art.projection.artifactType, art.projection.canvasTarget, art.projection.openTarget, art.projection);
        }
      }
    } catch {
      if (status) status.textContent = t('revisionUnavailable');
    }
  }

  function install() {
    const searchButton = document.getElementById('btn-header-search');
    if (searchButton) searchButton.onclick = openSearchPanel;
    document.addEventListener('click', () => {
      if (window.location.hash.startsWith('#canvas/')) setTimeout(ensureRevisionControl, 100);
    });
    window.addEventListener('hashchange', () => {
      if (window.location.hash.startsWith('#canvas/')) setTimeout(ensureRevisionControl, 100);
    });
    setTimeout(() => {
      if (window.location.hash.startsWith('#canvas/')) ensureRevisionControl();
    }, 300);
    window.NAGEX_BROWSER_CONVERGENCE = { openSearchPanel, runSearch, openSearchResult, ensureRevisionControl, submitRevision };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}());
