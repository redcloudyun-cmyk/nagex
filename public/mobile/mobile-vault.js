// NAgex Mobile Vault (R22.2 Contextual UX)
// Real GET /api/v1/workspace/vault rendering canonical VaultItem[] items.
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

  function truncate(text, max) {
    const s = String(text || '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function unwrapApiData(res) {
    if (!res) return null;
    return res.data !== undefined ? res.data : res;
  }

  const ICONS = {
    file: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
    link: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    doc: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="7" y2="10"/><line x1="17" y1="14" x2="7" y2="14"/><line x1="9" y1="18" x2="7" y2="18"/><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2z"/></svg>`,
  };

  function typeIcon(type) {
    if (type === 'LINK') return ICONS.link;
    if (type === 'CREATED_OUTPUT' || type === 'SAVED_ANALYSIS') return ICONS.doc;
    return ICONS.file;
  }

  function typeIconVariant(type) {
    if (type === 'CREATED_OUTPUT' || type === 'SAVED_ANALYSIS') return 'mh-row-icon-success';
    if (type === 'LINK') return 'mh-row-icon-blue';
    if (type === 'REFERENCE_ASSET') return 'mh-row-icon-warning';
    return 'mh-row-icon-blue';
  }

  function typeLabel(type) {
    const map = {
      CREATED_OUTPUT: t('mobileVault.categoryResult', 'Result'),
      SAVED_ANALYSIS: t('mobileVault.categoryAnalysis', 'Analysis'),
      REFERENCE_ASSET: t('mobileVault.categoryReference', 'Reference'),
      DOCUMENT: t('mobileVault.categoryDocument', 'Document'),
      FILE: t('mobileVault.categoryFile', 'File'),
      IMAGE: t('mobileVault.categoryFile', 'File'),
      LINK: t('mobileVault.categoryLink', 'Link'),
    };
    return map[type] || type;
  }

  function sourceProvenanceLabel(source) {
    if (!source) return t('mobileVault.sourceGeneric', 'Saved item');
    const s = String(source).toUpperCase();
    if (s.includes('CONVERSATION')) return t('mobileVault.sourceConversation', 'Saved from Conversation');
    if (s.includes('RESEARCH')) return t('mobileVault.sourceResearch', 'Saved from Research result');
    if (s.includes('UPLOAD')) return t('mobileVault.sourceUpload', 'Uploaded');
    if (s.includes('MANUAL') || s.includes('USER_SAVE')) return t('mobileVault.sourceManual', 'Manual save');
    if (s.includes('AMBIENT')) return t('mobileVault.sourceAmbient', 'Saved from Ambient result');
    return t('mobileVault.sourceGeneric', 'Saved item');
  }

  let mhVaultFilter = 'ALL';
  let mhVaultSearchQuery = '';
  let mhVaultLoadError = false;
  let mhVaultLoading = false;

  // VaultItem-grounded filters (R22.2 Section 12)
  function matchesFilter(item) {
    if (mhVaultFilter === 'ALL') return true;
    if (mhVaultFilter === 'RESULTS') return item.type === 'CREATED_OUTPUT' || item.type === 'SAVED_ANALYSIS';
    if (mhVaultFilter === 'DOCUMENTS') return item.type === 'DOCUMENT' || item.type === 'FILE' || item.type === 'IMAGE';
    if (mhVaultFilter === 'LINKS') return item.type === 'LINK';
    if (mhVaultFilter === 'REFERENCES') return item.type === 'REFERENCE_ASSET';
    return true;
  }

  function matchesSearch(item) {
    if (!mhVaultSearchQuery) return true;
    const q = mhVaultSearchQuery.toLowerCase();
    const safeSummary = (item.metadata && typeof item.metadata.summary === 'string' ? item.metadata.summary : '') ||
                        (item.metadata && typeof item.metadata.description === 'string' ? item.metadata.description : '');
    const sourceLabel = sourceProvenanceLabel(item.source);
    const haystack = [item.title, typeLabel(item.type), safeSummary, sourceLabel].filter(Boolean).join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  // P0 Data Fetching: GET /api/v1/workspace/vault -> canonical VaultItem[] in res.items
  async function refreshVaultData() {
    if (!window.NAGEX.apiFetch) return;
    mhVaultLoading = true;
    mhVaultLoadError = false;
    try {
      const res = await window.NAGEX.apiFetch('/api/v1/workspace/vault');
      mhVaultLoading = false;
      const data = unwrapApiData(res);
      if (!data || !Array.isArray(data.items)) {
        mhVaultLoadError = true;
        return;
      }
      if (window.NAGEX.getState) {
        window.NAGEX.getState().vault = data;
        window.NAGEX.getState().vaultItems = data.items;
      }
    } catch (err) {
      mhVaultLoading = false;
      mhVaultLoadError = true;
    }
  }

  function renderStorageError() {
    const labelEl = document.getElementById('mh-vault-storage-label');
    const quotaTextEl = document.getElementById('mh-vault-quota-text');
    const quotaFillEl = document.getElementById('mh-vault-quota-fill');
    if (labelEl) labelEl.textContent = t('mobileVault.loadError', "Couldn't load Vault.");
    if (quotaTextEl) quotaTextEl.textContent = '';
    if (quotaFillEl) quotaFillEl.style.width = '0%';
  }

  function renderStorageSummary() {
    const labelEl = document.getElementById('mh-vault-storage-label');
    const quotaTextEl = document.getElementById('mh-vault-quota-text');
    const quotaFillEl = document.getElementById('mh-vault-quota-fill');
    const countEl = document.getElementById('mh-vault-count');
    if (!labelEl || !window.NAGEX.getState) return;

    const vault = window.NAGEX.getState().vault;
    if (!vault) return;

    const items = window.NAGEX.getState().vaultItems || vault.items || [];
    const totalCount = typeof vault.total === 'number' ? vault.total : items.length;

    labelEl.textContent = vault.storageInfo?.label || t('mobileVault.storageLocal', 'Local Development Vault');
    if (quotaTextEl) {
      const usedBytes = typeof vault.usedSizeBytes === 'number' ? vault.usedSizeBytes : 0;
      const quotaBytes = typeof vault.quotaSizeBytes === 'number' ? vault.quotaSizeBytes : 10737418240;
      const usedMb = (usedBytes / (1024 * 1024)).toFixed(1);
      const quotaGb = (quotaBytes / (1024 * 1024 * 1024)).toFixed(0);
      quotaTextEl.textContent = t('mobileVault.quotaUsed', '{used} MB of {quota} GB').replace('{used}', usedMb).replace('{quota}', quotaGb);
    }
    if (quotaFillEl) {
      const usedBytes = typeof vault.usedSizeBytes === 'number' ? vault.usedSizeBytes : 0;
      const quotaBytes = typeof vault.quotaSizeBytes === 'number' ? vault.quotaSizeBytes : 10737418240;
      const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
      quotaFillEl.style.width = `${pct.toFixed(1)}%`;
    }
    if (countEl) {
      if (totalCount > 0) {
        countEl.hidden = false;
        countEl.textContent = String(totalCount);
      } else {
        countEl.hidden = true;
      }
    }
  }

  function initFilterRow() {
    const row = document.getElementById('mh-vault-filter-row');
    if (!row || row.dataset.bound) return;
    row.dataset.bound = '1';
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mh-filter]');
      if (!btn) return;
      mhVaultFilter = btn.getAttribute('data-mh-filter');
      row.querySelectorAll('.mh-vault-filter-pill').forEach((p) => p.classList.toggle('active', p === btn));
      renderVaultList();
    });
  }

  function initSearch() {
    const input = document.getElementById('mh-vault-search-input');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('input', () => {
      mhVaultSearchQuery = input.value.trim();
      renderVaultList();
    });
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-vault-lang-toggle');
  }

  function showVaultDetailModal(item) {
    let modal = document.getElementById('mh-vault-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'mh-vault-detail-modal';
      modal.className = 'mh-detail-modal-overlay';
      document.body.appendChild(modal);
    }

    const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
    const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '';
    const safeSummary = (item.metadata && typeof item.metadata.summary === 'string' ? item.metadata.summary : '') ||
                        (item.metadata && typeof item.metadata.description === 'string' ? item.metadata.description : '');

    const hasPreview = item.storageRef && (item.storageRef.startsWith('http://') || item.storageRef.startsWith('https://'));

    modal.innerHTML = `
      <div class="mh-detail-modal-card">
        <div class="mh-detail-modal-header">
          <h3>${escapeHtml(item.title)}</h3>
          <button class="mh-detail-modal-close" onclick="document.getElementById('mh-vault-detail-modal').style.display='none'">&times;</button>
        </div>
        <div class="mh-detail-modal-body">
          ${safeSummary ? `<p class="mh-detail-desc">${escapeHtml(safeSummary)}</p>` : ''}
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">Type:</span>
            <span class="nagex-badge nagex-badge-muted">${escapeHtml(typeLabel(item.type))}</span>
          </div>
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">Source:</span>
            <span>${escapeHtml(sourceProvenanceLabel(item.source))}</span>
          </div>
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">Created:</span>
            <span>${escapeHtml(created)}</span>
          </div>
          ${updated ? `
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">Updated:</span>
            <span>${escapeHtml(updated)}</span>
          </div>` : ''}
        </div>
        <div class="mh-detail-modal-footer">
          ${hasPreview ? `<a href="${escapeHtml(item.storageRef)}" target="_blank" rel="noopener" class="mh-activity-action-btn">Open Preview</a>` : ''}
          <button class="mh-activity-action-btn secondary" onclick="document.getElementById('mh-vault-detail-modal').style.display='none'">${escapeHtml(t('mobileVault.close', 'Close'))}</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
  }

  function renderVaultItemCard(item) {
    const title = item.title || '';
    const safeSummary = (item.metadata && typeof item.metadata.summary === 'string' ? item.metadata.summary : '') ||
                        (item.metadata && typeof item.metadata.description === 'string' ? item.metadata.description : '');
    const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    const sourceLabel = sourceProvenanceLabel(item.source);

    return `
      <div class="mh-vault-card" data-vault-item-id="${escapeHtml(item.vaultItemId)}">
        <div class="mh-row-icon ${typeIconVariant(item.type)}">${typeIcon(item.type)}</div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(truncate(title, 80))}</div>
          ${safeSummary ? `<div class="mh-row-detail">${escapeHtml(truncate(safeSummary, 100))}</div>` : ''}
          <div class="mh-vault-provenance-line">${escapeHtml(sourceLabel)}</div>
          <div class="mh-vault-card-meta">
            <span class="nagex-badge nagex-badge-muted">${escapeHtml(typeLabel(item.type))}</span>
            <span class="mh-vault-timestamp">${escapeHtml(createdAt)}</span>
          </div>
        </div>
      </div>`;
  }

  function bindCardClickHandlers() {
    const listEl = document.getElementById('mh-vault-list');
    if (!listEl || listEl.dataset.cardBound) return;
    listEl.dataset.cardBound = '1';
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.mh-vault-card');
      if (!card || e.target.closest('button') || e.target.closest('a')) return;
      const itemId = card.getAttribute('data-vault-item-id');
      const items = (window.NAGEX.getState && window.NAGEX.getState().vaultItems) || [];
      const item = items.find((v) => v.vaultItemId === itemId);
      if (item) showVaultDetailModal(item);
    });
  }

  function renderVaultList() {
    const listEl = document.getElementById('mh-vault-list');
    if (!listEl || !window.NAGEX.getState) return;

    if (mhVaultLoadError) {
      listEl.innerHTML = emptyState(t('mobileVault.loadError', "Couldn't load Vault."));
      return;
    }
    if (mhVaultLoading) {
      listEl.innerHTML = '<div class="nagex-loading-row"></div><div class="nagex-loading-row"></div>';
      return;
    }

    const items = window.NAGEX.getState().vaultItems || (window.NAGEX.getState().vault && window.NAGEX.getState().vault.items) || [];
    if (items.length === 0) {
      listEl.innerHTML = emptyState(t('mobileVault.empty', 'Nothing saved yet.'));
      return;
    }

    const filtered = items.filter((item) => matchesFilter(item) && matchesSearch(item));
    if (filtered.length === 0) {
      listEl.innerHTML = emptyState(t('mobileVault.noResults', 'No items match your search or filter.'));
      return;
    }

    listEl.innerHTML = filtered.map(renderVaultItemCard).join('');
    bindCardClickHandlers();
  }

  function renderMobileVault() {
    if (!document.getElementById('mobile-view-vault')) return;
    initFilterRow();
    initSearch();
    initLangToggle();
    renderVaultList();
    if (mhVaultLoadError) renderStorageError();
    refreshVaultData().then(() => {
      if (!document.getElementById('mobile-view-vault') || document.getElementById('mobile-view-vault').hidden) return;
      if (mhVaultLoadError) {
        renderStorageError();
        renderVaultList();
        return;
      }
      renderStorageSummary();
      renderVaultList();
    });
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileVault = renderMobileVault;
})();
