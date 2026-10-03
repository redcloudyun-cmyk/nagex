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

  // R23.7H-C Phase D.2 §10 — Recent Creations must be visual: real
  // artifacts get a real image thumbnail; other real (non-planned)
  // artifact types get a designed type-specific icon placeholder instead
  // of plain text, never a fake generated preview.
  window.NAGEX.renderArtifactThumbnail = function (proj) {
    if (!proj) return '';
    if (proj.previewKind === 'IMAGE' && proj.previewTarget) {
      // R23.7H-C D8 — if the real image route 404s (e.g. a stale fixture
      // whose underlying file no longer exists), fall back to a truthful
      // generic IMAGE icon instead of the browser's broken-image glyph —
      // never substitutes a fake picture, just an honest "image
      // unavailable" placeholder in the same visual language as the TEXT
      // placeholder below.
      return `<div class="ph-artifact-thumbnail" style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#1e293b;margin-right:12px;position:relative;"><img src="${esc(proj.previewTarget)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;background:#e2e8f0;color:#64748b;"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span></div>`;
    }
    if (proj.previewKind === 'TEXT') {
      const upperType = String(proj.artifactType || '').toUpperCase();
      const isResearch = upperType === 'RESEARCH' || upperType === 'ANALYSIS';
      const bg = isResearch ? '#dcfce7' : '#dbeafe';
      const fg = isResearch ? '#15803d' : '#1d4ed8';
      const icon = isResearch
        ? '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 20l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
        : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6"/>';
      return `<div class="ph-artifact-thumbnail" style="width:48px;height:48px;border-radius:8px;flex-shrink:0;margin-right:12px;display:flex;align-items:center;justify-content:center;background:${bg};color:${fg};"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor">${icon}</svg></div>`;
    }
    return '';
  };

  // R23.7H-C Phase D.4 §11 — shared Agent Context-tab renderer, prefix-
  // aware so Home's embedded Agent panel and Focus Mode's Agent panel
  // both use it (was hardcoded to the desktop 'canvas-' id only, meaning
  // a second instance couldn't exist safely). Real artifact fields only —
  // no raw canonical URL/API path (D.1 §7), never fabricated.
  function renderArtifactContext(prefix, artifactType, artifactProjection) {
    const contextFields = document.getElementById(prefix + 'agent-context-fields');
    if (!contextFields) return;
    const c = COPY[locale()];
    const rows = [
      [c.contextType, artifactType || ''],
      [c.contextTitle, (artifactProjection && artifactProjection.title) || c.untitledArtifact],
      [c.contextUpdated, (artifactProjection && artifactProjection.updatedAt) ? new Date(artifactProjection.updatedAt).toLocaleString(locale() === 'ko' ? 'ko-KR' : 'en-US') : c.contextUnknown],
    ];
    contextFields.innerHTML = rows.map(([label, value]) => `<div class="canvas-agent-context-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
  }

  // R23.7H-C Phase D.3 §8/§11 — shared artifact-stage renderer used by
  // BOTH Focus Mode Canvas (openArtifactInCanvas below) and Home's
  // embedded Canvas preview. Same IMAGE/DOCUMENT rendering, same
  // loading/error semantics, same truthfulness — only the DOM prefix and
  // where load status is recorded differ, so there is exactly one
  // implementation of "how an artifact renders" in this app.
  function renderArtifactStage(prefix, artifactType, artifactProjection, openTarget, stateRef) {
    if (prefix === 'canvas-' || prefix === 'mh-canvas-') {
      const dRegion = document.getElementById('canvas-renderer-region');
      const mRegion = document.getElementById('mh-canvas-renderer-region');
      if (dRegion) dRegion.innerHTML = '';
      if (mRegion) mRegion.innerHTML = '';
    }

    const rendererRegion = document.getElementById(prefix + 'renderer-region');
    if (!rendererRegion) return;
    const upperType = String(artifactType || '').toUpperCase();

    if (upperType === 'IMAGE') {
      const previewUrl = artifactProjection && artifactProjection.previewTarget ? artifactProjection.previewTarget : openTarget;
      const loadingId = prefix + 'loading';
      const errorId = prefix + 'error';
      const wrapperId = (prefix === 'canvas-' || prefix === 'mh-canvas-') ? 'canvas-image-wrapper' : prefix + 'image-wrapper';
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
        <div class="canvas-image-container" id="${wrapperId}" style="display:none;">
           <img id="${imgId}" class="canvas-image-target" alt="Generated Image" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:4px;" />
        </div>
      `;

      const img = document.getElementById(imgId);
      if (img) {
          img.onload = function() {
             document.getElementById(loadingId).style.display = 'none';
             document.getElementById(wrapperId).style.display = 'flex';
             if (stateRef) stateRef.loadStatus = 'READY';
          };
          img.onerror = function() {
             document.getElementById(loadingId).style.display = 'none';
             document.getElementById(errorId).style.display = 'flex';
             if (stateRef) stateRef.loadStatus = 'ERROR';
          };
          img.src = previewUrl;
      }
    } else if (upperType === 'DOCUMENT') {
      renderDocumentStage(rendererRegion, artifactProjection, openTarget, stateRef);
    } else if (upperType === 'ANALYSIS') {
      // R24.7B — show the same saved summary Ask is grounded in (the projection
      // carries the persisted preview), read-only, so the user can see what NAgex answers about.
      renderReadOnlyText(rendererRegion, (artifactProjection && artifactProjection.summary) || '', COPY[locale()].askSummaryCaption);
      if (stateRef) stateRef.loadStatus = 'READY';
    } else if (upperType === 'RESEARCH') {
      rendererRegion.innerHTML = `<div class="canvas-document-container" style="padding: 20px; text-align: center; color: #64748b;">
        <h3>${esc(upperType)} Workspace</h3>
        <p>Metadata preview is available. Rich content editor not yet implemented.</p>
      </div>`;
      if (stateRef) stateRef.loadStatus = 'READY';
    } else {
      rendererRegion.innerHTML = `<div class="canvas-error-state" style="padding: 20px; text-align: center; color: #64748b;">
         <h3>Unsupported artifact</h3>
      </div>`;
      if (stateRef) stateRef.loadStatus = 'ERROR';
    }
  }

  // R24.7B — read-only text view. Content is only ever assigned through
  // textContent (never innerHTML), so document Markdown/HTML in a saved
  // artifact is displayed as plain text and can never execute.
  function renderReadOnlyText(region, text, caption) {
    region.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'canvas-document-container canvas-document-readonly';
    if (caption) {
      const cap = document.createElement('p');
      cap.className = 'canvas-document-caption';
      cap.textContent = caption;
      wrap.appendChild(cap);
    }
    const pre = document.createElement('pre');
    pre.className = 'canvas-document-text';
    pre.textContent = text || COPY[locale()].documentEmpty;
    wrap.appendChild(pre);
    region.appendChild(wrap);
  }

  // The stale-response guard is per REGION (Home's embedded Canvas and the Focus
  // Canvas can show the same artifact at the same time and must not cancel each other).
  function renderDocumentStage(region, projection, openTarget, stateRef) {
    const c = COPY[locale()];
    const seq = (region._documentStageSeq = (region._documentStageSeq || 0) + 1);
    region.innerHTML = '';
    const status = document.createElement('p');
    status.className = 'canvas-document-caption';
    status.textContent = c.documentLoading;
    region.appendChild(status);
    const target = (projection && projection.openTarget) || openTarget || '';
    // Only the same-origin NAgex API is ever fetched for an artifact's body.
    if (!/^\/api\/v1\//.test(target)) {
      status.textContent = c.documentUnavailable;
      if (stateRef) stateRef.loadStatus = 'ERROR';
      return;
    }
    window.NAGEX.apiFetch(target).then((res) => {
      if (seq !== region._documentStageSeq || !region.isConnected) return;
      const doc = res && res.document;
      if (!doc || typeof doc.content !== 'string') {
        status.textContent = c.documentUnavailable;
        if (stateRef) stateRef.loadStatus = 'ERROR';
        return;
      }
      renderReadOnlyText(region, doc.content, c.documentReadOnlyCaption);
      if (stateRef) stateRef.loadStatus = 'READY';
    });
  }

  // --- R24.7B Canvas Ask (read-only, artifact-grounded, one shared implementation) ---
  // One handler (submitCanvasAsk) and one renderer (renderAskState) serve the
  // desktop Focus Canvas ('canvas-'), Home's embedded Canvas ('home-canvas-')
  // and the mobile Canvas ('mh-canvas-'). No Ask/answer state is stored here
  // beyond a per-surface request sequence number that discards stale responses.
  const askSeq = { 'canvas-': 0, 'home-canvas-': 0, 'mh-canvas-': 0 };

  // Which artifact a given Ask surface is about. Home's embedded Canvas never
  // touches window.NAGEX._canvasState (by design), so it is resolved from the
  // embedded Canvas's own DOM, written by renderHomeEmbeddedCanvas; the Focus
  // surfaces use the single Focus state. Server-side the artifact is
  // re-resolved and ownership-checked from this id alone.
  function activeArtifactForPrefix(prefix) {
    if (prefix === 'home-canvas-') {
      const el = document.getElementById('home-embedded-canvas');
      const id = el && el.getAttribute('data-artifact-id');
      if (!id) return null;
      let ask = null;
      try { ask = JSON.parse(el.getAttribute('data-ask') || 'null'); } catch (e) { ask = null; }
      return { artifactId: id, ask };
    }
    const st = window.NAGEX._canvasState;
    if (!st || !st.active || !st.artifactId) return null;
    return { artifactId: st.artifactId, ask: (st.artifactProjection && st.artifactProjection.ask) || null };
  }

  function askControls(prefix) {
    const input = document.getElementById(prefix + 'ask-input');
    const button = input ? input.nextElementSibling : null;
    return { input, button, region: document.getElementById(prefix + 'ask-answer') };
  }

  function setAskBusy(prefix, busy) {
    const { input, button } = askControls(prefix);
    if (input) input.disabled = busy;
    if (button) button.disabled = busy;
  }

  const ASK_UNSUPPORTED_KEYS = { IMAGE_VISUAL_UNSUPPORTED: 'askUnsupportedImage', RESEARCH_PREVIEW_ONLY: 'askUnsupportedResearch', TYPE_NOT_SUPPORTED: 'askUnsupportedType' };

  function groundingLines(g) {
    const c = COPY[locale()];
    const lines = [];
    if (g && g.scope === 'PERSISTED_SUMMARY') lines.push(c.askGroundedSummary);
    else lines.push(g && g.revision ? c.askGroundedDocumentRev(g.revision) : c.askGroundedDocument);
    if (g && g.truncated) lines.push(c.askTruncated(g.contextChars, g.contentChars));
    if (!g || g.externalVerified !== true) lines.push(c.askNotVerified);
    return lines;
  }

  // The single response renderer. Everything server- or model-supplied is set via textContent.
  function renderAskState(prefix, stateName, data) {
    const { region } = askControls(prefix);
    if (!region) return;
    const c = COPY[locale()];
    region.innerHTML = '';
    if (stateName === 'idle') { region.hidden = true; region.removeAttribute('data-ask-state'); return; }
    region.hidden = false;
    region.setAttribute('data-ask-state', stateName);
    const body = document.createElement('div');
    body.className = 'canvas-ask-answer-body';
    const para = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; };
    if (stateName === 'loading') {
      body.appendChild(para('canvas-ask-status', c.askLoading));
    } else if (stateName === 'answer') {
      // What the answer is based on (and that it is NOT externally verified) comes FIRST,
      // so it is always visible — never scrolled out of a short mobile answer region.
      groundingLines(data.grounding).forEach((line) => body.appendChild(para('canvas-ask-grounding', line)));
      body.appendChild(para('canvas-ask-answer-text', data.answer));
    } else if (stateName === 'unsupported') {
      body.appendChild(para('canvas-ask-status', c[ASK_UNSUPPORTED_KEYS[data && data.reason] || 'askUnsupportedType']));
    } else if (stateName === 'auth') {
      body.appendChild(para('canvas-ask-status', c.askSignIn));
    } else {
      body.appendChild(para('canvas-ask-status', (data && data.message) || c.askError));
    }
    region.appendChild(body);
  }

  // Resets the Ask surface for the artifact it is now showing: cancels any
  // in-flight response (stale-response guard), clears the input and the
  // answer, and — when the server's projection says Ask is unsupported for this
  // type — shows that truthful reason and disables the input instead of letting
  // the user type a question that cannot be answered.
  function resetAskSurface(prefix, ask) {
    askSeq[prefix] = (askSeq[prefix] || 0) + 1;
    const { input } = askControls(prefix);
    if (input) input.value = '';
    if (ask && ask.supported === false) {
      renderAskState(prefix, 'unsupported', { reason: ask.reason });
      setAskBusy(prefix, true);
    } else {
      renderAskState(prefix, 'idle');
      setAskBusy(prefix, false);
    }
  }
  window.NAGEX._resetAskSurface = resetAskSurface;

  function classifyAskError(res) {
    const c = COPY[locale()];
    if (!res) return { state: 'error', message: c.askNetworkError };
    const code = typeof res.error === 'string' ? res.error : (res.error && res.error.code) || '';
    if (code === 'AUTHENTICATION_REQUIRED') return { state: 'auth' };
    if (code === 'ARTIFACT_ASK_UNSUPPORTED') return { state: 'unsupported', data: { reason: res.reason } };
    if (code === 'ARTIFACT_NOT_FOUND') return { state: 'error', message: c.askNotFound };
    if (code === 'ARTIFACT_CONTEXT_UNAVAILABLE') return { state: 'error', message: c.askContextUnavailable };
    if (code === 'INVALID_QUESTION') return { state: 'error', message: c.askInvalidQuestion };
    if (code === 'ASK_MODEL_UNAVAILABLE') return { state: 'error', message: c.askModelUnavailable };
    if (code === 'REQUEST_TIMEOUT') return { state: 'error', message: c.askTimeout };
    return { state: 'error', message: c.askError };
  }

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

    if (titleEl) {
      // R23.7H-C Phase D.1 §7 — raw artifact IDs are backend identity, not
      // primary-surface UX. Prefer the real title; fall back to a generic
      // truthful label (never the ID) when no title exists yet.
      titleEl.textContent = (artifactProjection && artifactProjection.title) || COPY[locale()].untitledArtifact;
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

    // Desktop-only NAgex Agent panel. Mobile Canvas has no Agent panel
    // (prefix + 'agent-context-fields' doesn't exist there), so this is a
    // safe no-op on mobile.
    renderArtifactContext(prefix, artifactType, artifactProjection);
    window.NAGEX.switchCanvasAgentTab('chat');

    renderArtifactStage(prefix, artifactType, artifactProjection, window.NAGEX._canvasState.openTarget, window.NAGEX._canvasState);
    // R24.7B — a different artifact never inherits the previous Ask input/answer.
    resetAskSurface(prefix, artifactProjection && artifactProjection.ask);

    if (typeof window.NAGEX.switchTab === 'function') {
      window.NAGEX.switchTab('tab-canvas', { artifactId: artifactId });
    }

    return window.NAGEX._canvasState;
  };

  window.NAGEX.switchCanvasAgentTab = function(tabId) {
    document.querySelectorAll('.canvas-agent-tab').forEach((btn) => {
      const active = btn.dataset.agentTab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.canvas-agent-tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.agentPanel !== tabId;
    });
  };

  window.NAGEX.closeCanvas = function() {
     if (window.NAGEX._canvasState) {
        window.NAGEX._canvasState.active = false;
     }
     if (typeof window.NAGEX.switchTab === 'function') {
        window.NAGEX.switchTab('tab-home');
     }
  };

  // R24.7B — reopens ANY owned artifact on reload via the real artifact
  // endpoint's projection (the same ArtifactUxProjection Home uses); it no
  // longer depends on the artifact being in Home's top-5 Recent Creations.
  // Not found / not owned / unauthenticated all look the same on purpose.
  window.NAGEX.restoreCanvasFromRoute = function(artifactId) {
      if (window.NAGEX._canvasState && window.NAGEX._canvasState.artifactId === artifactId && window.NAGEX._canvasState.active) {
          return;
      }
      window.NAGEX.apiFetch('/api/v1/artifacts/' + encodeURIComponent(artifactId)).then((res) => {
          const proj = res && res.projection;
          if (proj && proj.artifactId === artifactId) {
              window.NAGEX.dispatchArtifactOpen(proj.artifactType, artifactId, { artifactProjection: proj, title: proj.title });
              return;
          }
          const region = document.getElementById(canvasIdPrefix() + 'renderer-region');
          const titleEl = document.getElementById(canvasIdPrefix() + 'artifact-title');
          if (titleEl) titleEl.textContent = COPY[locale()].untitledArtifact;
          if (region) {
              region.innerHTML = '';
              const p = document.createElement('p');
              p.className = 'canvas-document-caption';
              p.textContent = COPY[locale()].artifactNotFound;
              region.appendChild(p);
          }
      });
  };

  // R23.7H-C Phase D.4 §11 — accepts an explicit prefix override so
  // Home's embedded Agent ("home-canvas-") can share this exact truthful
  // handler with Focus Mode (desktop "canvas-" / mobile "mh-canvas-")
  // instead of a second copy.
  window.NAGEX.submitCanvasAsk = async function(prefixOverride) {
     const prefix = prefixOverride || canvasIdPrefix();
     const { input } = askControls(prefix);
     if (!input) return;
     const question = String(input.value || '').trim();
     if (!question) return;
     const active = activeArtifactForPrefix(prefix);
     if (!active) { renderAskState(prefix, 'error', { message: COPY[locale()].askNoArtifact }); return; }
     if (active.ask && active.ask.supported === false) { renderAskState(prefix, 'unsupported', { reason: active.ask.reason }); return; }
     const seq = (askSeq[prefix] = (askSeq[prefix] || 0) + 1);
     const artifactId = active.artifactId;
     setAskBusy(prefix, true);
     renderAskState(prefix, 'loading');
     // Only the question (and the UI language) is sent: the server resolves the
     // artifact, its owner and its content from the id and the session cookie.
     const res = await window.NAGEX.apiFetch('/api/v1/artifacts/' + encodeURIComponent(artifactId) + '/ask', {
       method: 'POST',
       body: JSON.stringify({ question, locale: locale() }),
       timeoutMs: 90000,
     });
     const now = activeArtifactForPrefix(prefix);
     if (seq !== askSeq[prefix] || !now || now.artifactId !== artifactId) return; // stale: surface was reset or moved to another artifact
     setAskBusy(prefix, false);
     if (res && typeof res.answer === 'string' && res.answer && res.grounding && res.grounding.artifactId === artifactId) {
       renderAskState(prefix, 'answer', { answer: res.answer, grounding: res.grounding });
       input.value = '';
       return;
     }
     const failure = classifyAskError(res);
     renderAskState(prefix, failure.state, failure.data || { message: failure.message });
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
    en: {
      rightNow: 'Right Now', create: 'Create with NAgex', attention: 'Needs Attention', today: 'Today', preparing: 'NAgex Is Preparing', creations: 'Recent Creations', recent: 'Recent Activity', empty: 'Nothing to show right now.', noCreations: 'Your completed research and file analyses will appear here.', unavailable: 'This source is currently unavailable.', research: 'Research', analyze: 'Analyze', researchDesc: 'Find, verify, and synthesize information.', analyzeDesc: 'Understand supported documents and files.', open: 'Continue in Canvas',
      createSubtitle: 'Turn your ideas into high-quality content.',
      capREPORTTitle: 'Report', capREPORTDesc: 'Write a structured report or document.',
      capSLIDESTitle: 'Slides', capSLIDESDesc: 'Presentation decks.',
      capIMAGETitle: 'Image', capIMAGEDesc: 'Generate images and visual assets.',
      capVIDEOTitle: 'Video', capVIDEODesc: 'Short video clips.',
      capRESEARCHTitle: 'Research', capRESEARCHDesc: 'Find, verify, and synthesize information.',
      capPLANTitle: 'Plan', capPLANDesc: 'Turn a goal into a structured, approvable plan.',
      capCODETitle: 'Code', capCODEDesc: 'Generate and work with code.',
      capStatusLive: 'Available', capStatusPartial: 'Partially available', capStatusPlanned: 'Coming soon',
      workWithData: 'Work with your data', workWithDataSubtitle: 'NAgex can use your documents and connected sources to create personalized content.',
      contextType: 'Type', contextTitle: 'Title', contextUpdated: 'Updated', contextUnknown: 'Unknown', untitledArtifact: 'Untitled artifact',
      homeCanvasEmptyTitle: 'Create something with NAgex', homeCanvasEmptyBody: 'Start a report, image, research project, or plan — your work will continue here.', homeCanvasOpenFocus: 'Open in Canvas',
      documentLoading: 'Loading document…', documentUnavailable: 'This document could not be loaded.', documentEmpty: '(This document has no content.)', documentReadOnlyCaption: 'Read-only view of the saved document', askSummaryCaption: 'Saved summary of this file (read-only)',
      artifactNotFound: 'This artifact could not be opened. It may not exist, or it may belong to another account.',
      askLoading: 'NAgex is reading this artifact…', askSignIn: 'Sign in to ask about this artifact.',
      askUnsupportedImage: 'NAgex cannot inspect the content of this image in Ask yet, so it cannot answer questions about what the image shows.',
      askUnsupportedResearch: 'Ask is not available for research results yet: only a short preview is saved, not the full result.',
      askUnsupportedType: 'Ask is not available for this kind of artifact yet.',
      askGroundedDocument: 'Answered from this document only.', askGroundedDocumentRev: (n) => `Answered from this document only (revision ${n}).`, askGroundedSummary: 'Answered from the saved summary of this file only, not the full file.',
      askTruncated: (used, total) => `Only the first ${used} of ${total} characters were used, so this answer covers the beginning only.`,
      askNotVerified: 'Not independently verified. NAgex changed nothing.',
      askError: 'NAgex could not answer right now. Try again.', askNetworkError: 'Could not reach NAgex. Check your connection and try again.', askTimeout: 'This took too long and was cancelled. Try again.',
      askNotFound: 'This artifact could not be found.', askContextUnavailable: 'The saved content of this artifact is not available right now.', askInvalidQuestion: 'Enter a question of up to 2000 characters.',
      askModelUnavailable: 'NAgex cannot answer right now because no model is available.', askNoArtifact: 'Open an artifact first.',
      creationNetworkError: 'Could not reach NAgex. Check your connection and try again.',
      reportModelUnavailable: 'NAgex cannot write reports right now because no model is available.', reportFailed: "NAgex couldn't generate that report. Please try again.",
      researchSearchUnavailable: 'NAgex cannot research that right now because live web search is unavailable.', researchNoVerifiedSources: 'No verified sources were found for that question, so NAgex did not produce a research answer.',
      researchModelUnavailable: 'NAgex cannot research that right now because no model is available.', researchFailed: "NAgex couldn't complete that research. Please try again.",
      justNow: 'Just now', minutesAgo: (n) => `${n} min ago`, hoursAgo: (n) => `${n} hour${n === 1 ? '' : 's'} ago`, daysAgo: (n) => `${n} day${n === 1 ? '' : 's'} ago`,
    },
    ko: {
      rightNow: '지금', create: 'NAgex로 만들기', attention: '확인이 필요해요', today: '오늘', preparing: 'NAgex가 준비 중이에요', creations: '최근 생성 결과', recent: '최근 활동', empty: '지금 표시할 항목이 없습니다.', noCreations: '완료된 리서치와 파일 분석 결과가 여기에 표시됩니다.', unavailable: '현재 이 정보를 불러올 수 없습니다.', research: '리서치', analyze: '분석', researchDesc: '필요한 정보를 찾고 검증해 핵심을 정리합니다.', analyzeDesc: '지원되는 문서와 파일의 내용을 이해하고 정리합니다.', open: '캔버스에서 계속하기',
      createSubtitle: '아이디어를 완성도 높은 결과물로 만들어 보세요.',
      capREPORTTitle: '보고서', capREPORTDesc: '구조화된 보고서나 문서를 작성해요.',
      capSLIDESTitle: '슬라이드', capSLIDESDesc: '프레젠테이션 자료.',
      capIMAGETitle: '이미지', capIMAGEDesc: '이미지와 시각 자료를 생성해요.',
      capVIDEOTitle: '비디오', capVIDEODesc: '짧은 영상 클립.',
      capRESEARCHTitle: '리서치', capRESEARCHDesc: '필요한 정보를 찾고 검증해 핵심을 정리해요.',
      capPLANTitle: '플랜', capPLANDesc: '목표를 구조화된 승인 가능한 계획으로 만들어요.',
      capCODETitle: '코드', capCODEDesc: '코드를 생성하고 다뤄요.',
      capStatusLive: '이용 가능', capStatusPartial: '부분적으로 이용 가능', capStatusPlanned: '출시 예정',
      workWithData: '내 데이터로 작업하기', workWithDataSubtitle: 'NAgex가 문서와 연결된 소스를 활용해 맞춤 콘텐츠를 만들어 드려요.',
      contextType: '유형', contextTitle: '제목', contextUpdated: '업데이트', contextUnknown: '알 수 없음', untitledArtifact: '제목 없는 아티팩트',
      homeCanvasEmptyTitle: 'NAgex로 무언가를 만들어보세요', homeCanvasEmptyBody: '보고서, 이미지, 리서치, 플랜을 시작해 보세요 — 작업 내용이 여기에서 이어집니다.', homeCanvasOpenFocus: '캔버스에서 열기',
      documentLoading: '문서를 불러오는 중…', documentUnavailable: '이 문서를 불러오지 못했어요.', documentEmpty: '(이 문서에는 내용이 없어요.)', documentReadOnlyCaption: '저장된 문서의 읽기 전용 보기', askSummaryCaption: '이 파일의 저장된 요약 (읽기 전용)',
      artifactNotFound: '이 아티팩트를 열 수 없어요. 존재하지 않거나 다른 계정의 항목일 수 있어요.',
      askLoading: 'NAgex가 이 아티팩트를 읽는 중이에요…', askSignIn: '이 아티팩트에 대해 물어보려면 로그인하세요.',
      askUnsupportedImage: '아직은 질문하기에서 이미지의 내용을 확인할 수 없어서, 이미지에 무엇이 담겼는지는 답할 수 없어요.',
      askUnsupportedResearch: '아직은 리서치 결과에 대해 질문할 수 없어요. 전체 결과가 아니라 짧은 미리보기만 저장되어 있어요.',
      askUnsupportedType: '아직은 이 종류의 아티팩트에 대해 질문할 수 없어요.',
      askGroundedDocument: '이 문서만을 근거로 답했어요.', askGroundedDocumentRev: (n) => `이 문서(${n}번째 버전)만을 근거로 답했어요.`, askGroundedSummary: '파일 전체가 아니라 저장된 요약만을 근거로 답했어요.',
      askTruncated: (used, total) => `전체 ${total}자 중 앞부분 ${used}자만 사용했기 때문에 이 답변은 앞부분만 다뤄요.`,
      askNotVerified: '외부에서 검증된 내용은 아니에요. NAgex는 아무것도 바꾸지 않았어요.',
      askError: '지금은 NAgex가 답할 수 없어요. 다시 시도해 주세요.', askNetworkError: 'NAgex에 연결하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.', askTimeout: '시간이 너무 오래 걸려 취소되었어요. 다시 시도해 주세요.',
      askNotFound: '이 아티팩트를 찾을 수 없어요.', askContextUnavailable: '이 아티팩트의 저장된 내용을 지금은 불러올 수 없어요.', askInvalidQuestion: '2000자 이내로 질문을 입력해 주세요.',
      askModelUnavailable: '사용할 수 있는 모델이 없어 지금은 답할 수 없어요.', askNoArtifact: '먼저 아티팩트를 열어 주세요.',
      creationNetworkError: 'NAgex에 연결하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.',
      reportModelUnavailable: '사용할 수 있는 모델이 없어 지금은 보고서를 작성할 수 없어요.', reportFailed: '보고서를 생성하지 못했어요. 다시 시도해 주세요.',
      researchSearchUnavailable: '실시간 웹 검색을 사용할 수 없어 지금은 조사할 수 없어요.', researchNoVerifiedSources: '이 질문에 대해 확인된 출처를 찾지 못해서 리서치 답변을 만들지 않았어요.',
      researchModelUnavailable: '사용할 수 있는 모델이 없어 지금은 조사할 수 없어요.', researchFailed: '리서치를 완료하지 못했어요. 다시 시도해 주세요.',
      justNow: '방금 전', minutesAgo: (n) => `${n}분 전`, hoursAgo: (n) => `${n}시간 전`, daysAgo: (n) => `${n}일 전`,
    },
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
      const thumbHtml = window.NAGEX.renderArtifactThumbnail(item.artifactProjection);
      return `<article class="ph-item" data-source-key="${esc(item.key)}" ${thumbHtml ? 'style="display:flex;align-items:center;"' : ''}>
        ${thumbHtml}
        <div class="ph-item-copy" style="flex:1;"><h3>${esc(item.title)}</h3>${item.context ? `<p>${esc(item.context)}</p>` : ''}${item.time ? `<time datetime="${esc(item.time)}">${esc(new Date(item.time).toLocaleTimeString(locale() === 'ko' ? 'ko-KR' : 'en-US', { hour: 'numeric', minute: '2-digit' }))}</time>` : ''}</div>
        <div class="ph-item-meta"><span class="ph-state" data-state="${esc(item.state)}">${esc(STATE_LABELS[locale()][item.state] || item.state)}</span>${item.action ? `<button type="button" class="ph-action" data-type="${esc(item.type)}" data-ref="${esc(item.sourceRef)}" data-target="${esc(item.actionTarget || '')}">${esc(item.action.type === 'OPEN_ARTIFACT' ? (COPY[locale()].homeCanvasOpenFocus || COPY[locale()].open) : item.action.label)}</button>` : ''}</div>
      </article>`;
    }).join('');
  }

  // R23.7H-C Phase D.4 §16 — a truly empty section (no items, and no
  // section-specific designed empty state — the generic "Nothing to show
  // right now" text repeated across every section isn't one) must not
  // render as an empty bordered card. Sections with real content, or a
  // genuinely designed empty state (embedded Canvas, Recent Creations —
  // both handled by their own render functions, not this one), are
  // unaffected.
  function renderSection(target, title, items, id) {
    if (!target) return;
    if (!items || !items.length) {
      target.hidden = true;
      return;
    }
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

  // R23.7H-C Phase D — "Work with your data". The real ANALYZE action
  // (file analysis, previously one of the 2 generic Create tiles) lives
  // here now, since it isn't one of the 7 mockup Create capabilities —
  // same real dispatch (`activateCreationAction('ANALYZE')` → the existing
  // #composer-file-input file picker), not deleted, just relocated.
  // Connected-sources state is read from the real creationActions/
  // sourceStatus fields already on the Home response — no invented
  // integrations, truthful empty state when nothing is connected.
  // R23.7H-C Phase D — Recent Creations filter pills. Client-side only:
  // filters the already-fetched `items` array in place, no new API/store.
  // Maps real ArtifactType values to the 7 mockup capability labels;
  // PLAN/CODE have no real artifacts today so their pills always filter
  // to empty (truthful — never implies fake runtime/history).
  const RECENT_FILTER_TYPE_MAP = { REPORT: ['DOCUMENT'], SLIDES: ['PRESENTATION'], IMAGE: ['IMAGE'], VIDEO: ['VIDEO'], RESEARCH: ['RESEARCH', 'ANALYSIS'], PLAN: [], CODE: [] };
  const RECENT_FILTERS = ['ALL', 'REPORT', 'SLIDES', 'IMAGE', 'VIDEO', 'RESEARCH', 'PLAN', 'CODE'];

  function recentFilterLabel(id) {
    if (id === 'ALL') return locale() === 'ko' ? '전체' : 'All';
    return capabilityCopy(id).title;
  }

  function wireActionButtons(listEl, items) {
    if (!listEl) return;
    listEl.querySelectorAll('.ph-action').forEach((button) => button.addEventListener('click', async () => {
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

  // R23.7H-C D9 §2 — real timestamp → truthful relative-time string. Only
  // ever reads artifactProjection.updatedAt (real data); never fabricates
  // a time when none exists.
  function formatRelativeTime(iso) {
    if (!iso) return '';
    const c = COPY[locale()];
    const diffMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return c.justNow;
    if (minutes < 60) return c.minutesAgo(minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return c.hoursAgo(hours);
    return c.daysAgo(Math.floor(hours / 24));
  }

  const ARTIFACT_TYPE_TO_CAPABILITY = { DOCUMENT: 'REPORT', PRESENTATION: 'SLIDES', IMAGE: 'IMAGE', VIDEO: 'VIDEO', RESEARCH: 'RESEARCH', ANALYSIS: 'RESEARCH' };
  function artifactTypeLabel(artifactType) {
    const capId = ARTIFACT_TYPE_TO_CAPABILITY[String(artifactType || '').toUpperCase()];
    return capId ? capabilityCopy(capId).title : (artifactType || '');
  }

  // R23.7H-C D9 §2 — Recent Creations' own card template (not the shared
  // renderItems() other sections use — Needs Attention/Today's layout is
  // explicitly frozen this pass). Compacts the state into the metadata
  // line ("{Type} • {Status} • {relative time}") instead of a separate
  // badge row, matching the reference's single metadata line while
  // keeping the real status visible (STATUS_DATA_REMOVED=NO) — nothing
  // is deleted, just no longer given its own 20px row.
  function renderRecentItems(items) {
    if (!items.length) return `<p class="ph-empty">${esc(COPY[locale()].empty)}</p>`;
    return items.map((item) => {
      const thumbHtml = window.NAGEX.renderArtifactThumbnail(item.artifactProjection);
      const typeLabel = artifactTypeLabel(item.artifactProjection ? item.artifactProjection.artifactType : item.type);
      const stateLabel = STATE_LABELS[locale()][item.state] || item.state;
      const relTime = item.artifactProjection && item.artifactProjection.updatedAt ? formatRelativeTime(item.artifactProjection.updatedAt) : '';
      const metaParts = [typeLabel, stateLabel, relTime].filter(Boolean);
      return `<article class="ph-item" data-source-key="${esc(item.key)}">
        ${thumbHtml}
        <div class="ph-item-copy"><h3>${esc(item.title)}</h3><p class="ph-item-compact-meta" data-state="${esc(item.state)}">${esc(metaParts.join(' • '))}</p></div>
        ${item.action ? `<button type="button" class="ph-action" data-type="${esc(item.type)}" data-ref="${esc(item.sourceRef)}" data-target="${esc(item.actionTarget || '')}">${esc(item.action.type === 'OPEN_ARTIFACT' ? (COPY[locale()].homeCanvasOpenFocus || COPY[locale()].open) : item.action.label)}</button>` : ''}
      </article>`;
    }).join('');
  }

  function renderRecentCreations(target, title, items) {
    if (!target) return;
    if (!items || !items.length) {
      target.hidden = true;
      return;
    }
    target.hidden = false;
    target.setAttribute('data-home-section', 'recent-creations');
    const pillsHtml = `<div class="ph-recent-filters">${RECENT_FILTERS.map((id) => `<button type="button" class="ph-recent-filter-pill${id === 'ALL' ? ' active' : ''}" data-recent-filter="${esc(id)}">${esc(recentFilterLabel(id))}</button>`).join('')}</div>`;
    target.innerHTML = `<div class="ph-heading"><h2>${esc(title)}</h2></div>${pillsHtml}<div class="ph-list" id="${target.id}-list">${renderRecentItems(items)}</div>`;
    const listEl = document.getElementById(target.id + '-list');
    const applyFilter = (filterId) => {
      const filtered = filterId === 'ALL' ? items : items.filter((item) => (RECENT_FILTER_TYPE_MAP[filterId] || []).includes(String(item.type || '').toUpperCase()));
      listEl.innerHTML = renderRecentItems(filtered);
      wireActionButtons(listEl, filtered);
    };
    target.querySelectorAll('.ph-recent-filter-pill').forEach((pill) => pill.addEventListener('click', () => {
      target.querySelectorAll('.ph-recent-filter-pill').forEach((p) => p.classList.toggle('active', p === pill));
      applyFilter(pill.dataset.recentFilter);
    }));
    wireActionButtons(listEl, items);
  }

  function renderWorkWithData(target) {
    if (!target) return;
    const c = COPY[locale()];
    target.hidden = false;
    target.setAttribute('data-home-section', 'work-with-data');
    if (target.id === 'home-section-work-with-data') {
      target.innerHTML = `<div class="ph-work-data-heading"><span class="ph-work-data-icon" aria-hidden="true"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 8l10 5 10-5-10-5zm-7 9 7 3.5L19 12v4l-7 3.5L5 16v-4z"/></svg></span><div><h2>${esc(c.workWithData)}</h2><p class="ph-heading-sub">${esc(c.workWithDataSubtitle)}</p></div></div><div class="ph-work-data-actions"><button type="button" class="ph-connect-sources" data-creation-action="ANALYZE">Connect sources <span aria-hidden="true">-&gt;</span></button><div class="ph-source-icons" aria-label="Source providers availability"><span class="ph-source-icon" title="Google Drive available when connected">G</span><span class="ph-source-icon" title="Notion planned">N</span><span class="ph-source-icon" title="Cloud storage planned">C</span></div></div>`;
      target.querySelectorAll('[data-creation-action]').forEach((button) => button.addEventListener('click', () => activateCreationAction(button.dataset.creationAction)));
      return;
    }
    target.innerHTML = `<div class="ph-heading"><h2>${esc(c.workWithData)}</h2><p class="ph-heading-sub">${esc(c.workWithDataSubtitle)}</p></div><div class="ph-create-actions"><button type="button" class="ph-create-action" data-creation-action="ANALYZE"><strong>${esc(c.analyze)}</strong><span>${esc(c.analyzeDesc)}</span></button></div>`;
    target.querySelectorAll('[data-creation-action]').forEach((button) => button.addEventListener('click', () => activateCreationAction(button.dataset.creationAction)));
  }

  // R23.7H-C Phase D.3 §8/§9 — Home's embedded Canvas: shows the most
  // recent real artifact using the EXACT SAME shared rendering
  // architecture as Focus Mode Canvas (renderArtifactStage — no second
  // implementation), or a truthful empty state when none exists. This
  // never touches window.NAGEX._canvasState — that only happens when the
  // user actually navigates to Focus Mode via "Open in Canvas" below —
  // so the embedded preview and Focus Mode can never disagree about
  // which artifact is "open" (there is only ever one real state object).
  function renderHomeEmbeddedCanvas(model) {
    const target = document.getElementById('home-embedded-canvas');
    if (!target) return;
    const c = COPY[locale()];
    const recent = (model.recentCreations || []).find((item) => item.artifactProjection && (item.artifactProjection.previewKind === 'IMAGE' || item.artifactProjection.previewKind === 'TEXT'));

    target.hidden = false;
    target.setAttribute('data-home-section', 'embedded-canvas');
    const agentPanel = document.getElementById('home-agent-panel');

    if (!recent) {
      target.removeAttribute('data-artifact-id');
      target.removeAttribute('data-ask');
      resetAskSurface('home-canvas-', null);
      target.innerHTML = `<div class="home-canvas-empty"><h2>${esc(c.homeCanvasEmptyTitle)}</h2><p>${esc(c.homeCanvasEmptyBody)}</p></div>`;
      // R23.7H-C Phase D.4 §16 — no artifact means the Agent has nothing
      // real to collaborate on yet; hide it rather than show an empty
      // Chat/Context/Suggestions shell beside an empty Canvas.
      if (agentPanel) agentPanel.hidden = true;
      return;
    }
    if (agentPanel) agentPanel.hidden = false;

    const proj = recent.artifactProjection;
    // R23.7H-C Phase D.4 §24 — exposes the REAL canonical artifactId the
    // embedded preview actually rendered, so certification can verify
    // "Home and Focus Mode agree" by identity rather than assuming list
    // position (the D.3 cert script's flawed assumption). Real state,
    // same real-state-exposure pattern Focus Mode already uses elsewhere.
    window.NAGEX._homeEmbeddedArtifactIdForCert = proj.artifactId;
    const previousEmbeddedId = target.getAttribute('data-artifact-id');
    target.setAttribute('data-artifact-id', proj.artifactId);
    target.setAttribute('data-ask', JSON.stringify(proj.ask || null));
    target.innerHTML = `
      <div class="canvas-toolbar home-embedded-canvas-toolbar">
        <div class="canvas-toolbar-left">
          <div class="canvas-context">
            <span id="home-canvas-artifact-type" class="badge-status">${esc(proj.artifactType || '')}</span>
            <h2 id="home-canvas-artifact-title">${esc(proj.title || c.untitledArtifact)}</h2>
          </div>
        </div>
        <div class="canvas-toolbar-right">
          <button type="button" class="btn-primary" id="home-canvas-open-btn">${esc(c.homeCanvasOpenFocus)}</button>
        </div>
      </div>
      <div class="canvas-stage home-embedded-canvas-stage">
        <div id="home-canvas-renderer-region" class="canvas-renderer"></div>
      </div>
    `;

    renderArtifactStage('home-canvas-', proj.artifactType, proj, proj.openTarget, null);
    renderArtifactContext('home-canvas-', proj.artifactType, proj);
    window.NAGEX.switchCanvasAgentTab('chat');
    if (previousEmbeddedId !== proj.artifactId) resetAskSurface('home-canvas-', proj.ask);

    const openBtn = document.getElementById('home-canvas-open-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        window.NAGEX.dispatchArtifactOpen(proj.artifactType, recent.sourceRef, recent);
      });
    }
  }

  // R23.7H-C Phase D — the 7 first-class Create capabilities, matching the
  // approved mockup. This is a static, presentational catalog, NOT the
  // server's `creationActions` field (which stays a real, typed 2-entry
  // RESEARCH/ANALYZE dispatch list, untouched). Status here is a truthful,
  // static fact about which routes/executors actually exist in this
  // codebase (verified: document-creation.routes.ts for REPORT,
  // creation.routes.ts/image-executor.ts for IMAGE, research.routes.ts for
  // RESEARCH, plan-resolver.ts + tasks/automations routes for PLAN's real
  // but partial step execution; SLIDES/VIDEO/CODE have no route at all) —
  // the same kind of hardcoded per-type truth Phase C's ArtifactPreviewKind
  // mapping already uses, not personalized/runtime data.
  const CREATE_CAPABILITIES = [
    { id: 'REPORT', status: 'LIVE', tile: 'blue', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
    { id: 'SLIDES', status: 'PLANNED', tile: 'orange', icon: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8" stroke="currentColor" stroke-width="1.6"/>' },
    { id: 'IMAGE', status: 'LIVE', tile: 'purple', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6" fill="#fff"/><path d="M21 15l-5-5L5 21" fill="none" stroke="#fff" stroke-width="1.6"/>' },
    { id: 'VIDEO', status: 'PLANNED', tile: 'red', icon: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>' },
    { id: 'RESEARCH', status: 'LIVE', tile: 'green', icon: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 20l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
    { id: 'PLAN', status: 'PARTIAL', tile: 'blue', icon: '<rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 2v4M16 2v4M3 10h18" fill="none" stroke="currentColor" stroke-width="2"/>' },
    { id: 'CODE', status: 'PLANNED', tile: 'purple', icon: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
  ];

  function capabilityCopy(id) {
    const c = COPY[locale()];
    return { title: c['cap' + id + 'Title'] || id, desc: c['cap' + id + 'Desc'] || '' };
  }

  function statusBadgeLabel(status) {
    const c = COPY[locale()];
    if (status === 'LIVE') return c.capStatusLive;
    if (status === 'PARTIAL') return c.capStatusPartial;
    return c.capStatusPlanned;
  }

  function renderCreateCapabilities(target) {
    if (!target) return;
    const c = COPY[locale()];
    target.hidden = false;
    target.setAttribute('data-home-section', 'create-capabilities');
    target.innerHTML = `<div class="ph-heading"><h2><svg class="svg-icon-sm" style="color:var(--primary-blue, #0a56f7);" viewBox="0 0 24 24"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/></svg> ${esc(c.create)}</h2><p class="ph-heading-sub">${esc(c.createSubtitle)}</p></div><div class="ph-capability-row">${CREATE_CAPABILITIES.map((cap) => {
      const copy = capabilityCopy(cap.id);
      return `<button type="button" class="ph-capability-tile" data-capability="${esc(cap.id)}" data-status="${esc(cap.status)}" aria-label="${esc(copy.title)} — ${esc(statusBadgeLabel(cap.status))}">
        <span class="ph-capability-icon card-icon-tile ${esc(cap.tile)}-tile"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor">${cap.icon}</svg></span>
        <strong>${esc(copy.title)}</strong>
        <span class="ph-capability-desc">${esc(copy.desc)}</span>
        <span class="ph-capability-status" data-status="${esc(cap.status)}"><i></i>${esc(statusBadgeLabel(cap.status))}</span>
      </button>`;
    }).join('')}</div>`;
    target.querySelectorAll('[data-capability]').forEach((button) => button.addEventListener('click', () => activateCreateCapability(button.dataset.capability)));
  }

  function activateCreateCapability(id) {
    if (id === 'IMAGE') {
      if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-create');
      return;
    }
    if (id === 'PLAN') {
      if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-plans');
      return;
    }
    if (id === 'RESEARCH') {
      activateCreationAction('RESEARCH');
      return;
    }
    if (id === 'REPORT') {
      // R24.8B — on Desktop the Home composer is intentionally hidden; the Report flow starts in the visible Ask sheet.
      if (!isMobileViewport() && window.NAGEX.openAsk) { window.NAGEX.openAsk('REPORT'); return; }
      const input = document.getElementById('mh-command-input');
      if (!input) return;
      input.dataset.creationMode = 'REPORT';
      input.value = '';
      input.placeholder = locale() === 'ko' ? '어떤 내용의 보고서를 작성할까요?' : 'What should NAgex write a report about?';
      input.focus();
      return;
    }
    // SLIDES / VIDEO / CODE — genuinely planned, no executor exists yet.
    // Same truthful pattern as dispatchArtifactOpen's PLANNED handling:
    // tell the user honestly, never fake progress or success.
    const msg = locale() === 'ko' ? '해당 기능은 향후 업데이트에서 지원될 예정입니다.' : 'This capability is planned for a future update.';
    if (typeof window.alert === 'function') window.alert(msg);
  }

  async function submitReport(prompt) {
    const result = await window.NAGEX.apiFetch('/api/v1/creations/documents', { method: 'POST', body: JSON.stringify({ prompt }) });
    if (!result || result.error) return result;
    cachedPromise = null;
    if (result.artifactId) {
      // Open with the REAL projection (title, Ask support) from the artifact endpoint, not an empty one.
      const art = await window.NAGEX.apiFetch('/api/v1/artifacts/' + encodeURIComponent(result.artifactId));
      const projection = art && art.projection && art.projection.artifactId === result.artifactId ? art.projection : null;
      window.NAGEX.openArtifactInCanvas(result.artifactId, 'DOCUMENT', projection ? projection.canvasTarget : undefined, result.openTarget, projection);
    }
    return result;
  }

  function activateCreationAction(action) {
    if (action === 'ANALYZE') {
      const fileInput = document.getElementById('composer-file-input');
      if (fileInput) fileInput.click();
      return;
    }
    // R24.8B — Desktop: the visible Ask sheet (the Home composer is hidden by design); Mobile: its composer.
    if (!isMobileViewport() && window.NAGEX.openAsk) { window.NAGEX.openAsk('RESEARCH'); return; }
    const input = document.getElementById('mh-command-input');
    if (!input) return;
    input.dataset.creationMode = 'RESEARCH';
    input.value = '';
    input.placeholder = locale() === 'ko' ? '무엇을 조사할까요?' : 'What should NAgex research?';
    input.focus();
  }

  async function submitResearch(query, opts) {
    const result = await window.NAGEX.apiFetch('/api/v1/research', { method: 'POST', body: JSON.stringify({ query }) });
    // A response with a `status` means the server could not ground an answer (no live search / no verified sources).
    if (!result || result.error || result.status) return result;
    cachedPromise = null;
    const model = await fetchHome(true);
    renderDesktop(model);
    renderMobile(model);
    if (!(opts && opts.quiet)) window.alert(result.answer || (locale() === 'ko' ? '리서치가 완료되었습니다.' : 'Research completed.'));
    return result;
  }

  // R24.8B — one truthful, localized explanation for a failed Report/Research request (null = it succeeded).
  // Both entry surfaces (Desktop Ask sheet, Mobile composer) show this text; nothing is ever reported as done on failure.
  const UNAVAILABLE_CODES = new Set(['UNAVAILABLE', 'NO_MODEL_PROVIDER_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'ALL_MODEL_PROVIDERS_FAILED', 'MODEL_PROVIDER_NOT_REGISTERED']);
  function explainCreationFailure(kind, result) {
    const c = COPY[locale()];
    if (!result) return c.creationNetworkError;
    const code = typeof result.error === 'string' ? result.error : (result.error && result.error.code) || '';
    if (kind === 'RESEARCH') {
      if (result.status === 'UNAVAILABLE') return c.researchSearchUnavailable;
      if (result.status) return c.researchNoVerifiedSources;
      if (code) return UNAVAILABLE_CODES.has(code) ? c.researchModelUnavailable : c.researchFailed;
      return null;
    }
    if (code) return UNAVAILABLE_CODES.has(code) ? c.reportModelUnavailable : c.reportFailed;
    return null;
  }

  function renderDesktop(model) {
    const c = COPY[locale()];
    renderSection(document.getElementById('home-section-right-now'), c.rightNow, model.rightNow, 'right-now');
    renderCreateCapabilities(document.getElementById('home-section-create'));
    renderWorkWithData(document.getElementById('home-section-work-with-data'));
    renderHomeEmbeddedCanvas(model);
    renderSection(document.getElementById('home-section-needs-attention'), c.attention, model.attention, 'needs-attention');
    renderSection(document.getElementById('home-section-today'), c.today, model.today, 'today');
    renderSection(document.getElementById('home-section-prepared'), c.preparing, model.preparing, 'preparing');
    renderRecentCreations(document.getElementById('home-section-recent-creations'), c.creations, model.recentCreations);
    renderSection(document.getElementById('home-section-recent-results'), c.recent, model.recent, 'recent');
    const obsolete = document.getElementById('home-section-working'); if (obsolete) obsolete.hidden = true;
  }

  function renderMobile(model) {
    const c = COPY[locale()];
    renderSection(document.getElementById('mh-right-now-hero'), c.rightNow, model.rightNow, 'right-now');
    renderCreateCapabilities(document.getElementById('mh-section-create'));
    renderWorkWithData(document.getElementById('mh-section-work-with-data'));
    renderSection(document.getElementById('mh-section-approvals'), c.attention, model.attention, 'needs-attention');
    renderSection(document.getElementById('mh-section-today'), c.today, model.today, 'today');
    renderSection(document.getElementById('mh-section-prepared'), c.preparing, model.preparing, 'preparing');
    renderRecentCreations(document.getElementById('mh-section-recent-creations'), c.creations, model.recentCreations);
    renderSection(document.getElementById('mh-section-recent'), c.recent, model.recent, 'recent');
    const suggestions = document.getElementById('mh-section-suggestions'); if (suggestions) suggestions.hidden = true;
  }

  window.NAGEX_PERSONAL_HOME = Object.freeze({ STATES, normalize, fetchHome, renderDesktop, renderMobile, submitResearch, submitReport, explainCreationFailure, invalidate: () => { cachedPromise = null; } });
})();
