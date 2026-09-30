(function () {
  'use strict';

  const STATES = Object.freeze(['Prepared', 'Needs approval', 'In progress', 'Completed', 'Needs your action', 'Failed', 'Unavailable']);
  let cachedPromise = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function locale() {
    return window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko' : 'en';
  }

  // Desktop and mobile share one Canvas architecture (state, dispatch,
  // renderer, loading/error semantics) — only the DOM id prefix differs,
  // so each shell's own markup (#view-canvas vs #mobile-view-canvas) is
  // targeted without a second implementation. Falls back to desktop ids
  // when matchMedia is unavailable (e.g. the Phase B/C mock-DOM tests).
  function isMobileViewport() {
    try { return Boolean(window.matchMedia && window.matchMedia('(max-width: 768px)').matches); } catch (e) { return false; }
  }

  function canvasIdPrefix() {
    return isMobileViewport() ? 'mh-canvas-' : 'canvas-';
  }

  // --- Shared Artifact UX Contract Helpers ---
  window.NAGEX = window.NAGEX || {};

  window.NAGEX.getArtifactPreviewKind = function (item) {
    if (item && item.artifactProjection) return item.artifactProjection.previewKind;
    const type = String(item?.type || item || '').toUpperCase();
    if (type === 'IMAGE') return 'IMAGE';
    if (['DOCUMENT', 'RESEARCH', 'ANALYSIS'].includes(type)) return 'TEXT';
    if (['PRESENTATION', 'VIDEO'].includes(type)) return 'PLANNED';
    return 'UNKNOWN';
  };

  window.NAGEX.renderArtifactThumbnail = function (proj) {
    if (!proj || proj.previewKind !== 'IMAGE' || !proj.previewTarget) return '';
    return `<div class="ph-artifact-thumbnail" style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#1e293b;margin-right:12px;"><img src="${esc(proj.previewTarget)}" alt="" style="width:100%;height:100%;object-fit:cover;" /></div>`;
  };

  window.NAGEX.openArtifactInCanvas = function (artifactId, artifactType, canvasTarget, openTarget, artifactProjection) {
    window.NAGEX = window.NAGEX || {};
    window.NAGEX._canvasState = {
      artifactId,
      artifactType,
      canvasTarget: canvasTarget || `/canvas?artifactId=` + encodeURIComponent(artifactId) + `&type=` + encodeURIComponent(artifactType),
      openTarget: openTarget || `/api/v1/artifacts/` + encodeURIComponent(artifactId),
      artifactProjection: artifactProjection || null,
      active: true,
      activatedAt: new Date().toISOString(),
      loadStatus: 'LOADING'
    };

    const prefix = canvasIdPrefix();
    const titleEl = document.getElementById(prefix + 'artifact-title');
    const typeEl = document.getElementById(prefix + 'artifact-type');
    const actionOpenEl = document.getElementById(prefix + 'action-open');
    const rendererRegion = document.getElementById(prefix + 'renderer-region');

    if (titleEl) {
      titleEl.textContent = 'Artifact: ' + artifactId;
    }

    if (typeEl) {
      typeEl.textContent = artifactType;
    }

    if (actionOpenEl && window.NAGEX._canvasState.openTarget && artifactType === 'IMAGE') {
      actionOpenEl.href = window.NAGEX._canvasState.openTarget;
      actionOpenEl.style.display = 'inline-flex';
    } else if (actionOpenEl) {
      actionOpenEl.style.display = 'none';
    }

    if (rendererRegion) {
      rendererRegion.innerHTML = '';
      const upperType = String(artifactType || '').toUpperCase();

      if (upperType === 'IMAGE') {
        const previewUrl = artifactProjection && artifactProjection.previewTarget ? artifactProjection.previewTarget : window.NAGEX._canvasState.openTarget;
        const loadingId = prefix + 'loading';
        const errorId = prefix + 'error';
        const wrapperId = prefix + 'image-wrapper';
        const imgId = prefix + 'img-element';

        rendererRegion.innerHTML = `
          <div id="${loadingId}" style="display:flex; flex-direction:column; align-items:center; color:#64748b; height:100%; justify-content:center;">
             <svg class="svg-icon-sm animate-spin" viewBox="0 0 24 24" style="width:32px;height:32px;margin-bottom:16px;"><path fill="currentColor" d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg>
             <span>Loading artifact...</span>
          </div>
          <div id="${errorId}" class="canvas-error-state" style="display:none; height:100%; justify-content:center; align-items:center; flex-direction:column;">
             <svg viewBox="0 0 24 24" style="width:48px;height:48px;margin-bottom:16px;"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
             <h3>Image failed to load</h3>
             <p>We couldn't load this artifact. It may have been deleted or you may lack permission.</p>
             <button class="btn-secondary" onclick="window.NAGEX.closeCanvas()" style="margin-top:16px;">Go back</button>
          </div>
          <div class="canvas-image-container" id="${wrapperId}" style="display:none; height:100%;">
             <img id="${imgId}" class="canvas-image-target" alt="Generated Image" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:4px;" />
          </div>
        `;

        const img = document.getElementById(imgId);
        if (img) {
            img.onload = function() {
               document.getElementById(loadingId).style.display = 'none';
               document.getElementById(wrapperId).style.display = 'flex';
               window.NAGEX._canvasState.loadStatus = 'READY';
            };
            img.onerror = function() {
               document.getElementById(loadingId).style.display = 'none';
               document.getElementById(errorId).style.display = 'flex';
               window.NAGEX._canvasState.loadStatus = 'ERROR';
            };
            img.src = previewUrl;
        }
      } else if (['DOCUMENT', 'RESEARCH', 'ANALYSIS'].includes(upperType)) {
        rendererRegion.innerHTML = `<div class="canvas-document-container" style="padding: 20px; text-align: center; color: #64748b;">
          <h3>${esc(upperType)} Workspace</h3>
          <p>Metadata preview is available. Rich content editor not yet implemented.</p>
        </div>`;
        window.NAGEX._canvasState.loadStatus = 'READY';
      } else {
        rendererRegion.innerHTML = `<div class="canvas-error-state" style="padding: 20px; text-align: center; color: #64748b;">
           <h3>Unsupported artifact</h3>
        </div>`;
        window.NAGEX._canvasState.loadStatus = 'ERROR';
      }
    }

    if (typeof window.NAGEX.switchTab === 'function') {
      window.NAGEX.switchTab('tab-canvas', { artifactId: artifactId });
    }

    return window.NAGEX._canvasState;
  };

  window.NAGEX.closeCanvas = function() {
     if (window.NAGEX._canvasState) {
        window.NAGEX._canvasState.active = false;
     }
     if (typeof window.NAGEX.switchTab === 'function') {
        window.NAGEX.switchTab('tab-home');
     }
  };

  window.NAGEX.restoreCanvasFromRoute = function(artifactId) {
      if (window.NAGEX._canvasState && window.NAGEX._canvasState.artifactId === artifactId && window.NAGEX._canvasState.active) {
          return;
      }
      if (window.NAGEX_PERSONAL_HOME && typeof window.NAGEX_PERSONAL_HOME.fetchHome === 'function') {
          window.NAGEX_PERSONAL_HOME.fetchHome().then(model => {
              const item = (model.recentCreations || []).find(c => c.id === artifactId) || (model.recentResults || []).find(c => c.id === artifactId);
              if (item && item.artifactProjection) {
                  window.NAGEX.dispatchArtifactOpen(item.artifactProjection.artifactType, artifactId, item);
              }
          });
      }
  };

  window.NAGEX.submitCanvasAsk = function() {
     const input = document.getElementById(canvasIdPrefix() + 'ask-input');
     if (input && input.value) {
         if (typeof window.alert === 'function') {
             window.alert(locale() === 'ko' ? '기능이 향후 지원될 예정입니다.' : 'Action not yet supported. NAgex mutation will be available soon.');
         }
         input.value = '';
     }
  };

  window.NAGEX.dispatchArtifactOpen = function (type, sourceRef, item) {
    const proj = item && item.artifactProjection;
    if (proj) {
      if (proj.previewKind === 'PLANNED') {
        const msg = locale() === 'ko' ? '해당 기능은 향후 업데이트에서 지원될 예정입니다.' : 'This artifact type is planned for a future update.';
        if (typeof window.alert === 'function') window.alert(msg);
        return { handled: true, status: 'PLANNED', message: msg };
      }
      if (proj.previewKind === 'UNKNOWN') {
        const msg = locale() === 'ko' ? '지원되지 않는 아티팩트 유형입니다.' : 'Unsupported artifact type.';
        if (typeof window.alert === 'function') window.alert(msg);
        return { handled: true, status: 'UNKNOWN', message: msg };
      }

      const titleEl = document.getElementById(canvasIdPrefix() + 'artifact-title');
      if (titleEl && item && item.title) {
         titleEl.textContent = item.title;
      }

      if (!document.getElementById(isMobileViewport() ? 'mobile-view-canvas' : 'view-canvas')) {
          return { handled: true, status: 'CANVAS_NOT_AVAILABLE', artifactId: proj.artifactId, artifactType: proj.artifactType };
      }
      const state = window.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
      return { handled: true, status: (state.loadStatus === 'LOADING' ? 'LOADING' : 'OPENED'), canvasState: state };
    }

    const upperType = String(type || '').toUpperCase();
    if (upperType === 'PRESENTATION' || upperType === 'VIDEO') {
      const msg = locale() === 'ko' ? '해당 기능은 향후 업데이트에서 지원될 예정입니다.' : 'This artifact type is planned for a future update.';
      if (typeof window.alert === 'function') window.alert(msg);
      return { handled: true, status: 'PLANNED', message: msg };
    }

    if (['IMAGE', 'DOCUMENT', 'RESEARCH', 'ANALYSIS'].includes(upperType)) {
      if (!document.getElementById(isMobileViewport() ? 'mobile-view-canvas' : 'view-canvas')) {
          return { handled: true, status: 'CANVAS_NOT_AVAILABLE', artifactId: sourceRef, artifactType: upperType };
      }
      const state = window.NAGEX.openArtifactInCanvas(sourceRef, upperType, `/canvas?artifactId=${encodeURIComponent(sourceRef)}&type=${encodeURIComponent(upperType)}`);
      return { handled: true, status: (state.loadStatus === 'LOADING' ? 'LOADING' : 'OPENED'), canvasState: state };
    }

    const msg = locale() === 'ko' ? '지원되지 않는 아티팩트 유형입니다.' : 'Unsupported artifact type.';
    if (typeof window.alert === 'function') window.alert(msg);
    return { handled: true, status: 'UNKNOWN', message: msg };
  };
  // -------------------------------------------

  const COPY = {
    en: { rightNow: 'Right Now', create: 'Create with NAgex', attention: 'Needs Attention', today: 'Today', preparing: 'NAgex Is Preparing', creations: 'Recent Creations', recent: 'Recent Activity', empty: 'Nothing to show right now.', noCreations: 'Your completed research and file analyses will appear here.', unavailable: 'This source is currently unavailable.', research: 'Research', analyze: 'Analyze', researchDesc: 'Find, verify, and synthesize information.', analyzeDesc: 'Understand supported documents and files.', open: 'Open' },
    ko: { rightNow: '지금', create: 'NAgex로 만들기', attention: '확인이 필요해요', today: '오늘', preparing: 'NAgex가 준비 중이에요', creations: '최근 생성 결과', recent: '최근 활동', empty: '지금 표시할 항목이 없습니다.', noCreations: '완료된 리서치와 파일 분석 결과가 여기에 표시됩니다.', unavailable: '현재 이 정보를 불러올 수 없습니다.', research: '리서치', analyze: '분석', researchDesc: '필요한 정보를 찾고 검증해 핵심을 정리합니다.', analyzeDesc: '지원되는 문서와 파일의 내용을 이해하고 정리합니다.', open: '열기' },
  };
  const STATE_LABELS = {
    en: Object.fromEntries(STATES.map((state) => [state, state])),
    ko: { Prepared: '준비됨', 'Needs approval': '승인 필요', 'In progress': '진행 중', Completed: '완료됨', 'Needs your action': '확인 필요', Failed: '실패', Unavailable: '사용할 수 없음' },
  };

  function owningSurface(item) {
    const source = String(item.sourceType || item.kind || item.type || '').toUpperCase();
    if (source.includes('APPROVAL')) return 'Approvals';
    if (source.includes('CALENDAR') || source.includes('MEETING') || source.includes('REMINDER')) return 'Today';
    if (source.includes('TASK')) return 'Activity';
    if (source.includes('INBOX') || source.includes('PROPOSAL')) return 'Inbox';
    return 'Activity';
  }

  function key(item) {
    return `${item.sourceType || item.kind || item.type || 'ITEM'}:${item.sourceId || item.sourceRef || item.id || ''}`;
  }

  function card(item, state, extra) {
    return Object.assign({ key: key(item), owningSurface: owningSurface(item), title: item.title || '', context: item.summary || item.reason || '', state, action: item.action || null, actionTarget: item.action?.targetUrl || null, availability: state === 'Unavailable' ? 'unavailable' : 'available', error: state === 'Failed' ? item.summary || item.reason || null : null, type: item.type || item.kind || '', sourceRef: item.sourceId || item.sourceRef || item.id || '', artifactProjection: item.artifactProjection || null }, extra || {});
  }

  function inferRightNow(item) {
    if (!item) return null;
    if (item.state && STATES.includes(item.state)) return item.state;
    if (item.type === 'APPROVAL') return 'Needs approval';
    if (item.type === 'BLOCKED_TASK' || item.type === 'ATTENTION') return 'Needs your action';
    if (item.type === 'TASK') return 'In progress';
    return 'Prepared';
  }

  function inferRecent(item) {
    if (item.state && STATES.includes(item.state)) return item.state;
    const outcome = String(item.outcomeStatus || item.executionStatus || item.providerStatus || item.status || '').toUpperCase();
    if (outcome === 'PROVIDER_ACCEPTED' || outcome === 'ACCEPTED' || outcome === 'QUEUED' || outcome === 'RUNNING') return 'In progress';
    if (outcome === 'FAILED') return 'Failed';
    if (outcome === 'NEEDS_ATTENTION') return 'Needs your action';
    return 'Completed';
  }

  function normalize(response) {
    const home = response && response.data ? response.data : response;
    const seen = new Set();
    const unique = (items) => (items || []).filter((item) => item && item.key && !seen.has(item.key) && seen.add(item.key));
    const rightNow = unique(home && home.rightNow ? [card(home.rightNow, inferRightNow(home.rightNow))] : []);
    const attention = unique((home?.needsAttention || []).map((item) => card(item, item.state || (item.type === 'APPROVAL' ? 'Needs approval' : item.type === 'BLOCKED_TASK' ? 'Failed' : 'Needs your action'))));
    const todayItems = (home?.today?.meetings || []).map((item) => card(Object.assign({ sourceType: 'CALENDAR', sourceId: item.id, type: 'MEETING' }, item), item.state || 'Prepared', { time: item.startsAt }));
    if (home?.sourceStatus?.calendar === 'UNAVAILABLE' && todayItems.length === 0) todayItems.push(card({ id: 'calendar-unavailable', sourceType: 'CALENDAR', title: COPY[locale()].unavailable }, 'Unavailable'));
    const today = unique(todayItems);
    const preparing = unique([...(home?.preparedForYou || []).map((item) => card(item, item.state || 'Prepared')), ...(home?.workingForYou || []).map((item) => card(item, item.state || 'In progress'))]);
    const recent = unique((home?.recentResults || []).map((item) => card(item, inferRecent(item))));
    const creationActions = (home?.creationActions || []).filter((item) => item.id === 'RESEARCH' || item.id === 'ANALYZE');
    const recentCreations = unique((home?.recentCreations || []).map((item) => card(item, inferRecent(item))));
    return { generatedAt: home?.generatedAt || null, rightNow, creationActions, attention, today, preparing, recentCreations, recent };
  }

  function fetchHome(force) {
    if (force || !cachedPromise) cachedPromise = window.NAGEX.apiFetch('/api/v1/personal/home').then(normalize).catch(() => normalize({ sourceStatus: { calendar: 'UNAVAILABLE' } }));
    return cachedPromise;
  }

  function renderItems(items) {
    if (!items.length) return `<p class="ph-empty">${esc(COPY[locale()].empty)}</p>`;
    return items.map((item) => {
      const isImage = item.artifactProjection && item.artifactProjection.previewKind === 'IMAGE' && item.artifactProjection.previewTarget;
      const thumbHtml = window.NAGEX.renderArtifactThumbnail(item.artifactProjection);
      return `<article class="ph-item" data-source-key="${esc(item.key)}" ${isImage ? 'style="display:flex;align-items:center;"' : ''}>
        ${thumbHtml}
        <div class="ph-item-copy" style="flex:1;"><h3>${esc(item.title)}</h3>${item.context ? `<p>${esc(item.context)}</p>` : ''}${item.time ? `<time datetime="${esc(item.time)}">${esc(new Date(item.time).toLocaleTimeString(locale() === 'ko' ? 'ko-KR' : 'en-US', { hour: 'numeric', minute: '2-digit' }))}</time>` : ''}</div>
        <div class="ph-item-meta"><span class="ph-state" data-state="${esc(item.state)}">${esc(STATE_LABELS[locale()][item.state] || item.state)}</span>${item.action ? `<button type="button" class="ph-action" data-type="${esc(item.type)}" data-ref="${esc(item.sourceRef)}" data-target="${esc(item.actionTarget || '')}">${esc(item.action.type === 'OPEN_ARTIFACT' ? COPY[locale()].open : item.action.label)}</button>` : ''}</div>
      </article>`;
    }).join('');
  }

  function renderSection(target, title, items, id) {
    if (!target) return;
    target.hidden = false;
    target.setAttribute('data-home-section', id);
    target.innerHTML = `<div class="ph-heading"><h2>${esc(title)}</h2></div><div class="ph-list">${renderItems(items)}</div>`;
    target.querySelectorAll('.ph-action').forEach((button) => button.addEventListener('click', async () => {
      if (button.dataset.target && button.dataset.type === 'RESEARCH') {
        const result = await window.NAGEX.apiFetch(button.dataset.target);
        const artifact = result && result.artifact;
        if (artifact) window.alert(`${artifact.title}\n\n${artifact.preview}`);
        return;
      }
      const itemKey = button.closest('.ph-item')?.dataset?.sourceKey;
      const item = items.find((i) => i.key === itemKey);
      window.NAGEX.handleHomeItemAction(button.dataset.type, button.dataset.ref, item);
    }));
  }

  function renderCreationActions(target, actions) {
    if (!target) return;
    const c = COPY[locale()];
    target.hidden = false;
    target.setAttribute('data-home-section', 'create');
    target.innerHTML = `<div class="ph-heading"><h2>${esc(c.create)}</h2></div><div class="ph-create-actions">${actions.map((action) => {
      const isResearch = action.id === 'RESEARCH';
      return `<button type="button" class="ph-create-action" data-creation-action="${esc(action.id)}"><strong>${esc(isResearch ? c.research : c.analyze)}</strong><span>${esc(isResearch ? c.researchDesc : c.analyzeDesc)}</span></button>`;
    }).join('')}</div>`;
    target.querySelectorAll('[data-creation-action]').forEach((button) => button.addEventListener('click', () => activateCreationAction(button.dataset.creationAction)));
  }

  function activateCreationAction(action) {
    if (action === 'ANALYZE') {
      const fileInput = document.getElementById('composer-file-input');
      if (fileInput) fileInput.click();
      return;
    }
    const input = document.getElementById(window.matchMedia && window.matchMedia('(max-width: 768px)').matches ? 'mh-command-input' : 'home-prompt-input');
    if (!input) return;
    input.dataset.creationMode = 'RESEARCH';
    input.value = '';
    input.placeholder = locale() === 'ko' ? '무엇을 조사할까요?' : 'What should NAgex research?';
    input.focus();
  }

  async function submitResearch(query) {
    const result = await window.NAGEX.apiFetch('/api/v1/research', { method: 'POST', body: JSON.stringify({ query }) });
    if (!result || result.error || result.status === 'UNAVAILABLE') return result;
    cachedPromise = null;
    const model = await fetchHome(true);
    renderDesktop(model);
    renderMobile(model);
    window.alert(result.answer || (locale() === 'ko' ? '리서치가 완료되었습니다.' : 'Research completed.'));
    return result;
  }

  function renderDesktop(model) {
    const c = COPY[locale()];
    renderSection(document.getElementById('home-section-right-now'), c.rightNow, model.rightNow, 'right-now');
    renderCreationActions(document.getElementById('home-section-create'), model.creationActions);
    renderSection(document.getElementById('home-section-needs-attention'), c.attention, model.attention, 'needs-attention');
    renderSection(document.getElementById('home-section-today'), c.today, model.today, 'today');
    renderSection(document.getElementById('home-section-prepared'), c.preparing, model.preparing, 'preparing');
    renderSection(document.getElementById('home-section-recent-creations'), c.creations, model.recentCreations, 'recent-creations');
    renderSection(document.getElementById('home-section-recent-results'), c.recent, model.recent, 'recent');
    const obsolete = document.getElementById('home-section-working'); if (obsolete) obsolete.hidden = true;
  }

  function renderMobile(model) {
    const c = COPY[locale()];
    renderSection(document.getElementById('mh-right-now-hero'), c.rightNow, model.rightNow, 'right-now');
    renderCreationActions(document.getElementById('mh-section-create'), model.creationActions);
    renderSection(document.getElementById('mh-section-approvals'), c.attention, model.attention, 'needs-attention');
    renderSection(document.getElementById('mh-section-today'), c.today, model.today, 'today');
    renderSection(document.getElementById('mh-section-prepared'), c.preparing, model.preparing, 'preparing');
    renderSection(document.getElementById('mh-section-recent-creations'), c.creations, model.recentCreations, 'recent-creations');
    renderSection(document.getElementById('mh-section-recent'), c.recent, model.recent, 'recent');
    const suggestions = document.getElementById('mh-section-suggestions'); if (suggestions) suggestions.hidden = true;
  }

  window.NAGEX_PERSONAL_HOME = Object.freeze({ STATES, normalize, fetchHome, renderDesktop, renderMobile, submitResearch, invalidate: () => { cachedPromise = null; } });
})();
