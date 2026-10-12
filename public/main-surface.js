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
    sessionChecked: false,
    briefingExpandedInConversation: false,
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
              <h1 id="main-greeting"></h1>
              <p id="main-greeting-sub"></p>
            </div>
            <p class="main-quote">"<span data-i18n="mainText.Small_steps_every_day_create_a_bigger_tomorrow">Small steps every day create a bigger tomorrow.</span>"</p>
          </div>
          <section class="main-composer-card" aria-label="Main NAgex request composer" data-i18n-aria-label="mainText.Main_NAgex_request_composer">
            <div class="main-mode-row" id="main-mode-row"></div>
            <div class="main-input-wrap">
              <textarea id="main-surface-input" placeholder="Ask NAgex to research, create, plan, or act..." data-i18n-placeholder="mainText.Ask_NAgex_to_research_create_plan_or_act"></textarea>
              <div class="main-attachment-list" id="main-attachment-list"></div>
              <div class="main-composer-footer">
                <div class="main-left-tools">
                  <button type="button" class="main-tool-btn" id="main-attach" data-i18n="mainText.Attach">Attach</button>
                  <input type="file" id="main-file-input" hidden>
                  <button type="button" class="main-tool-btn main-toggle" id="main-web-toggle" aria-pressed="true" data-i18n="mainText.Web">Web</button>
                  <button type="button" class="main-tool-btn main-toggle" id="main-data-toggle" aria-pressed="false" data-i18n="mainText.My_data">My data</button>
                </div>
                <div class="main-right-tools">
                  <button type="button" class="main-mic-btn" id="main-mic" title="Dictate into the Main composer">
                    <span aria-hidden="true" class="main-voice-mic"></span>
                    <span class="nagex-sr-only" data-i18n="mainText.Microphone_dictation">Microphone dictation</span>
                  </button>
                  <button type="button" class="main-voice-btn" id="main-voice" title="Start NAgex voice mode" data-i18n-title="mainText.Start_NAgex_voice_mode">
                    <span aria-hidden="true" class="main-voice-dot"></span>
                    <span data-i18n="mainText.Voice">Voice</span>
                  </button>
                  <span class="main-voice-status" id="main-voice-status">Idle</span>
                  <button type="button" class="main-tool-btn" id="main-voice-cancel" data-i18n="mainText.Cancel" hidden>Cancel</button>
                  <button type="button" class="main-tool-btn main-toggle" id="main-plan-toggle" aria-pressed="true" data-i18n="mainText.Show_plan_before_actions">Show plan before actions</button>
                  <button type="button" class="main-send" id="main-send" aria-label="Send request" data-i18n-aria-label="mainText.Send_request">></button>
                </div>
              </div>
              <div class="main-composer-notice" id="main-composer-notice" role="status" aria-live="polite" hidden></div>
            </div>
          </section>
          <section class="main-home-briefing" id="main-home-briefing" aria-label="Personal briefing" data-state="idle" hidden>
            <div class="main-briefing-grid">
              <article class="main-briefing-card" data-briefing-section="today"><h2 id="main-briefing-title-today">Today</h2><div class="main-briefing-body" id="main-briefing-today"></div></article>
              <article class="main-briefing-card" data-briefing-section="since"><h2 id="main-briefing-title-since">Since Yesterday</h2><div class="main-briefing-body" id="main-briefing-since"></div></article>
              <article class="main-briefing-card" data-briefing-section="suggestions"><h2 id="main-briefing-title-suggestions">Suggestions</h2><div class="main-briefing-body" id="main-briefing-suggestions"></div></article>
            </div>
            <button type="button" class="main-tool-btn main-briefing-retry" id="main-briefing-retry" hidden>Try again</button>
          </section>
          <section class="main-thread-card" id="main-thread-card" hidden>
            <div class="main-thread-tools"><button type="button" class="main-tool-btn" id="main-toggle-briefing" aria-controls="main-home-briefing" aria-expanded="false">My Day</button><button type="button" class="main-tool-btn" id="main-new-conversation">New conversation</button></div>
            <div class="main-message">
              <span class="main-avatar" id="main-user-avatar">U</span>
              <div>
                <div class="main-message-meta"><strong id="main-user-name">You</strong><span id="main-request-time">Just now</span></div>
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
        <aside class="main-result-panel" id="main-result-panel" hidden aria-label="Result panel" data-i18n-aria-label="mainText.Result_panel">
          <div class="main-result-header">
            <div class="main-result-file-icon" id="main-result-kind">DOC</div>
            <div class="main-result-title-group">
              <h2 id="main-result-title">Result</h2>
              <p id="main-result-meta">Ready</p>
            </div>
            <button type="button" class="main-result-icon-btn" id="main-result-close" aria-label="Close result" data-i18n-aria-label="mainText.Close_result">x</button>
          </div>
          <div class="main-result-tabs">
            <button type="button" class="active" data-i18n="mainText.Preview">Preview</button>
            <button type="button" id="main-result-sources" data-i18n="mainText.Sources" disabled>Sources</button>
            <button type="button" id="main-result-versions" data-i18n="mainText.Versions" disabled>Versions</button>
            <button type="button" class="main-result-expand" id="main-result-expand" data-i18n="mainText.Expand">Expand</button>
          </div>
          <div class="main-result-preview" id="main-result-preview"></div>
          <div class="main-result-footer">
            <button type="button" class="btn-secondary" id="main-result-download" data-i18n="mainText.Download" disabled>Download</button>
            <button type="button" class="btn-secondary" id="main-result-open" data-i18n="mainText.Open">Open</button>
            <button type="button" class="btn-primary" id="main-result-revise" data-i18n="mainText.Revise">Revise</button>
          </div>
        </aside>
      </div>
    `;
  }

  function renderModes() {
    const row = document.getElementById('main-mode-row');
    if (!row) return;
    row.setAttribute('role', 'toolbar');
    row.setAttribute('aria-label', mt('Main execution modes'));
    row.innerHTML = MODES.map((mode) => `
      <button type="button" class="main-mode-chip" data-main-mode="${esc(mode.id)}" data-support="${esc(mode.support)}" aria-pressed="${mode.id === state.mode ? 'true' : 'false'}" aria-disabled="${mode.enabled ? 'false' : 'true'}" ${mode.enabled ? '' : 'disabled title="' + esc(mt(mode.reason)) + '"'}>
        ${esc(mt(mode.label))}
      </button>
    `).join('');
  }

  function setStep(items) {
    const list = document.getElementById('main-step-list');
    if (!list) return;
    list.innerHTML = items.map((item) => `
      <li class="${esc(item.state)}"><span class="main-step-dot">${item.state === 'done' ? '✓' : ''}</span><span>${esc(localizeAppText(item.label))}</span><small>${esc(localizeAppText(item.detail || ''))}</small></li>
    `).join('');
  }

  function showThread(prompt, status, title, summary, steps) {
    const card = document.getElementById('main-thread-card');
    if (card) card.hidden = false;
    const promptEl = document.getElementById('main-request-text');
    if (promptEl) promptEl.textContent = prompt;
    const statusEl = document.getElementById('main-status');
    if (statusEl) { statusEl.textContent = localizeAppText(status); statusEl.dataset.status = status; }
    const titleEl = document.getElementById('main-work-title');
    if (titleEl) titleEl.textContent = localizeAppText(title);
    const summaryEl = document.getElementById('main-work-summary');
    if (summaryEl) summaryEl.textContent = localizeAppText(summary);
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
    notice.textContent = localizeAppText(message);
  }

  // Inline prompt inside the composer notice: message plus choices. Used for voice-processing consent.
  function setComposerPrompt(message, actions) {
    const notice = document.getElementById('main-composer-notice');
    if (!notice) return;
    notice.hidden = false;
    notice.dataset.tone = 'consent';
    notice.textContent = '';
    const text = document.createElement('span');
    text.textContent = localizeAppText(message);
    notice.appendChild(text);
    const row = document.createElement('div');
    row.className = 'main-notice-actions';
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'main-tool-btn';
      btn.textContent = localizeAppText(action.label);
      btn.addEventListener('click', action.action);
      row.appendChild(btn);
    });
    notice.appendChild(row);
  }

  function renderAttachments() {
    const el = document.getElementById('main-attachment-list');
    if (!el) return;
    el.innerHTML = state.attachments.map((a, index) => `
      <span class="main-attachment-chip">${esc(a.filename || a.title || mt('Attachment'))} <button type="button" data-remove-attachment="${index}" aria-label="${esc(mt('Remove attachment'))}">x</button></span>
    `).join('');
  }

  async function uploadFile(file) {
    if (!file || state.busy) return;
    setComposerNotice('');
    showThread(mt('Attachment upload'), 'Uploading', 'Adding attachment', 'NAgex is storing this file through the real workspace upload pipeline.', [
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
        showThread(mt('Attachment upload'), 'Ready', 'Attachment added', 'The file is persisted and will be referenced by the next request.', [
          { state: 'done', label: 'Upload file', detail: result.captureId || file.name },
        ]);
      } else {
        showThread(mt('Attachment upload'), 'Error', 'Attachment failed', (result && result.error && result.error.message) || 'The file could not be uploaded.', [
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
      label: step.title || (mt('Step') + ' ' + (index + 1)),
      detail: step.requiresApproval ? 'Approval needed before execution' : (step.resolvedToolId || ''),
    }));
    showThread(prompt, 'Plan ready', result.plan.summary || 'NAgex prepared a plan.', 'Review the plan inline. Required approvals remain mandatory and cannot be bypassed here.', steps);
    renderInlineActions([
      { id: 'show-plan', label: 'Show plan', action: () => setStep((result.plan.steps || []).map((step, index) => ({ state: index === 0 ? 'running' : 'pending', label: step.title || (mt('Step') + ' ' + (index + 1)), detail: step.reasoning || '' }))) },
    ]);
  }

  function showModeCapabilityMatrix(prompt) {
    const enabled = MODES.filter((mode) => mode.enabled && mode.id !== 'MORE').map((mode) => `${mt(mode.label)}: ${mt(mode.support)}`).join(' / ');
    const unavailable = MODES.filter((mode) => !mode.enabled).map((mode) => `${mt(mode.label)}: ${mt(mode.reason)}`).join(' ');
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
      btn.textContent = localizeAppText(action.label);
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
    if (status) status.textContent = mt(detail || next.replace(/_/g, ' ').toLowerCase());
    const recording = next === 'REQUESTING' || next === 'LISTENING' || next === 'TRANSCRIBING' || next === 'VOICE_SESSION_ACTIVE';
    const cancel = document.getElementById('main-voice-cancel');
    if (cancel) cancel.hidden = !recording;
    if (mic) mic.title = recording && state.voiceMode === 'DICTATION' ? mt('Stop and transcribe') : mt('Dictate into the Main composer');
  }

  function userVoiceStatus(detail, fallback) {
    const value = String(detail || '').toLowerCase();
    if (value === 'no-speech' || value === 'no_transcript') return 'Try again';
    if (value === 'consent_required') return 'Needs your OK';
    if (value.includes('permission') || value === 'notallowederror') return 'Permission needed';
    if (value.includes('network')) return 'Unavailable';
    return fallback || 'Voice ready';
  }

  function userVoiceFailureMessage(result) {
    if (!result) return 'Voice input did not start. Try again or type your request.';
    if (result.state === 'PERMISSION_DENIED') {
      return 'Microphone permission is blocked. Enable microphone access in the browser and try again.';
    }
    if (result.reason === 'DESKTOP_RUNTIME_NO_STT') {
      return 'Voice input is not available in the desktop app yet. You can type your request.';
    }
    if (result.reason === 'PROVIDER_UNKNOWN') {
      return "Voice input is off because this browser's speech service can't be identified. You can type your request.";
    }
    if (result.reason === 'LOCAL_PROCESSING_NOT_VERIFIED') {
      return "This browser couldn't confirm on-device speech recognition, so voice input is off. You can type your request.";
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

  function voiceProcessorNotice(processor) {
    if (!processor) return '';
    if (processor.kind === 'LOCAL') return 'Listening on this device. Your audio is not sent anywhere.';
    if (processor.kind === 'THIRD_PARTY') return 'Listening. Your audio is sent to ' + processor.label + ' to be turned into text. Press the microphone to stop, or Cancel to discard.';
    return '';
  }

  function showVoiceConsentPrompt(processor, mode) {
    const consent = window.NAGEX_RENDERER_VOICE.consent;
    const browserName = processor.provider === 'microsoft' ? 'Edge' : 'Chrome';
    const actions = [];
    if (processor.localInstallable) {
      actions.push({
        label: 'Install on-device speech',
        action: async () => {
          setComposerNotice('Downloading the on-device speech model. No audio is sent.', 'info');
          const installed = await window.NAGEX_RENDERER_VOICE.installLocalModel('ko-KR');
          if (installed) setComposerNotice('On-device speech is ready. Press the microphone to start.', 'info');
          else setComposerNotice('On-device speech could not be installed. You can allow ' + processor.label + ' speech or type your request.', 'warning');
        },
      });
    }
    actions.push({
      label: 'Allow ' + processor.label + ' speech',
      action: () => {
        consent.grant(processor.consentKey);
        setComposerNotice('');
        startVoiceRecognition(mode);
      },
    });
    actions.push({
      label: 'Type instead',
      action: () => {
        setComposerNotice('');
        focusComposer();
      },
    });
    setComposerPrompt(
      'Voice input in ' + browserName + ' sends your audio to ' + processor.label + ' to turn it into text. NAgex only receives the text and never stores the audio. Allow it? You can withdraw this in Settings.',
      actions,
    );
  }

  async function startVoiceRecognition(mode) {
    if (state.voiceAdapter && state.voiceAdapter.isActive()) {
      // second press = stop recording and transcribe what was captured (Cancel discards instead)
      await state.voiceAdapter.stop();
      return;
    }
    if (!window.NAGEX_RENDERER_VOICE || !window.NAGEX_RENDERER_VOICE.RendererVoiceAdapter) {
      setVoiceState('ERROR', 'Unavailable');
      setComposerNotice('Voice input is unavailable in this browser. You can type your request or try a supported browser.', 'error');
      return;
    }
    setComposerNotice('');
    const input = document.getElementById('main-surface-input');
    const voiceBase = input ? input.value.trim() : '';
    if (input) input.dataset.voiceBase = voiceBase;
    state.voiceMode = mode;
    state.voiceAdapter = new window.NAGEX_RENDERER_VOICE.RendererVoiceAdapter({
      onDiagnostic: (diagnostic) => {
        window.__NAGEX_LAST_MAIN_VOICE_EVENT = diagnostic && diagnostic.event ? diagnostic.event : null;
      },
      onProcessor: (processor) => {
        state.voiceProcessor = processor;
      },
      onStateChange: ({ state: nextState, detail }) => {
        const map = {
          REQUESTING_PERMISSION: 'REQUESTING',
          LISTENING: mode === 'SESSION' ? 'VOICE_SESSION_ACTIVE' : 'LISTENING',
          TRANSCRIBING: 'TRANSCRIBING',
          COMPLETED: mode === 'SESSION' ? 'VOICE_SESSION_ACTIVE' : 'IDLE',
          CANCELLED: 'IDLE',
          CONSENT_REQUIRED: 'IDLE',
          PERMISSION_DENIED: 'DENIED',
          UNAVAILABLE: 'ERROR',
          ERROR: 'ERROR',
          IDLE: 'IDLE',
        };
        const label = detail && detail.reason ? userVoiceStatus(detail.reason, undefined) : undefined;
        setVoiceState(map[nextState] || nextState, label);
        if (nextState === 'LISTENING') setComposerNotice(voiceProcessorNotice(state.voiceProcessor), 'info');
      },
      onTranscript: ({ finalTranscript, interimTranscript }) => {
        const current = document.getElementById('main-surface-input');
        if (!current) return;
        const hasVoiceBase = Object.prototype.hasOwnProperty.call(current.dataset, 'voiceBase');
        const base = hasVoiceBase ? current.dataset.voiceBase : current.value;
        current.value = [base, finalTranscript, interimTranscript].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
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
    state.voiceProcessor = null;
    if (result.state === 'COMPLETED' && result.transcript) {
      setComposerNotice('');
      setVoiceState('IDLE', mode === 'SESSION' ? 'voice ready' : 'dictation ready');
      return;
    }
    if (result.state === 'CONSENT_REQUIRED') {
      setVoiceState('IDLE', 'Needs your OK');
      showVoiceConsentPrompt(result.processor, mode);
      return;
    }
    if (result.state === 'CANCELLED') {
      if (result.reason === 'cancelled') {
        // Cancel discards the recording: put the composer back exactly as it was
        if (input) {
          input.value = voiceBase;
          autoGrow(input);
        }
        setComposerNotice('');
        setVoiceState('IDLE', 'cancelled');
        return;
      }
      setVoiceState('IDLE', result.reason === 'no-speech' || result.reason === 'NO_TRANSCRIPT' ? 'Try again' : 'cancelled');
      if (result.reason === 'no-speech' || result.reason === 'NO_TRANSCRIPT') {
        setComposerNotice(userVoiceFailureMessage(result), 'warning');
      } else {
        setComposerNotice('');
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
    showThread(mt('Save to Vault'), result && !result.error ? 'Saved' : 'Error', result && !result.error ? 'Saved to Vault' : 'Could not save', result && !result.error ? 'The result is now stored in your workspace Vault.' : ((result && result.error && result.error.message) || 'Save failed.'), [
      { state: result && !result.error ? 'done' : 'running', label: 'Save to Vault', detail: result && (result.vaultItemId || result.id || '') },
    ]);
  }

  function showResult(result) {
    state.result = result;
    const root = document.getElementById('nagex-main-surface');
    const panel = document.getElementById('main-result-panel');
    if (root) root.classList.add('has-result');
    if (panel) panel.hidden = false;
    const kind = document.getElementById('main-result-kind');
    const title = document.getElementById('main-result-title');
    const meta = document.getElementById('main-result-meta');
    const preview = document.getElementById('main-result-preview');
    const revise = document.getElementById('main-result-revise');
    if (kind) kind.textContent = result.type === 'DOCUMENT' ? 'DOC' : result.type;
    if (title) title.textContent = localizeAppText(result.title || 'Result');
    if (meta) meta.textContent = String(result.meta || '').split(' - ').map(localizeAppText).join(' - ');
    if (preview) {
      if (result.type === 'IMAGE' && result.imageUrl) {
        preview.innerHTML = `<article class="main-doc-page main-image-page"><div><strong>NAgex</strong><br><small>${esc(mt('Your Personal AI'))}</small></div><h1>${esc(localizeAppText(result.title || 'Generated image'))}</h1><img src="${esc(result.imageUrl)}" alt="${esc(localizeAppText(result.title || 'Generated image'))}" loading="lazy"><p>${esc(localizeAppText(result.preview || 'Image artifact'))}</p></article>`;
      } else {
        preview.innerHTML = `<article class="main-doc-page"><div><strong>NAgex</strong><br><small>${esc(mt('Your Personal AI'))}</small></div><h1>${esc(localizeAppText(result.title || 'Generated result'))}</h1><p>${esc(localizeAppText(result.preview || 'Preview is unavailable for this result.'))}</p></article>`;
      }
    }
    if (revise) {
      revise.disabled = !result.documentId;
      revise.title = result.documentId ? mt('Create a bounded document revision from Main.') : mt('Revision is available only for document artifacts.');
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
    document.getElementById('main-voice-cancel')?.addEventListener('click', () => { if (state.voiceAdapter) state.voiceAdapter.cancel(); });
    document.getElementById('main-surface-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.voiceAdapter && state.voiceAdapter.isActive()) {
        event.preventDefault();
        state.voiceAdapter.cancel();
      }
    });
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

  // ── Home personal briefing (Today / Since Yesterday / Suggestions) ───────────────────────────────────────
  // Restored after commit b834803 deleted it. It is shown under the composer only on an empty Home and hidden (never removed)
  // while a conversation or result is active. Data comes only from the existing /api/v1/personal/home aggregation; an
  // unavailable source is stated, never filled in. Visibility is derived from the actual Main session state.
  const FRESH_MARK_KEY = 'nagex_main_fresh_after_v1';
  const briefing = { data: null, status: 'idle', loadedAt: 0, localeListener: false };
  let sessionObserver = null;

  function bt(key, fallback) {
    return window.NAGEX_I18N && window.NAGEX_I18N.t ? window.NAGEX_I18N.t(key, fallback) : fallback;
  }

  // ── Localization of application-generated text ─────────────────────────────────────────────────────────
  // mt(): exact UI/chrome strings (key mainText.<slug>). localizeAppText(): also the server's templated activity and
  // suggestion phrases ("Approval Required: x"), translating only the fixed wording and leaving the embedded user
  // content ("x") and stored records untouched. Text that matches nothing (user content, AI answers) is returned as is.
  function mtSlug(text) {
    return String(text).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  }

  function mt(text) {
    if (text == null || text === '') return text == null ? '' : text;
    const value = String(text);
    const key = 'mainText.' + mtSlug(value);
    const translated = bt(key, value);
    return translated === key ? value : translated;
  }

  const APP_TEXT_PATTERNS = [
    [/^Approval Required: (.+)$/, 'mainPattern.approval_required'],
    [/^Task Blocked: (.+)$/, 'mainPattern.task_blocked'],
    [/^"(.+)" needs your attention$/, 'mainPattern.needs_attention'],
    [/^Action "(.+)" was rejected by user\.$/, 'mainPattern.action_rejected'],
    [/^Could not analyze "(.+)"$/, 'mainPattern.could_not_analyze'],
    [/^Summarized "(.+)"$/, 'mainPattern.summarized'],
    [/^Executed: (.+)$/, 'mainPattern.executed'],
    [/^Created task from suggestion: (.+)$/, 'mainPattern.task_from_suggestion'],
    [/^Suggestion (accepted|dismissed|snoozed|declined|rejected)$/, 'mainPattern.suggestion_decision'],
    [/^Created task "(.+)"$/, 'mainPattern.created_task'],
    [/^Remembered: (.+)$/, 'mainPattern.remembered'],
    [/^Added "(.+)" to knowledge$/, 'mainPattern.added_knowledge'],
    [/^Added "(.+)" to Google Calendar$/, 'mainPattern.added_calendar'],
    [/^Prepare for (.+)$/, 'mainPattern.prepare_for'],
    [/^Follow up: (.+)$/, 'mainPattern.follow_up'],
    [/^Continue: (.+)$/, 'mainPattern.continue_item'],
    [/^Your meeting is in progress now and I found (\d+) related items?\.$/, 'mainPattern.meeting_now_items'],
    [/^Your meeting starts in (\d+) minutes? and I found (\d+) related items?\.$/, 'mainPattern.meeting_soon_items'],
    [/^A related message says: (.*)$/, 'mainPattern.related_message'],
    [/^NAgex prepared an action \((.+)\) that needs your approval\.$/, 'mainPattern.prepared_action'],
    [/^Starts in (\d+) minutes?$/, 'mainPattern.starts_in'],
    [/^Due in (\d+) minutes?$/, 'mainPattern.due_in'],
    [/^Overdue by (\d+) minutes?$/, 'mainPattern.overdue_by'],
    [/^Because: You have "(.+)" in (\d+) minutes?\.$/, 'mainPattern.because_event'],
    [/^Allow (.+) speech$/, 'mainPattern.allow_speech'],
    [/^Voice input in (.+) sends your audio to (.+) to turn it into text\. NAgex only receives the text and never stores the audio\. Allow it\? You can withdraw this in Settings\.$/, 'mainPattern.voice_consent_prompt'],
    [/^Listening\. Your audio is sent to (.+) to be turned into text\. Press the microphone to stop, or Cancel to discard\.$/, 'mainPattern.listening_third_party'],
    [/^On-device speech could not be installed\. You can allow (.+) speech or type your request\.$/, 'mainPattern.local_install_failed'],
  ];

  function localizeAppText(text) {
    if (text == null || text === '') return text == null ? '' : text;
    const value = String(text);
    const exact = mt(value);
    if (exact !== value) return exact;
    for (const entry of APP_TEXT_PATTERNS) {
      const match = entry[0].exec(value);
      if (!match) continue;
      const template = bt(entry[1], '');
      if (!template || template === entry[1]) return value;
      return template.replace(/\{(\d)\}/g,(_m, index) => {
        const part = match[Number(index) + 1] == null ? '' : match[Number(index) + 1];
        return /^(accepted|dismissed|snoozed|declined|rejected)$/.test(part) ? mt(part) : part;
      });
    }
    return value;
  }


  // Static chrome carries data-i18n* attributes (applied here at mount, and by i18n.js on every language change). The few regions that
  // hold dynamic text are only re-localized while they still show their idle placeholder, so a result already on screen is not rewritten.
  function applyMainStaticLocale() {
    const root = document.getElementById('nagex-main-surface');
    if (!root) return;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = bt(el.getAttribute('data-i18n'), el.textContent); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', bt(el.getAttribute('data-i18n-placeholder'), el.getAttribute('placeholder') || '')); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', bt(el.getAttribute('data-i18n-title'), el.getAttribute('title') || '')); });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', bt(el.getAttribute('data-i18n-aria-label'), el.getAttribute('aria-label') || '')); });
    const threadIdle = document.getElementById('main-thread-card') && document.getElementById('main-thread-card').hidden;
    const resultIdle = document.getElementById('main-result-panel') && document.getElementById('main-result-panel').hidden;
    const setIdle = (id, english) => { const el = document.getElementById(id); if (el) el.textContent = mt(english); };
    if (threadIdle) { setIdle('main-status', 'Ready'); setIdle('main-work-title', 'Ready'); setIdle('main-request-time', 'Just now'); }
    if (resultIdle) { setIdle('main-result-title', 'Result'); setIdle('main-result-meta', 'Ready'); }
    const voiceStatus = document.getElementById('main-voice-status');
    if (voiceStatus && (!root.dataset.voiceState || root.dataset.voiceState === 'IDLE') && /^(idle|Idle|대기 중)$/.test(voiceStatus.textContent.trim())) voiceStatus.textContent = mt('Idle');
    const mic = document.getElementById('main-mic');
    if (mic && !root.dataset.voiceState) mic.title = mt('Dictate into the Main composer');
  }

  function briefingLocale() {
    return window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko-KR' : 'en-US';
  }

  function briefingStateLabel(value) {
    const map = {
      Prepared: ['mainBriefing.state.prepared', 'Prepared'],
      'Needs approval': ['mainBriefing.state.needsApproval', 'Needs approval'],
      'In progress': ['mainBriefing.state.inProgress', 'In progress'],
      Completed: ['mainBriefing.state.completed', 'Completed'],
      'Needs your action': ['mainBriefing.state.needsAction', 'Needs your action'],
      Failed: ['mainBriefing.state.failed', 'Failed'],
      Unavailable: ['mainBriefing.state.unavailable', 'Unavailable'],
    };
    return map[value] ? bt(map[value][0], map[value][1]) : '';
  }

  function briefingTime(iso) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(briefingLocale(), { hour: '2-digit', minute: '2-digit' });
  }

  function briefingWhen(iso) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return '';
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor((startOfToday.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return briefingTime(iso);
    if (days === 1) return bt('mainBriefing.yesterday', 'Yesterday') + ' ' + briefingTime(iso);
    return date.toLocaleDateString(briefingLocale(), { month: 'short', day: 'numeric' });
  }

  function startOfYesterdayMs() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime() - 86400000;
  }

  // ── Greeting: the signed-in user's real profile name and the local time of day ───────────────────────────
  // The name comes from the existing personal-home aggregation (userProfile.name = the account's display name). Without one
  // (profile missing, placeholder name or the briefing source failing) the greeting is time-of-day only and the avatar is neutral.
  function mainUserName() {
    const profile = briefing.data && briefing.data.userProfile;
    return profile && typeof profile.name === 'string' ? profile.name.trim() : '';
  }

  function greetingSalutation(hour) {
    if (hour < 12) return bt('home.greetingMorning', 'Good morning');
    if (hour < 18) return bt('home.greetingAfternoon', 'Good afternoon');
    return bt('home.greetingEvening', 'Good evening');
  }

  function renderGreeting() {
    const heading = document.getElementById('main-greeting');
    if (!heading) return;
    const name = mainUserName();
    const base = greetingSalutation(new Date().getHours());
    heading.textContent = '';
    heading.appendChild(document.createTextNode(name ? base + ', ' : base));
    if (name) {
      const span = document.createElement('span');
      span.textContent = briefingLocale() === 'ko-KR' ? name + '님' : name;
      heading.appendChild(span);
    }
    const sub = document.getElementById('main-greeting-sub');
    if (sub) sub.textContent = bt('mainHome.subtitle', 'What would you like to accomplish today?');
    const avatar = document.getElementById('main-user-avatar');
    if (avatar) avatar.textContent = name ? Array.from(name)[0].toUpperCase() : 'U';
    const label = document.getElementById('main-user-name');
    if (label) label.textContent = name || bt('mainHome.you', 'You');
  }

  function briefingModel(home) {
    const list = (value) => (Array.isArray(value) ? value.filter((item) => item && item.title) : []);
    const status = home.sourceStatus || {};
    const seenToday = new Set();
    const today = [];
    const pushToday = (title, meta) => {
      if (seenToday.has(title)) return;
      seenToday.add(title);
      today.push({ title, meta });
    };
    list(home.today && home.today.meetings).forEach((meeting) => pushToday(meeting.title === 'Untitled Meeting' ? mt(meeting.title) : meeting.title, briefingTime(meeting.startsAt)));
    list(home.needsAttention).forEach((item) => pushToday(localizeAppText(item.title), briefingStateLabel(item.state)));
    list(home.upcoming).forEach((item) => pushToday(item.title, briefingTime(item.timestamp)));
    const cutoff = startOfYesterdayMs();
    const seenSince = new Set();
    const since = [...list(home.recentResults), ...list(home.recentCreations)]
      .filter((item) => item.createdAt && Date.parse(item.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .filter((item) => {
        const key = item.sourceId || item.id || item.title;
        if (seenSince.has(key)) return false;
        seenSince.add(key);
        return true;
      })
      .slice(0, 4)
      .map((item) => ({ title: localizeAppText(item.title), meta: [briefingStateLabel(item.state), briefingWhen(item.createdAt)].filter(Boolean).join(' - ') }));
    const suggestions = list(home.suggestions).slice(0, 3).map((item) => ({
      title: localizeAppText(item.title),
      reason: localizeAppText(item.reason || ''),
      approval: Boolean(item.action && item.action.requiresApproval),
    }));
    return {
      today: today.slice(0, 5),
      since,
      suggestions,
      calendarUnavailable: status.calendar === 'UNAVAILABLE',
      // why the calendar is (not) available: state + reason + connect path, from the server (null on an older server)
      calendar: home.calendarConnection && typeof home.calendarConnection === 'object' ? home.calendarConnection : null,
      activityUnavailable: Boolean(status.activity) && status.activity !== 'OK',
    };
  }

  // The Today card never claims "nothing scheduled" when the calendar is simply not readable. It says which state
  // the Google Calendar connection is in and offers the one action that can change it (never a dead button).
  const CALENDAR_ERROR_TEXT = {
    PROVIDER_TIMEOUT: ['mainBriefing.cal.timeout', 'Google Calendar did not respond in time.'],
    PROVIDER_UNREACHABLE: ['mainBriefing.cal.unreachable', 'Google Calendar could not be reached.'],
    PROVIDER_RATE_LIMITED: ['mainBriefing.cal.rateLimited', 'Google Calendar is limiting requests right now.'],
    PROVIDER_API_DISABLED: ['mainBriefing.cal.apiDisabled', 'The Google Calendar API is not enabled for this NAgex deployment.'],
    PROVIDER_FORBIDDEN: ['mainBriefing.cal.forbidden', 'Google Calendar refused this request.'],
    PROVIDER_ERROR: ['mainBriefing.cal.providerError', 'Google Calendar returned an error.'],
    INTERNAL_ERROR: ['mainBriefing.cal.internalError', "NAgex couldn't read Google Calendar because of an internal error."],
  };

  function calendarNotice(model) {
    const c = model.calendar;
    if (!c) {
      // an older server without the connection detail: keep the previous, generic statement
      return model.calendarUnavailable ? '<p class="main-briefing-note">' + esc(bt('mainBriefing.calendarNote', "Calendar isn't connected; events are not included.")) + '</p>' : '';
    }
    if (c.state === 'CONNECTED') return '';
    let text = '';
    let action = null;
    const connectPath = typeof c.connectPath === 'string' && c.connectPath.indexOf('/api/v1/oauth/') === 0 ? c.connectPath : null;
    if (c.state === 'NOT_CONNECTED') {
      text = bt('mainBriefing.cal.notConnected', "Google Calendar isn't connected, so today's events can't be shown.");
      if (connectPath) action = { id: 'connect', label: bt('mainBriefing.cal.connect', 'Connect Google Calendar') };
    } else if (c.state === 'CONNECTING') {
      text = bt('mainBriefing.cal.connecting', 'Finishing Google Calendar authorization...');
      action = { id: 'refresh', label: bt('mainBriefing.cal.checkAgain', 'Check again') };
    } else if (c.state === 'REAUTH_REQUIRED') {
      text = c.reason === 'MISSING_SCOPE'
        ? bt('mainBriefing.cal.missingScope', "Calendar access wasn't fully granted. Reconnect and allow calendar access.")
        : bt('mainBriefing.cal.reauth', "Google Calendar access expired or was revoked. Reconnect to see today's events.");
      if (connectPath) action = { id: 'connect', label: bt('mainBriefing.cal.reconnect', 'Reconnect Google Calendar') };
    } else if (c.state === 'ERROR') {
      const entry = CALENDAR_ERROR_TEXT[c.reason] || CALENDAR_ERROR_TEXT.PROVIDER_ERROR;
      text = bt(entry[0], entry[1]);
      if (c.retryable) action = { id: 'refresh', label: bt('mainBriefing.cal.retry', 'Try again') };
    } else {
      text = bt('mainBriefing.cal.unavailable', "Google Calendar isn't available on this server.");
    }
    return '<div class="main-briefing-note main-calendar-state" data-calendar-state="' + esc(c.state) + '"' + (c.reason ? ' data-calendar-reason="' + esc(c.reason) + '"' : '') + '><span>' + esc(text) + '</span>'
      + (action ? ' <button type="button" class="main-tool-btn main-calendar-action" data-calendar-action="' + action.id + '"' + (action.id === 'connect' ? ' data-calendar-path="' + esc(connectPath) + '"' : '') + '>' + esc(action.label) + '</button>' : '')
      + '</div>';
  }

  function briefingRows(rows) {
    return '<ul class="main-briefing-list">' + rows.map((row) => '<li class="main-briefing-row"><span>' + esc(row.title) + '</span>' + (row.meta ? '<small>' + esc(row.meta) + '</small>' : '') + '</li>').join('') + '</ul>';
  }

  function renderBriefing() {
    const section = document.getElementById('main-home-briefing');
    if (!section) return;
    section.setAttribute('aria-label', bt('mainBriefing.aria', 'Personal briefing'));
    section.dataset.state = briefing.status;
    const titles = { today: bt('mainBriefing.today', 'Today'), since: bt('mainBriefing.since', 'Since Yesterday'), suggestions: bt('mainBriefing.suggestions', 'Suggestions') };
    Object.keys(titles).forEach((key) => {
      const heading = document.getElementById('main-briefing-title-' + key);
      if (heading) heading.textContent = titles[key];
    });
    const newButton = document.getElementById('main-new-conversation');
    if (newButton) {
      newButton.textContent = bt('mainBriefing.newConversation', 'New conversation');
      newButton.title = bt('mainBriefing.newConversationHint', 'Start a fresh Home. Your earlier conversation is kept.');
    }
    const bodies = { today: document.getElementById('main-briefing-today'), since: document.getElementById('main-briefing-since'), suggestions: document.getElementById('main-briefing-suggestions') };
    const retry = document.getElementById('main-briefing-retry');
    const note = (text) => '<p class="main-briefing-empty">' + esc(text) + '</p>';
    if (briefing.status === 'idle' || briefing.status === 'loading') {
      Object.values(bodies).forEach((body) => { if (body) body.innerHTML = note(bt('mainBriefing.loading', 'Loading...')); });
      if (retry) retry.hidden = true;
      return;
    }
    if (briefing.status === 'error' || !briefing.data) {
      Object.values(bodies).forEach((body) => { if (body) body.innerHTML = note(bt('mainBriefing.error', "Couldn't load your briefing.")); });
      if (retry) {
        retry.hidden = false;
        retry.textContent = bt('mainBriefing.retry', 'Try again');
      }
      return;
    }
    if (retry) retry.hidden = true;
    const model = briefingModel(briefing.data);
    if (bodies.today) {
      const calendarState = calendarNotice(model);
      bodies.today.innerHTML = model.today.length
        ? briefingRows(model.today) + calendarState
        : (calendarState || note(bt('mainBriefing.emptyToday', 'Nothing scheduled or waiting for you today.')));
    }
    if (bodies.since) {
      bodies.since.innerHTML = model.since.length
        ? briefingRows(model.since)
        : note(model.activityUnavailable ? bt('mainBriefing.activityUnavailable', 'Recent activity is unavailable right now.') : bt('mainBriefing.emptySince', 'No updates since yesterday.'));
    }
    if (bodies.suggestions) {
      bodies.suggestions.innerHTML = model.suggestions.length
        ? '<ul class="main-briefing-list">' + model.suggestions.map((item, index) => '<li><button type="button" class="main-briefing-suggestion" data-suggestion-index="' + index + '" title="' + esc(bt('mainBriefing.useSuggestion', 'Put this in the Main box')) + '"><span>' + esc(item.title) + '</span>' + (item.reason ? '<small>' + esc(item.reason) + '</small>' : '') + (item.approval ? '<small class="main-briefing-approval">' + esc(bt('mainBriefing.approvalRequired', 'Approval required')) + '</small>' : '') + '</button></li>').join('') + '</ul>'
        : note(bt('mainBriefing.emptySuggestions', 'No suggestions right now.'));
    }
  }

  async function loadBriefing(force) {
    if (briefing.status === 'loading') return;
    if (!force && briefing.status === 'ready' && Date.now() - briefing.loadedAt < 60000) {
      renderBriefing();
      return;
    }
    if (!briefing.data) briefing.status = 'loading';
    renderBriefing();
    const response = await api('/api/v1/personal/home');
    const home = response && response.data && typeof response.data === 'object' ? response.data : response;
    if (home && !home.error && typeof home === 'object' && home.sourceStatus) {
      briefing.data = home;
      briefing.status = 'ready';
      briefing.loadedAt = Date.now();
    } else if (!briefing.data) {
      briefing.status = 'error';
    }
    renderBriefing();
    renderGreeting();
  }

  function threadIsVisible() {
    const card = document.getElementById('main-thread-card');
    return Boolean(card && !card.hidden);
  }

  // Derived from what Main is really showing: an active result, an active/restored conversation, or an empty Home.
  function mainSessionState() {
    const panel = document.getElementById('main-result-panel');
    if ((panel && !panel.hidden) || (state.result && document.getElementById('nagex-main-surface')?.classList.contains('has-result'))) return 'RESULT';
    if (state.busy || threadIsVisible()) return 'CONVERSATION';
    return 'EMPTY_HOME';
  }

  function syncBriefingVisibility() {
    const root = document.getElementById('nagex-main-surface');
    const section = document.getElementById('main-home-briefing');
    if (!root || !section) return;
    const sessionState = state.sessionChecked ? mainSessionState() : 'CHECKING';
    root.dataset.sessionState = sessionState;
    const showBriefing = sessionState === 'EMPTY_HOME' || (sessionState !== 'CHECKING' && state.briefingExpandedInConversation);
    section.hidden = !showBriefing;
    const button = document.getElementById('main-toggle-briefing');
    if (button) {
      button.setAttribute('aria-expanded', String(showBriefing && sessionState !== 'EMPTY_HOME'));
      button.textContent = mt(showBriefing && sessionState !== 'EMPTY_HOME' ? 'Hide My Day' : 'My Day');
    }
  }

  function watchMainSession() {
    if (sessionObserver) sessionObserver.disconnect();
    sessionObserver = new MutationObserver(syncBriefingVisibility);
    const root = document.getElementById('nagex-main-surface');
    const card = document.getElementById('main-thread-card');
    const panel = document.getElementById('main-result-panel');
    if (root) sessionObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    if (card) sessionObserver.observe(card, { attributes: true, attributeFilter: ['hidden'] });
    if (panel) sessionObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  function readFreshMark() {
    try { return window.sessionStorage.getItem(FRESH_MARK_KEY) || ''; } catch { return ''; }
  }

  function writeFreshMark(value) {
    try { window.sessionStorage.setItem(FRESH_MARK_KEY, value); } catch { /* storage unavailable: the mark only lives for this page */ }
  }

  // Refresh: rebuild the visible conversation from the server's Main session (minus anything the user started fresh from).
  async function restoreMainSession() {
    const data = await api('/api/v1/conversations/main', { timeoutMs: 4000 });
    if (data && !data.error && Array.isArray(data.messages) && !state.busy && !threadIsVisible()) {
      const mark = readFreshMark();
      const messages = data.messages
        .filter((m) => m && typeof m.content === 'string' && m.createdAt && (!m.status || m.status === 'COMMITTED') && (!mark || m.createdAt > mark))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let lastUser = -1;
      messages.forEach((m, index) => { if (String(m.role).toUpperCase() === 'USER') lastUser = index; });
      if (lastUser >= 0) {
        const user = messages[lastUser];
        const reply = messages.slice(lastUser + 1).find((m) => String(m.role).toUpperCase() === 'ASSISTANT');
        showThread(
          user.content,
          reply ? 'Answered' : bt('mainBriefing.noReplyStatus', 'No reply saved'),
          bt('mainBriefing.restoredTitle', 'Earlier in this conversation'),
          reply ? reply.content : bt('mainBriefing.noReply', 'This request has no saved answer.'),
          [{ state: 'done', label: bt('mainBriefing.restoredStep', 'Restored from your Main conversation'), detail: briefingWhen(user.createdAt) }],
        );
        const when = document.getElementById('main-request-time');
        if (when) when.textContent = briefingWhen(user.createdAt);
        renderInlineActions([{ id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') }]);
      }
    }
    state.sessionChecked = true;
    syncBriefingVisibility();
  }

  // New conversation: only the visible Home is reset. The server keeps the whole history; the view just starts after it.
  async function startNewConversation() {
    if (state.busy) return;
    const data = await api('/api/v1/conversations/main', { timeoutMs: 4000 });
    if (!data || data.error || !Array.isArray(data.messages)) {
      setComposerNotice(bt('mainBriefing.newFailed', "Couldn't start a new conversation right now. Try again."), 'error');
      return;
    }
    const newest = data.messages.reduce((acc, m) => (m && m.createdAt && m.createdAt > acc ? m.createdAt : acc), readFreshMark());
    if (newest) writeFreshMark(newest);
    const card = document.getElementById('main-thread-card');
    if (card) card.hidden = true;
    state.briefingExpandedInConversation = false;
    renderInlineActions([]);
    hideResult();
    state.result = null;
    state.revisionTarget = null;
    setComposerNotice('');
    state.sessionChecked = true;
    syncBriefingVisibility();
    loadBriefing(true);
    document.getElementById('main-surface-input')?.focus();
  }

  function initHomeBriefing() {
    state.sessionChecked = false;
    watchMainSession();
    document.getElementById('main-new-conversation')?.addEventListener('click', startNewConversation);
    document.getElementById('main-toggle-briefing')?.addEventListener('click', () => {
      state.briefingExpandedInConversation = !state.briefingExpandedInConversation;
      syncBriefingVisibility();
    });
    document.getElementById('main-briefing-retry')?.addEventListener('click', () => loadBriefing(true));
    document.getElementById('main-briefing-today')?.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-calendar-action]');
      if (!button) return;
      if (button.dataset.calendarAction === 'connect' && button.dataset.calendarPath && button.dataset.calendarPath.indexOf('/api/v1/oauth/') === 0) {
        // real OAuth: a full navigation to the server, which redirects to Google
        window.location.href = button.dataset.calendarPath;
      } else if (button.dataset.calendarAction === 'refresh') {
        loadBriefing(true);
      }
    });
    document.getElementById('main-briefing-suggestions')?.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-suggestion-index]');
      if (!button || !briefing.data) return;
      const item = briefingModel(briefing.data).suggestions[Number(button.dataset.suggestionIndex)];
      const input = document.getElementById('main-surface-input');
      if (!item || !input) return;
      input.value = input.value.trim() ? input.value.replace(/\s+$/, '') + '\n' + item.title : item.title;
      autoGrow(input);
      input.focus();
    });
    if (!briefing.localeListener) {
      briefing.localeListener = true;
      window.addEventListener('nagex:localechange', () => { renderModes(); renderBriefing(); renderGreeting(); applyMainStaticLocale(); });
      window.setInterval(renderGreeting, 5 * 60 * 1000);
    }
    renderGreeting();
    renderBriefing();
    syncBriefingVisibility();
    restoreMainSession();
    loadBriefing(false);
  }

  async function renderAttentionCenter() {
    const pop = document.getElementById('attention-popover');
    if (!pop) return;
    const [approvals, tasks, activity, notifications] = await Promise.all([
      api('/api/v1/approvals'), api('/api/v1/tasks'), api('/api/v1/activity'), api('/api/v1/notifications'),
    ]);
    const rows = [
      ...((approvals && approvals.pending) || []).map((a) => ({ label: a.intent || mt('Approval needed'), target: 'tab-inbox' })),
      ...((tasks && tasks.tasks) || []).filter((t) => t.status === 'RUNNING').map((t) => ({ label: t.name || mt('Running task'), target: 'tab-inbox' })),
      ...((activity && activity.activities) || []).slice(0, 3).map((a) => ({ label: localizeAppText(a.title || mt('Recent result')), target: 'tab-executions' })),
      ...((notifications && notifications.notifications) || []).filter((n) => !n.readAt).slice(0, 3).map((n) => ({ label: localizeAppText(n.title || mt('Notification')), target: 'tab-inbox' })),
    ];
    pop.innerHTML = `<h2>${esc(mt('Attention Center'))}</h2>${rows.length ? rows.map((r) => `<button type="button" class="main-attention-row" data-target="${esc(r.target)}">${esc(r.label)}</button>`).join('') : '<p>' + esc(mt('Nothing needs attention right now.')) + '</p>'}`;
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
    applyMainStaticLocale();
    bind();
    wireAttentionBell();
    initHomeBriefing();
    window.NAGEX_MAIN_SURFACE = Object.freeze({
      openArtifactResult,
      getControlMatrix: () => [
        ['main-mode-row', 'mode chips', 'Main', 'click', 'requestMetadata/preferredMode', 'metadata changes', 'selected chip', 'disabled if unavailable', 'per request', 'auth inherited'],
        ['main-send', 'send', 'Main', 'click', 'ambient/research/creation APIs', 'goal/result created where supported', 'inline progress/result', 'inline error', 'server stores', 'session'],
        ['main-attach', 'attach', 'Main', 'click/change', '/api/v1/workspace/upload', 'capture persisted', 'attachment chip', 'inline error', 'CaptureStore', 'session/owner'],
        ['main-web-toggle', 'web toggle', 'Main', 'click', 'requestMetadata.allowWebResearch', 'metadata changes', 'pressed state', 'n/a', 'per request', 'SSRF policy server-side'],
        ['main-data-toggle', 'my data toggle', 'Main', 'click', 'requestMetadata.usePersonalContext', 'metadata changes', 'pressed state', 'n/a', 'per request', 'consent/owner'],
        ['main-mic', 'microphone dictation', 'Main', 'click', 'Device voice adapter: on-device when the browser verifies it, otherwise the browser vendor only after consent; stop = transcribe, cancel = discard', 'transcript inserted into composer', 'composer text updated', 'permission/unavailable guidance', 'per request', 'browser permission'],
        ['main-voice', 'voice session', 'Main', 'click', 'Device voice adapter (same location and consent rules as dictation) -> Main composer', 'recognized speech becomes editable text', 'composer text updated', 'permission/unavailable guidance', 'per request', 'same Main authority rules'],
        ['main-home-briefing', 'personal briefing', 'Main', 'render', '/api/v1/personal/home (existing aggregation, read-only)', 'Today / Since Yesterday / Suggestions from real data or a stated empty or unavailable state', 'section under the composer; hidden (not removed) while a conversation or result is active', 'error text with retry; never invented items', 'server aggregation; nothing stored by the section', 'same session authentication'],
        ['main-new-conversation', 'new conversation', 'Main', 'click', 'GET /api/v1/conversations/main (read-only)', 'visible conversation reset; earlier history kept', 'empty Home with the briefing', 'inline error if the session cannot be read', 'server keeps the history; sessionStorage mark only', 'same session authentication'],
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
