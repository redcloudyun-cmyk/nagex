// NAgex Mobile Vault (UI-5 R4) — a native view inside the shared
// #mobile-app-shell (see mobile-home.js's updateShellVisibility(), the
// ONLY place deciding when #mobile-view-vault is shown). Never rendered
// while hidden — mobile-home.js only calls window.NAGEX.renderMobileVault()
// when the active tab really is 'tab-vault' on a real mobile viewport.
//
// Data: real GET /api/v1/workspace/vault (quota/category/storage summary
// only) + the already-loaded, already-real window.NAGEX.getState().inbox
// (the full, uncapped CaptureItem[] — /vault's own `recentItems` field is
// hard-capped at 10 server-side with no pagination param, confirmed in
// the R4 preflight, so the full browsable list is deliberately sourced
// from state.inbox instead, never a second/extra item fetch). No Memory
// API, no Knowledge API — Vault is CaptureItem data only (see R4
// preflight §3 for the verified store/API boundary). No new backend
// endpoint, no invented field.
//
// Deliberately NOT implemented this slice (real capabilities, confirmed
// dormant/unexposed everywhere in the app today, out of scope per the R4
// directive): pinned state (CaptureItem has no such field — that is a
// Memory-only concept), delete (endpoint exists, zero confirmation UX
// exists anywhere in this app to safely gate it), preview/download
// (endpoints exist, zero frontend usage anywhere — a real, separate
// future capability, not required for a native list/browse UI).
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

  const ICONS = {
    file: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
    link: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    mic: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>`,
    note: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="7" y2="10"/><line x1="17" y1="14" x2="7" y2="14"/><line x1="9" y1="18" x2="7" y2="18"/><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2z"/></svg>`,
  };

  function typeIcon(type) {
    return ICONS[type === 'FILE' ? 'file' : type === 'LINK' ? 'link' : type === 'AUDIO' ? 'mic' : 'note'];
  }

  function typeIconVariant(type) {
    if (type === 'FILE') return 'mh-row-icon-blue';
    if (type === 'LINK') return 'mh-row-icon-success';
    if (type === 'AUDIO') return 'mh-row-icon-warning';
    return 'mh-row-icon-blue';
  }

  function typeLabel(type) {
    const map = {
      FILE: t('mobileVault.filterFiles', 'Files'),
      LINK: t('mobileVault.filterLinks', 'Links'),
      AUDIO: t('mobileVault.filterAudio', 'Audio'),
      TEXT: t('mobileVault.filterNotes', 'Notes'),
    };
    return map[type] || type;
  }

  let mhVaultFilter = 'ALL';
  let mhVaultSearchQuery = '';
  let mhVaultLoadError = false;
  let mhVaultLoading = false;

  // ── Real filter — exactly the 4 real CaptureType values (directive §9). ──
  function matchesFilter(item) {
    if (mhVaultFilter === 'ALL') return true;
    return item.type === mhVaultFilter;
  }

  // ── Real, client-side substring search over already-loaded real fields
  // only (directive §8) — never the full internal metadata object. ──
  function matchesSearch(item) {
    if (!mhVaultSearchQuery) return true;
    const q = mhVaultSearchQuery.toLowerCase();
    const haystack = [
      item.metadata?.extractedTitle,
      item.metadata?.extractedSummary,
      item.content,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  // ── Real storage summary — one real fetch, GET /api/v1/workspace/vault.
  // Its own storageInfo.label already carries the full truthful cloud/
  // local/misconfigured computation server-side (quick-capture.service.ts
  // getVaultSummary()) — reused verbatim, never re-derived or simplified
  // away (directive §7). ──
  async function refreshVaultSummary() {
    if (!window.NAGEX.apiFetch) return;
    mhVaultLoading = true;
    mhVaultLoadError = false;
    const data = await window.NAGEX.apiFetch('/api/v1/workspace/vault');
    mhVaultLoading = false;
    if (!data || typeof data.totalSizeBytes !== 'number') {
      mhVaultLoadError = true;
      return;
    }
    if (window.NAGEX.getState) window.NAGEX.getState().vault = data;
  }

  // Error state is rendered into the same fixed set of elements (never an
  // innerHTML replace of the whole card), so a later successful refresh
  // can always restore real content into the same, still-present nodes —
  // no destroyed DOM to recreate.
  function renderStorageError() {
    const labelEl = document.getElementById('mh-vault-storage-label');
    const quotaTextEl = document.getElementById('mh-vault-quota-text');
    const quotaFillEl = document.getElementById('mh-vault-quota-fill');
    if (labelEl) labelEl.textContent = t('mobileVault.loadError', 'Unable to load Vault. Reopen to try again.');
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

    labelEl.textContent = vault.storageInfo?.label || t('mobileVault.storageLocal', 'Local Development Vault');
    if (quotaTextEl) {
      const usedMb = (vault.totalSizeBytes / (1024 * 1024)).toFixed(1);
      const quotaGb = (vault.quotaSizeBytes / (1024 * 1024 * 1024)).toFixed(0);
      quotaTextEl.textContent = t('mobileVault.quotaUsed', '{used} MB of {quota} GB').replace('{used}', usedMb).replace('{quota}', quotaGb);
    }
    if (quotaFillEl) {
      const pct = vault.quotaSizeBytes > 0 ? Math.min(100, (vault.totalSizeBytes / vault.quotaSizeBytes) * 100) : 0;
      quotaFillEl.style.width = `${pct.toFixed(1)}%`;
    }
    if (countEl) {
      if (vault.totalItems > 0) {
        countEl.hidden = false;
        countEl.textContent = String(vault.totalItems);
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
      renderVaultList(); // client-side only — no refetch
    });
  }

  function initSearch() {
    const input = document.getElementById('mh-vault-search-input');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('input', () => {
      mhVaultSearchQuery = input.value.trim();
      renderVaultList(); // client-side only, over already-loaded state.inbox — no refetch per keystroke
    });
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-vault-lang-toggle');
  }

  function renderVaultItemCard(item) {
    const title = item.metadata?.extractedTitle || item.content || '';
    const summary = item.metadata?.extractedSummary || item.content || '';
    const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    return `
      <div class="mh-vault-card">
        <div class="mh-row-icon ${typeIconVariant(item.type)}">${typeIcon(item.type)}</div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(truncate(title, 80))}</div>
          <div class="mh-row-detail">${escapeHtml(truncate(summary, 100))}</div>
          <div class="mh-vault-card-meta">
            <span class="nagex-badge nagex-badge-muted">${escapeHtml(typeLabel(item.type))}</span>
            <span class="mh-vault-timestamp">${escapeHtml(createdAt)}</span>
          </div>
        </div>
      </div>`;
  }

  // ── The real, uncapped item list — sourced from window.NAGEX.getState().
  // inbox (the same real CaptureItem[] Mobile Inbox already keeps fresh),
  // never /vault's own 10-item-capped recentItems, and never a second
  // item fetch of its own (directive §5). Order is never re-derived —
  // the server's own createdAt DESC order is preserved through filter and
  // search alike (directive §12). ──
  function renderVaultList() {
    const listEl = document.getElementById('mh-vault-list');
    if (!listEl || !window.NAGEX.getState) return;

    const all = window.NAGEX.getState().inbox || [];
    if (all.length === 0) {
      listEl.innerHTML = emptyState(t('mobileVault.empty', 'Your Vault is empty.'));
      return;
    }

    const filtered = all.filter((item) => matchesFilter(item) && matchesSearch(item));
    if (filtered.length === 0) {
      listEl.innerHTML = emptyState(t('mobileVault.noResults', 'No items match your search or filter.'));
      return;
    }

    listEl.innerHTML = filtered.map(renderVaultItemCard).join('');
  }

  function renderMobileVault() {
    if (!document.getElementById('mobile-view-vault')) return;
    initFilterRow();
    initSearch();
    initLangToggle();
    renderVaultList(); // real state.inbox is already loaded/fresh — render immediately, no wait
    if (mhVaultLoadError) renderStorageError();
    refreshVaultSummary().then(() => {
      // Guard: don't paint a stale fetch result over a view the user has
      // since navigated away from.
      if (!document.getElementById('mobile-view-vault') || document.getElementById('mobile-view-vault').hidden) return;
      if (mhVaultLoadError) {
        renderStorageError();
        return;
      }
      renderStorageSummary();
    });
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileVault = renderMobileVault;
})();
