(function () {
  'use strict';

  const MODES = [
    { id: 'ASK', label: 'Ask', capability: 'ASK', enabled: true, support: 'FULL', route: '/api/v1/ai/chat' },
    { id: 'RESEARCH', label: 'Research', capability: 'RESEARCH', enabled: true, support: 'FULL', route: '/api/v1/research' },
    { id: 'DOCUMENT', label: 'Document', artifactType: 'DOCUMENT', enabled: true, support: 'FULL', route: '/api/v1/creations/documents' },
    { id: 'PLAN', label: 'Plan', capability: 'PLAN', enabled: true, support: 'PARTIAL', route: '/api/v1/ambient/intent' },
    { id: 'IMAGE', label: 'Image', artifactType: 'IMAGE', enabled: true, support: 'FULL', route: '/api/v1/creations/generate' },
    { id: 'SLIDES', label: 'Slides', artifactType: 'PRESENTATION', enabled: false, support: 'MISSING', reason: 'Presentation provider ports exist, but no consumer-safe Main generation route is enabled yet.' },
    { id: 'VIDEO', label: 'Video', artifactType: 'VIDEO', enabled: false, support: 'MISSING', reason: 'Video provider experiments exist, but no consumer-safe Main generation route is enabled yet.' },
    { id: 'CODE', label: 'Code', capability: 'CODE', enabled: false, support: 'MISSING', reason: 'No canonical code artifact runtime is enabled in Main yet.' },
    { id: 'MORE', label: 'More', capability: 'CAPABILITY_AUDIT', enabled: true, support: 'PARTIAL', route: 'inline capability matrix' },
  ];

  const state = {
    mode: 'ASK',
    web: true,
    personalContext: false,
    planPreview: true,
    busy: false,
    trayCollapsed: false,
    attachments: [],
    result: null,
    revisionTarget: null,
    voiceState: 'IDLE',
    voiceAdapter: null,
    voiceMode: null,
  };

  function api(endpoint, options) {
    if (window.NAGEX && window.NAGEX.apiFetch) return window.NAGEX.apiFetch(endpoint, options);
    return fetch(endpoint, options).then((r) => r.json()).catch(() => null);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function requestMetadata() {
    const mode = MODES.find((m) => m.id === state.mode) || MODES[0];
    return {
      preferredMode: mode.id,
      preferredCapability: mode.capability || null,
      preferredArtifactType: mode.artifactType || null,
      allowWebResearch: state.web,
      usePersonalContext: state.personalContext,
      showPlanBeforeConsequentialActions: state.planPreview,
      routingPolicy: 'INTERNAL_AUTO',
      attachmentRefs: state.attachments.map((a) => a.captureId || a.id).filter(Boolean),
      activeContext: {
        artifactId: state.result && state.result.artifactId ? state.result.artifactId : null,
        documentId: state.result && state.result.documentId ? state.result.documentId : null,
        revisionDocumentId: state.revisionTarget && state.revisionTarget.documentId ? state.revisionTarget.documentId : null,
      },
    };
  }

  function template() {
    return `
      <div class="nagex-main-surface" id="nagex-main-surface" data-state="idle">
        <section class="nagex-main-left">
          <div class="main-hero-row">
            <div>
              <h1>Good morning, <span>redcloudyun</span></h1>
              <p>What would you like to accomplish today?</p>
            </div>
            <p class="main-quote">"Small steps every day create a bigger tomorrow."</p>
          </div>
          <section class="main-composer-card" aria-label="Main NAgex request composer">
            <div class="main-mode-row" id="main-mode-row"></div>
            <div class="main-input-wrap">
              <textarea id="main-surface-input" placeholder="Ask NAgex to research, create, plan, or act..."></textarea>
              <div class="main-attachment-list" id="main-attachment-list"></div>
              <div class="main-composer-footer">
                <div class="main-left-tools">
                  <button type="button" class="main-tool-btn" id="main-attach">Attach</button>
                  <input type="file" id="main-file-input" hidden>
                  <button type="button" class="main-tool-btn main-toggle" id="main-web-toggle" aria-pressed="true">Web</button>
                  <button type="button" class="main-tool-btn main-toggle" id="main-data-toggle" aria-pressed="false">My data</button>
                </div>
                <div class="main-right-tools">
                  <button type="button" class="main-mic-btn" id="main-mic" title="Dictate into the Main composer">
                    <span aria-hidden="true" class="main-voice-mic"></span>
                    <span class="nagex-sr-only">Microphone dictation</span>
                  </button>
                  <button type="button" class="main-voice-btn" id="main-voice" title="Start NAgex voice mode">
                    <span aria-hidden="true" class="main-voice-dot"></span>
                    <span>Voice</span>
                  </button>
                  <span class="main-voice-status" id="main-voice-status">Idle</span>
                  <button type="button" class="main-tool-btn main-toggle" id="main-plan-toggle" aria-pressed="true">Show plan before actions</button>
                  <button type="button" class="main-send" id="main-send" aria-label="Send request">></button>
                </div>
              </div>
              <div class="main-composer-notice" id="main-composer-notice" role="status" aria-live="polite" hidden></div>
            </div>
          </section>
          <section class="main-thread-card" id="main-thread-card" hidden>
            <div class="main-message">
              <span class="main-avatar">R</span>
              <div>
                <div class="main-message-meta"><strong>redcloudyun</strong><span id="main-request-time">Just now</span></div>
                <p id="main-request-text"></p>
              </div>
            </div>
            <div class="main-message">
              <span class="main-avatar nagex">N</span>
              <div>
                <div class="main-message-meta"><strong>NAgex</strong><span id="main-status">Ready</span></div>
                <h2 id="main-work-title">Ready</h2>
                <p id="main-work-summary"></p>
                <ol class="main-step-list" id="main-step-list"></ol>
                <div class="main-inline-actions" id="main-inline-actions"></div>
              </div>
            </div>
          </section>
        </section>
        <aside class="main-result-panel" id="main-result-panel" hidden aria-label="Result panel">
          <div class="main-result-header">
            <div class="main-result-file-icon" id="main-result-kind">DOC</div>
            <div class="main-result-title-group">
              <h2 id="main-result-title">Result</h2>
              <p id="main-result-meta">Ready</p>
            </div>
            <button type="button" class="main-result-icon-btn" id="main-result-close" aria-label="Close result">x</button>
          </div>
          <div class="main-result-tabs">
            <button type="button" class="active">Preview</button>
            <button type="button" id="main-result-sources" disabled>Sources</button>
            <button type="button" id="main-result-versions" disabled>Versions</button>
            <button type="button" class="main-result-expand" id="main-result-expand">Expand</button>
          </div>
          <div class="main-result-preview" id="main-result-preview"></div>
          <div class="main-result-footer">
            <button type="button" class="btn-secondary" id="main-result-download" disabled>Download</button>
            <button type="button" class="btn-secondary" id="main-result-open">Open</button>
            <button type="button" class="btn-primary" id="main-result-revise">Revise</button>
          </div>
        </aside>
      </div>
    `;
  }

  function renderModes() {
    const row = document.getElementById('main-mode-row');
    if (!row) return;
    row.setAttribute('role', 'toolbar');
    row.setAttribute('aria-label', 'Main execution modes');
    row.innerHTML = MODES.map((mode) => `
      <button type="button" class="main-mode-chip" data-main-mode="${esc(mode.id)}" data-support="${esc(mode.support)}" aria-pressed="${mode.id === state.mode ? 'true' : 'false'}" aria-disabled="${mode.enabled ? 'false' : 'true'}" ${mode.enabled ? '' : 'disabled title="' + esc(mode.reason) + '"'}>
        ${esc(mode.label)}
      </button>
    `).join('');
  }

  function setStep(items) {
    const list = document.getElementById('main-step-list');
    if (!list) return;
    list.innerHTML = items.map((item) => `
      <li class="${esc(item.state)}"><span class="main-step-dot">${item.state === 'done' ? '✓' : ''}</span><span>${esc(item.label)}</span><small>${esc(item.detail || '')}</small></li>
    `).join('');
  }

  function showThread(prompt, status, title, summary, steps) {
    const card = document.getElementById('main-thread-card');
    if (card) card.hidden = false;
    const promptEl = document.getElementById('main-request-text');
    if (promptEl) promptEl.textContent = prompt;
    const statusEl = document.getElementById('main-status');
    if (statusEl) statusEl.textContent = status;
    const titleEl = document.getElementById('main-work-title');
    if (titleEl) titleEl.textContent = title;
    const summaryEl = document.getElementById('main-work-summary');
    if (summaryEl) summaryEl.textContent = summary;
    setStep(steps || []);
  }

  function setComposerNotice(message, tone) {
    const notice = document.getElementById('main-composer-notice');
    if (!notice) return;
    if (!message) {
      notice.hidden = true;
      notice.textContent = '';
      notice.removeAttribute('data-tone');
      return;
    }
    notice.hidden = false;
    notice.dataset.tone = tone || 'info';
    notice.textContent = message;
  }

  function setTrayCollapsed(collapsed) {
    state.trayCollapsed = collapsed;
    const tray = document.getElementById('main-bottom-tray');
    const btn = document.getElementById('main-tray-toggle');
    if (tray) tray.dataset.collapsed = collapsed ? 'true' : 'false';
    if (btn) btn.textContent = collapsed ? 'Expand' : 'Collapse';
  }

  function renderAttachments() {
    const el = document.getElementById('main-attachment-list');
    if (!el) return;
    el.innerHTML = state.attachments.map((a, index) => `
      <span class="main-attachment-chip">${esc(a.filename || a.title || 'Attachment')} <button type="button" data-remove-attachment="${index}" aria-label="Remove attachment">x</button></span>
    `).join('');
  }

  async function uploadFile(file) {
    if (!file || state.busy) return;
    setComposerNotice('');
    showThread('Attachment upload', 'Uploading', 'Adding attachment', 'NAgex is storing this file through the real workspace upload pipeline.', [
      { state: 'running', label: 'Upload file', detail: file.name },
    ]);
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = String(reader.result || '').split(',')[1];
      const result = await api('/api/v1/workspace/upload', {
        method: 'POST',
        body: JSON.stringify({ type: 'FILE', filename: file.name, mimeType: file.type || 'application/octet-stream', base64, source: 'WEB' }),
      });
      if (result && !result.error) {
        state.attachments.push(result);
        renderAttachments();
        showThread('Attachment upload', 'Ready', 'Attachment added', 'The file is persisted and will be referenced by the next request.', [
          { state: 'done', label: 'Upload file', detail: result.captureId || file.name },
        ]);
      } else {
        showThread('Attachment upload', 'Error', 'Attachment failed', (result && result.error && result.error.message) || 'The file could not be uploaded.', [
          { state: 'running', label: 'Upload failed', detail: file.name },
        ]);
      }
    };
    reader.readAsDataURL(file);
  }

  async function sendRequest() {
    const input = document.getElementById('main-surface-input');
    const send = document.getElementById('main-send');
    const prompt = input ? input.value.trim() : '';
    if (!prompt || state.busy) return;
    setComposerNotice('');
    state.busy = true;
    if (send) send.disabled = true;
    setTrayCollapsed(true);
    hideResult();
    const metadata = requestMetadata();
    showThread(prompt, 'Submitting', 'NAgex is starting from Main.', 'Your request is being classified before any execution path is chosen.', [
      { state: 'done', label: 'Request captured', detail: metadata.preferredMode },
      { state: 'running', label: 'Classify intent', detail: metadata.allowWebResearch ? 'Web allowed' : 'Web off' },
      { state: 'pending', label: 'Prepare result', detail: '' },
    ]);
    try {
      await dispatchMainRequest(prompt, metadata);
      if (input) input.value = '';
    } finally {
      state.busy = false;
      if (send) send.disabled = false;
    }
  }

  async function classifyInput(prompt, metadata) {
    const result = await api('/api/v1/workspace/route-input', {
      method: 'POST',
      body: JSON.stringify({ text: prompt, hasFile: state.attachments.length > 0, requestMetadata: metadata }),
    });
    if (!result || result.error) {
      return { error: result && result.error ? result.error : { message: 'Intent routing is unavailable.' } };
    }
    return result.data || result;
  }

  async function dispatchMainRequest(prompt, metadata) {
    const route = await classifyInput(prompt, metadata);
    if (route.error) {
      showThread(prompt, 'Error', 'NAgex could not classify the request', route.error.message || 'Intent routing is unavailable.', [
        { state: 'done', label: 'Request captured', detail: metadata.preferredMode },
        { state: 'running', label: 'Intent routing failed', detail: route.error.code || '' },
      ]);
      return;
    }
    const routeDetail = [route.primaryIntent, route.confidence != null ? Math.round(Number(route.confidence) * 100) + '%' : ''].filter(Boolean).join(' - ');
    const steps = [
      { state: 'done', label: 'Request captured', detail: metadata.preferredMode },
      { state: 'done', label: 'Intent classified', detail: routeDetail },
      { state: 'running', label: 'Run selected path', detail: route.reason || '' },
    ];
    setStep(steps);

    if (route.primaryIntent === 'LINK_CAPTURE' || route.primaryIntent === 'CAPTURE') {
      await captureInput(prompt, route);
      return;
    }

    if (state.revisionTarget && metadata.preferredArtifactType === 'DOCUMENT') {
      await reviseDocument(prompt, metadata, state.revisionTarget);
    } else if (metadata.preferredArtifactType === 'DOCUMENT') {
      await createDocument(prompt, metadata);
    } else if (metadata.preferredArtifactType === 'IMAGE') {
      await createImage(prompt, metadata);
    } else if (metadata.preferredCapability === 'RESEARCH') {
      await runResearch(prompt, metadata);
    } else if (metadata.preferredCapability === 'PLAN' || route.primaryIntent === 'COMMAND') {
      await runPlan(prompt, metadata, route);
    } else if (metadata.preferredCapability === 'CAPABILITY_AUDIT') {
      showModeCapabilityMatrix(prompt);
    } else {
      await runAnswer(prompt, metadata, route);
    }
  }

  async function captureInput(prompt, route) {
    const result = await api('/api/v1/workspace/capture', {
      method: 'POST',
      body: JSON.stringify({
        type: route.primaryIntent === 'LINK_CAPTURE' ? 'LINK' : 'TEXT',
        content: route.normalizedPayload && route.normalizedPayload.cleanText ? route.normalizedPayload.cleanText : prompt,
        source: 'WEB',
      }),
    });
    if (!result || result.error) {
      showThread(prompt, 'Error', 'Capture could not be saved', (result && result.error && result.error.message) || 'The workspace capture endpoint did not save this request.', [
        { state: 'done', label: 'Intent classified', detail: route.primaryIntent },
        { state: 'running', label: 'Capture failed', detail: '' },
      ]);
      return;
    }
    showThread(prompt, 'Saved', 'Saved to Inbox', 'The request was stored through the real workspace capture pipeline.', [
      { state: 'done', label: 'Intent classified', detail: route.primaryIntent },
      { state: 'done', label: 'Capture persisted', detail: result.captureId || result.itemId || '' },
    ]);
  }

  async function runAnswer(prompt, metadata, route) {
    const result = await api('/api/v1/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: prompt, requestMetadata: metadata }),
      timeoutMs: 120000,
    });
    if (!result || result.error) {
      showThread(prompt, 'Unavailable', 'Answer is unavailable', (result && result.error && result.error.message) || 'The answer provider did not return a usable response.', [
        { state: 'done', label: 'Intent classified', detail: route.primaryIntent || 'ASK' },
        { state: 'running', label: 'Answer unavailable', detail: result && result.error && result.error.code ? result.error.code : '' },
      ]);
      return;
    }
    const answer = (result.data && result.data.message) || result.message || '';
    showThread(prompt, 'Answered', 'NAgex answered inline', answer || 'NAgex returned an empty answer.', [
      { state: 'done', label: 'Intent classified', detail: route.primaryIntent || 'ASK' },
      { state: 'done', label: 'Answer prepared', detail: (result.data && result.data.messageId) || result.requestId || '' },
    ]);
    renderInlineActions([
      { id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') },
      { id: 'save', label: 'Save to Vault', action: () => saveTextToVault(answer || prompt) },
    ]);
  }

  async function createDocument(prompt, metadata) {
    const result = await api('/api/v1/creations/documents', {
      method: 'POST',
      body: JSON.stringify({ prompt, requestMetadata: metadata }),
    });
    if (!result || result.error) {
      showThread(prompt, 'Error', 'Document could not be created', (result && result.error && result.error.message) || 'No document result is available.', [
        { state: 'done', label: 'Request captured', detail: 'Document' },
        { state: 'running', label: 'Creation failed', detail: '' },
      ]);
      return;
    }
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const documentId = result.documentId || result.creationId || parseDocumentId(result.openTarget || (projection && projection.openTarget));
    showThread(prompt, 'Completed', 'Document created', 'The result is ready in the right panel. You can revise it or open the detailed viewer.', [
      { state: 'done', label: 'Request captured', detail: 'Document' },
      { state: 'done', label: 'Document generated', detail: result.creationId || result.documentId || '' },
      { state: 'done', label: 'Result panel opened', detail: result.artifactId || '' },
    ]);
    showResult({
      type: 'DOCUMENT',
      title: result.title || (projection && projection.title) || 'Generated document',
      meta: [result.format || 'DOCX', result.artifactId ? 'artifact ready' : 'artifact unavailable'].join(' - '),
      preview: result.content || (projection && projection.preview) || 'The document was created, but no inline preview is available.',
      artifactId: result.artifactId,
      documentId,
      openTarget: result.openTarget,
      projection,
    });
  }

  async function createImage(prompt, metadata) {
    const result = await api('/api/v1/creations/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        type: 'IMAGE',
        creationKind: 'IMAGE',
        recipe: { type: 'IMAGE', aspectRatio: '1:1', locale: 'ko' },
        requestMetadata: metadata,
      }),
      timeoutMs: 120000,
    });
    if (!result || result.error || result.status === 'FAILED' || result.status === 'UNAVAILABLE') {
      showThread(prompt, 'Unavailable', 'Image generation is unavailable', (result && (result.message || result.errorMessage)) || (result && result.error && result.error.message) || 'No configured image provider produced a real image.', [
        { state: 'done', label: 'Request captured', detail: 'Image' },
        { state: 'running', label: 'Image provider unavailable', detail: (result && (result.error || result.errorCode || result.status)) || '' },
      ]);
      return;
    }
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const imageUrl = result.imageUrl || result.outputAssetUrl || result.openTarget || (projection && projection.openTarget);
    showThread(prompt, 'Completed', 'Image created', 'The image result is ready in the right panel.', [
      { state: 'done', label: 'Request captured', detail: 'Image' },
      { state: 'done', label: 'Image generated', detail: result.creationId || '' },
      { state: 'done', label: 'Result panel opened', detail: result.artifactId || '' },
    ]);
    showResult({
      type: 'IMAGE',
      title: result.title || (projection && projection.title) || 'Generated image',
      meta: [result.mimeType || 'image/png', result.artifactId ? 'artifact ready' : 'artifact unavailable'].join(' - '),
      preview: result.prompt || prompt,
      imageUrl,
      artifactId: result.artifactId,
      openTarget: result.openTarget || imageUrl,
      projection,
    });
  }

  async function reviseDocument(prompt, metadata, target) {
    const result = await api('/api/v1/creations/documents/' + encodeURIComponent(target.documentId) + '/revisions', {
      method: 'POST',
      body: JSON.stringify({ instruction: prompt, requestMetadata: metadata }),
    });
    if (!result || result.error || result.ok === false) {
      showThread(prompt, 'Error', 'Document revision could not be created', (result && result.message) || (result && result.error && result.error.message) || 'The document revision endpoint did not create a revision.', [
        { state: 'done', label: 'Revision target selected', detail: target.documentId },
        { state: 'running', label: 'Revision failed', detail: '' },
      ]);
      return;
    }
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const documentId = result.documentId || result.creationId || parseDocumentId(result.openTarget || (projection && projection.openTarget)) || target.documentId;
    state.revisionTarget = null;
    showThread(prompt, 'Completed', 'Document revised', 'The revised artifact is ready in the right panel.', [
      { state: 'done', label: 'Revision target selected', detail: target.documentId },
      { state: 'done', label: 'Revision created', detail: documentId },
      { state: 'done', label: 'Result panel updated', detail: result.artifactId || '' },
    ]);
    showResult({
      type: 'DOCUMENT',
      title: result.title || (projection && projection.title) || target.title || 'Revised document',
      meta: [result.format || 'DOCX', 'revision ready'].join(' - '),
      preview: result.content || (projection && projection.preview) || 'The document revision was created, but no inline preview is available.',
      artifactId: result.artifactId || target.artifactId,
      documentId,
      openTarget: result.openTarget || (projection && projection.openTarget),
      projection,
    });
  }

  async function runResearch(prompt, metadata) {
    const result = await api('/api/v1/research', {
      method: 'POST',
      body: JSON.stringify({ query: prompt, requestMetadata: metadata }),
    });
    if (!result || result.error || result.status) {
      showThread(prompt, 'Unavailable', 'Research is unavailable', (result && result.error && result.error.message) || 'No verified research result is available from the current providers.', [
        { state: 'done', label: 'Request captured', detail: 'Research' },
        { state: 'running', label: 'Research unavailable', detail: result && result.status ? result.status : '' },
      ]);
      return;
    }
    showThread(prompt, 'Completed', 'Research result', result.answer || 'Research completed.', [
      { state: 'done', label: 'Request captured', detail: 'Research' },
      { state: 'done', label: 'Sources checked', detail: Array.isArray(result.sources) ? String(result.sources.length) : '' },
      { state: 'done', label: 'Answer prepared', detail: '' },
    ]);
    renderInlineActions([
      { id: 'follow', label: 'Ask follow-up', action: () => focusComposer(result.answer || '') },
      { id: 'report', label: 'Create report', action: () => { state.mode = 'DOCUMENT'; renderModes(); focusComposer(prompt); } },
      { id: 'save', label: 'Save to Vault', action: () => saveTextToVault(result.answer || prompt) },
    ]);
  }

  async function runPlan(prompt, metadata, route) {
    const result = await api('/api/v1/ambient/intent', {
      method: 'POST',
      body: JSON.stringify({ prompt, requestMetadata: metadata }),
      timeoutMs: 120000,
    });
    if (!result || result.error || !result.plan) {
      showThread(prompt, 'Error', 'NAgex could not prepare a plan', (result && result.error && result.error.message) || 'The planner did not return a usable plan.', [
        { state: 'done', label: 'Intent classified', detail: route && route.primaryIntent ? route.primaryIntent : metadata.preferredMode },
        { state: 'running', label: 'Planning failed', detail: '' },
      ]);
      return;
    }
    const steps = (result.plan.steps || []).slice(0, 6).map((step, index) => ({
      state: index === 0 ? 'done' : index === 1 ? 'running' : 'pending',
      label: step.title || ('Step ' + (index + 1)),
      detail: step.requiresApproval ? 'Approval needed before execution' : (step.resolvedToolId || ''),
    }));
    showThread(prompt, 'Plan ready', result.plan.summary || 'NAgex prepared a plan.', 'Review the plan inline. Required approvals remain mandatory and cannot be bypassed here.', steps);
    renderInlineActions([
      { id: 'show-plan', label: 'Show plan', action: () => setStep((result.plan.steps || []).map((step, index) => ({ state: index === 0 ? 'running' : 'pending', label: step.title || ('Step ' + (index + 1)), detail: step.reasoning || '' }))) },
    ]);
  }

  function showModeCapabilityMatrix(prompt) {
    const enabled = MODES.filter((mode) => mode.enabled && mode.id !== 'MORE').map((mode) => `${mode.label}: ${mode.support}`).join(' / ');
    const unavailable = MODES.filter((mode) => !mode.enabled).map((mode) => `${mode.label}: ${mode.reason}`).join(' ');
    showThread(prompt, 'Ready', 'Main mode capability audit', 'Supported modes route to real execution. Unsupported modes stay disabled until their canonical route can produce a verified result.', [
      { state: 'done', label: 'Enabled modes', detail: enabled },
      { state: 'pending', label: 'Not enabled', detail: unavailable },
    ]);
    renderInlineActions([
      { id: 'ask', label: 'Ask', action: () => selectMode('ASK') },
      { id: 'research', label: 'Research', action: () => selectMode('RESEARCH') },
      { id: 'document', label: 'Document', action: () => selectMode('DOCUMENT') },
      { id: 'image', label: 'Image', action: () => selectMode('IMAGE') },
    ]);
  }

  function selectMode(modeId) {
    const mode = MODES.find((m) => m.id === modeId);
    if (!mode || !mode.enabled) return;
    state.mode = mode.id;
    renderModes();
    focusComposer('');
  }

  function renderInlineActions(actions) {
    const el = document.getElementById('main-inline-actions');
    if (!el) return;
    el.innerHTML = '';
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.id === 'cancel' ? 'btn-secondary danger' : 'btn-secondary';
      btn.textContent = action.label;
      btn.addEventListener('click', action.action);
      el.appendChild(btn);
    });
  }

  function focusComposer(seed) {
    const input = document.getElementById('main-surface-input');
    if (!input) return;
    if (seed && !input.value) input.value = seed;
    input.focus();
    autoGrow(input);
  }

  function setVoiceState(next, detail) {
    state.voiceState = next;
    const root = document.getElementById('nagex-main-surface');
    const mic = document.getElementById('main-mic');
    const voice = document.getElementById('main-voice');
    const status = document.getElementById('main-voice-status');
    if (root) root.dataset.voiceState = next;
    if (mic) mic.setAttribute('aria-pressed', String(state.voiceMode === 'DICTATION' && next === 'LISTENING'));
    if (voice) voice.setAttribute('aria-pressed', String(state.voiceMode === 'SESSION' && (next === 'VOICE_SESSION_ACTIVE' || next === 'LISTENING' || next === 'TRANSCRIBING')));
    if (status) status.textContent = detail || next.replace(/_/g, ' ').toLowerCase();
  }

  function userVoiceStatus(detail, fallback) {
    const value = String(detail || '').toLowerCase();
    if (value === 'no-speech' || value === 'no_transcript') return 'Try again';
    if (value.includes('permission') || value === 'notallowederror') return 'Permission needed';
    if (value.includes('network')) return 'Unavailable';
    return fallback || 'Voice ready';
  }

  function userVoiceFailureMessage(result) {
    if (!result) return 'Voice input did not start. Try again or type your request.';
    if (result.state === 'PERMISSION_DENIED') {
      return 'Microphone permission is blocked. Enable microphone access in the browser and try again.';
    }
    if (result.state === 'UNAVAILABLE') {
      return 'Voice input is unavailable in this browser. You can type your request or try a supported browser.';
    }
    if (result.reason === 'no-speech' || result.reason === 'NO_TRANSCRIPT') {
      return "I didn't catch that. Try again or type your request.";
    }
    if (result.reason === 'SPEECH_RECOGNITION_NETWORK') {
      return 'Speech recognition is unavailable right now. Try again or type your request.';
    }
    return 'Voice input failed. Try again or type your request.';
  }

  async function startVoiceRecognition(mode) {
    if (state.voiceAdapter && state.voiceAdapter.isActive()) {
      await state.voiceAdapter.cancel();
      state.voiceMode = null;
      return;
    }
    if (!window.NAGEX_RENDERER_VOICE || !window.NAGEX_RENDERER_VOICE.RendererVoiceAdapter) {
      setVoiceState('ERROR', 'Unavailable');
      setComposerNotice('Voice input is unavailable in this browser. You can type your request or try a supported browser.', 'error');
      return;
    }
    setComposerNotice('');
    const input = document.getElementById('main-surface-input');
    if (input) input.dataset.voiceBase = input.value.trim();
    state.voiceMode = mode;
    state.voiceAdapter = new window.NAGEX_RENDERER_VOICE.RendererVoiceAdapter({
      onDiagnostic: (diagnostic) => {
        window.__NAGEX_LAST_MAIN_VOICE_EVENT = diagnostic && diagnostic.event ? diagnostic.event : null;
      },
      onStateChange: ({ state: nextState, detail }) => {
        const map = {
          REQUESTING_PERMISSION: 'REQUESTING',
          LISTENING: mode === 'SESSION' ? 'VOICE_SESSION_ACTIVE' : 'LISTENING',
          TRANSCRIBING: 'TRANSCRIBING',
          COMPLETED: mode === 'SESSION' ? 'VOICE_SESSION_ACTIVE' : 'IDLE',
          CANCELLED: 'IDLE',
          PERMISSION_DENIED: 'DENIED',
          UNAVAILABLE: 'ERROR',
          ERROR: 'ERROR',
          IDLE: 'IDLE',
        };
        const label = detail && detail.reason ? userVoiceStatus(detail.reason, undefined) : undefined;
        setVoiceState(map[nextState] || nextState, label);
      },
      onTranscript: ({ finalTranscript, interimTranscript }) => {
        const current = document.getElementById('main-surface-input');
        if (!current) return;
        const hasVoiceBase = Object.prototype.hasOwnProperty.call(current.dataset, 'voiceBase');
        const base = hasVoiceBase ? current.dataset.voiceBase : current.value;
        current.value = [base, finalTranscript, interimTranscript].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if ((finalTranscript || interimTranscript) && current.value) setComposerNotice('');
        autoGrow(current);
      },
    });
    const result = await state.voiceAdapter.start({
      lang: 'ko-KR',
      continuous: mode === 'SESSION',
      session: {
        mode,
        activeResultArtifactId: state.result && state.result.artifactId ? state.result.artifactId : null,
        activeDocumentId: state.result && state.result.documentId ? state.result.documentId : null,
        revisionTarget: state.revisionTarget,
      },
    });
    if (input) delete input.dataset.voiceBase;
    state.voiceMode = null;
    if (result.state === 'COMPLETED' && result.transcript) {
      setComposerNotice('');
      setVoiceState('IDLE', mode === 'SESSION' ? 'voice ready' : 'dictation ready');
      return;
    }
    if (result.state === 'CANCELLED') {
      setVoiceState('IDLE', result.reason === 'no-speech' || result.reason === 'NO_TRANSCRIPT' ? 'Try again' : 'cancelled');
      if (result.reason === 'no-speech' || result.reason === 'NO_TRANSCRIPT') {
        setComposerNotice(userVoiceFailureMessage(result), 'warning');
      }
      return;
    }
    if (result.state === 'PERMISSION_DENIED' || result.state === 'UNAVAILABLE' || result.state === 'ERROR') {
      setVoiceState('ERROR', userVoiceStatus(result.reason, 'Unavailable'));
      setComposerNotice(userVoiceFailureMessage(result), 'error');
    }
  }

  async function saveTextToVault(text) {
    const result = await api('/api/v1/workspace/vault', {
      method: 'POST',
      body: JSON.stringify({ title: 'Saved NAgex result', type: 'DOCUMENT', mimeType: 'text/plain', storageRef: 'main-result:' + Date.now(), contentText: text }),
    });
    showThread('Save to Vault', result && !result.error ? 'Saved' : 'Error', result && !result.error ? 'Saved to Vault' : 'Could not save', result && !result.error ? 'The result is now stored in your workspace Vault.' : ((result && result.error && result.error.message) || 'Save failed.'), [
      { state: result && !result.error ? 'done' : 'running', label: 'Save to Vault', detail: result && (result.vaultItemId || result.id || '') },
    ]);
  }

  function showResult(result) {
    state.result = result;
    const root = document.getElementById('nagex-main-surface');
    const panel = document.getElementById('main-result-panel');
    if (root) root.classList.add('has-result');
    if (panel) panel.hidden = false;
    setTrayCollapsed(true);
    const kind = document.getElementById('main-result-kind');
    const title = document.getElementById('main-result-title');
    const meta = document.getElementById('main-result-meta');
    const preview = document.getElementById('main-result-preview');
    const revise = document.getElementById('main-result-revise');
    if (kind) kind.textContent = result.type === 'DOCUMENT' ? 'DOC' : result.type;
    if (title) title.textContent = result.title || 'Result';
    if (meta) meta.textContent = result.meta || '';
    if (preview) {
      if (result.type === 'IMAGE' && result.imageUrl) {
        preview.innerHTML = `<article class="main-doc-page main-image-page"><div><strong>NAgex</strong><br><small>Your Personal AI</small></div><h1>${esc(result.title || 'Generated image')}</h1><img src="${esc(result.imageUrl)}" alt="${esc(result.title || 'Generated image')}" loading="lazy"><p>${esc(result.preview || 'Image artifact')}</p></article>`;
      } else {
        preview.innerHTML = `<article class="main-doc-page"><div><strong>NAgex</strong><br><small>Your Personal AI</small></div><h1>${esc(result.title || 'Generated result')}</h1><p>${esc(result.preview || 'Preview is unavailable for this result.')}</p></article>`;
      }
    }
    if (revise) {
      revise.disabled = !result.documentId;
      revise.title = result.documentId ? 'Create a bounded document revision from Main.' : 'Revision is available only for document artifacts.';
    }
  }

  async function openArtifactResult(artifactId) {
    if (!artifactId) return false;
    const artifact = await api('/api/v1/artifacts/' + encodeURIComponent(artifactId));
    if (!artifact || artifact.error || !artifact.projection) return false;
    const projection = artifact.projection;
    const documentId = parseDocumentId(projection.openTarget);
    let document = null;
    if (documentId) {
      const documentResponse = await api('/api/v1/creations/documents/' + encodeURIComponent(documentId));
      document = documentResponse && documentResponse.document ? documentResponse.document : null;
    }
    showResult({
      type: projection.artifactType || 'ARTIFACT',
      title: projection.title || (document && document.title) || 'Stored artifact',
      meta: [projection.artifactType || 'ARTIFACT', projection.state || 'ready'].filter(Boolean).join(' - '),
      preview: (document && document.content) || projection.preview || 'This artifact has no inline preview.',
      artifactId,
      documentId,
      openTarget: projection.openTarget,
      projection,
    });
    return true;
  }

  function parseDocumentId(openTarget) {
    const match = String(openTarget || '').match(/\/api\/v1\/creations\/documents\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function hideResult() {
    const root = document.getElementById('nagex-main-surface');
    const panel = document.getElementById('main-result-panel');
    if (root) root.classList.remove('has-result');
    if (panel) panel.hidden = true;
    document.body.classList.remove('main-result-fullscreen');
  }

  function openResult() {
    if (!state.result) return;
    if (state.result.artifactId && window.NAGEX && window.NAGEX.openArtifactInCanvas) {
      const p = state.result.projection || {};
      window.NAGEX.openArtifactInCanvas(state.result.artifactId, p.artifactType || state.result.type, p.canvasTarget, state.result.openTarget, p);
    }
  }

  function reviseResult() {
    if (!state.result || !state.result.documentId) return;
    state.mode = 'DOCUMENT';
    state.revisionTarget = {
      documentId: state.result.documentId,
      artifactId: state.result.artifactId || null,
      title: state.result.title || 'Document',
    };
    renderModes();
    focusComposer('');
    showThread('Revision requested', 'Ready', 'Describe the revision', 'Your next Main submission will call the document revision endpoint for the selected artifact.', [
      { state: 'done', label: 'Revision target selected', detail: state.result.documentId },
      { state: 'running', label: 'Waiting for revision instruction', detail: '' },
    ]);
  }

  function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 330) + 'px';
  }

  function bind() {
    document.getElementById('main-mode-row')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-main-mode]');
      if (!btn || btn.disabled) return;
      selectMode(btn.dataset.mainMode);
    });
    document.getElementById('main-mode-row')?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(document.querySelectorAll('#main-mode-row [data-main-mode]')).filter((btn) => !btn.disabled);
      const current = document.activeElement;
      const currentIndex = Math.max(0, buttons.indexOf(current));
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === 'ArrowRight') nextIndex = Math.min(buttons.length - 1, currentIndex + 1);
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      event.preventDefault();
      buttons[nextIndex]?.focus();
    });
    const input = document.getElementById('main-surface-input');
    if (input) input.addEventListener('input', () => autoGrow(input));
    document.getElementById('main-send')?.addEventListener('click', sendRequest);
    document.getElementById('main-mic')?.addEventListener('click', () => startVoiceRecognition('DICTATION'));
    document.getElementById('main-voice')?.addEventListener('click', () => startVoiceRecognition('SESSION'));
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) sendRequest();
    });
    document.getElementById('main-attach')?.addEventListener('click', () => document.getElementById('main-file-input')?.click());
    document.getElementById('main-file-input')?.addEventListener('change', (event) => uploadFile(event.target.files && event.target.files[0]));
    document.getElementById('main-web-toggle')?.addEventListener('click', (event) => {
      state.web = !state.web;
      event.currentTarget.setAttribute('aria-pressed', String(state.web));
    });
    document.getElementById('main-data-toggle')?.addEventListener('click', (event) => {
      state.personalContext = !state.personalContext;
      event.currentTarget.setAttribute('aria-pressed', String(state.personalContext));
    });
    document.getElementById('main-plan-toggle')?.addEventListener('click', (event) => {
      state.planPreview = !state.planPreview;
      event.currentTarget.setAttribute('aria-pressed', String(state.planPreview));
    });
    document.getElementById('main-attachment-list')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-remove-attachment]');
      if (!btn) return;
      state.attachments.splice(Number(btn.dataset.removeAttachment), 1);
      renderAttachments();
    });
    document.getElementById('main-result-close')?.addEventListener('click', hideResult);
    document.getElementById('main-result-expand')?.addEventListener('click', () => document.body.classList.toggle('main-result-fullscreen'));
    document.getElementById('main-result-open')?.addEventListener('click', openResult);
    document.getElementById('main-result-revise')?.addEventListener('click', reviseResult);
  }

  async function renderAttentionCenter() {
    const pop = document.getElementById('attention-popover');
    if (!pop) return;
    const [approvals, tasks, activity, notifications] = await Promise.all([
      api('/api/v1/approvals'), api('/api/v1/tasks'), api('/api/v1/activity'), api('/api/v1/notifications'),
    ]);
    const rows = [
      ...((approvals && approvals.pending) || []).map((a) => ({ label: a.intent || 'Approval needed', target: 'tab-inbox' })),
      ...((tasks && tasks.tasks) || []).filter((t) => t.status === 'RUNNING').map((t) => ({ label: t.name || 'Running task', target: 'tab-inbox' })),
      ...((activity && activity.activities) || []).slice(0, 3).map((a) => ({ label: a.title || 'Recent result', target: 'tab-executions' })),
      ...((notifications && notifications.notifications) || []).filter((n) => !n.readAt).slice(0, 3).map((n) => ({ label: n.title || 'Notification', target: 'tab-inbox' })),
    ];
    pop.innerHTML = `<h2>Attention Center</h2>${rows.length ? rows.map((r) => `<button type="button" class="main-attention-row" data-target="${esc(r.target)}">${esc(r.label)}</button>`).join('') : '<p>Nothing needs attention right now.</p>'}`;
    pop.hidden = false;
  }

  function wireAttentionBell() {
    const bell = document.getElementById('btn-notif-bell');
    if (!bell || bell.dataset.mainWired) return;
    bell.dataset.mainWired = 'true';
    bell.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pop = document.getElementById('attention-popover');
      if (pop && !pop.hidden) { pop.hidden = true; return; }
      renderAttentionCenter();
    }, true);
    document.getElementById('attention-popover')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-target]');
      if (row && window.NAGEX && window.NAGEX.switchTab) window.NAGEX.switchTab(row.dataset.target);
    });
  }

  function rebuildHome() {
    const view = document.getElementById('view-home');
    if (!view || view.dataset.mainSurface === '1') return;
    view.dataset.mainSurface = '1';
    view.className = 'tab-view active-view';
    view.innerHTML = template();
    renderModes();
    bind();
    wireAttentionBell();
    window.NAGEX_MAIN_SURFACE = Object.freeze({
      openArtifactResult,
      getControlMatrix: () => [
        ['main-mode-row', 'mode chips', 'Main', 'click', 'requestMetadata/preferredMode', 'metadata changes', 'selected chip', 'disabled if unavailable', 'per request', 'auth inherited'],
        ['main-send', 'send', 'Main', 'click', 'ambient/research/creation APIs', 'goal/result created where supported', 'inline progress/result', 'inline error', 'server stores', 'session'],
        ['main-attach', 'attach', 'Main', 'click/change', '/api/v1/workspace/upload', 'capture persisted', 'attachment chip', 'inline error', 'CaptureStore', 'session/owner'],
        ['main-web-toggle', 'web toggle', 'Main', 'click', 'requestMetadata.allowWebResearch', 'metadata changes', 'pressed state', 'n/a', 'per request', 'SSRF policy server-side'],
        ['main-data-toggle', 'my data toggle', 'Main', 'click', 'requestMetadata.usePersonalContext', 'metadata changes', 'pressed state', 'n/a', 'per request', 'consent/owner'],
        ['main-mic', 'microphone dictation', 'Main', 'click', 'Browser SpeechRecognition + microphone permission', 'transcript inserted into composer', 'composer text updated', 'permission/unavailable guidance', 'per request', 'browser permission'],
        ['main-voice', 'voice session', 'Main', 'click', 'Browser SpeechRecognition -> Main composer', 'recognized speech becomes editable text', 'composer text updated', 'permission/unavailable guidance', 'per request', 'same Main authority rules'],
        ['btn-notif-bell', 'bell', 'Header', 'click', 'tasks/approvals/activity/notifications APIs', 'none', 'attention center', 'empty state', 'server stores', 'session'],
        ['main-result-open', 'open result', 'Result', 'click', 'openArtifactInCanvas', 'route/detail view', 'artifact opens', 'unavailable if missing', 'artifact store', 'owner gate'],
        ['main-result-expand', 'expand result', 'Result', 'click', 'UI state', 'fullscreen class', 'large viewer', 'n/a', 'session UI', 'n/a'],
        ['main-result-close', 'close result', 'Result', 'click', 'UI state', 'panel hidden', 'Main restored', 'n/a', 'session UI', 'n/a'],
        ['main-result-revise', 'revise', 'Result', 'click', '/api/v1/creations/documents/:id/revisions', 'document revision created', 'result panel updated', 'disabled if no document target', 'DocumentStore/ArtifactStore', 'owner gate'],
      ],
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rebuildHome);
  else rebuildHome();
  window.addEventListener('hashchange', () => {
    if ((window.location.hash || '#home').startsWith('#home')) setTimeout(rebuildHome, 0);
  });
})();
