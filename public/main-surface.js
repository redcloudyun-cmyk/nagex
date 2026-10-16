(function () {
  'use strict';

  // One Input: the person never has to pick a mode - NAgex decides from the words (server-owned routing decision, see dispatchMainRequest).
  // These are OPTIONAL shortcuts under the "+" menu. A shortcut only biases the artifact format of a plain request for ONE request; it can never override an
  // action (which stays an approval-gated plan) or an unsupported kind.
  const AUTO_MODE = { id: 'AUTO', label: 'Auto', capability: null, artifactType: null, enabled: true, support: 'FULL' };
  const MODES = [
    { id: 'RESEARCH', label: 'Research', capability: 'RESEARCH', enabled: true, support: 'FULL', route: '/api/v1/research' },
    { id: 'DOCUMENT', label: 'Document', artifactType: 'DOCUMENT', enabled: true, support: 'FULL', route: '/api/v1/creations/documents' },
    { id: 'IMAGE', label: 'Image', artifactType: 'IMAGE', enabled: true, support: 'FULL', route: '/api/v1/creations/generate' },
    { id: 'SLIDES', label: 'Slides', artifactType: 'PRESENTATION', enabled: true, support: 'PARTIAL', route: '/api/v1/creations/presentations' },
    { id: 'VIDEO', label: 'Video', artifactType: 'VIDEO', enabled: false, support: 'MISSING', reason: 'Video provider experiments exist, but no consumer-safe Main generation route is enabled yet.' },
    { id: 'CODE', label: 'Code', capability: 'CODE', enabled: false, support: 'MISSING', reason: 'No canonical code artifact runtime is enabled in Main yet.' },
    { id: 'MORE', label: 'What NAgex can do', capability: 'CAPABILITY_AUDIT', enabled: true, support: 'PARTIAL', route: 'inline capability matrix' },
  ];

  const state = {
    mode: 'AUTO',
    shortcutsOpen: false,
    lastContext: '',
    lastAnswerFull: '',
    answerForSave: '',
    web: true,
    personalContext: false,
    planPreview: true,
    busy: false,
    sessionChecked: false,
    attachments: [],
    result: null,
    revisionTarget: null,
    // the last document that was made or opened: "이 보고서로 발표자료 ..." can name it even after another result replaced it on screen
    recentDocument: null,
    voiceState: 'IDLE',
    voiceAdapter: null,
    voiceMode: null,
    activeTurn: null,
    myDayOpen: false,
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

  // The language the person wrote in decides the language of what NAgex writes back (never the screen language, never an automatic translation).
  // Mirrors the server's detectRequestLanguage(): Korean as soon as Hangul is a meaningful part of the letters; the screen language only when the text has no letters.
  function requestLocale(text) {
    const value = String(text || '');
    const hangul = (value.match(/[ㄱ-ㆎ가-힣]/g) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    if (hangul > 0 && hangul / (hangul + latin) >= 0.25) return 'ko';
    if (latin > 0) return 'en';
    return (window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale()) === 'ko' ? 'ko' : 'en';
  }

  // The timezone of THIS device (an IANA name such as Asia/Seoul): the server uses it to read "tomorrow at 2 pm" in the person's own day when their profile sets none. The clock itself is the server's.
  function clientTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  // the id of the deck on screen (NAgex-owned identity from its open path), or null
  function openPresentationId() {
    const target = state.result && state.result.type === 'PRESENTATION' ? String(state.result.openTarget || '') : '';
    const match = /\/api\/v1\/creations\/presentations\/(pres_[0-9a-f]{24})$/.exec(target);
    return match ? match[1] : null;
  }

  function requestMetadata() {
    const mode = MODES.find((m) => m.id === state.mode) || AUTO_MODE;
    return {
      timezone: clientTimezone(),
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
        // what is open (advice for routing; every endpoint still checks ownership): a deck can be revised by its id, a recent document can be a deck's source
        artifactType: state.result && (state.result.type === 'PRESENTATION' || state.result.type === 'DOCUMENT') ? state.result.type : null,
        presentationId: openPresentationId(),
        sourceDocumentArtifactId: state.recentDocument && state.recentDocument.artifactId ? state.recentDocument.artifactId : null,
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
            <div class="main-input-wrap">
              <textarea id="main-surface-input" rows="1" placeholder="Ask NAgex to research, create, plan, or act..." data-i18n-placeholder="mainText.Ask_NAgex_to_research_create_plan_or_act"></textarea>
              <div class="main-attachment-list" id="main-attachment-list"></div>
              <div class="main-shortcut-chip" id="main-shortcut-chip" hidden>
                <span id="main-shortcut-chip-label"></span>
                <button type="button" class="main-shortcut-clear" id="main-shortcut-clear" aria-label="Remove shortcut">x</button>
              </div>
              <div class="main-composer-footer">
                <div class="main-left-tools">
                  <div class="main-shortcut-wrap">
                    <button type="button" class="main-tool-btn main-shortcut-toggle" id="main-shortcut-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="main-mode-row" aria-label="Shortcuts" title="Shortcuts">+</button>
                    <div class="main-mode-row" id="main-mode-row" role="menu" hidden></div>
                  </div>
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
          <p class="main-trust-notice" id="main-trust-notice" role="note" data-i18n="mainTrust.notice">AI responses and actions may contain errors. Review important decisions and results.</p>
          <div class="main-conversation-bar" id="main-conversation-bar">
            <button type="button" class="main-tool-btn main-myday-toggle" id="main-myday-toggle" aria-expanded="false" aria-controls="main-home-briefing">My Day</button>
            <button type="button" class="main-tool-btn" id="main-new-conversation" hidden>New conversation</button>
          </div>
          <section class="main-home-briefing" id="main-home-briefing" aria-label="Personal briefing" data-state="idle" hidden>
            <div class="main-briefing-grid">
              <article class="main-briefing-card" data-briefing-section="today"><h2 id="main-briefing-title-today">Today</h2><div class="main-briefing-body" id="main-briefing-today"></div></article>
              <article class="main-briefing-card" data-briefing-section="todo"><h2 id="main-briefing-title-todo">To-do</h2><div class="main-briefing-body" id="main-briefing-todo"></div></article>
              <article class="main-briefing-card" data-briefing-section="since"><h2 id="main-briefing-title-since">Since Yesterday</h2><div class="main-briefing-body" id="main-briefing-since"></div></article>
              <article class="main-briefing-card" data-briefing-section="suggestions"><h2 id="main-briefing-title-suggestions">Suggestions</h2><div class="main-briefing-body" id="main-briefing-suggestions"></div></article>
            </div>
            <button type="button" class="main-tool-btn main-briefing-retry" id="main-briefing-retry" hidden>Try again</button>
          </section>
          <section class="main-thread-card" id="main-thread-card" aria-label="Conversation" data-i18n-aria-label="mainText.Conversation" hidden>
            <ol class="main-turns" id="main-turns"></ol>
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
            <button type="button" class="active" id="main-result-preview-tab" data-i18n="mainText.Preview">Preview</button>
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

  // The optional shortcuts live in a compact "+" menu. Nothing here is required: a plain request is routed by what it says.
  function modeLabel(mode) {
    return mode.id === 'MORE' ? bt('mainRoute.capabilities', 'What NAgex can do') : mt(mode.label);
  }

  function renderModes() {
    const row = document.getElementById('main-mode-row');
    if (!row) return;
    row.setAttribute('role', 'menu');
    row.setAttribute('aria-label', bt('mainRoute.shortcutsLabel', 'Optional shortcuts'));
    row.innerHTML = MODES.map((mode) => `
      <button type="button" role="menuitem" class="main-mode-chip" data-main-mode="${esc(mode.id)}" data-support="${esc(mode.support)}" aria-checked="${mode.id === state.mode ? 'true' : 'false'}" aria-disabled="${mode.enabled ? 'false' : 'true'}" ${mode.enabled ? '' : 'disabled title="' + esc(bt('mainRoute.shortcutUnavailable', 'Not available yet') + ' - ' + mt(mode.reason)) + '"'}>
        <span>${esc(modeLabel(mode))}</span>${mode.enabled ? '' : '<small>' + esc(bt('mainRoute.shortcutUnavailable', 'Not available yet')) + '</small>'}
      </button>
    `).join('');
    const toggle = document.getElementById('main-shortcut-toggle');
    if (toggle) {
      const label = bt('mainRoute.shortcutsLabel', 'Optional shortcuts');
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      toggle.setAttribute('aria-expanded', String(state.shortcutsOpen));
    }
    row.hidden = !state.shortcutsOpen;
    const chip = document.getElementById('main-shortcut-chip');
    const active = MODES.find((m) => m.id === state.mode);
    if (chip) {
      chip.hidden = !active;
      const text = document.getElementById('main-shortcut-chip-label');
      if (text) text.textContent = active ? modeLabel(active) : '';
      const clear = document.getElementById('main-shortcut-clear');
      if (clear) clear.setAttribute('aria-label', bt('mainRoute.shortcutRemove', 'Remove shortcut'));
    }
  }

  function setShortcutsOpen(open, returnFocus) {
    state.shortcutsOpen = Boolean(open);
    renderModes();
    if (state.shortcutsOpen) {
      const first = document.querySelector('#main-mode-row [data-main-mode]:not([disabled])');
      if (first) first.focus();
    } else if (returnFocus) {
      document.getElementById('main-shortcut-toggle')?.focus();
    }
  }

  // ── Safe Markdown ─────────────────────────────────────────────────────────────────────────────────────────
  // AI answers are untrusted text. They are turned into DOM nodes (headings, lists, tables, code, quotes, links) where
  // every piece of text is a text node, raw HTML is never interpreted, and a link is only ever http(s) with rel=noopener.
  function mdSafeUrl(value) {
    try {
      const url = new URL(String(value).trim());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function mdInline(parent, text) {
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"')\]]+)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      const token = match[0];
      if (match[1]) { const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.appendChild(code); }
      else if (match[2] || match[3]) { const strong = document.createElement('strong'); mdInline(strong, token.slice(2, -2)); parent.appendChild(strong); }
      else if (match[4]) { const em = document.createElement('em'); mdInline(em, token.slice(1, -1)); parent.appendChild(em); }
      else {
        let label = token;
        let href = token;
        if (match[5]) {
          const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
          label = parts[1];
          href = parts[2];
        }
        const safe = mdSafeUrl(href);
        if (safe) {
          const a = document.createElement('a');
          a.href = safe;
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
          a.textContent = label;
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(token));
        }
      }
      last = match.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function mdCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function renderMarkdown(container, source) {
    container.textContent = '';
    const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    const flushParagraph = (buffer) => {
      if (!buffer.length) return;
      const p = document.createElement('p');
      buffer.forEach((line, index) => { if (index) p.appendChild(document.createElement('br')); mdInline(p, line); });
      container.appendChild(p);
      buffer.length = 0;
    };
    const paragraph = [];
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph(paragraph);
        const body = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        const wrap = document.createElement('div');
        wrap.className = 'main-md-code';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'main-md-copy';
        copy.textContent = mt('Copy');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (fence[1]) code.dataset.lang = fence[1].toLowerCase();
        code.textContent = body.join('\n');
        pre.appendChild(code);
        copy.addEventListener('click', () => {
          const done = () => { copy.textContent = mt('Copied'); setTimeout(() => { copy.textContent = mt('Copy'); }, 1500); };
          try { navigator.clipboard.writeText(code.textContent).then(done, () => {}); } catch { /* clipboard unavailable: the text stays selectable */ }
        });
        wrap.appendChild(copy);
        wrap.appendChild(pre);
        container.appendChild(wrap);
        continue;
      }
      if (!line.trim()) { flushParagraph(paragraph); i += 1; continue; }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph(paragraph);
        const h = document.createElement('h' + Math.min(6, heading[1].length + 2));
        mdInline(h, heading[2]);
        container.appendChild(h);
        i += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flushParagraph(paragraph); container.appendChild(document.createElement('hr')); i += 1; continue; }
      if (/^>\s?/.test(line)) {
        flushParagraph(paragraph);
        const quote = document.createElement('blockquote');
        const parts = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^>\s?/, '')); i += 1; }
        parts.forEach((part, index) => { if (index) quote.appendChild(document.createElement('br')); mdInline(quote, part); });
        container.appendChild(quote);
        continue;
      }
      const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
      if (list) {
        flushParagraph(paragraph);
        const ordered = /\d/.test(list[2]);
        const el = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]);
          if (!item || /\d/.test(item[2]) !== ordered) break;
          const li = document.createElement('li');
          mdInline(li, item[3]);
          el.appendChild(li);
          i += 1;
        }
        container.appendChild(el);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flushParagraph(paragraph);
        const table = document.createElement('table');
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        mdCells(line).forEach((cell) => { const th = document.createElement('th'); mdInline(th, cell); headRow.appendChild(th); });
        head.appendChild(headRow);
        table.appendChild(head);
        const bodyEl = document.createElement('tbody');
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const tr = document.createElement('tr');
          mdCells(lines[i]).forEach((cell) => { const td = document.createElement('td'); mdInline(td, cell); tr.appendChild(td); });
          bodyEl.appendChild(tr);
          i += 1;
        }
        table.appendChild(bodyEl);
        const scroller = document.createElement('div');
        scroller.className = 'main-md-table';
        scroller.appendChild(table);
        container.appendChild(scroller);
        continue;
      }
      paragraph.push(line);
      i += 1;
    }
    flushParagraph(paragraph);
  }

  // ── Conversation stream ───────────────────────────────────────────────────────────────────────────────────
  // One Main session, one stream: every request becomes a turn (the question once, then NAgex's answer). The newest
  // turn owns the element ids the rest of Main (and the tests) use; older turns keep their content but not the ids.
  // What a turn shows follows what really happened: a plain answer is just the answer, a task shows its real steps.
  const TURN_IDS = ['main-user-avatar', 'main-user-name', 'main-request-time', 'main-request-text', 'main-status', 'main-work-title', 'main-work-summary', 'main-step-list', 'main-inline-actions', 'main-inline-approvals'];

  function diagnosticsOn() {
    try { return window.localStorage.getItem('nagex_main_diagnostics') === '1' || /[?&]diagnostics=1/.test(window.location.search + window.location.hash); } catch { return false; }
  }

  // Internal identifiers (enums, ids, tool ids) are for diagnostics, never ordinary UI.
  function isInternalToken(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    return /^[A-Z][A-Z0-9_]{2,}$/.test(s)
      || /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9_.]+$/.test(s)
      || /^(?:req|msg|art|doc|cap|cr|task|plan|exe|cmd|evt|gcal|vault|capture|item)[_-][A-Za-z0-9_-]{3,}$/i.test(s)
      || /^[A-Za-z0-9]+_[A-Za-z0-9_-]{8,}$/.test(s)
      || /^[a-f0-9-]{12,}$/i.test(s);
  }

  function visibleDetail(detail, showRaw) {
    const text = localizeAppText(detail || '');
    if (!text) return '';
    return showRaw || !isInternalToken(detail) ? text : '';
  }

  function turnTemplate() {
    return `
      <li class="main-turn" data-kind="pending">
        <div class="main-message main-message-user">
          <span class="main-avatar main-user-avatar" id="main-user-avatar">U</span>
          <div>
            <div class="main-message-meta"><strong class="main-user-name" id="main-user-name">You</strong><span class="main-request-time" id="main-request-time"></span></div>
            <p id="main-request-text"></p>
          </div>
        </div>
        <div class="main-message main-message-nagex">
          <span class="main-avatar nagex">N</span>
          <div>
            <div class="main-message-meta"><strong>NAgex</strong><span class="main-message-status" id="main-status"></span></div>
            <p class="main-turn-working" role="status"></p>
            <h2 class="main-work-title" id="main-work-title"></h2>
            <div class="main-work-summary" id="main-work-summary"></div>
            <ol class="main-step-list" id="main-step-list"></ol>
            <button type="button" class="main-tool-btn main-turn-details" hidden></button>
            <div class="main-inline-actions" id="main-inline-actions"></div>
            <div class="main-inline-approvals" id="main-inline-approvals"></div>
          </div>
        </div>
      </li>`;
  }

  function stripTurnIds(el) {
    if (!el) return;
    TURN_IDS.forEach((id) => { const node = el.querySelector('#' + id); if (node) node.removeAttribute('id'); });
  }

  function beginTurn(prompt) {
    const list = document.getElementById('main-turns');
    if (!list) return null;
    stripTurnIds(list.lastElementChild);
    const holder = document.createElement('div');
    holder.innerHTML = turnTemplate();
    const el = holder.firstElementChild;
    list.appendChild(el);
    const turn = { el, prompt, kind: 'pending', steps: [], detailsOpen: false, todoId: state.pendingTodoId || null };
    state.activeTurn = turn;
    const text = el.querySelector('.main-message-user p');
    if (text) text.textContent = prompt;
    const working = el.querySelector('.main-turn-working');
    if (working) working.textContent = mt('Working on it...');
    const toggle = el.querySelector('.main-turn-details');
    if (toggle) toggle.addEventListener('click', () => { turn.detailsOpen = !turn.detailsOpen; renderSteps(turn); });
    renderGreeting();
    return turn;
  }

  function turnKindFor(status) {
    const s = String(status || '');
    if (s === 'Submitting' || s === 'Uploading') return 'pending';
    if (s === 'Answered') return 'answer';
    if (s === 'Plan ready' || s === 'Completed') return 'task';
    return 'notice';
  }

  function renderSteps(turn) {
    if (!turn || !turn.el) return;
    const list = turn.el.querySelector('.main-step-list');
    if (!list) return;
    const showRaw = diagnosticsOn() || turn.detailsOpen;
    list.innerHTML = (turn.steps || []).map((item) => `
      <li class="${esc(item.state)}"><span class="main-step-dot">${item.state === 'done' ? '✓' : ''}</span><span>${esc(localizeAppText(item.label))}</span><small>${esc(visibleDetail(item.detail, showRaw))}</small></li>
    `).join('');
    // "Show details" exists only where there is real, otherwise hidden execution evidence to inspect.
    const toggle = turn.el.querySelector('.main-turn-details');
    if (toggle) {
      const hasEvidence = (turn.steps || []).some((item) => item.detail && isInternalToken(item.detail));
      toggle.hidden = !(turn.kind === 'task' && hasEvidence && !diagnosticsOn());
      toggle.textContent = turn.detailsOpen ? mt('Hide details') : mt('Show details');
      toggle.setAttribute('aria-expanded', String(Boolean(turn.detailsOpen)));
    }
  }

  function setStep(items) {
    if (!state.activeTurn) return;
    state.activeTurn.steps = items || [];
    renderSteps(state.activeTurn);
  }

  function scrollStreamToEnd() {
    const card = document.getElementById('main-thread-card');
    if (card) card.scrollTop = card.scrollHeight;
    // phones: the thread is not its own scroller (the canvas is), so the end of the stream is the end of the canvas
    const canvas = document.querySelector('.center-canvas');
    if (canvas && canvas.scrollHeight > canvas.clientHeight + 2 && card && card.scrollHeight <= card.clientHeight + 2) canvas.scrollTop = canvas.scrollHeight;
  }

  function showThread(prompt, status, title, summary, steps) {
    const card = document.getElementById('main-thread-card');
    if (card) card.hidden = false;
    let turn = state.activeTurn;
    if (!turn || !turn.el.isConnected || turn.prompt !== prompt) turn = beginTurn(prompt);
    if (!turn) return;
    turn.kind = turnKindFor(status);
    turn.status = status;
    turn.el.dataset.kind = turn.kind;
    const statusEl = turn.el.querySelector('.main-message-status');
    if (statusEl) { statusEl.textContent = localizeAppText(status); statusEl.dataset.status = status; }
    const titleEl = turn.el.querySelector('.main-work-title');
    if (titleEl) titleEl.textContent = localizeAppText(title);
    const summaryEl = turn.el.querySelector('.main-work-summary');
    if (summaryEl) {
      // an AI answer (or a research answer) is rendered as safe Markdown; NAgex's own status text stays plain
      if (turn.kind === 'answer' || (turn.kind === 'task' && title === 'Research result')) renderMarkdown(summaryEl, summary);
      else { summaryEl.textContent = localizeAppText(summary); summaryEl.classList.add('main-plain'); }
    }
    turn.steps = steps || [];
    renderSteps(turn);
    scrollStreamToEnd();
  }

  // ── Agent run: a plan becomes a real Task; what is shown is what the run record says, never invented ──────────
  const RUN_STATE_LABELS = { RUNNING: 'Running', WAITING_APPROVAL: 'Waiting for your approval', SUCCEEDED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled' };

  function runBlockFor(turn) {
    let block = turn.el.querySelector('.main-run-block');
    if (!block) {
      block = document.createElement('div');
      block.className = 'main-run-block';
      block.innerHTML = '<div class="main-run-head"><strong class="main-run-state"></strong><button type="button" class="main-tool-btn main-run-open" hidden></button><button type="button" class="main-tool-btn main-run-cancel" hidden></button></div><div class="main-run-proposal" hidden></div><ol class="main-run-steps"></ol><p class="main-run-note"></p>';
      const anchor = turn.el.querySelector('.main-inline-approvals');
      (anchor && anchor.parentNode ? anchor.parentNode : turn.el).insertBefore(block, anchor || null);
    }
    return block;
  }

  // Steps come from the run's own result (completed, waiting, halted) - the executor plans on its own, so the preview's
  // titles are NOT assumed to match; each step is named by the real action it performed.
  function renderRun(turn, taskId, run, note) {
    const block = runBlockFor(turn);
    const status = run && run.status ? run.status : 'RUNNING';
    const result = run && run.result && typeof run.result === 'object' ? run.result : {};
    // A run that only produced a reviewable plan (no step executed, nothing sent or changed) is NOT "completed": it is said to be a reviewed plan.
    const planOnly = status === 'SUCCEEDED' && result.kind === 'PLAN_PREVIEW';
    // An approved step that ran is "the tool responded" - what the provider answered - never "verified": NAgex has not checked the outcome in the world.
    const responded = status === 'SUCCEEDED' && result.kind === 'STEP_EXECUTION';
    const declined = status === 'FAILED' && run && run.errorCode === 'APPROVAL_REJECTED';
    const expired = status === 'FAILED' && run && run.errorCode === 'APPROVAL_EXPIRED';
    // D-9: a Vault save that was read back from the person's own Vault is reported as saved (VERIFIED); a failed one as not saved - never as a tool response
    const executedSteps = Array.isArray(result.steps) ? result.steps : Array.isArray(result.completedSteps) ? result.completedSteps : [];
    const savedStep = status === 'SUCCEEDED' ? executedSteps.find((s) => s && s.result && s.result.outcome === 'SAVED_TO_VAULT' && s.result.verification && s.result.verification.status === 'VERIFIED') : null;
    const vaultFailed = status === 'FAILED' && run && /^VAULT_/.test(String(run.errorCode || ''));
    // a Google Calendar change is "confirmed" only when NAgex read the event back and it matched; provider acceptance alone is never described as done
    const calendarStep = status === 'SUCCEEDED' ? executedSteps.find((s) => s && /^google_calendar\.(create_event|update_event|cancel_event|respond_to_event)$/.test(String(s.capabilityId || '')) && s.result && s.result.verification && typeof s.result.verification.outcome === 'string') : null;
    const calendarOutcome = calendarStep ? calendarStep.result.verification.outcome : '';
    block.dataset.runState = calendarOutcome === 'VERIFIED' ? 'CALENDAR_CONFIRMED' : calendarOutcome === 'MISMATCH' ? 'CALENDAR_MISMATCH' : calendarOutcome === 'NOT_VERIFIED' ? 'CALENDAR_UNCONFIRMED' : savedStep ? 'SAVED_TO_VAULT' : vaultFailed ? 'VAULT_NOT_SAVED' : planOnly ? 'PLAN_ONLY' : responded ? 'TOOL_RESPONDED' : declined ? 'DECLINED' : expired ? 'EXPIRED' : status;
    block.querySelector('.main-run-state').textContent = calendarOutcome === 'VERIFIED' ? bt('mainCalendar.confirmedState', 'Done - confirmed on your calendar')
      : calendarOutcome === 'MISMATCH' ? bt('mainCalendar.mismatchState', 'Sent - your calendar shows something different')
      : calendarOutcome === 'NOT_VERIFIED' ? bt('mainCalendar.unconfirmedState', 'Sent to your calendar - not confirmed')
      : savedStep ? bt('mainVault.saved', 'Saved to your Vault')
      : vaultFailed ? bt('mainVault.notSaved', 'Not saved')
      : planOnly ? bt('mainRoute.planOnlyState', 'Plan reviewed')
      : responded ? bt('mainRun.toolResponded', 'Tool responded')
      : declined ? bt('mainRun.declined', 'Not run - you declined')
      : expired ? bt('mainRun.expired', 'Not run - the approval expired')
      : status === 'WAITING_APPROVAL' && block.dataset.flow === 'reviewed' ? bt('mainRun.waiting', 'Waiting for your approval - nothing has been done yet')
      : mt(RUN_STATE_LABELS[status] || status);
    const steps = [];
    (Array.isArray(result.steps) ? result.steps : Array.isArray(result.completedSteps) ? result.completedSteps : []).forEach((s) => {
      const finished = s.status === 'SUCCEEDED' || s.status === 'COMPLETED' || s.status === 'EXECUTED';
      const answer = finished && s.result && typeof s.result.text === 'string' ? s.result.text.replace(/\s+/g, ' ').slice(0, 200) : '';
      steps.push({ state: finished ? 'done' : 'running', label: mt('Step') + ' ' + s.step + ' - ' + friendlyToolName(s.capabilityId || ''), detail: finished ? answer : String(s.status || '') });
    });
    if (typeof result.waitingAtStep === 'number') steps.push({ state: 'running', label: mt('Step') + ' ' + result.waitingAtStep, detail: mt('Approval needed before this step can run.') });
    if (typeof result.haltedAtStep === 'number') steps.push({ state: 'failed', label: mt('Step') + ' ' + result.haltedAtStep, detail: String(result.reason || '') });
    block.querySelector('.main-run-steps').innerHTML = steps.map((s) => '<li class="' + esc(s.state) + '"><span class="main-step-dot">' + (s.state === 'done' ? '✓' : '') + '</span><span>' + esc(s.label) + '</span><small>' + esc(visibleDetail(s.detail, diagnosticsOn() || turn.detailsOpen)) + '</small></li>').join('');
    const noteEl = block.querySelector('.main-run-note');
    let text = note || '';
    if (!text && declined) text = bt('mainRun.declinedNote', 'You declined, so nothing was done.');
    if (!text && expired) text = bt('mainRun.expiredNote', 'The approval expired before it was granted, so nothing was done. Ask again to get a fresh one.');
    if (!text && calendarOutcome === 'VERIFIED') text = bt('mainCalendar.confirmedNote', 'Google Calendar accepted the change and NAgex read the event back to confirm it.');
    if (!text && calendarOutcome === 'MISMATCH') {
      const differing = (calendarStep.result.verification.checks || []).filter((c) => c && c.ok === false).map((c) => String(c.field)).slice(0, 4).join(', ');
      text = bt('mainCalendar.mismatchNote', 'Google Calendar accepted the change, but when NAgex read the event back it did not match what you approved ({fields}). Check your calendar.').replace('{fields}', differing);
    }
    if (!text && calendarOutcome === 'NOT_VERIFIED') text = bt('mainCalendar.unconfirmedNote', 'Google Calendar accepted the change, but NAgex could not read the event back to confirm it. Check your calendar.');
    if (!text && savedStep) text = bt('mainVault.savedNote', 'Saved, and read back from your Vault: "{title}".').replace('{title}', String(savedStep.result.title || ''));
    if (!text && vaultFailed) text = bt('mainVault.failedNote', 'The Vault could not store this, so nothing was saved. The approval was used - ask again to get a fresh one.');
    if (!text && responded) text = bt('mainRun.respondedNote', 'The tool answered. NAgex has not independently checked the result in the real world.');
    if (!text && status === 'WAITING_APPROVAL' && block.dataset.flow === 'reviewed') text = bt('mainRun.waitingNote', 'It will only happen if you approve below.');
    if (!text && status === 'FAILED') text = result && typeof result.reason === 'string' && result.reason ? mt("NAgex couldn't complete this plan.") + ' ' + String(result.reason).slice(0, 200) : mt("NAgex couldn't complete this plan.");
    if (!text && planOnly) text = bt('mainRoute.planOnlyNote', "Nothing was executed. NAgex can't run this plan automatically yet - it stays a plan for you to carry out or approve step by step.");
    if (!text && status === 'SUCCEEDED') text = mt('The plan finished.');
    if (!text && status === 'CANCELLED') text = mt('The plan was cancelled.');
    noteEl.textContent = text;
    noteEl.hidden = !text;
    const openBtn = block.querySelector('.main-run-open');
    if (openBtn) {
      const calendarUrl = calendarStep && typeof calendarStep.result.externalUrl === 'string' && /^https:\/\//.test(calendarStep.result.externalUrl) && calendarStep.capabilityId !== 'google_calendar.cancel_event' ? calendarStep.result.externalUrl : '';
      openBtn.hidden = !savedStep && !calendarUrl;
      if (savedStep) {
        openBtn.textContent = bt('mainVault.open', 'Open in Vault');
        openBtn.onclick = () => openVaultItem(savedStep.result.vaultItemId);
      } else if (calendarUrl) {
        openBtn.textContent = bt('mainCalendar.openEvent', 'Open in Google Calendar');
        openBtn.onclick = () => window.open(calendarUrl, '_blank', 'noopener,noreferrer');
      }
    }
    const cancel = block.querySelector('.main-run-cancel');
    const live = status === 'RUNNING' || status === 'WAITING_APPROVAL';
    cancel.hidden = !live;
    cancel.textContent = mt('Cancel');
    cancel.onclick = async () => {
      cancel.disabled = true;
      const res = await api('/api/v1/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST', body: JSON.stringify({}) });
      cancel.disabled = false;
      if (res && !res.error) { turn.runPolling = false; renderRun(turn, taskId, { status: 'CANCELLED', result }, ''); }
      else setComposerNotice(mt("Couldn't cancel this plan."), 'error');
    };
    scrollStreamToEnd();
  }

  async function pollRun(turn, taskId) {
    turn.runPolling = true;
    for (let i = 0; i < 240 && turn.runPolling && turn.el.isConnected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!turn.runPolling || !turn.el.isConnected) return;
      const data = await api('/api/v1/tasks/' + encodeURIComponent(taskId) + '/runs');
      const runs = data && !data.error && Array.isArray(data.runs) ? data.runs : null;
      if (!runs || runs.length === 0) continue;
      const latest = runs.slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).pop();
      renderRun(turn, taskId, latest, '');
      if (latest.status === 'WAITING_APPROVAL') loadInlineApprovals(turn);
      // once the run has ended its approval is no longer pending: re-read the list so "Waiting for your approval" does not stay on screen next to a finished result
      if (latest.status === 'SUCCEEDED' || latest.status === 'FAILED') { turn.runPolling = false; loadInlineApprovals(turn); return; }
    }
    turn.runPolling = false;
  }

  // "2026-10-17T14:00:00" (a wall-clock time in the timezone shown beside it) -> "2026-10-17 (토) 14:00". Anything else is shown as it is.
  function calendarWhen(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value == null ? '' : value));
    if (!m) return String(value == null ? '' : value);
    const weekdays = (window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale() === 'ko') ? ['일', '월', '화', '수', '목', '금', '토'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekday = weekdays[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
    return m[1] + '-' + m[2] + '-' + m[3] + ' (' + weekday + ') ' + m[4] + ':' + m[5];
  }

  // What the person is about to approve, in their own words and values: the action and its exact arguments. Never an id, never a secret (the server already hid those).
  function renderProposal(turn, proposal) {
    const block = runBlockFor(turn);
    const box = block.querySelector('.main-run-proposal');
    if (!box) return;
    box.textContent = '';
    const args = proposal && Array.isArray(proposal.arguments) ? proposal.arguments : [];
    if (!proposal || !proposal.capabilityId) { box.hidden = true; return; }
    const title = document.createElement('strong');
    title.textContent = bt('mainRun.youApprove', 'You are asked to approve: ') + friendlyToolName(proposal.capabilityId);
    box.appendChild(title);
    if (args.length > 0) {
      const list = document.createElement('dl');
      const vaultSave = proposal.capabilityId === 'vault.save_note';
      const calendarCreate = proposal.capabilityId === 'google_calendar.create_event' || proposal.capabilityId === 'google_calendar.update_event';
      args.forEach((a) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        if (calendarCreate) {
          // a calendar event is approved as a person reads it: what, exactly when (date, weekday, time, timezone) and in which calendar - never raw field names
          const names = { event: bt('mainCalendar.event', 'Event'), beforeStart: bt('mainCalendar.beforeStarts', 'Now starts'), beforeEnd: bt('mainCalendar.beforeEnds', 'Now ends'), summary: bt('mainCalendar.title', 'Title'), start: proposal.capabilityId === 'google_calendar.update_event' ? bt('mainCalendar.newStarts', 'Will start') : bt('mainCalendar.starts', 'Starts'), end: proposal.capabilityId === 'google_calendar.update_event' ? bt('mainCalendar.newEnds', 'Will end') : bt('mainCalendar.ends', 'Ends'), timezone: bt('mainCalendar.timezone', 'Timezone'), calendarId: bt('mainCalendar.calendar', 'Calendar'), description: bt('mainCalendar.notes', 'Notes'), attendees: bt('mainCalendar.guests', 'Guests') };
          dt.textContent = names[a.name] || String(a.name || '');
          dd.textContent = a.name === 'start' || a.name === 'end' || a.name === 'beforeStart' || a.name === 'beforeEnd' ? calendarWhen(a.value) : a.name === 'calendarId' && a.value === 'primary' ? bt('mainCalendar.primary', 'Primary calendar') : a.name === 'attendees' && (a.value === '[]' || !a.value) ? bt('mainCalendar.noGuests', 'None') : String(a.value == null ? '' : a.value);
        } else if (vaultSave) {
          // a Vault draft is approved in the person's own words: field names and the source in plain language, the text whole
          const names = { title: bt('mainVault.fieldTitle', 'Title'), content: bt('mainVault.contentLabel', 'Text to be saved'), source: bt('mainVault.fieldSource', 'Text from') };
          dt.textContent = names[a.name] || String(a.name || '');
          dd.textContent = a.name === 'source' ? (a.value === 'USER_MESSAGE' ? bt('mainVault.sourceUser', 'Your message') : bt('mainVault.sourceAnswer', 'The previous answer, unedited')) : String(a.value == null ? '' : a.value);
          if (a.name === 'content') dd.className = 'main-vault-content';
        } else {
          dt.textContent = String(a.name || '');
          dd.textContent = String(a.value == null ? '' : a.value);
        }
        list.appendChild(dt);
        list.appendChild(dd);
      });
      box.appendChild(list);
    }
    box.hidden = false;
    scrollStreamToEnd();
  }

  // D-9: the exact text that would be saved to the person's Vault, shown BEFORE anything is requested or stored (textContent only - never markup)
  function renderVaultDraft(turn, plan, draftSource) {
    if (!turn || !turn.el) return;
    const step = plan && Array.isArray(plan.steps) ? plan.steps[0] : null;
    const p = step && step.tool === 'vault.save_note' && step.parameters && typeof step.parameters.content === 'string' ? step.parameters : null;
    let box = turn.el.querySelector('.main-vault-draft');
    if (!p) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('section');
      box.className = 'main-vault-draft';
      const summary = turn.el.querySelector('.main-work-summary');
      if (summary && summary.parentNode) summary.parentNode.insertBefore(box, summary.nextSibling);
      else turn.el.appendChild(box);
    }
    box.textContent = '';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', bt('mainVault.draftLabel', 'Draft to save'));
    const heading = document.createElement('strong');
    heading.textContent = bt('mainVault.draftHeading', 'Exactly this is saved - only after you approve');
    box.appendChild(heading);
    const facts = document.createElement('dl');
    [[bt('mainVault.fieldTitle', 'Title'), String(p.title || '')], [bt('mainVault.fieldWhere', 'Saved to'), bt('mainVault.destination', 'My Vault')], [bt('mainVault.fieldSource', 'Text from'), p.source === 'USER_MESSAGE' ? bt('mainVault.sourceUser', 'Your message') : bt('mainVault.sourceAnswer', 'The previous answer, unedited')]].forEach((row) => {
      const dt = document.createElement('dt');
      dt.textContent = row[0];
      const dd = document.createElement('dd');
      dd.textContent = row[1];
      facts.appendChild(dt);
      facts.appendChild(dd);
    });
    box.appendChild(facts);
    const body = document.createElement('div');
    body.className = 'main-vault-draft-text';
    body.setAttribute('tabindex', '0');
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', bt('mainVault.contentLabel', 'Text to be saved'));
    body.textContent = p.content;
    box.appendChild(body);
    scrollStreamToEnd();
  }

  // Opens the Vault screen and then the saved item itself (its own preview), so "saved" can be checked by looking at it
  // The Vault has two real screens: the desktop one (#view-vault, list #vault-recent-list) and the phone's native one (#mobile-view-vault, list #mh-vault-list). The hash switches the
  // shell to the right one; the item is then opened by THAT screen's own viewer, through the owner-authenticated Vault data it already loads - never a guessed URL.
  async function openVaultItem(vaultItemId) {
    const id = String(vaultItemId || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return;
    window.location.hash = '#vault';
    const app = window.NAGEX || {};
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const phone = document.getElementById('mobile-view-vault');
      if (phone && !phone.hidden && typeof app.openMobileVaultItem === 'function') { app.openMobileVaultItem(id); return; }
      const desk = document.getElementById('vault-recent-list');
      if (desk && desk.offsetParent !== null && desk.querySelector('[onclick*="' + id + '"]') && typeof app.previewVaultItem === 'function') { app.previewVaultItem(id); return; }
    }
    if (typeof app.previewVaultItem === 'function') app.previewVaultItem(id);
  }

  function setPlanNote(turn, text) {
    if (!turn || !turn.el) return;
    let note = turn.el.querySelector('.main-plan-note');
    if (!text) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('p');
      note.className = 'main-plan-note';
      const summary = turn.el.querySelector('.main-work-summary');
      if (summary && summary.parentNode) summary.parentNode.insertBefore(note, summary.nextSibling);
      else turn.el.appendChild(note);
    }
    note.textContent = text;
  }

  function planRunFailureText(code, reasons) {
    if (code === 'PLAN_SEAL_EXPIRED') return bt('mainRun.err.expired', 'This plan is too old to run. Ask again to get a fresh plan.');
    if (code === 'PLAN_SEAL_INVALID' || code === 'PLAN_SEAL_MISSING') return bt('mainRun.err.invalid', "NAgex couldn't confirm that this is the plan you were shown, so nothing was started.");
    if (code === 'PLAN_ALREADY_STARTED') return bt('mainRun.err.started', 'This plan was already sent for approval.');
    if (code === 'PLAN_NOT_RUNNABLE') return runnableReasonText(reasons);
    return bt('mainRun.err.generic', "NAgex couldn't send this plan for approval. Nothing was done.");
  }

  function runnableReasonText(reasons) {
    const list = Array.isArray(reasons) ? reasons : [];
    const table = {
      PLAN_NOT_SINGLE_STEP: bt('mainRun.why.single', 'From Home, NAgex sends one step at a time for approval, and this plan has several.'),
      STEP_NOT_APPROVAL_GATED: bt('mainRun.why.read', 'This step only reads information, so there is nothing to approve - ask in the conversation instead.'),
      TOOL_NOT_SUPPORTED_FROM_HOME: bt('mainRun.why.unsupported', "NAgex can't send this kind of step for approval from Home yet."),
      TOOL_UNAVAILABLE: bt('mainRun.why.unavailable', "The app this needs isn't connected or available here, so it can't be run."),
      ARGUMENTS_MISSING: bt('mainRun.why.args', 'Some details are missing (for example who, what or when). Add them and ask again.'),
      PLAN_BLOCKED: bt('mainRun.why.blocked', "This plan can't be run: a step is blocked or not recognised."),
    };
    return list.map((r) => table[r]).filter(Boolean)[0] || table.PLAN_BLOCKED;
  }

  // "Request approval to run": the reviewed plan (sealed by the server) is sent back; the server checks it is exactly the plan that was shown, for this person, and asks for
  // the approval through the existing approval machinery. NOTHING is executed here. The run starts only after the person approves (the unchanged Approve button below).
  async function startPlanRun(turn, prompt, plan, planSeal) {
    if (!turn || !turn.el || turn.runStarted) return;
    turn.runStarted = true;
    runBlockFor(turn).dataset.flow = 'reviewed';
    renderRun(turn, '', { status: 'RUNNING' }, bt('mainRun.requesting', 'Asking for your approval...'));
    const started = await api('/api/v1/tasks/from-reviewed-plan', { method: 'POST', body: JSON.stringify({ plan, planSeal, prompt }), timeoutMs: 60000 });
    if (!started || started.error || !started.run) {
      const error = started && started.error && typeof started.error === 'object' ? started.error : null;
      const code = error ? error.code : '';
      // an already-started plan is attached to its real run; a refused or failed request leaves the plan reviewable
      if (code === 'PLAN_ALREADY_STARTED' && error.taskId) {
        if (turn.todoId) linkTodo(turn.todoId, { taskId: error.taskId }).then(() => watchTodo(turn.todoId));
        renderRun(turn, error.taskId, { status: 'WAITING_APPROVAL' }, planRunFailureText(code));
        loadInlineApprovals(turn);
        pollRun(turn, error.taskId);
        return;
      }
      if (code !== 'PLAN_SEAL_EXPIRED') turn.runStarted = false;
      renderRun(turn, '', { status: 'FAILED' }, planRunFailureText(code, error && error.reasons));
      return;
    }
    renderProposal(turn, started.proposal);
    if (turn.todoId && started.taskId) linkTodo(turn.todoId, { taskId: started.taskId }).then(() => watchTodo(turn.todoId));
    renderRun(turn, started.taskId, started.run, '');
    if (started.run.status === 'WAITING_APPROVAL') { loadInlineApprovals(turn); pollRun(turn, started.taskId); }
  }

  // Real pending approvals of the signed-in user, rendered inline with working Approve / Reject controls.
  // Nothing is shown (or claimed) when the list cannot be read.
  async function loadInlineApprovals(turn) {
    if (!turn || !turn.el) return;
    const box = turn.el.querySelector('.main-inline-approvals');
    if (!box) return;
    const data = await api('/api/v1/approvals');
    const pending = data && !data.error && Array.isArray(data.pending) ? data.pending : null;
    box.textContent = '';
    if (!pending || pending.length === 0) return;
    const heading = document.createElement('strong');
    heading.textContent = mt('Waiting for your approval');
    box.appendChild(heading);
    pending.slice(0, 5).forEach((approval) => {
      const row = document.createElement('div');
      row.className = 'main-approval-card';
      row.dataset.approvalId = approval.approvalId || approval.id;
      const label = document.createElement('span');
      label.textContent = localizeAppText(approval.action || mt('Approval needed'));
      row.appendChild(label);
      if (approval.expiresAt) {
        const when = document.createElement('small');
        when.textContent = mt('Expires') + ' ' + briefingWhen(approval.expiresAt);
        row.appendChild(when);
      }
      const decide = async (verdict) => {
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        const result = await api('/api/v1/approvals/' + encodeURIComponent(row.dataset.approvalId) + '/' + verdict, { method: 'POST', body: JSON.stringify({}) });
        if (result && !result.error) {
          row.textContent = (verdict === 'approve' ? mt('Approved') : mt('Rejected')) + ' - ' + localizeAppText(approval.action || '');
          row.dataset.decision = verdict;
        } else {
          row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          setComposerNotice(mt('Could not update this approval.'), 'error');
        }
      };
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'btn-primary';
      approve.textContent = mt('Approve');
      approve.addEventListener('click', () => decide('approve'));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'btn-secondary danger';
      reject.textContent = mt('Reject');
      reject.addEventListener('click', () => decide('reject'));
      row.appendChild(approve);
      row.appendChild(reject);
      box.appendChild(row);
    });
  }

  function setComposerNotice(message, tone, raw) {
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
    // raw: the text is already in the screen language and complete (a translated sentence plus a platform hint) - looking it up again could match the sentence alone and drop the hint
    notice.textContent = raw ? message : localizeAppText(message);
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
        showThread(mt('Attachment upload'), 'Error', 'Attachment failed', serverFailure(result, 'The file could not be uploaded.'), [
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
    if (state.voiceAdapter && state.voiceAdapter.isActive()) {
      // the same handler for Enter and the button: stop recording, let the person read what was heard, and send only on the next press
      if (state.voiceMode === 'DICTATION') setComposerNotice(bt('mainVoice.stopFirst', 'Recording stopped. Check the text, then press Enter or Send.'), 'info');
      await state.voiceAdapter.stop();
      return;
    }
    if (!prompt || state.busy) return;
    setComposerNotice('');
    state.busy = true;
    if (send) send.disabled = true;
    hideResult();
    state.activeTurn = null;
    const metadata = requestMetadata();
    // an optional shortcut applies to exactly ONE request: the next plain request is routed by its words again
    const armed = MODES.find((m) => m.id === state.mode);
    state.mode = 'AUTO';
    state.shortcutsOpen = false;
    renderModes();
    // working on a request gives the stream the room: My Day closes (one click reopens it, without touching the conversation or the draft)
    state.myDayOpen = false;
    syncBriefingVisibility();
    showThread(prompt, 'Submitting', 'NAgex is starting from Main.', 'Your request is being classified before any execution path is chosen.', [
      { state: 'done', label: 'Request captured', detail: armed ? modeLabel(armed) : '' },
      { state: 'running', label: 'Classify intent', detail: metadata.allowWebResearch ? 'Web allowed' : 'Web off' },
      { state: 'pending', label: 'Prepare result', detail: '' },
    ]);
    // the question now lives in the conversation stream: clear the composer so it is shown once, not twice
    if (input) { input.value = ''; autoGrow(input); }
    try {
      await dispatchMainRequest(prompt, metadata);
      offerRetryAfterFailure(prompt);
    } catch (error) {
      showThread(prompt, 'Error', bt('mainError.requestFailedTitle', 'NAgex could not finish this request'), bt('mainError.requestFailedBody', 'Something went wrong while handling this request. Your request is still in the box.'), [
        { state: 'done', label: 'Request captured', detail: '' },
        { state: 'running', label: bt('mainError.requestFailedStep', 'Request failed'), detail: '' },
      ]);
    } finally {
      state.busy = false;
      if (send) send.disabled = false;
      keepRequestAfterFailure(prompt);
      const notice = document.getElementById('main-composer-notice');
      if (notice && notice.dataset.tone === 'busy') setComposerNotice('');
    }
  }

  // A request that did not work is not lost: its words go back into the box (only when the box is empty - anything newer the person typed meanwhile stays) so it can be sent again or edited.
  function keepRequestAfterFailure(prompt) {
    const turn = state.activeTurn;
    if (!turn || turn.prompt !== prompt || (turn.status !== 'Error' && turn.status !== 'Unavailable')) return;
    const input = document.getElementById('main-surface-input');
    if (input && !input.value.trim()) { input.value = prompt; autoGrow(input); }
  }

  // A request that ended in an error/unavailable notice can be put back in the composer with one click.
  function offerRetryAfterFailure(prompt) {
    const turn = state.activeTurn;
    if (!turn || turn.kind !== 'notice' || turn.prompt !== prompt) return;
    const actions = turn.el.querySelector('.main-inline-actions');
    if (!actions || actions.children.length > 0) return;
    renderInlineActions([{ id: 'retry', label: 'Try again', action: () => { const input = document.getElementById('main-surface-input'); if (input && !input.value) input.value = prompt; focusComposer(''); } }]);
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
    // "save that to my Vault" may use only the answer the person was looking at when they asked: the one from the turn right before this request. Every request takes that answer out of
    // reach; a Vault-save request puts it back (so asking again after a decline still works), anything else leaves it gone - an old answer never rides along with an unrelated request.
    state.answerForSave = state.lastAnswerFull;
    state.lastAnswerFull = '';
    const route = await classifyInput(prompt, metadata);
    if (route.error) {
      showThread(prompt, 'Error', 'NAgex could not classify the request', route.error.message || 'Intent routing is unavailable.', [
        { state: 'done', label: 'Request captured', detail: metadata.preferredMode },
        { state: 'running', label: 'Intent routing failed', detail: route.error.code || '' },
      ]);
      return;
    }
    const decision = routingDecisionOf(route, metadata);
    const steps = [
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: 'Intent classified', detail: routeLabel(decision) },
      { state: 'running', label: 'Run selected path', detail: route.reason || '' },
    ];
    setStep(steps);

    if (decision.kind === 'CAPTURE') {
      await captureInput(prompt, route);
      return;
    }

    // "지난번 보고서 수정 전 버전과 지금 버전을 비교해줘": about the versions of a report or a deck - answered from the stored versions, nothing is created
    if (decision.kind === 'CONVERSATION' && ((decision.reasonCodes || []).indexOf('COMPARE_VERSIONS') >= 0 || (decision.reasonCodes || []).indexOf('RESTORE_VERSION') >= 0)) {
      await runVersionRequest(prompt, decision);
      return;
    }

    // "Revise" was pressed on a document: the next request is its instruction. Only an action or something unavailable is kept out of that path.
    if (state.revisionTarget && decision.kind !== 'ACTION_PLAN' && decision.kind !== 'UNSUPPORTED' && decision.kind !== 'CLARIFY') {
      await reviseDocument(prompt, metadata, state.revisionTarget);
      return;
    }

    // A deck is open and the request changes it ("한 장 추가하고 전체를 다시 구성해줘"): the revision endpoint of THAT deck, which creates a new deck and leaves the original as it was.
    if (decision.kind === 'CREATE_ARTIFACT' && (decision.reasonCodes || []).indexOf('REVISE_ACTIVE_ARTIFACT') >= 0 && openPresentationId()) {
      await createPresentation(prompt, metadata, { revisionOf: openPresentationId() });
      return;
    }

    // The server decided WHICH existing path serves the request. Each path below is the unchanged route with its own rights and its own approval:
    // an action is only ever a plan that waits for the person's approval; what NAgex cannot do is said plainly; nothing falls through to a chat answer
    // that pretends to be the deliverable.
    switch (decision.kind) {
      case 'CLARIFY':
        showClarification(prompt, decision);
        return;
      case 'UNSUPPORTED':
        showUnsupported(prompt, decision);
        return;
      case 'ACTION_PLAN':
      case 'ADVICE':
        await runPlan(prompt, metadata, route);
        return;
      case 'RESEARCH':
        await runResearch(prompt, metadata);
        return;
      case 'CREATE_ARTIFACT':
        await runCreation(prompt, metadata, decision);
        return;
      default:
        await runAnswer(prompt, metadata, route);
    }
  }

  // The routing decision is owned by the server. A server that only answers with the legacy intent is read the safe way: a plan that needs approval, or a plain answer.
  function routingDecisionOf(route, metadata) {
    if (route && route.decision && typeof route.decision.kind === 'string') return route.decision;
    const legacy = route && route.primaryIntent;
    const kind = legacy === 'COMMAND' ? 'ACTION_PLAN' : legacy === 'LINK_CAPTURE' || legacy === 'CAPTURE' ? 'CAPTURE' : 'CONVERSATION';
    return {
      version: 1, kind, targetArtifactType: null, needs: [], compound: false, supported: true, language: requestLocale(''),
      confidence: route && typeof route.confidence === 'number' ? route.confidence : 0,
      ambiguity: { level: 'NONE', reason: null, clarifyingQuestion: null }, permissionRisk: 'NONE', destructive: false, executionNegated: false, reasonCodes: ['LEGACY_ROUTE'],
    };
  }

  function routeLabel(decision) {
    const labels = {
      CONVERSATION: bt('mainRoute.kind.answer', 'Answer'),
      ADVICE: bt('mainRoute.kind.advice', 'Advice'),
      RESEARCH: bt('mainRoute.kind.research', 'Research with sources'),
      ACTION_PLAN: bt('mainRoute.kind.action', 'Plan for your approval'),
      CAPTURE: bt('mainRoute.kind.capture', 'Save'),
      UNSUPPORTED: bt('mainRoute.kind.unsupported', 'Not available yet'),
      CLARIFY: bt('mainRoute.kind.clarify', 'Needs one detail'),
    };
    if (decision.kind === 'CREATE_ARTIFACT') {
      const artifact = { DOCUMENT: mt('Document'), PRESENTATION: mt('Slides'), IMAGE: mt('Image') }[decision.targetArtifactType] || mt('Document');
      const research = (decision.needs || []).some((n) => n.capability === 'RESEARCH');
      return research ? bt('mainRoute.kind.researchThenCreate', 'Research, then {artifact}').replace('{artifact}', artifact) : bt('mainRoute.kind.create', 'Create {artifact}').replace('{artifact}', artifact);
    }
    return labels[decision.kind] || '';
  }

  function putBackInComposer(prompt) {
    const input = document.getElementById('main-surface-input');
    if (input && !input.value) input.value = prompt;
    focusComposer('');
  }

  // One minimal question, no side effect: nothing was started, nothing was spent.
  function showClarification(prompt, decision) {
    const question = decision.ambiguity && decision.ambiguity.clarifyingQuestion;
    const text = question ? (decision.language === 'ko' ? question.ko : question.en) : bt('mainRoute.clarifyBody', 'Tell me a little more about what you want.');
    showThread(prompt, 'Ready', bt('mainRoute.clarifyTitle', 'One quick question'), text, [
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: 'Intent classified', detail: routeLabel(decision) },
      { state: 'running', label: bt('mainRoute.waitingForDetail', 'Waiting for your answer'), detail: '' },
    ]);
    renderInlineActions([{ id: 'edit', label: bt('mainRoute.editRequest', 'Edit request'), action: () => putBackInComposer(prompt) }]);
  }

  // What NAgex cannot do is said plainly. Nothing was created or run, and the request is never answered as if it had been.
  function showUnsupported(prompt, decision) {
    const video = decision.targetArtifactType === 'VIDEO';
    const title = video ? bt('mainRoute.videoTitle', "Video creation isn't available yet") : bt('mainRoute.codeTitle', "Building or running an app isn't available yet");
    const body = video
      ? bt('mainRoute.videoBody', "NAgex can't make videos yet, so nothing was created. I can write a script or storyboard, make an image, or build slides instead - just ask.")
      : bt('mainRoute.codeBody', "NAgex can't build, run or host an app or website yet, so nothing was created or run. I can still explain code or answer coding questions here.");
    showThread(prompt, 'Unavailable', title, body, [
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: 'Intent classified', detail: routeLabel(decision) },
      { state: 'pending', label: bt('mainRoute.nothingCreated', 'Nothing was created or run'), detail: '' },
    ]);
    renderInlineActions([{ id: 'edit', label: bt('mainRoute.editRequest', 'Edit request'), action: () => putBackInComposer(prompt) }]);
  }

  // The answer on screen is remembered twice: a short copy that travels as context for "make slides from this", and the whole text (bounded) that a "save that to my Vault" request may use.
  // The whole text is only ever sent when the person asks to save, and it is shown in full, as the draft, before anything is requested or stored.
  function rememberAnswer(text) {
    const full = String(text == null ? '' : text);
    state.lastContext = full.slice(0, 6000);
    state.lastAnswerFull = full.slice(0, 20001);
  }

  // Only the first N characters of a previous answer ever travel as context for "make slides from this".
  function withContext(prompt) {
    const nl = String.fromCharCode(10);
    return prompt + nl + nl + 'Source material (the previous answer in this conversation):' + nl + String(state.lastContext || '').slice(0, 6000);
  }

  async function runCreation(prompt, metadata, decision) {
    const target = decision.targetArtifactType;
    if ((target === 'DOCUMENT' || target === 'PRESENTATION') && (decision.needs || []).some((n) => n.capability === 'RESEARCH')) {
      // a report is searched, retrieved, verified and composed on the server (the document carries its own source list); slides are still written from the research answer
      if (target === 'DOCUMENT') await runResearchReport(prompt, metadata, decision);
      else await runResearchThenCreate(prompt, metadata, decision);
      return;
    }
    let apiPrompt = prompt;
    if (decision.ambiguity && decision.ambiguity.level === 'HIGH' && decision.ambiguity.reason === 'MISSING_TOPIC') {
      const refersBack = (decision.reasonCodes || []).indexOf('CONTEXT_REFERENCE') >= 0;
      if (refersBack && state.lastContext && (target === 'DOCUMENT' || target === 'PRESENTATION')) apiPrompt = withContext(prompt);
      else { showClarification(prompt, decision); return; }
    }
    if (target === 'DOCUMENT') await createDocument(prompt, metadata, { apiPrompt });
    else if (target === 'PRESENTATION') {
      // "이 보고서로 발표자료 8장": the deck is built from that document (read by the server, which checks that it is the person's own)
      const fromDocument = (decision.reasonCodes || []).indexOf('SOURCE_ACTIVE_DOCUMENT') >= 0 && state.recentDocument && state.recentDocument.artifactId;
      await createPresentation(prompt, metadata, { apiPrompt, ...(fromDocument ? { sourceArtifactIds: [state.recentDocument.artifactId] } : {}) });
    }
    else if (target === 'IMAGE') await createImage(prompt, metadata, { researchSkipped: (decision.reasonCodes || []).indexOf('RESEARCH_NOT_USED_FOR_IMAGE') >= 0 });
    else showUnsupported(prompt, decision);
  }

  function researchSourceLines(sources) {
    return (Array.isArray(sources) ? sources : []).slice(0, 12).map((s, i) => '[' + (i + 1) + '] ' + String(s.title || s.sourceName || s.url || '').slice(0, 160) + (s.url ? ' - ' + s.url : ''));
  }

  function researchReportPrompt(prompt, research, artifact) {
    const nl = String.fromCharCode(10);
    return [
      prompt,
      '',
      'Write the ' + (artifact || 'report') + ' ONLY from these verified research findings. Cite the numbered sources where they support a statement. Do not add facts that are not in the findings or the sources.',
      '',
      'FINDINGS:',
      String(research.answer || ''),
      '',
      'SOURCES:',
    ].concat(researchSourceLines(research.sources)).join(nl);
  }

  // "Research X and turn it into a report": the research is real and runs first; the report is written from ITS findings only. If no verified source
  // exists the report is not written at all (an unsourced report would be a fake deliverable) and the person is told which step stopped.
  async function runResearchThenCreate(prompt, metadata, decision) {
    const target = decision.targetArtifactType;
    const artifactName = target === 'PRESENTATION' ? mt('Slides') : target === 'IMAGE' ? mt('Image') : mt('Document');
    setStep([
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: 'Intent classified', detail: routeLabel(decision) },
      { state: 'running', label: bt('mainRoute.stepResearch', 'Collecting and checking sources'), detail: '' },
      { state: 'pending', label: bt('mainRoute.stepThenCreate', 'Then write the {artifact}').replace('{artifact}', artifactName), detail: '' },
    ]);
    const research = await api('/api/v1/research', { method: 'POST', body: JSON.stringify({ query: prompt, requestMetadata: metadata }) });
    if (!research || research.error || research.status || !research.answer) {
      showThread(prompt, 'Unavailable', bt('mainRoute.researchStoppedTitle', 'The research step could not be completed'), serverFailure(research, bt('mainRoute.researchStoppedBody', 'No verified research result is available from the current providers.')) + ' ' + bt('mainRoute.reportNotWritten', 'No report was written, because it would not rest on verified sources.'), [
        { state: 'done', label: 'Request captured', detail: '' },
        { state: 'running', label: 'Research unavailable', detail: research && research.status ? research.status : '' },
        { state: 'pending', label: bt('mainRoute.nothingCreated', 'Nothing was created or run'), detail: '' },
      ]);
      return;
    }
    rememberAnswer(research.answer);
    const sourceCount = Array.isArray(research.sources) ? research.sources.length : 0;
    const lead = [{ state: 'done', label: 'Sources checked', detail: String(sourceCount) }];
    if (target === 'PRESENTATION') await createPresentation(prompt, metadata, { apiPrompt: researchReportPrompt(prompt, research, 'slides'), leadSteps: lead });
    else await createDocument(prompt, metadata, { apiPrompt: researchReportPrompt(prompt, research), leadSteps: lead });
  }

  // "Research X and write a report with sources": the server searches with the configured provider, fetches the pages it is allowed to read, keeps only statements it could verify in the retrieved text,
  // composes the report itself and saves it as a document. If a step cannot be done the person is told which one - and no report exists.
  function researchSteps(steps, failureLabel, failureDetail) {
    const labels = {
      PLAN: bt('mainResearch.stepPlan', 'Planning the searches'),
      SEARCH: bt('mainResearch.stepSearch', 'Searching for sources'),
      RETRIEVE: bt('mainResearch.stepRetrieve', 'Reading the sources'),
      EXTRACT: bt('mainResearch.stepExtract', 'Checking statements against the sources'),
      COMPOSE: bt('mainResearch.stepCompose', 'Writing the report from verified statements'),
      PUBLISH: bt('mainResearch.stepPublish', 'Saving the report'),
    };
    const out = [{ state: 'done', label: 'Request captured', detail: '' }];
    (Array.isArray(steps) ? steps : []).forEach((s) => {
      if (s.status === 'FAILED') return;
      out.push({ state: 'done', label: labels[s.step] || s.step, detail: s.detail || '' });
    });
    if (failureLabel) out.push({ state: 'running', label: failureLabel, detail: failureDetail || '' });
    return out;
  }

  function researchStopMessage(result) {
    const code = String((result && result.code) || '');
    if (code === 'SEARCH_UNAVAILABLE') return { title: bt('mainResearch.unavailableTitle', 'Research is not available'), body: bt('mainResearch.unavailableBody', 'Live web search is not configured, so no research was performed and no report was written.') };
    if (code === 'SEARCH_AUTH_FAILED' || code === 'SEARCH_RATE_LIMITED' || code === 'SEARCH_PROVIDER_ERROR' || code === 'SEARCH_TIMEOUT' || code === 'SEARCH_FAILED' || code === 'SEARCH_INVALID_RESPONSE') return { title: bt('mainResearch.searchFailedTitle', 'The search did not work'), body: bt('mainResearch.searchFailedBody', 'The search provider could not be used right now, so no report was written. Try again later.') };
    if (code === 'SEARCH_NO_RESULTS') return { title: bt('mainResearch.noResultsTitle', 'No sources found'), body: bt('mainResearch.noResultsBody', 'The search found no sources for this question, so no report was written.') };
    if (code === 'NO_SOURCE_RETRIEVED' || code === 'NO_VERIFIABLE_CLAIMS' || code === 'NO_SUPPORTED_REPORT') return { title: bt('mainResearch.noEvidenceTitle', 'Not enough verifiable evidence'), body: bt('mainResearch.noEvidenceBody', 'The sources that could be read did not contain enough statements that could be checked against their text, so no report was written rather than one that is not backed by sources.') };
    return { title: bt('mainResearch.failedTitle', 'The research could not be completed'), body: bt('mainResearch.failedBody', 'A step of the research failed, so no report was written.') };
  }

  async function runResearchReport(prompt, metadata, decision) {
    setStep([
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: 'Intent classified', detail: routeLabel(decision) },
      { state: 'running', label: bt('mainResearch.stepRunning', 'Searching, reading and checking sources'), detail: '' },
      { state: 'pending', label: bt('mainResearch.stepThenWrite', 'Then write the report from what was verified'), detail: '' },
    ]);
    const result = await api('/api/v1/research/reports', { method: 'POST', body: JSON.stringify({ query: prompt, locale: requestLocale(prompt) }), timeoutMs: 300000 });
    if (!result || result.error || result.status !== 'SUCCESS') {
      const stop = researchStopMessage(result);
      showThread(prompt, result && result.status === 'UNAVAILABLE' ? 'Unavailable' : 'Error', stop.title, stop.body, researchSteps(result && result.steps, bt('mainResearch.stopped', 'Research stopped'), result && result.code ? result.code : '').concat([{ state: 'pending', label: bt('mainRoute.nothingCreated', 'Nothing was created or run'), detail: '' }]));
      return;
    }
    const full = result.documentId ? await api('/api/v1/creations/documents/' + encodeURIComponent(result.documentId)) : null;
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const cited = Array.isArray(result.sources) ? result.sources.length : 0;
    showThread(prompt, 'Completed', bt('mainResearch.createdTitle', 'Research report created'), bt('mainResearch.createdBody', '{n} sources were read and cited. Every statement was checked against the retrieved text. Open the report to see the sources and how they were read.').replace('{n}', String(cited)), researchSteps(result.steps).concat([{ state: 'done', label: 'Result panel opened', detail: result.artifactId || '' }]));
    showResult({
      type: 'DOCUMENT',
      title: result.title || (projection && projection.title) || 'Research report',
      meta: ['DOCX', cited + ' ' + bt('mainResearch.sourcesMeta', 'sources')].join(' - '),
      preview: (full && full.document && full.document.content) || (projection && projection.preview) || result.summary || '',
      artifactId: result.artifactId,
      documentId: result.documentId,
      researchRunId: result.runId,
      openTarget: result.openTarget,
      projection,
    });
    offerArtifactTodos(result.artifactId);
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
      showThread(prompt, 'Error', 'Capture could not be saved', serverFailure(result, 'The workspace capture endpoint did not save this request.'), [
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
      showThread(prompt, 'Unavailable', 'Answer is unavailable', serverFailure(result, 'The answer provider did not return a usable response.'), [
        { state: 'done', label: 'Intent classified', detail: routeLabel(routingDecisionOf(route, metadata)) },
        { state: 'running', label: 'Answer unavailable', detail: result && result.error && result.error.code ? result.error.code : '' },
      ]);
      return;
    }
    const answer = (result.data && result.data.message) || result.message || '';
    if (answer) rememberAnswer(answer);
    showThread(prompt, 'Answered', 'NAgex answered inline', answer || 'NAgex returned an empty answer.', [
      { state: 'done', label: 'Intent classified', detail: routeLabel(routingDecisionOf(route, metadata)) },
      { state: 'done', label: 'Answer prepared', detail: (result.data && result.data.messageId) || result.requestId || '' },
    ]);
    renderInlineActions([
      { id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') },
      { id: 'save', label: 'Save to Vault', action: () => saveTextToVault(answer || prompt) },
    ]);
    offerConversationTodos(state.activeTurn, prompt, answer);
  }

  // options.apiPrompt: what the creation route is asked (the original words plus source material); the thread always shows the person's own words.
  // options.leadSteps: stages that already finished in front of this one (the research of "research, then write a report").
  async function createDocument(prompt, metadata, options) {
    const opts = options || {};
    const lead = Array.isArray(opts.leadSteps) ? opts.leadSteps : [];
    const apiPrompt = opts.apiPrompt || prompt;
    const result = await api('/api/v1/creations/documents', {
      method: 'POST',
      body: JSON.stringify({ prompt: apiPrompt, locale: requestLocale(opts.localeSource || prompt), requestMetadata: metadata }),
    });
    if (!result || result.error) {
      showThread(prompt, 'Error', 'Document could not be created', serverFailure(result, 'No document result is available.'), lead.concat([
        { state: 'done', label: 'Request captured', detail: 'Document' },
        { state: 'running', label: 'Creation failed', detail: '' },
      ]));
      return;
    }
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const documentId = result.documentId || result.creationId || parseDocumentId(result.openTarget || (projection && projection.openTarget));
    showThread(prompt, 'Completed', 'Document created', 'The result is ready in the right panel. You can revise it or open the detailed viewer.', lead.concat([
      { state: 'done', label: 'Request captured', detail: 'Document' },
      { state: 'done', label: 'Document generated', detail: result.creationId || result.documentId || '' },
      { state: 'done', label: 'Result panel opened', detail: result.artifactId || '' },
    ]));
    showResult({
      type: 'DOCUMENT',
      title: result.title || (projection && projection.title) || 'Generated document',
      meta: [documentId ? 'DOCX' : 'Markdown', result.artifactId ? 'artifact ready' : 'artifact unavailable'].join(' - '),
      preview: result.content || (projection && projection.preview) || 'The document was created, but no inline preview is available.',
      artifactId: result.artifactId,
      documentId,
      openTarget: result.openTarget,
      projection,
    });
    offerArtifactTodos(result.artifactId);
  }

  async function createImage(prompt, metadata, opts) {
    opts = opts || {};
    // "research X and draw it": the image is made from the description only - say so instead of implying a research step that did not run
    const noResearch = opts.researchSkipped ? ' ' + bt('mainRoute.imageNoResearch', 'Images are made from your description - no research step is run for images.') : '';
    const result = await api('/api/v1/creations/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        type: 'IMAGE',
        creationKind: 'IMAGE',
        recipe: { type: 'IMAGE', aspectRatio: '1:1', locale: requestLocale(prompt) },
        requestMetadata: metadata,
      }),
      timeoutMs: 120000,
    });
    if (!result || result.error || result.status === 'FAILED' || result.status === 'UNAVAILABLE') {
      showThread(prompt, 'Unavailable', 'Image generation is unavailable', serverFailure(result, 'No configured image provider produced a real image.') + noResearch, [
        { state: 'done', label: 'Request captured', detail: 'Image' },
        { state: 'running', label: 'Image provider unavailable', detail: (result && (result.error || result.errorCode || result.status)) || '' },
      ]);
      return;
    }
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    const imageUrl = result.imageUrl || result.outputAssetUrl || result.openTarget || (projection && projection.openTarget);
    showThread(prompt, 'Completed', 'Image created', 'The image result is ready in the right panel.' + noResearch, [
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
      mimeType: result.mimeType,
      artifactId: result.artifactId,
      openTarget: result.openTarget || imageUrl,
      projection,
    });
  }

  // NAgex-owned presentation identity and download path; anything else is never rendered as a link
  const PRESENTATION_DOWNLOAD_PATH = /^\/api\/v1\/creations\/presentations\/pres_[0-9a-f]{24}\/download$/;
  const PRESENTATION_VIEW_PATH = /^\/api\/v1\/creations\/presentations\/pres_[0-9a-f]{24}$/;

  async function createPresentation(prompt, metadata, options) {
    const opts = options || {};
    const lead = Array.isArray(opts.leadSteps) ? opts.leadSteps : [];
    const revisionOf = opts.revisionOf || null;
    const result = await api(revisionOf ? '/api/v1/creations/presentations/' + encodeURIComponent(revisionOf) + '/revisions' : '/api/v1/creations/presentations', {
      method: 'POST',
      body: JSON.stringify(revisionOf
        ? { instruction: prompt, locale: requestLocale(prompt) }
        : { prompt: opts.apiPrompt || prompt, locale: requestLocale(prompt), requestMetadata: metadata, ...(Array.isArray(opts.sourceArtifactIds) && opts.sourceArtifactIds.length > 0 ? { sourceArtifactIds: opts.sourceArtifactIds } : {}) }),
      timeoutMs: 180000,
    });
    if (!result || result.error || result.status === 'FAILED' || result.status === 'UNAVAILABLE') {
      showThread(prompt, 'Error', revisionOf ? bt('mainSlides.reviseFailedTitle', 'Presentation could not be revised') : bt('mainSlides.failedTitle', 'Presentation could not be created'), serverFailure(result, bt('mainSlides.failedBody', 'No presentation was produced.')), lead.concat([
        { state: 'done', label: 'Request captured', detail: 'Slides' },
        { state: 'running', label: 'Creation failed', detail: '' },
      ]));
      return;
    }
    const viewer = result.openTarget && PRESENTATION_VIEW_PATH.test(result.openTarget) ? await api(result.openTarget) : null;
    const deck = viewer && viewer.presentation ? viewer.presentation : null;
    const artifact = result.artifactId ? await api('/api/v1/artifacts/' + encodeURIComponent(result.artifactId)) : null;
    const projection = artifact && artifact.projection ? artifact.projection : null;
    showThread(prompt, 'Completed', revisionOf ? bt('mainSlides.revisedTitle', 'Presentation revised') : bt('mainSlides.createdTitle', 'Presentation created'), revisionOf ? bt('mainSlides.revisedBody', 'A revised presentation is ready in the right panel. The original is unchanged.') : bt('mainSlides.createdBody', 'The presentation is ready in the right panel. Download the .pptx to edit it in PowerPoint or Keynote.'), lead.concat([
      { state: 'done', label: 'Request captured', detail: 'Slides' },
      { state: 'done', label: bt('mainSlides.stepPlanned', 'Deck planned'), detail: '' },
      { state: 'done', label: bt('mainSlides.stepFile', 'Presentation file created'), detail: '' },
    ]));
    showResult(presentationResult(deck || { presentationId: result.creationId, title: result.title, subtitle: '', slides: [], downloadTarget: result.metadata && result.metadata.downloadTarget }, result.artifactId, result.openTarget, projection, result.content));
  }

  function presentationResult(deck, artifactId, openTarget, projection, fallbackText) {
    const slides = Array.isArray(deck.slides) ? deck.slides : [];
    return {
      type: 'PRESENTATION',
      title: deck.title || 'Presentation',
      meta: [bt('mainSlides.count', '{n} slides').replace('{n}', String(slides.length + 1)), '.pptx'].join(' - '),
      preview: fallbackText || deck.summary || '',
      slides,
      subtitle: deck.subtitle || '',
      downloadTarget: PRESENTATION_DOWNLOAD_PATH.test(String(deck.downloadTarget || '')) ? deck.downloadTarget : '',
      artifactId,
      openTarget,
      projection,
    };
  }

  async function reviseDocument(prompt, metadata, target) {
    const result = await api('/api/v1/creations/documents/' + encodeURIComponent(target.documentId) + '/revisions', {
      method: 'POST',
      body: JSON.stringify({ instruction: prompt, requestMetadata: metadata }),
    });
    if (!result || result.error || result.ok === false) {
      showThread(prompt, 'Error', 'Document revision could not be created', (result && result.message) || serverFailure(result, 'The document revision endpoint did not create a revision.'), [
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
      meta: [documentId ? 'DOCX' : 'Markdown', 'revision ready'].join(' - '),
      preview: result.content || (projection && projection.preview) || 'The document revision was created, but no inline preview is available.',
      artifactId: result.artifactId || target.artifactId,
      documentId,
      openTarget: result.openTarget || (projection && projection.openTarget),
      projection,
    });
    offerArtifactTodos(result.artifactId || target.artifactId);
  }

  async function runResearch(prompt, metadata) {
    const result = await api('/api/v1/research', {
      method: 'POST',
      body: JSON.stringify({ query: prompt, requestMetadata: metadata }),
    });
    if (!result || result.error || result.status) {
      showThread(prompt, 'Unavailable', 'Research is unavailable', serverFailure(result, 'No verified research result is available from the current providers.'), [
        { state: 'done', label: 'Request captured', detail: 'Research' },
        { state: 'running', label: 'Research unavailable', detail: result && result.status ? result.status : '' },
      ]);
      return;
    }
    // the sources are shown with the answer: "with sources" is only true when the person can open them
    const nl = String.fromCharCode(10);
    const sourceList = (Array.isArray(result.sources) ? result.sources : []).slice(0, 12)
      .filter((s) => s && /^https?:\/\//i.test(String(s.url || '')))
      .map((s, i) => '- [' + (i + 1) + '] [' + String(s.title || s.sourceName || s.url).replace(/[\[\]]/g, '') + '](' + String(s.url).replace(/\s/g, '') + ')');
    const answerText = result.answer || 'Research completed.';
    const markdown = sourceList.length ? answerText + nl + nl + '**' + bt('mainRoute.sources', 'Sources') + '**' + nl + sourceList.join(nl) : answerText;
    if (result.answer) rememberAnswer(result.answer);
    showThread(prompt, 'Completed', 'Research result', markdown, [
      { state: 'done', label: 'Request captured', detail: 'Research' },
      { state: 'done', label: 'Sources checked', detail: Array.isArray(result.sources) ? String(result.sources.length) : '' },
      { state: 'done', label: 'Answer prepared', detail: '' },
    ]);
    renderInlineActions([
      { id: 'follow', label: 'Ask follow-up', action: () => focusComposer(result.answer || '') },
      // the report is a NEXT STEP the person confirms: it is written from these findings only
      { id: 'report', label: 'Create report', action: () => createReportFromResearch(prompt, metadata, result) },
      { id: 'save', label: 'Save to Vault', action: () => saveTextToVault(result.answer || prompt) },
    ]);
  }

  async function createReportFromResearch(prompt, metadata, research) {
    if (state.busy) return;
    state.busy = true;
    const send = document.getElementById('main-send');
    if (send) send.disabled = true;
    try {
      const shown = bt('mainRoute.reportFromFindings', 'Create a report from these findings');
      state.activeTurn = null;
      showThread(shown, 'Submitting', 'NAgex is starting from Main.', 'Your request is being classified before any execution path is chosen.', [
        { state: 'done', label: 'Request captured', detail: '' },
        { state: 'running', label: bt('mainRoute.stepWriteReport', 'Writing the report from the verified findings'), detail: '' },
      ]);
      await createDocument(shown, metadata, { apiPrompt: researchReportPrompt(prompt, research), localeSource: prompt, leadSteps: [{ state: 'done', label: 'Sources checked', detail: Array.isArray(research.sources) ? String(research.sources.length) : '' }] });
    } finally {
      state.busy = false;
      if (send) send.disabled = false;
    }
  }

  // ── Next actions (TODOs) ──────────────────────────────────────────────────────────────────────────────────
  // A report offers the follow-up that follows from it (a deck from that very document); a request for "next steps / to-dos" gets what the person asked for; an advice answer's suggestions are split into
  // what NAgex can run and what stays advice. Only a TODO the server classified as runnable has a button, only the one the person presses runs, and it runs as THE SAME REQUEST they could have typed:
  // the normal route, plan preview, approval and run. Its state on screen is what the server reads from the task engine / artifact store - the screen never marks anything done by itself.
  const TODO_ASK = /(할\s*일|투두|to-?\s?do\b|todo\b|next\s+steps?|next\s+actions?|action\s+items?|액션\s*아이템|checklist|체크\s*리스트|다음\s*(단계|행동|작업|할\s*일)|해야\s*(할|하는|될)\s*(일|것|작업)|what\s+should\s+i\s+do\s+next)/i;
  const TODO_STATES = ['PROPOSED', 'APPROVAL_REQUIRED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];
  const TODO_DEFAULT_LABEL = { PROPOSED: 'Suggested', APPROVAL_REQUIRED: 'Needs your approval', IN_PROGRESS: 'In progress', COMPLETED: 'Done', FAILED: 'Did not work' };
  const TODO_NOTES = {
    APPROVAL_PENDING: ['mainTodo.note.APPROVAL_PENDING', 'Waiting for your approval. Nothing has happened yet.'],
    PLAN_ONLY: ['mainTodo.note.PLAN_ONLY', 'A plan is ready. Nothing was run yet - request approval to run it.'],
    RUNNING: ['mainTodo.note.RUNNING', 'Working on it...'],
    CREATED: ['mainTodo.note.CREATED', 'Created - it is open in the panel.'],
    VERIFIED: ['mainTodo.note.VERIFIED', 'Done and confirmed.'],
    RESPONDED: ['mainTodo.note.RESPONDED', 'The tool answered; NAgex did not confirm the result separately.'],
    DECLINED: ['mainTodo.note.DECLINED', 'You declined it, so it was not run.'],
    EXPIRED: ['mainTodo.note.EXPIRED', 'The approval expired, so it was not run.'],
    MISMATCH: ['mainTodo.note.MISMATCH', 'It was sent, but your calendar shows something different.'],
    NOT_CONFIRMED: ['mainTodo.note.NOT_CONFIRMED', 'It was sent, but NAgex could not confirm it.'],
    NOT_EXECUTED: ['mainTodo.note.NOT_EXECUTED', 'NAgex only answered; nothing was done.'],
    FAILED: ['mainTodo.note.FAILED', 'It did not work out. You can try again.'],
  };

  function todoNoteText(todo) {
    if (todo.state === 'PROPOSED') return '';
    const entry = TODO_NOTES[todo.detail && todo.detail.code] || (todo.state === 'FAILED' ? TODO_NOTES.FAILED : null);
    return entry ? bt(entry[0], entry[1]) : '';
  }

  function paintTodo(li, todo) {
    li.dataset.state = todo.state;
    const label = li.querySelector('.main-todo-state');
    if (label) label.textContent = bt('mainTodo.state.' + todo.state, TODO_DEFAULT_LABEL[todo.state] || todo.state);
    const note = li.querySelector('.main-todo-note');
    if (note) { const text = todoNoteText(todo); note.textContent = text; note.hidden = !text; }
    // a button only where choosing it can do something: not yet started, or it did not work and may be tried again
    let button = li.querySelector('.main-todo-run');
    const runnable = todo.state === 'PROPOSED' || todo.state === 'FAILED';
    if (runnable && !button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary main-todo-run';
      button.addEventListener('click', () => runTodo(todo.todoId, button));
      li.appendChild(button);
    }
    if (!runnable && button) button.remove();
    if (button) { button.disabled = false; button.textContent = todo.state === 'FAILED' ? bt('mainTodo.retry', 'Try again') : bt('mainTodo.run', 'Do this'); }
    li.dataset.title = todo.title;
  }

  function todoItem(todo) {
    const li = document.createElement('li');
    li.className = 'main-todo';
    li.dataset.todoId = todo.todoId;
    li.dataset.kind = todo.kind;
    const head = document.createElement('div');
    head.className = 'main-todo-head';
    const stateEl = document.createElement('span');
    stateEl.className = 'main-todo-state';
    const title = document.createElement('span');
    title.className = 'main-todo-title';
    title.textContent = todo.title;
    head.appendChild(title);
    head.appendChild(stateEl);
    li.appendChild(head);
    // what choosing it will really do: the kind of path (from the router's decision on the very words below) and the exact request
    const what = document.createElement('div');
    what.className = 'main-todo-what';
    const kind = document.createElement('span');
    kind.className = 'main-todo-kind';
    kind.textContent = bt('mainTodo.kind.' + todo.kind, todo.kind);
    const asked = document.createElement('span');
    asked.className = 'main-todo-prompt';
    asked.textContent = bt('mainTodo.asks', 'Request:') + ' ' + todo.prompt;
    what.appendChild(kind);
    what.appendChild(asked);
    li.appendChild(what);
    const note = document.createElement('div');
    note.className = 'main-todo-note';
    li.appendChild(note);
    paintTodo(li, todo);
    return li;
  }

  function renderTodoBlock(turn, suggestions) {
    if (!turn || !turn.el || !turn.el.isConnected) return;
    const todos = suggestions && Array.isArray(suggestions.todos) ? suggestions.todos : [];
    const recommendations = suggestions && Array.isArray(suggestions.recommendations) ? suggestions.recommendations.filter((s) => typeof s === 'string' && s.trim()) : [];
    const old = turn.el.querySelector('.main-todos');
    if (old) old.remove();
    if (!todos.length && !recommendations.length) return;
    const block = document.createElement('section');
    block.className = 'main-todos';
    block.setAttribute('aria-label', bt('mainTodo.title', 'Next actions'));
    if (todos.length) {
      const heading = document.createElement('h3');
      heading.textContent = bt('mainTodo.title', 'Next actions');
      block.appendChild(heading);
      const list = document.createElement('ul');
      list.className = 'main-todo-list';
      todos.forEach((todo) => list.appendChild(todoItem(todo)));
      block.appendChild(list);
    }
    if (recommendations.length) {
      const heading = document.createElement('h4');
      heading.textContent = bt('mainTodo.recsTitle', 'For you to do yourself (NAgex does not run these)');
      block.appendChild(heading);
      const list = document.createElement('ul');
      list.className = 'main-todo-recs';
      recommendations.forEach((text) => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); });
      block.appendChild(list);
    }
    const anchor = turn.el.querySelector('.main-inline-actions');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(block, anchor); else turn.el.appendChild(block);
    scrollStreamToEnd();
  }

  function updateTodoViews(views) {
    (views || []).forEach((todo) => {
      document.querySelectorAll('.main-todo[data-todo-id="' + todo.todoId + '"]').forEach((li) => paintTodo(li, todo));
    });
  }

  async function refreshTodos() {
    const result = await api('/api/v1/todos');
    const todos = result && !result.error && Array.isArray(result.todos) ? result.todos : [];
    updateTodoViews(todos);
    return todos;
  }

  async function linkTodo(todoId, body) {
    const result = await api('/api/v1/todos/' + encodeURIComponent(todoId) + '/link', { method: 'POST', body: JSON.stringify(body) });
    if (result && result.todo) updateTodoViews([result.todo]);
    return result;
  }

  // follows a TODO whose state is decided elsewhere (an approval, a run) until it is settled
  function watchTodo(todoId) {
    state.todoWatch = state.todoWatch || {};
    if (state.todoWatch[todoId]) return;
    state.todoWatch[todoId] = true;
    (async () => {
      for (let i = 0; i < 150; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const todo = (await refreshTodos()).find((t) => t.todoId === todoId);
        if (!todo || todo.state === 'COMPLETED' || todo.state === 'FAILED' || todo.state === 'PROPOSED') break;
      }
      state.todoWatch[todoId] = false;
    })();
  }

  async function offerArtifactTodos(artifactId) {
    const turn = state.activeTurn;
    if (!/^art_[0-9a-f]{24}$/.test(String(artifactId || ''))) return;
    const result = await api('/api/v1/todos/suggest', { method: 'POST', body: JSON.stringify({ artifactId }) });
    if (result && !result.error && Array.isArray(result.todos)) renderTodoBlock(turn, result);
  }

  // only when the person asked for a to-do list / next steps; a plain question gets no list
  async function offerConversationTodos(turn, message, answer, options) {
    if (!TODO_ASK.test(message)) return;
    const result = await api('/api/v1/todos/suggest', { method: 'POST', body: JSON.stringify({ message, answer, timezone: clientTimezone() }), timeoutMs: 90000 });
    // after an advice answer the advice already lists what the person has to do themselves: only what NAgex can do is added
    if (result && !result.error && Array.isArray(result.todos)) { renderTodoBlock(turn, options && options.todosOnly ? { todos: result.todos, recommendations: [] } : result); return; }
    if (turn && turn.el && turn.el.isConnected) {
      const note = document.createElement('p');
      note.className = 'main-todos-note';
      note.textContent = bt('mainTodo.unavailable', 'The next actions could not be prepared right now.');
      const anchor = turn.el.querySelector('.main-inline-actions');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(note, anchor);
    }
  }

  // The person chose this one. It runs through the same handler as typed text (Enter / Send): route, plan preview, approval and run are unchanged.
  async function runTodo(todoId, button) {
    if (state.busy) { setComposerNotice(bt('mainTodo.busy', 'Finish the current request first.'), 'info'); return; }
    if (state.voiceAdapter && state.voiceAdapter.isActive()) { setComposerNotice(bt('mainVoice.stopFirst', 'Recording stopped. Check the text, then press Enter or Send.'), 'info'); return; }
    if (button) button.disabled = true;
    const started = await api('/api/v1/todos/' + encodeURIComponent(todoId) + '/start', { method: 'POST', body: '{}' });
    if (!started || started.error || typeof started.prompt !== 'string') {
      if (button) button.disabled = false;
      setComposerNotice(bt('mainTodo.unavailable', 'The next actions could not be prepared right now.'), 'error');
      refreshTodos();
      return;
    }
    updateTodoViews([started.todo]);
    // a follow-up that continues from a report continues from THAT report, whatever else was opened since
    if (started.source && /^art_[0-9a-f]{24}$/.test(String(started.source.artifactId || '')) && /^doc_[0-9a-f]{24}$/.test(String(started.source.documentId || ''))) {
      state.recentDocument = { artifactId: started.source.artifactId, documentId: started.source.documentId, title: started.todo.title || '' };
    }
    const input = document.getElementById('main-surface-input');
    const draft = input ? input.value : '';
    state.pendingTodoId = todoId;
    state.todoRun = { todoId, artifactId: null };
    if (input) { input.value = started.prompt; autoGrow(input); }
    await sendRequest();
    const run = state.todoRun;
    state.todoRun = null;
    state.pendingTodoId = null;
    if (input && draft && !input.value) { input.value = draft; autoGrow(input); }
    // what the request produced, reported for the server to verify (a success is never taken on trust)
    const turn = state.activeTurn;
    if (turn && turn.todoId === todoId) {
      if (turn.status === 'Error' || turn.status === 'Unavailable') await linkTodo(todoId, { failure: { code: 'REQUEST_FAILED' } });
      else if (run && run.artifactId) await linkTodo(todoId, { artifactId: run.artifactId });
      else if (turn.kind === 'answer') await linkTodo(todoId, { failure: { code: 'NOT_EXECUTED' } });
      else await refreshTodos();
    } else {
      await refreshTodos();
    }
  }

  async function runPlan(prompt, metadata, route) {
    // "save that to my Vault": the answer on screen goes along ONLY for that request; the server uses it only when the request names no text of its own
    const savesToVault = ((routingDecisionOf(route, metadata).reasonCodes) || []).indexOf('VAULT_SAVE') >= 0;
    const result = await api('/api/v1/ambient/intent', {
      method: 'POST',
      body: JSON.stringify(savesToVault && state.answerForSave ? { prompt, requestMetadata: metadata, saveContext: state.answerForSave } : { prompt, requestMetadata: metadata }),
      timeoutMs: 120000,
    });
    if (savesToVault && state.answerForSave && result && !result.error && (result.status === 'PLAN_PREVIEW' || result.status === 'NEEDS_DETAIL')) state.lastAnswerFull = state.answerForSave;
    // nothing (or nothing storable) to save: a plain question or reason, no plan, no approval
    if (result && !result.error && result.status === 'NEEDS_DETAIL' && typeof result.message === 'string') {
      showThread(prompt, 'Ready', bt('mainRoute.clarifyTitle', 'One quick question'), result.message, [
        { state: 'done', label: 'Request captured', detail: '' },
        { state: 'running', label: bt('mainVault.nothingSaved', 'Nothing was saved'), detail: '' },
      ]);
      renderInlineActions([{ id: 'edit', label: bt('mainRoute.editRequest', 'Edit request'), action: () => putBackInComposer(prompt) }]);
      return;
    }
    // Advice only: the person asked for advice and nothing to be done. It is shown as an answer - no plan, no steps, no Run button, nothing to approve.
    if (result && !result.error && !result.plan && result.status === 'ADVISORY_RESPONSE' && result.executable === false && result.advice && typeof result.advice.summary === 'string') {
      const nl = String.fromCharCode(10);
      const suggestions = Array.isArray(result.advice.suggestions) ? result.advice.suggestions.filter((s) => typeof s === 'string' && s.trim()) : [];
      const markdown = [result.advice.summary]
        .concat(suggestions.length ? ['', '**' + mt('Suggested next moves') + '**'].concat(suggestions.map((s) => '- ' + s)) : [])
        .concat(['', '*' + mt('No actions were taken. This is advice only.') + '*'])
        .join(nl);
      rememberAnswer(result.advice.summary + nl + suggestions.join(nl));
      showThread(prompt, 'Answered', 'Advice', markdown, []);
      renderInlineActions([{ id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') }]);
      // a sentence of advice is addressed to the person, so it stays advice; when they asked for next steps / a to-do list, what NAgex can do for them is offered separately
      offerConversationTodos(state.activeTurn, prompt, result.advice.summary + nl + suggestions.join(nl), { todosOnly: true });
      return;
    }
    if (!result || result.error || !result.plan) {
      showThread(prompt, 'Error', 'NAgex could not prepare a plan', serverFailure(result, 'The planner did not return a usable plan.'), [
        { state: 'done', label: 'Intent classified', detail: routeLabel(routingDecisionOf(route, metadata)) },
        { state: 'running', label: 'Planning failed', detail: '' },
      ]);
      return;
    }
    const steps = (result.plan.steps || []).slice(0, 6).map((step, index) => ({
      state: index === 0 ? 'done' : index === 1 ? 'running' : 'pending',
      label: step.title || (mt('Step') + ' ' + (index + 1)),
      detail: step.requiresApproval ? 'Approval needed before execution' : (step.resolvedToolId || ''),
    }));
    if ((result.plan.steps || []).some((step) => step.requiresApproval)) setTimeout(() => loadInlineApprovals(state.activeTurn), 0);
    const runnable = result.runnable && result.runnable.ok === true && result.planSeal && typeof result.planSeal.token === 'string';
    showThread(prompt, 'Plan ready', result.plan.summary || 'NAgex prepared a plan.', 'Review the plan inline. Required approvals remain mandatory and cannot be bypassed here.', steps);
    // a plan Home cannot take to approval is a preview, and says why (a separate line: the summary above is a fixed, translated sentence)
    setPlanNote(state.activeTurn, runnable ? '' : bt('mainRun.previewOnly', 'This is a preview only:') + ' ' + runnableReasonText(result.runnable && result.runnable.reasons));
    renderVaultDraft(state.activeTurn, result.plan, result.draftSource);
    renderInlineActions([
      // Request approval: sends exactly this reviewed plan to the existing approval flow. Nothing runs until the person approves.
      ...(runnable ? [{ id: 'run-plan', label: bt('mainRun.requestApproval', 'Request approval to run'), action: ((turn) => () => startPlanRun(turn, prompt, result.plan, result.planSeal))(state.activeTurn) }] : []),
      { id: 'show-plan', label: 'Show plan', action: () => setStep((result.plan.steps || []).map((step, index) => ({ state: index === 0 ? 'running' : 'pending', label: step.title || (mt('Step') + ' ' + (index + 1)), detail: step.reasoning || '' }))) },
    ]);
  }

  // "What NAgex can do": the plain list, nothing advertised that has no real path today
  function showModeCapabilityMatrix(prompt) {
    state.activeTurn = null;
    showThread(prompt, 'Ready', bt('mainRoute.capabilitiesTitle', 'What NAgex can do'), bt('mainRoute.capabilitiesBody', 'Just tell NAgex what you want, in your own words. It answers questions, gives advice, researches with sources, writes documents, builds slides and makes images, and prepares plans for things to be done - those wait for your approval before anything happens. Video and building or running apps are not available yet.'), [
      { state: 'done', label: bt('mainRoute.capAvailable', 'Available now'), detail: [mt('Research'), mt('Document'), mt('Slides'), mt('Image')].join(' / ') },
      { state: 'pending', label: bt('mainRoute.shortcutUnavailable', 'Not available yet'), detail: [mt('Video'), mt('Code')].join(' / ') },
    ]);
    renderInlineActions([]);
  }

  // An optional shortcut for the NEXT request only (clear it with x). It never replaces the words and never overrides an action.
  function selectMode(modeId) {
    const mode = MODES.find((m) => m.id === modeId);
    if (!mode || !mode.enabled) return;
    if (mode.id === 'MORE') {
      setShortcutsOpen(false, true);
      showModeCapabilityMatrix(bt('mainRoute.capabilitiesTitle', 'What NAgex can do'));
      return;
    }
    state.mode = mode.id;
    state.shortcutsOpen = false;
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
    // the buttons are the last thing rendered for a turn: the end of the stream includes them (on phones they would otherwise sit under the fixed navigation)
    if (actions.length) scrollStreamToEnd();
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

  // The language the microphone listens in: the language of the screen (Korean or English)
  function voiceLang() {
    return window.NAGEX_I18N && window.NAGEX_I18N.getLocale && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko-KR' : 'en-US';
  }

  // A truthful way to still talk when the browser cannot listen: the operating system's own dictation, named as what it is (nothing here presses a key or opens a program).
  function voiceFallbackHint() {
    const ua = (navigator.userAgent || '') + ' ' + ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return ' ' + bt('mainVoice.hintTouch', 'You can also tap the microphone key on your keyboard.');
    if (/Windows|Win32|Win64/i.test(ua)) return ' ' + bt('mainVoice.hintWindows', 'You can also use Windows voice typing: click in the box and press Win + H.');
    if (/Mac/i.test(ua)) return ' ' + bt('mainVoice.hintApple', 'You can also use your system dictation in this box (turn it on in the keyboard settings).');
    return '';
  }

  function userVoiceFailureMessage(result) {
    const hint = voiceFallbackHint();
    if (result && (result.reason === 'NO_MICROPHONE' || result.reason === 'audio-capture')) return bt('mainVoice.noMicrophone', 'No microphone was found. Connect one, or type your request.') + hint;
    if (result && result.reason === 'MICROPHONE_BUSY') return bt('mainVoice.micBusy', 'The microphone is in use by another app. Close it and try again, or type your request.') + hint;
    if (result && (result.state === 'UNAVAILABLE' || result.reason === 'PROVIDER_UNKNOWN' || result.reason === 'DESKTOP_RUNTIME_NO_STT' || result.reason === 'LOCAL_PROCESSING_NOT_VERIFIED')) return localizeAppText(voiceFailureMessage(result)) + hint;
    return localizeAppText(voiceFailureMessage(result));
  }

  function voiceFailureMessage(result) {
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
          const installed = await window.NAGEX_RENDERER_VOICE.installLocalModel(voiceLang());
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
      setComposerNotice(localizeAppText('Voice input is unavailable in this browser. You can type your request or try a supported browser.') + voiceFallbackHint(), 'error', true);
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
        if (!current || current.dataset.voiceFrozen === '1') return;
        const hasVoiceBase = Object.prototype.hasOwnProperty.call(current.dataset, 'voiceBase');
        const base = hasVoiceBase ? current.dataset.voiceBase : current.value;
        current.value = [base, finalTranscript, interimTranscript].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        autoGrow(current);
      },
    });
    const result = await state.voiceAdapter.start({
      lang: voiceLang(),
      continuous: mode === 'SESSION',
      session: {
        mode,
        activeResultArtifactId: state.result && state.result.artifactId ? state.result.artifactId : null,
        activeDocumentId: state.result && state.result.documentId ? state.result.documentId : null,
        revisionTarget: state.revisionTarget,
      },
    });
    if (input) { delete input.dataset.voiceBase; delete input.dataset.voiceFrozen; }
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
        setComposerNotice(userVoiceFailureMessage(result), 'warning', true);
      } else {
        setComposerNotice('');
      }
      return;
    }
    if (result.state === 'PERMISSION_DENIED' || result.state === 'UNAVAILABLE' || result.state === 'ERROR') {
      setVoiceState('ERROR', userVoiceStatus(result.reason, 'Unavailable'));
      setComposerNotice(userVoiceFailureMessage(result), 'error', true);
    }
  }

  async function saveTextToVault(text) {
    const result = await api('/api/v1/workspace/vault', {
      method: 'POST',
      body: JSON.stringify({ title: 'Saved NAgex result', type: 'DOCUMENT', mimeType: 'text/plain', storageRef: 'main-result:' + Date.now(), contentText: text }),
    });
    showThread(mt('Save to Vault'), result && !result.error ? 'Saved' : 'Error', result && !result.error ? 'Saved to Vault' : 'Could not save', result && !result.error ? 'The result is now stored in your workspace Vault.' : (serverFailure(result, 'Save failed.')), [
      { state: result && !result.error ? 'done' : 'running', label: 'Save to Vault', detail: result && (result.vaultItemId || result.id || '') },
    ]);
  }

  function showResult(result) {
    state.result = result;
    if (state.todoRun && result && result.artifactId && !state.todoRun.artifactId) state.todoRun.artifactId = result.artifactId;
    if (result && result.type === 'DOCUMENT' && /^art_[0-9a-f]{24}$/.test(String(result.artifactId || '')) && /^doc_[0-9a-f]{24}$/.test(String(result.documentId || ''))) {
      state.recentDocument = { artifactId: result.artifactId, documentId: result.documentId, title: result.title || '' };
    }
    // a result gives the room to the result: My Day closes (one click reopens it)
    state.myDayOpen = false;
    const root = document.getElementById('nagex-main-surface');
    const panel = document.getElementById('main-result-panel');
    if (root) root.classList.add('has-result');
    if (panel) panel.hidden = false;
    const kind = document.getElementById('main-result-kind');
    const title = document.getElementById('main-result-title');
    const meta = document.getElementById('main-result-meta');
    const preview = document.getElementById('main-result-preview');
    const revise = document.getElementById('main-result-revise');
    // the file badge is a 40px chip: "PRESENTATION" was cut off ("PRESE"), so a deck shows the short label PowerPoint users know
    if (kind) kind.textContent = result.type === 'DOCUMENT' ? 'DOC' : result.type === 'PRESENTATION' ? 'PPT' : result.type;
    if (title) title.textContent = localizeAppText(result.title || 'Result');
    if (meta) meta.textContent = String(result.meta || '').split(' - ').map(localizeAppText).join(' - ');
    if (preview) {
      if (result.type === 'PRESENTATION') {
        const outline = (result.slides || []).map((slide, index) => `<li><strong>${esc(slide.title)}</strong><ul>${(slide.bullets || []).map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul></li>`).join('');
        const link = result.downloadTarget ? `<p><a class="main-result-download" href="${esc(result.downloadTarget)}" download>${esc(bt('mainSlides.download', 'Download .pptx'))}</a></p>` : '';
        preview.innerHTML = `<article class="main-doc-page main-deck-page"><div><strong>NAgex</strong><br><small>${esc(mt('Your Personal AI'))}</small></div><h1>${esc(result.title || 'Presentation')}</h1>${result.subtitle ? `<p>${esc(result.subtitle)}</p>` : ''}${outline ? `<ol class="main-deck-outline">${outline}</ol>` : `<p>${esc(result.preview || '')}</p>`}${link}</article>`;
      } else if (result.type === 'IMAGE' && result.imageUrl) {
        preview.innerHTML = `<article class="main-doc-page main-image-page"><div><strong>NAgex</strong><br><small>${esc(mt('Your Personal AI'))}</small></div><h1>${esc(localizeAppText(result.title || 'Generated image'))}</h1><img src="${esc(result.imageUrl)}" alt="${esc(localizeAppText(result.title || 'Generated image'))}" loading="lazy"><p>${esc(localizeAppText(result.preview || 'Image artifact'))}</p>${imageDownloadLink(result)}</article>`;
      } else {
        preview.innerHTML = `<article class="main-doc-page"><div><strong>NAgex</strong><br><small>${esc(mt('Your Personal AI'))}</small></div><h1>${esc(localizeAppText(result.title || 'Generated result'))}</h1><p>${esc(localizeAppText(result.preview || 'Preview is unavailable for this result.'))}</p></article>`;
      }
    }
    // a research report is Markdown with headings, a source list and a method section: it is shown as such (safe DOM, no raw HTML), and its Sources tab shows where every source came from
    if (preview && result.type === 'DOCUMENT') {
      const holder = preview.querySelector('.main-doc-page p');
      if (holder) {
        const body = document.createElement('div');
        body.className = 'main-doc-md';
        holder.replaceWith(body);
        renderMarkdown(body, String(result.preview || '').replace(/^#\s+[^\n]*\n+/, ''));
      }
    }
    const sourcesTab = document.getElementById('main-result-sources');
    if (sourcesTab) {
      sourcesTab.disabled = !(result.type === 'DOCUMENT' && result.researchRunId);
      sourcesTab.dataset.run = result.researchRunId || '';
    }
    const previewTab = document.getElementById('main-result-preview-tab');
    if (previewTab) previewTab.classList.add('active');
    if (sourcesTab) sourcesTab.classList.remove('active');
    // a report or a deck has versions (a new one with every revision); the tab is only enabled for something that can have them
    const versionsTab = document.getElementById('main-result-versions');
    if (versionsTab) {
      versionsTab.disabled = !versionSubject();
      versionsTab.classList.remove('active');
    }
    const openButton = document.getElementById('main-result-open');
    if (openButton) {
      // a presentation opens in this panel (outline + download); there is no separate Canvas viewer for decks
      openButton.disabled = result.type === 'PRESENTATION';
      openButton.title = result.type === 'PRESENTATION' ? bt('mainSlides.openHint', 'Presentations open in this panel. Download the .pptx to edit them.') : '';
    }
    // the file the person can actually take away: the deck's .pptx, or the document as a .docx - and nothing else (no button that promises a file that does not exist)
    const download = document.getElementById('main-result-download');
    const downloadTarget = result.type === 'PRESENTATION' ? String(result.downloadTarget || '')
      : result.type === 'DOCUMENT' && /^doc_[0-9a-f]{24}$/.test(String(result.documentId || '')) ? '/api/v1/creations/documents/' + result.documentId + '/download' : '';
    state.downloadTarget = downloadTarget;
    if (download) {
      download.disabled = !downloadTarget;
      download.title = downloadTarget ? '' : bt('mainResult.noDownload', 'There is no file to download for this result.');
    }
    if (revise) {
      revise.disabled = !result.documentId;
      revise.title = result.documentId ? mt('Create a bounded document revision from Main.') : mt('Revision is available only for document artifacts.');
    }
  }

  // The only image source an opened artifact may display: the NAgex-owned canonical path (never a provider URL, data: URL or any other path).
  const CANONICAL_IMAGE_PATH = /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/;
  const IMAGE_EXTENSION = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

  // The file the person gets is the exact stored image; its extension comes from the type the provider reported (none when that is unknown).
  function imageDownloadLink(result) {
    const url = String(result.imageUrl || '');
    if (!CANONICAL_IMAGE_PATH.test(url)) return '';
    const name = 'nagex-' + url.slice(url.lastIndexOf('/') + 1) + (IMAGE_EXTENSION[String(result.mimeType || '').toLowerCase()] || '');
    return `<p><a class="main-result-download" href="${esc(url)}" download="${esc(name)}">${esc(bt('mainImage.download', 'Download image'))}</a></p>`;
  }

  async function openArtifactResult(artifactId) {
    if (!artifactId) return false;
    const artifact = await api('/api/v1/artifacts/' + encodeURIComponent(artifactId));
    if (!artifact || artifact.error || !artifact.projection) return false;
    const projection = artifact.projection;
    if (projection.artifactType === 'PRESENTATION' && PRESENTATION_VIEW_PATH.test(String(projection.openTarget || ''))) {
      const viewer = await api(projection.openTarget);
      if (!viewer || viewer.error || !viewer.presentation) return false;
      showResult(presentationResult(viewer.presentation, artifactId, projection.openTarget, projection, projection.summary));
      return true;
    }
    const documentId = parseDocumentId(projection.openTarget);
    let document = null;
    if (documentId) {
      const documentResponse = await api('/api/v1/creations/documents/' + encodeURIComponent(documentId));
      document = documentResponse && documentResponse.document ? documentResponse.document : null;
    }
    const imageUrl = projection.artifactType === 'IMAGE' && CANONICAL_IMAGE_PATH.test(String(projection.previewTarget || '')) ? projection.previewTarget : undefined;
    showResult({
      type: projection.artifactType || 'ARTIFACT',
      imageUrl,
      title: projection.title || (document && document.title) || 'Stored artifact',
      meta: [bt('mainArtifact.type.' + (projection.artifactType || 'ARTIFACT'), projection.artifactType || 'ARTIFACT'), bt('mainArtifact.state.' + String(projection.state || 'ready').toLowerCase(), projection.state || 'ready')].filter(Boolean).join(' - '),
      preview: (document && document.content) || projection.preview || projection.summary || 'This artifact has no inline preview.',
      artifactId,
      documentId,
      researchRunId: document && /^run_[0-9a-f]{24}$/.test(String(document.researchRunId || '')) ? document.researchRunId : undefined,
      openTarget: projection.openTarget,
      projection,
    });
    return true;
  }

  // The provenance of a research report: every source that was read, whether the report cites it, where and when it was retrieved, and how (whole page or only the search provider's excerpt).
  async function showResearchSources(runId) {
    const preview = document.getElementById('main-result-preview');
    if (!preview || !/^run_[0-9a-f]{24}$/.test(String(runId || ''))) return;
    document.getElementById('main-result-sources')?.classList.add('active');
    document.getElementById('main-result-preview-tab')?.classList.remove('active');
    const response = await api('/api/v1/research/runs/' + encodeURIComponent(runId));
    const run = response && response.run ? response.run : null;
    preview.textContent = '';
    const article = document.createElement('article');
    article.className = 'main-doc-page main-research-sources';
    const heading = document.createElement('h1');
    heading.textContent = bt('mainText.Sources', 'Sources');
    article.appendChild(heading);
    if (!run) {
      const failed = document.createElement('p');
      failed.textContent = bt('mainResearch.srcLoadFailed', 'The source details could not be loaded.');
      article.appendChild(failed);
      preview.appendChild(article);
      return;
    }
    const summary = document.createElement('p');
    summary.textContent = bt('mainResearch.srcSummary', '{v} statements were checked against the retrieved text; {r} were refused. Search provider: {p}.').replace('{v}', String((run.claims || []).length)).replace('{r}', String(run.rejectedClaims || 0)).replace('{p}', String(run.provider || ''));
    article.appendChild(summary);
    const cited = new Set(run.citedSourceIds || []);
    const list = document.createElement('ol');
    const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
    (run.sources || []).forEach((source) => {
      const item = document.createElement('li');
      const safe = mdSafeUrl(source.finalUrl || source.url);
      const title = document.createElement(safe ? 'a' : 'strong');
      title.textContent = source.title || source.publisher || '';
      if (safe) { title.href = safe; title.target = '_blank'; title.rel = 'noopener noreferrer nofollow'; }
      item.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'main-research-source-meta';
      const parts = [source.publisher];
      if (source.publishedAt) parts.push(bt('mainResearch.srcPublished', 'Published') + ' ' + day(source.publishedAt));
      if (source.updatedAt) parts.push(bt('mainResearch.srcUpdated', 'Updated') + ' ' + day(source.updatedAt));
      if (source.retrievedAt) parts.push(bt('mainResearch.srcRetrieved', 'Retrieved') + ' ' + new Date(source.retrievedAt).toLocaleString());
      parts.push(source.basis === 'FULL_TEXT' ? bt('mainResearch.srcFull', 'Full page read') : bt('mainResearch.srcSnippet', "Search provider's excerpt only"));
      parts.push(cited.has(source.sourceId) ? bt('mainResearch.srcCited', 'Cited in the report') : bt('mainResearch.srcNotCited', 'Read but not cited'));
      meta.textContent = parts.filter(Boolean).join(' · ');
      item.appendChild(meta);
      list.appendChild(item);
    });
    article.appendChild(list);
    if (!(run.sources || []).length) {
      const none = document.createElement('p');
      none.textContent = bt('mainResearch.srcNone', 'No sources are listed for this report.');
      article.appendChild(none);
    }
    preview.appendChild(article);
  }

  // ── Versions (R26-D) ──────────────────────────────────────────────────────────────────────────────────────
  // Every revision of a report or a deck is a version that stays retrievable. The Versions tab lists them, shows what changed between two of them (computed by the server from the stored text) and
  // brings an older one back as a NEW version - nothing is ever overwritten. All text from the server is shown with textContent, never as HTML.
  const VERSION_DOC_ID = /^doc_[0-9a-f]{24}$/;

  function versionSubject() {
    const r = state.result;
    if (!r) return null;
    if (r.type === 'DOCUMENT' && VERSION_DOC_ID.test(String(r.documentId || ''))) return { kind: 'DOCUMENT', id: r.documentId };
    const presentationId = openPresentationId();
    if (r.type === 'PRESENTATION' && presentationId) return { kind: 'PRESENTATION', id: presentationId };
    return null;
  }

  function versionBase(kind) {
    return kind === 'PRESENTATION' ? '/api/v1/creations/presentations/' : '/api/v1/creations/documents/';
  }

  function versionErrorCode(response) {
    if (!response) return 'UNAVAILABLE';
    if (typeof response.error === 'string') return response.error;
    return response.error && response.error.code ? response.error.code : '';
  }

  function versionEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setResultTab(name) {
    ['preview-tab', 'sources', 'versions'].forEach((id) => {
      const tab = document.getElementById('main-result-' + id);
      if (tab) tab.classList.toggle('active', id === name || (name === 'preview' && id === 'preview-tab'));
    });
  }

  function versionLabel(version) {
    return bt('mainVersions.label', 'Version {n}').replace('{n}', String(version.revisionIndex));
  }

  function versionSize(version) {
    return version.kind === 'PRESENTATION'
      ? bt('mainVersions.slides', '{n} slides').replace('{n}', String(version.size))
      : bt('mainVersions.chars', '{n} characters').replace('{n}', String(version.size));
  }

  function versionsPanel(preview, heading) {
    setResultTab('versions');
    preview.textContent = '';
    const article = versionEl('article', 'main-doc-page main-versions');
    article.appendChild(versionEl('h1', '', heading || bt('mainText.Versions', 'Versions')));
    preview.appendChild(article);
    return article;
  }

  async function showVersions(subject, notice) {
    const preview = document.getElementById('main-result-preview');
    if (!preview || !subject) return;
    const response = await api(versionBase(subject.kind) + encodeURIComponent(subject.id) + '/versions');
    const article = versionsPanel(preview);
    if (notice) {
      const note = versionEl('p', 'main-versions-notice', notice);
      note.setAttribute('role', 'status');
      article.appendChild(note);
    }
    if (!response || response.error || !Array.isArray(response.versions)) {
      article.appendChild(versionEl('p', '', bt('mainVersions.loadFailed', 'The versions could not be loaded.')));
      return;
    }
    const versions = response.versions;
    if (versions.length < 2) article.appendChild(versionEl('p', '', bt('mainVersions.onlyOne', 'There is only one version so far. Revise it and the earlier version stays here.')));
    const list = versionEl('ol', 'main-versions-list');
    versions.forEach((version) => {
      const item = versionEl('li', 'main-version-item' + (version.current ? ' current' : ''));
      item.dataset.versionId = version.id;
      const head = versionEl('div', 'main-version-head');
      head.appendChild(versionEl('strong', '', versionLabel(version)));
      if (version.current) head.appendChild(versionEl('span', 'main-version-tag', bt('mainVersions.current', 'Current')));
      item.appendChild(head);
      const from = version.restoredFromId ? versions.find((v) => v.id === version.restoredFromId) : null;
      const meta = [new Date(version.createdAt).toLocaleString(), versionSize(version)];
      if (from) meta.push(bt('mainVersions.restoredFrom', 'Brought back from version {n}').replace('{n}', String(from.revisionIndex)));
      item.appendChild(versionEl('div', 'main-version-meta', meta.join(' · ')));
      if (version.title) item.appendChild(versionEl('div', 'main-version-title', version.title));
      if (!version.current) {
        const actions = versionEl('div', 'main-version-actions');
        const compare = versionEl('button', 'btn-secondary main-version-compare', bt('mainVersions.compare', 'Compare with current'));
        compare.type = 'button';
        compare.addEventListener('click', () => showVersionCompare(subject, version.id, versions[0].id));
        const view = versionEl('button', 'btn-secondary main-version-view', bt('mainVersions.view', 'View'));
        view.type = 'button';
        view.disabled = !version.artifactId;
        view.addEventListener('click', () => viewVersion(version));
        const restore = versionEl('button', 'btn-primary main-version-restore', bt('mainVersions.restore', 'Bring this version back'));
        restore.type = 'button';
        restore.addEventListener('click', () => restoreVersion(subject, version, restore));
        actions.appendChild(compare);
        actions.appendChild(view);
        actions.appendChild(restore);
        item.appendChild(actions);
      }
      list.appendChild(item);
    });
    article.appendChild(list);
    if (versions.length > 1) article.appendChild(versionEl('p', 'main-versions-hint', bt('mainVersions.hint', 'Bringing a version back adds it as a new version. No earlier version is changed or removed.')));
  }

  async function viewVersion(version) {
    if (!version.artifactId) return;
    const opened = await openArtifactResult(version.artifactId);
    const subject = versionSubject();
    if (opened && subject) await showVersions(subject);
  }

  function diffRow(kind, text) {
    const row = versionEl('div', 'main-diff-line ' + kind);
    row.appendChild(versionEl('span', 'main-diff-mark', kind === 'added' ? '+' : kind === 'removed' ? '−' : ''));
    row.appendChild(versionEl('span', 'main-diff-text', text));
    return row;
  }

  function renderDocumentDiff(container, comparison) {
    const diff = comparison.diff;
    if (comparison.titleChanged) {
      container.appendChild(versionEl('p', 'main-diff-title', bt('mainVersions.titleChanged', 'Title: {a} → {b}').replace('{a}', comparison.titleChanged.from).replace('{b}', comparison.titleChanged.to)));
    }
    if (diff.identical) { container.appendChild(versionEl('p', '', bt('mainVersions.identical', 'These two versions have the same content.'))); return; }
    if (diff.tooLarge) { container.appendChild(versionEl('p', '', bt('mainVersions.tooLarge', 'These versions are too long to compare line by line.'))); return; }
    const box = versionEl('div', 'main-diff');
    diff.lines.forEach((line) => {
      if (line.kind === 'fold') box.appendChild(versionEl('div', 'main-diff-fold', bt('mainVersions.unchangedLines', '{n} unchanged lines').replace('{n}', String(line.hidden))));
      else box.appendChild(diffRow(line.kind, line.text || ' '));
    });
    container.appendChild(box);
  }

  function renderDeckDiff(container, comparison) {
    const diff = comparison.diff;
    if (diff.titleChanged) {
      container.appendChild(versionEl('p', 'main-diff-title', bt('mainVersions.titleChanged', 'Title: {a} → {b}').replace('{a}', diff.titleChanged.from).replace('{b}', diff.titleChanged.to)));
    }
    if (diff.identical) { container.appendChild(versionEl('p', '', bt('mainVersions.identical', 'These two versions have the same content.'))); return; }
    const labels = {
      added: bt('mainVersions.slideAdded', 'Slide added'),
      removed: bt('mainVersions.slideRemoved', 'Slide removed'),
      changed: bt('mainVersions.slideChanged', 'Slide changed'),
      unchanged: bt('mainVersions.slideSame', 'Slide unchanged'),
    };
    diff.slides.forEach((slide) => {
      const box = versionEl('div', 'main-diff-slide ' + slide.change);
      const head = versionEl('div', 'main-diff-slide-head');
      head.appendChild(versionEl('strong', '', slide.toTitle || slide.fromTitle || ''));
      head.appendChild(versionEl('span', 'main-version-tag', labels[slide.change]));
      box.appendChild(head);
      if (slide.change !== 'unchanged') slide.bullets.forEach((bullet) => box.appendChild(diffRow(bullet.kind, bullet.text)));
      container.appendChild(box);
    });
  }

  async function showVersionCompare(subject, fromId, toId) {
    const preview = document.getElementById('main-result-preview');
    if (!preview || !subject) return;
    const response = await api(versionBase(subject.kind) + encodeURIComponent(fromId) + '/compare?to=' + encodeURIComponent(toId));
    const article = versionsPanel(preview, bt('mainVersions.comparing', 'What changed'));
    const comparison = response && response.comparison ? response.comparison : null;
    const back = versionEl('button', 'btn-secondary main-version-back', bt('mainVersions.back', 'All versions'));
    back.type = 'button';
    back.addEventListener('click', () => showVersions(subject));
    if (!comparison) {
      article.appendChild(versionEl('p', '', bt('mainVersions.compareFailed', 'These versions could not be compared.')));
      article.appendChild(back);
      return;
    }
    const to = comparison.to;
    const from = comparison.from;
    article.appendChild(versionEl('p', 'main-diff-head', bt('mainVersions.fromTo', '{a} ({da}) → {b} ({db})')
      .replace('{a}', versionLabel(from)).replace('{da}', new Date(from.createdAt).toLocaleString())
      .replace('{b}', versionLabel(to) + (to.current ? ' · ' + bt('mainVersions.current', 'Current') : '')).replace('{db}', new Date(to.createdAt).toLocaleString())));
    const stats = comparison.diff.stats;
    const summary = comparison.kind === 'PRESENTATION'
      ? bt('mainVersions.deckStats', '{a} slides added, {r} removed, {c} changed, {u} unchanged').replace('{a}', String(stats.added)).replace('{r}', String(stats.removed)).replace('{c}', String(stats.changed)).replace('{u}', String(stats.unchanged))
      : bt('mainVersions.docStats', '{a} lines added, {r} removed, {u} unchanged').replace('{a}', String(stats.added)).replace('{r}', String(stats.removed)).replace('{u}', String(stats.unchanged));
    const stat = versionEl('p', 'main-diff-stats', summary);
    stat.setAttribute('role', 'status');
    article.appendChild(stat);
    if (comparison.kind === 'PRESENTATION') renderDeckDiff(article, comparison); else renderDocumentDiff(article, comparison);
    const actions = versionEl('div', 'main-version-actions');
    actions.appendChild(back);
    if (!from.current) {
      const restore = versionEl('button', 'btn-primary main-version-restore', bt('mainVersions.restoreN', 'Bring {n} back').replace('{n}', versionLabel(from)));
      restore.type = 'button';
      restore.addEventListener('click', () => restoreVersion(subject, from, restore));
      actions.appendChild(restore);
    }
    article.appendChild(actions);
  }

  async function restoreVersion(subject, version, button) {
    if (button) button.disabled = true;
    const response = await api(versionBase(subject.kind) + encodeURIComponent(version.id) + '/restore', { method: 'POST', body: JSON.stringify({}) });
    const code = versionErrorCode(response);
    if (!response || code || response.status === 'FAILED') {
      if (button) button.disabled = false;
      const message = code === 'VERSION_ALREADY_CURRENT' ? bt('mainVersions.alreadyCurrent', 'This version is already the current one.')
        : code === 'PRESENTATION_FILE_MISSING' ? bt('mainVersions.fileMissing', 'The file of that version is no longer available.')
        : bt('mainVersions.restoreFailed', 'The version could not be brought back.');
      await showVersions(subject, message);
      return;
    }
    const opened = response.artifactId ? await openArtifactResult(response.artifactId) : false;
    const next = opened ? versionSubject() : subject;
    const newest = response.metadata && response.metadata.revisionIndex ? response.metadata.revisionIndex : '';
    await showVersions(next || subject, bt('mainVersions.restored', '{a} was brought back as version {b}. The earlier versions are unchanged.').replace('{a}', versionLabel(version)).replace('{b}', String(newest)));
  }

  // "지난번 보고서 수정 전 버전과 지금 버전을 비교해줘" / "이전 버전으로 되돌려줘": the server only recognised the words (reason codes COMPARE_VERSIONS / RESTORE_VERSION). The comparison is read from the
  // stored versions; restoring is never done from words alone - the person picks the version in the list and presses the button.
  async function runVersionRequest(prompt, decision) {
    const wantsRestore = (decision.reasonCodes || []).indexOf('RESTORE_VERSION') >= 0;
    const steps = (outcome) => [
      { state: 'done', label: 'Request captured', detail: '' },
      { state: 'done', label: bt('mainVersions.stepFound', 'Versions found'), detail: outcome || '' },
    ];
    const none = (kind) => showThread(prompt, 'Unavailable', bt('mainVersions.noneTitle', 'No earlier version'),
      kind === 'PRESENTATION' ? bt('mainVersions.noneDeck', 'There is no presentation with an earlier version yet. A revision keeps the version before it here.') : bt('mainVersions.noneDoc', 'There is no report with an earlier version yet. A revision keeps the version before it here.'), [
        { state: 'done', label: 'Request captured', detail: '' },
        { state: 'running', label: bt('mainVersions.stepNone', 'No earlier version found'), detail: '' },
      ]);

    const open = versionSubject();
    const wanted = decision.targetArtifactType === 'PRESENTATION' || decision.targetArtifactType === 'DOCUMENT' ? decision.targetArtifactType : null;
    let subject = open && (!wanted || open.kind === wanted) ? open : null;
    let family = null;
    if (subject) {
      const response = await api(versionBase(subject.kind) + encodeURIComponent(subject.id) + '/versions');
      family = response && Array.isArray(response.versions) ? response : null;
    }
    if (!family) {
      // nothing (matching) is open: the newest report - or deck - that has an earlier version is what "지난번" means
      const kinds = wanted ? [wanted] : ['DOCUMENT', 'PRESENTATION'];
      for (const kind of kinds) {
        const response = await api('/api/v1/creations/versions/latest?kind=' + kind);
        if (response && Array.isArray(response.versions) && response.versions.length > 1) { family = response; subject = { kind, id: response.versions[0].id }; break; }
      }
    }
    if (!family || !subject || family.versions.length < 2) { none(wanted || (open && open.kind) || 'DOCUMENT'); return; }

    const versions = family.versions;
    const newest = versions[0];
    // make sure the panel shows the report (or deck) the versions belong to: the version that is open (sending a request closes the panel), otherwise the newest one
    const shown = open ? versions.find((v) => v.id === open.id) : null;
    const toShow = shown || newest;
    if (toShow.artifactId) await openArtifactResult(toShow.artifactId);
    const current = versionSubject() || { kind: subject.kind, id: newest.id };
    if (wantsRestore) {
      showThread(prompt, 'Completed', bt('mainVersions.restoreTitle', 'Pick the version to bring back'), bt('mainVersions.restoreBody', 'The versions are listed in the right panel. Press "Bring this version back" on the one you want - it is added as a new version and nothing is overwritten.'), steps(String(versions.length)));
      await showVersions(current);
      return;
    }
    // the version before the current one is "수정 전"; if an older version is open, that one is compared with the current one
    const openOlder = open && versions.find((v) => v.id === open.id && !v.current);
    const from = openOlder || versions[1];
    showThread(prompt, 'Completed', bt('mainVersions.compareTitle', 'Comparing the versions'), bt('mainVersions.compareBody', 'What changed between {a} and {b} is shown in the right panel.').replace('{a}', versionLabel(from)).replace('{b}', versionLabel(newest)), steps(String(versions.length)));
    await showVersionCompare(current, from.id, newest.id);
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
      if (event.key === 'Escape') {
        event.preventDefault();
        setShortcutsOpen(false, true);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(document.querySelectorAll('#main-mode-row [data-main-mode]')).filter((btn) => !btn.disabled);
      const current = document.activeElement;
      const currentIndex = Math.max(0, buttons.indexOf(current));
      let nextIndex = currentIndex;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = Math.min(buttons.length - 1, currentIndex + 1);
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      event.preventDefault();
      buttons[nextIndex]?.focus();
    });
    document.getElementById('main-shortcut-toggle')?.addEventListener('click', () => setShortcutsOpen(!state.shortcutsOpen, state.shortcutsOpen));
    document.getElementById('main-shortcut-clear')?.addEventListener('click', () => { state.mode = 'AUTO'; renderModes(); focusComposer(''); });
    // the menu closes when the person clicks anywhere else
    document.addEventListener('click', (event) => {
      if (!state.shortcutsOpen) return;
      if (event.target && event.target.closest && event.target.closest('.main-shortcut-wrap')) return;
      state.shortcutsOpen = false;
      renderModes();
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
    // dictation ends when the person types, leaves the screen or the page goes away: no microphone is left open
    input?.addEventListener('beforeinput', () => {
      if (state.voiceAdapter && state.voiceAdapter.isActive() && state.voiceMode === 'DICTATION') {
        input.dataset.voiceFrozen = '1';
        state.voiceAdapter.stop();
      }
    });
    const stopVoiceCapture = () => { if (state.voiceAdapter && state.voiceAdapter.isActive()) state.voiceAdapter.cancel(); };
    window.addEventListener('pagehide', stopVoiceCapture);
    window.addEventListener('hashchange', () => { if (location.hash && location.hash !== '#home') stopVoiceCapture(); });
    document.getElementById('main-mic')?.addEventListener('click', () => startVoiceRecognition('DICTATION'));
    document.getElementById('main-voice')?.addEventListener('click', () => startVoiceRecognition('SESSION'));
    // Enter sends - through the very same handler as the Send button (no second path). Shift+Enter is a new line. Enter that confirms an IME composition (Korean, Japanese, Chinese) is never a send.
    // An empty box and a held key send nothing, and a request in flight is not sent twice. On a touch-first device the virtual keyboard's Enter key is a new line and the Send button sends.
    let composing = false;
    let compositionEndedAt = 0;
    const touchFirst = () => !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    if (input) input.setAttribute('enterkeyhint', touchFirst() ? 'enter' : 'send');
    input?.addEventListener('compositionstart', () => { composing = true; });
    input?.addEventListener('compositionend', () => { composing = false; compositionEndedAt = Date.now(); });
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // the key that confirms an IME composition: some browsers report it as isComposing, some as keyCode 229, Safari fires compositionend first
      if (event.isComposing || composing || event.keyCode === 229 || Date.now() - compositionEndedAt < 80) return;
      if (event.shiftKey || event.altKey) return;
      const withModifier = event.ctrlKey || event.metaKey;
      if (!withModifier && touchFirst()) return;
      event.preventDefault();
      if (event.repeat) return;
      // while recording, Enter is the same as the Send button: stop recording and keep the text for review
      if (state.voiceAdapter && state.voiceAdapter.isActive()) { sendRequest(); return; }
      if (!input.value.trim()) return;
      if (state.busy) { setComposerNotice(bt('mainComposer.busy', 'NAgex is still working on your last request.'), 'busy'); return; }
      sendRequest();
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
    document.getElementById('main-result-sources')?.addEventListener('click', (event) => { const run = event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.run : ''; if (run) showResearchSources(run); });
    document.getElementById('main-result-preview-tab')?.addEventListener('click', () => { if (state.result) showResult(state.result); });
    document.getElementById('main-result-versions')?.addEventListener('click', () => { const subject = versionSubject(); if (subject) showVersions(subject); });
    document.getElementById('main-result-expand')?.addEventListener('click', () => document.body.classList.toggle('main-result-fullscreen'));
    document.getElementById('main-result-open')?.addEventListener('click', openResult);
    document.getElementById('main-result-revise')?.addEventListener('click', reviseResult);
    document.getElementById('main-result-download')?.addEventListener('click', () => {
      if (!state.downloadTarget) return;
      const link = document.createElement('a');
      link.href = state.downloadTarget;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
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

  // Servers answer with { error: { message } } or { error: 'CODE', message }. The first non-empty, truthful wording wins; the
  // "no model provider" case is worded for the user instead of echoing the internal sentence.
  const IMAGE_FAILURE_CODES = ['PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_MODEL_NOT_FOUND', 'CONTENT_REJECTED', 'TIMEOUT', 'PROVIDER_UNAVAILABLE_ERROR', 'EMPTY_PROVIDER_RESULT', 'UNSUPPORTED_ASPECT_RATIO'];

  function serverFailure(result, fallback) {
    if (result && result.error === 'NO_MODEL_PROVIDER_CONFIGURED') return bt('mainError.noModel', "NAgex can't do this right now because no AI model is available.");
    if (result && result.error === 'NO_CREATION_PROVIDER_AVAILABLE') return bt('mainError.noImageProvider', "NAgex can't create images right now because no image service is set up.");
    // image failures: the real reason in the screen's language (the provider's own English text is for the audit trail, not for the person)
    if (result && typeof result.error === 'string' && IMAGE_FAILURE_CODES.indexOf(result.error) >= 0) return bt('mainError.image.' + result.error, result.message || result.error);
    if (result && result.error && typeof result.error === 'object' && result.error.message) return result.error.message;
    if (result && typeof result.message === 'string' && result.message) return result.message;
    if (result && typeof result.errorMessage === 'string' && result.errorMessage) return result.errorMessage;
    return fallback;
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
    [/^Task Completed: (.+)$/, 'mainPattern.task_completed'],
    [/^Task Failed: (.+)$/, 'mainPattern.task_failed'],
    [/^Saved to Vault: (.+)$/, 'mainPattern.vault_saved'],
    [/^Could not save to Vault: (.+)$/, 'mainPattern.vault_save_failed'],
    [/^Condition Met: (.+)$/, 'mainPattern.condition_met'],
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

  // An internal tool id ("gmail.send_email") is never shown as is: it becomes the plain action it performs.
  const TOOL_ACTION_LABELS = {
    send_email: 'Send email',
    reply: 'Reply to email',
    create_draft: 'Create email draft',
    create_event: 'Create calendar event',
    update_event: 'Update calendar event',
    cancel_event: 'Cancel calendar event',
    respond_to_event: 'Respond to calendar event',
    save_note: 'Save to Vault',
  };

  function friendlyToolName(id) {
    const isUserTool = /^mcp[.]/.test(String(id));
    const action = isUserTool ? String(id).split('.').slice(2).join('.') || 'tool' : String(id).split('.').slice(1).join('.') || String(id);
    const label = TOOL_ACTION_LABELS[action] || (action.replace(/[_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
    return mt(label);
  }

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
        if (/^(accepted|dismissed|snoozed|declined|rejected)$/.test(part)) return mt(part);
        return /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9_.]+$/.test(part) ? friendlyToolName(part) : part;
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
    // English reads "Good evening, Name"; Korean reads naturally the other way round: "Name님, 좋은 저녁이에요".
    const korean = briefingLocale() === 'ko-KR';
    const nameSpan = () => { const span = document.createElement('span'); span.textContent = korean ? name + '님' : name; return span; };
    if (name && korean) {
      heading.appendChild(nameSpan());
      heading.appendChild(document.createTextNode(', ' + base));
    } else {
      heading.appendChild(document.createTextNode(name ? base + ', ' : base));
      if (name) heading.appendChild(nameSpan());
    }
    const sub = document.getElementById('main-greeting-sub');
    if (sub) sub.textContent = bt('mainHome.subtitle', 'What would you like to accomplish today?');
    document.querySelectorAll('.main-user-avatar').forEach((avatar) => { avatar.textContent = name ? Array.from(name)[0].toUpperCase() : 'U'; });
    document.querySelectorAll('.main-user-name').forEach((label) => { label.textContent = name || bt('mainHome.you', 'You'); });
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
    const todoSource = home.todo && typeof home.todo === 'object' ? home.todo : null;
    const todo = {
      status: todoSource && typeof todoSource.status === 'string' ? todoSource.status : 'UNAVAILABLE',
      items: todoSource && Array.isArray(todoSource.items) ? todoSource.items.filter((item) => item && item.title).slice(0, 5).map((item) => ({
        title: item.title,
        meta: [mt(item.state || ''), item.kind === 'REMINDER' && item.dueAt ? briefingTime(item.dueAt) : ''].filter(Boolean).join(' - '),
      })) : [],
    };
    const suggestions = list(home.suggestions).slice(0, 3).map((item) => ({
      title: localizeAppText(item.title),
      reason: localizeAppText(item.reason || ''),
      approval: Boolean(item.action && item.action.requiresApproval),
    }));
    return {
      today: today.slice(0, 5),
      todo,
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
    const titles = { today: bt('mainBriefing.today', 'Today'), todo: bt('mainBriefing.todo', 'To-do'), since: bt('mainBriefing.since', 'Since Yesterday'), suggestions: bt('mainBriefing.suggestions', 'Suggestions') };
    Object.keys(titles).forEach((key) => {
      const heading = document.getElementById('main-briefing-title-' + key);
      if (heading) heading.textContent = titles[key];
    });
    const newButton = document.getElementById('main-new-conversation');
    if (newButton) {
      newButton.textContent = bt('mainBriefing.newConversation', 'New conversation');
      newButton.title = bt('mainBriefing.newConversationHint', 'Start a fresh Home. Your earlier conversation is kept.');
    }
    const myDay = document.getElementById('main-myday-toggle');
    if (myDay) myDay.textContent = bt('mainDay.title', 'My Day');
    const bodies = { today: document.getElementById('main-briefing-today'), todo: document.getElementById('main-briefing-todo'), since: document.getElementById('main-briefing-since'), suggestions: document.getElementById('main-briefing-suggestions') };
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
    if (bodies.todo) {
      bodies.todo.innerHTML = model.todo.items.length
        ? briefingRows(model.todo.items)
        : note(model.todo.status === 'ERROR' ? bt('mainBriefing.todoError', "Couldn't load your to-do list.") : model.todo.status === 'UNAVAILABLE' ? bt('mainBriefing.todoUnavailable', "Your to-do list isn't available right now.") : bt('mainBriefing.todoEmpty', 'Nothing on your to-do list.'));
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
    const conversing = sessionState === 'CONVERSATION' || sessionState === 'RESULT';
    // The briefing never competes with the request box: it is collapsed until the person opens it with "My Day" (idle Home or mid-conversation alike),
    // and opening it does not touch the conversation or the draft. Its real provider / empty / failure states are unchanged.
    section.hidden = !state.myDayOpen;
    const bar = document.getElementById('main-conversation-bar');
    if (bar) bar.hidden = false;
    const fresh = document.getElementById('main-new-conversation');
    if (fresh) fresh.hidden = !conversing;
    const toggle = document.getElementById('main-myday-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(state.myDayOpen));
    const view = root.closest('.tab-view');
    if (view) view.classList.toggle('main-conversing', conversing);
    root.dataset.diagnostics = diagnosticsOn() ? '1' : '0';
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
      // the whole conversation, in order: each question once, followed by the answer that was saved for it
      const pairs = [];
      messages.forEach((m, index) => {
        if (String(m.role).toUpperCase() !== 'USER') return;
        const reply = messages.slice(index + 1).find((x) => String(x.role).toUpperCase() === 'ASSISTANT' || String(x.role).toUpperCase() === 'USER');
        pairs.push({ user: m, reply: reply && String(reply.role).toUpperCase() === 'ASSISTANT' ? reply : null });
      });
      pairs.slice(-20).forEach((pair) => {
        state.activeTurn = null;
        showThread(
          pair.user.content,
          pair.reply ? 'Answered' : bt('mainBriefing.noReplyStatus', 'No reply saved'),
          bt('mainBriefing.restoredTitle', 'Earlier in this conversation'),
          pair.reply ? pair.reply.content : bt('mainBriefing.noReply', 'This request has no saved answer.'),
          [],
        );
        const when = state.activeTurn && state.activeTurn.el.querySelector('.main-request-time, #main-request-time');
        if (when) when.textContent = briefingWhen(pair.user.createdAt);
      });
      if (pairs.length > 0) {
        renderInlineActions([{ id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') }]);
        // the next request starts a new turn after the restored ones
        state.activeTurn = null;
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
    const turns = document.getElementById('main-turns');
    if (turns) turns.textContent = '';
    state.activeTurn = null;
    state.myDayOpen = false;
    hideResult();
    state.result = null;
    state.revisionTarget = null;
    // a new conversation starts with no earlier answer that could be saved or used as source material
    state.lastContext = '';
    state.lastAnswerFull = '';
    state.answerForSave = '';
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
    document.getElementById('main-myday-toggle')?.addEventListener('click', () => {
      state.myDayOpen = !state.myDayOpen;
      syncBriefingVisibility();
      if (state.myDayOpen) loadBriefing(false);
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
    // keep whatever app.js decided for this route: a refresh on another screen must not bring Home back on top
    view.className = view.classList.contains('active-view') ? 'tab-view active-view' : 'tab-view';
    view.innerHTML = template();
    renderModes();
    applyMainStaticLocale();
    bind();
    wireAttentionBell();
    initHomeBriefing();
    window.NAGEX_MAIN_SURFACE = Object.freeze({
      openArtifactResult,
      getControlMatrix: () => [
        ['main-shortcut-toggle', 'optional shortcuts (+ menu)', 'Main', 'click/keyboard', 'requestMetadata.preferredArtifactType / preferredCapability (a hint for route-input, never required)', 'biases ONE plain request toward research / document / image / slides; cannot override an action or an unsupported kind', 'chip in the composer, cleared after the request', 'Video and Code disabled with a reason', 'per request', 'auth inherited; routing decision is advice only'],
        ['main-surface-input', 'one input', 'Main', 'send', 'POST /api/v1/workspace/route-input -> the existing answer / advice / research / creation / plan routes', 'the server routing decision selects ONE existing path; an action is only a plan that waits for approval', 'inline progress/result, or one clarifying question, or a plain not-available notice', 'inline error', 'server stores per route', 'each selected route enforces its own rights and approval'],
        ['main-send', 'send', 'Main', 'click', 'ambient/research/creation APIs', 'goal/result created where supported', 'inline progress/result', 'inline error', 'server stores', 'session'],
        ['main-attach', 'attach', 'Main', 'click/change', '/api/v1/workspace/upload', 'capture persisted', 'attachment chip', 'inline error', 'CaptureStore', 'session/owner'],
        ['main-web-toggle', 'web toggle', 'Main', 'click', 'requestMetadata.allowWebResearch', 'metadata changes', 'pressed state', 'n/a', 'per request', 'SSRF policy server-side'],
        ['main-data-toggle', 'my data toggle', 'Main', 'click', 'requestMetadata.usePersonalContext', 'metadata changes', 'pressed state', 'n/a', 'per request', 'consent/owner'],
        ['main-mic', 'microphone dictation', 'Main', 'click', 'Device voice adapter: on-device when the browser verifies it, otherwise the browser vendor only after consent; stop = transcribe, cancel = discard', 'transcript inserted into composer', 'composer text updated', 'permission/unavailable guidance', 'per request', 'browser permission'],
        ['main-voice', 'voice session', 'Main', 'click', 'Device voice adapter (same location and consent rules as dictation) -> Main composer', 'recognized speech becomes editable text', 'composer text updated', 'permission/unavailable guidance', 'per request', 'same Main authority rules'],
        ['main-home-briefing', 'personal briefing', 'Main', 'render', '/api/v1/personal/home (existing aggregation, read-only)', 'Today / Since Yesterday / Suggestions from real data or a stated empty or unavailable state', 'collapsed by default behind My Day; opens on request and closes again while a request or result is active (hidden, not removed)', 'error text with retry; never invented items', 'server aggregation; nothing stored by the section', 'same session authentication'],
        ['main-new-conversation', 'new conversation', 'Main', 'click', 'GET /api/v1/conversations/main (read-only)', 'visible conversation reset; earlier history kept', 'empty Home with the briefing', 'inline error if the session cannot be read', 'server keeps the history; sessionStorage mark only', 'same session authentication'],
        ['btn-notif-bell', 'bell', 'Header', 'click', 'tasks/approvals/activity/notifications APIs', 'none', 'attention center', 'empty state', 'server stores', 'session'],
        ['main-result-open', 'open result', 'Result', 'click', 'openArtifactInCanvas', 'route/detail view', 'artifact opens', 'unavailable if missing', 'artifact store', 'owner gate'],
        ['main-result-expand', 'expand result', 'Result', 'click', 'UI state', 'fullscreen class', 'large viewer', 'n/a', 'session UI', 'n/a'],
        ['main-result-close', 'close result', 'Result', 'click', 'UI state', 'panel hidden', 'Main restored', 'n/a', 'session UI', 'n/a'],
        ['main-result-revise', 'revise', 'Result', 'click', '/api/v1/creations/documents/:id/revisions', 'document revision created', 'result panel updated', 'disabled if no document target', 'DocumentStore/ArtifactStore', 'owner gate'],
      ],
    });
  }

  // The other screens (Activity ...) translate application-generated wording with the same rules as Main.
  window.NAGEX_MAIN_L10N = { localizeAppText, mt };
  // Other screens (Recent) continue work in Main: go Home, wait for Main, then open the artifact in the result panel.
  window.NAGEX_MAIN_ACTIONS = {
    openArtifact: async (artifactId) => {
      if (!artifactId) return false;
      if (window.NAGEX && window.NAGEX.switchTab) window.NAGEX.switchTab('tab-home');
      for (let i = 0; i < 60 && !document.getElementById('main-result-panel'); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return openArtifactResult(artifactId);
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rebuildHome);
  else rebuildHome();
  window.addEventListener('hashchange', () => {
    if ((window.location.hash || '#home').startsWith('#home')) setTimeout(rebuildHome, 0);
  });
})();
