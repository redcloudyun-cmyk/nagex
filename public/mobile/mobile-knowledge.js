// NAgex Mobile Knowledge (R24.5C)
// Real GET /api/v1/knowledge?q= — server-side search, not a client filter
// over an already-fetched list (contrast with mobile-vault.js's client-side
// substring search). Shares the same KnowledgeEngine/VaultStore backend as
// Desktop (DUPLICATE_KNOWLEDGE_SOURCE=0) — no mobile-only state.
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  function emptyState(text) {
    return `<div class="nagex-empty-state">${escapeHtml(text)}</div>`;
  }

  function unwrapApiData(res) {
    if (!res) return null;
    return res.data !== undefined ? res.data : res;
  }

  function statusLabel(status) {
    const map = {
      INDEXED: t('knowledge.statusIndexed', 'Indexed'),
      STORED: t('knowledge.statusStored', 'Stored'),
      PROCESSING: t('knowledge.statusProcessing', 'Processing'),
      FAILED: t('knowledge.statusFailed', 'Failed'),
    };
    return map[status] || status;
  }

  let mhKnowledgeQuery = '';
  let mhKnowledgeLoading = false;
  let mhKnowledgeLoadError = false;
  let mhKnowledgeItems = [];
  let mhKnowledgeSearchDebounce = null;

  async function refreshKnowledgeData(query) {
    if (!window.NAGEX.apiFetch) return;
    mhKnowledgeLoading = true;
    mhKnowledgeLoadError = false;
    renderKnowledgeList();
    try {
      const qs = query ? `?q=${encodeURIComponent(query)}` : '';
      const res = await window.NAGEX.apiFetch(`/api/v1/knowledge${qs}`);
      mhKnowledgeLoading = false;
      const data = unwrapApiData(res);
      if (!data || !Array.isArray(data.documents)) {
        mhKnowledgeLoadError = true;
        renderKnowledgeList();
        return;
      }
      mhKnowledgeItems = data.documents;
      renderKnowledgeList();
    } catch (err) {
      mhKnowledgeLoading = false;
      mhKnowledgeLoadError = true;
      renderKnowledgeList();
    }
  }

  function initSearch() {
    const input = document.getElementById('mh-knowledge-search-input');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('input', () => {
      mhKnowledgeQuery = input.value.trim();
      clearTimeout(mhKnowledgeSearchDebounce);
      mhKnowledgeSearchDebounce = setTimeout(() => refreshKnowledgeData(mhKnowledgeQuery), 300);
    });
  }

  async function uploadKnowledgeFile(file) {
    const addBtn = document.getElementById('mh-knowledge-add-btn');
    const text = await file.text();
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.querySelector('span').textContent = t('knowledge.uploading', 'Adding...');
    }
    try {
      const res = await window.NAGEX.apiFetch('/api/v1/knowledge', {
        method: 'POST',
        body: JSON.stringify({ title: file.name, content: text, mimeType: file.type || 'text/plain' }),
      });
      if (!res || res.error) {
        window.alert(t('knowledge.addFailed', "Couldn't add this document."));
      } else {
        await refreshKnowledgeData(mhKnowledgeQuery);
      }
    } finally {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.querySelector('span').textContent = t('knowledge.addButton', 'Add knowledge');
      }
    }
  }

  function initUpload() {
    const addBtn = document.getElementById('mh-knowledge-add-btn');
    const fileInput = document.getElementById('mh-knowledge-upload-input');
    if (!addBtn || !fileInput || addBtn.dataset.bound) return;
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) uploadKnowledgeFile(file);
    });
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-knowledge-lang-toggle');
  }

  function showKnowledgeSourceModal(item) {
    window.NAGEX.apiFetch(`/api/v1/knowledge/${encodeURIComponent(item.id)}`).then((res) => {
      const data = unwrapApiData(res);
      if (!data || data.error) {
        window.alert(t('knowledge.sourceLoadFailed', "Couldn't load this source."));
        return;
      }
      let modal = document.getElementById('mh-knowledge-detail-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mh-knowledge-detail-modal';
        modal.className = 'mh-detail-modal-overlay';
        document.body.appendChild(modal);
      }
      const created = data.source && data.source.createdAt ? new Date(data.source.createdAt).toLocaleString() : '';
      modal.innerHTML = `
        <div class="mh-detail-modal-card">
          <div class="mh-detail-modal-header">
            <h3>${escapeHtml(data.name)}</h3>
            <button class="mh-detail-modal-close" onclick="document.getElementById('mh-knowledge-detail-modal').style.display='none'">&times;</button>
          </div>
          <div class="mh-detail-modal-body">
            <p class="mh-detail-desc">${escapeHtml(data.content || '')}</p>
            <div class="mh-detail-meta-row">
              <span class="mh-detail-label">${escapeHtml(t('knowledge.status', 'Status:'))}</span>
              <span class="nagex-badge nagex-badge-muted">${escapeHtml(statusLabel(data.status))}</span>
            </div>
            ${data.source ? `
            <div class="mh-detail-meta-row">
              <span class="mh-detail-label">${escapeHtml(t('mobileCommon.created', 'Created:'))}</span>
              <span>${escapeHtml(created)}</span>
            </div>` : `
            <div class="mh-detail-meta-row"><span class="mh-detail-label">${escapeHtml(t('knowledge.sourceUnavailable', 'Original source is no longer available.'))}</span></div>`}
          </div>
          <div class="mh-detail-modal-footer">
            <button class="mh-activity-action-btn secondary" onclick="document.getElementById('mh-knowledge-detail-modal').style.display='none'">${escapeHtml(t('mobileVault.close', 'Close'))}</button>
          </div>
        </div>`;
      modal.style.display = 'flex';
    });
  }

  function renderKnowledgeCard(item) {
    return `
      <div class="mh-vault-card" data-knowledge-id="${escapeHtml(item.id)}">
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(item.name)}</div>
          <div class="mh-row-detail">${escapeHtml(item.snippet || '')}</div>
          <div class="mh-vault-card-meta">
            <span class="nagex-badge nagex-badge-muted">${escapeHtml(statusLabel(item.status))}</span>
            <span class="mh-vault-timestamp">${escapeHtml(String(item.chunk_count))} ${escapeHtml(t('knowledge.chunksShort', 'chunks'))}</span>
          </div>
        </div>
      </div>`;
  }

  function bindCardClickHandlers() {
    const listEl = document.getElementById('mh-knowledge-list');
    if (!listEl || listEl.dataset.cardBound) return;
    listEl.dataset.cardBound = '1';
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.mh-vault-card');
      if (!card) return;
      const id = card.getAttribute('data-knowledge-id');
      const item = mhKnowledgeItems.find((k) => k.id === id);
      if (item) showKnowledgeSourceModal(item);
    });
  }

  function renderKnowledgeList() {
    const listEl = document.getElementById('mh-knowledge-list');
    if (!listEl) return;

    if (mhKnowledgeLoadError) {
      listEl.innerHTML = emptyState(t('knowledge.loadError', "Couldn't load Knowledge."));
      return;
    }
    if (mhKnowledgeLoading) {
      listEl.innerHTML = '<div class="nagex-loading-row"></div><div class="nagex-loading-row"></div>';
      return;
    }
    if (mhKnowledgeItems.length === 0) {
      listEl.innerHTML = emptyState(mhKnowledgeQuery ? t('knowledge.noResults', 'No knowledge documents match your search.') : t('knowledge.empty', 'No knowledge documents yet. Add one to get started.'));
      return;
    }

    listEl.innerHTML = mhKnowledgeItems.map(renderKnowledgeCard).join('');
    bindCardClickHandlers();
  }

  function renderMobileKnowledge() {
    if (!document.getElementById('mobile-view-knowledge')) return;
    initSearch();
    initUpload();
    initLangToggle();
    refreshKnowledgeData(mhKnowledgeQuery);
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileKnowledge = renderMobileKnowledge;
})();
