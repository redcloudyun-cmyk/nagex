// NAgex Proactive Assistant Settings (R10) — real GET/PUT
// /api/v1/proactive-assistant/config only. One shared renderer for both
// Desktop (#proactive-assistant-panel) and Mobile
// (#mh-proactive-assistant-panel) Settings, same real config object, two
// mount points (Dual Experience directive). Never defaults to enabled —
// the panel always reflects exactly what the server last returned.
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  const WEEKDAYS = [
    { id: 0, key: 'proactiveAssistant.sun', fallback: 'Sun' },
    { id: 1, key: 'proactiveAssistant.mon', fallback: 'Mon' },
    { id: 2, key: 'proactiveAssistant.tue', fallback: 'Tue' },
    { id: 3, key: 'proactiveAssistant.wed', fallback: 'Wed' },
    { id: 4, key: 'proactiveAssistant.thu', fallback: 'Thu' },
    { id: 5, key: 'proactiveAssistant.fri', fallback: 'Fri' },
    { id: 6, key: 'proactiveAssistant.sat', fallback: 'Sat' },
  ];

  // A small, real set of common IANA zones plus whatever the browser
  // itself resolves to (added if not already in the list) — never a
  // fabricated/incomplete guess at "the" user's zone; the browser's own
  // Intl API is the real source, and the user can still pick a different
  // real zone from the list.
  function commonTimezones() {
    const base = ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Australia/Sydney'];
    let browserZone = null;
    try { browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* not available */ }
    if (browserZone && !base.includes(browserZone)) base.unshift(browserZone);
    return base;
  }

  let config = null;
  let configFetched = false;
  let saving = false;
  let saveError = false;
  // R24.6C — the schedule is owned by the signed-in account; a signed-out
  // visitor gets an honest sign-in state rather than an empty/default form.
  let signedOut = false;
  // R24.6B — ONE shared in-progress edit for the whole form (null until the
  // user touches any field). Every field edit lands here, and a render (weekday
  // chip, a Settings re-render, a failed save) always paints the draft over the
  // saved config — so unsaved edits are never discarded by another interaction.
  let draft = null;

  function browserZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  }

  function formFromConfig(cfg) {
    return {
      enabled: Boolean(cfg.enabled),
      localTime: cfg.localTime || '08:00',
      timezone: cfg.timezone || browserZone(),
      weekdays: (cfg.weekdays || []).slice(),
      notifyOnComplete: cfg.notifyOnComplete !== false,
    };
  }

  function ensureDraft() {
    if (!draft && config) draft = formFromConfig(config);
    return draft;
  }

  async function fetchConfig() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/proactive-assistant/config');
    signedOut = Boolean(data && data.error && data.error.code === 'UNAUTHORIZED');
    config = data && !data.error ? data : null;
    return config;
  }

  async function saveConfig(next) {
    if (!window.NAGEX.apiFetch || saving) return;
    saving = true;
    saveError = false;
    renderAll();
    let ok = false;
    try {
      const data = await window.NAGEX.apiFetch('/api/v1/proactive-assistant/config', { method: 'PUT', body: JSON.stringify(next) });
      if (data && !data.error) { config = data; ok = true; }
    } finally {
      saving = false;
      // A failed save keeps the user's edits (and says so) instead of
      // repainting the old saved values as if nothing happened.
      if (ok) draft = null; else saveError = true;
      renderAll();
    }
  }

  function formatDateTime(iso) {
    if (!iso) return t('proactiveAssistant.never', 'Never');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return t('proactiveAssistant.never', 'Never');
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function resultLabel(status) {
    if (status === 'SUCCEEDED') return t('proactiveAssistant.resultSuccess', 'Success');
    if (status === 'FAILED') return t('proactiveAssistant.resultFailed', 'Failed');
    return t('proactiveAssistant.resultNone', '—');
  }

  // scope ('desktop' | 'mobile') makes every id unique per panel — both
  // panels exist in the DOM at once, so shared ids would be duplicates.
  function buildPanelHtml(cfg, scope) {
    const form = draft || formFromConfig(cfg);
    const zones = commonTimezones();
    if (form.timezone && !zones.includes(form.timezone)) zones.unshift(form.timezone);
    const id = (name) => `pa-${scope}-${name}`;

    const weekdayChips = WEEKDAYS.map((w) => `
      <button type="button" class="pa-weekday-chip ${form.weekdays.includes(w.id) ? 'pa-weekday-selected' : ''}" data-pa-weekday="${w.id}" aria-pressed="${form.weekdays.includes(w.id) ? 'true' : 'false'}">${escapeHtml(t(w.key, w.fallback))}</button>
    `).join('');

    const zoneOptions = zones.map((z) => `<option value="${escapeHtml(z)}" ${z === form.timezone ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('');

    return `
      <div class="pa-toggle-row">
        <span class="pa-toggle-label">${escapeHtml(t('proactiveAssistant.enable', 'Generate automatically'))}</span>
        <label class="mh-toggle-switch pa-toggle-switch">
          <input type="checkbox" id="${id('enabled')}" data-pa-field="enabled" ${form.enabled ? 'checked' : ''}>
          <span class="mh-toggle-slider"></span>
        </label>
      </div>
      <div class="pa-field-row">
        <label class="pa-field-label" for="${id('time')}">${escapeHtml(t('proactiveAssistant.time', 'Generation time'))}</label>
        <input type="time" id="${id('time')}" data-pa-field="localTime" class="pa-time-input" value="${escapeHtml(form.localTime)}">
      </div>
      <div class="pa-field-row">
        <label class="pa-field-label" for="${id('timezone')}">${escapeHtml(t('proactiveAssistant.timezone', 'Timezone'))}</label>
        <select id="${id('timezone')}" data-pa-field="timezone" class="pa-timezone-select">${zoneOptions}</select>
      </div>
      <div class="pa-field-row pa-weekdays-row">
        <span class="pa-field-label">${escapeHtml(t('proactiveAssistant.weekdays', 'Days'))}</span>
        <div class="pa-weekday-chips">${weekdayChips}</div>
      </div>
      <div class="pa-toggle-row">
        <span class="pa-toggle-label">${escapeHtml(t('proactiveAssistant.notify', 'Notify me when ready'))}</span>
        <label class="mh-toggle-switch pa-toggle-switch">
          <input type="checkbox" id="${id('notify')}" data-pa-field="notifyOnComplete" ${form.notifyOnComplete ? 'checked' : ''}>
          <span class="mh-toggle-slider"></span>
        </label>
      </div>
      <button type="button" class="btn-secondary pa-save-btn" data-pa-save>${escapeHtml(saving ? t('proactiveAssistant.saving', 'Saving…') : t('proactiveAssistant.save', 'Save'))}</button>
      ${saveError ? `<p class="pa-save-error" role="alert">${escapeHtml(t('settings.saveFailed', 'Could not save settings.'))}</p>` : ''}
      <div class="pa-status-block">
        <div class="pa-status-row"><span>${escapeHtml(t('proactiveAssistant.automation', 'Automation'))}</span><strong class="${cfg.enabled ? 'pa-status-on' : 'pa-status-off'}">${escapeHtml(cfg.enabled ? t('proactiveAssistant.on', 'ON') : t('proactiveAssistant.off', 'OFF'))}</strong></div>
        <div class="pa-status-row"><span>${escapeHtml(t('proactiveAssistant.nextRun', 'Next run'))}</span><strong>${escapeHtml(formatDateTime(cfg.nextRunAt))}</strong></div>
        <div class="pa-status-row"><span>${escapeHtml(t('proactiveAssistant.lastRun', 'Last run'))}</span><strong>${escapeHtml(formatDateTime(cfg.lastRunAt))}</strong></div>
        <div class="pa-status-row"><span>${escapeHtml(t('proactiveAssistant.result', 'Result'))}</span><strong>${escapeHtml(resultLabel(cfg.lastRunStatus))}</strong></div>
      </div>
    `;
  }

  function bindPanel(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Field edits go into the shared draft; no re-render is needed (the
    // browser already shows the value), so nothing can be repainted over.
    container.querySelectorAll('[data-pa-field]').forEach((input) => {
      const field = input.getAttribute('data-pa-field');
      const handler = () => {
        const d = ensureDraft();
        if (!d) return;
        d[field] = input.type === 'checkbox' ? input.checked : input.value;
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    container.querySelectorAll('[data-pa-weekday]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dayId = Number(btn.getAttribute('data-pa-weekday'));
        const d = ensureDraft();
        if (!d) return;
        d.weekdays = d.weekdays.includes(dayId) ? d.weekdays.filter((day) => day !== dayId) : [...d.weekdays, dayId].sort();
        // Update both panels' chips in place — no full re-render, so the
        // other unsaved fields keep their DOM state as well as the draft.
        ['proactive-assistant-panel', 'mh-proactive-assistant-panel'].forEach((cid) => {
          const root = document.getElementById(cid);
          if (!root) return;
          root.querySelectorAll('[data-pa-weekday]').forEach((chip) => {
            const on = d.weekdays.includes(Number(chip.getAttribute('data-pa-weekday')));
            chip.classList.toggle('pa-weekday-selected', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        });
      });
    });

    const saveBtn = container.querySelector('[data-pa-save]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const d = ensureDraft();
        if (!d) return;
        if (d.weekdays.length === 0) {
          alert(t('proactiveAssistant.needsDay', 'Select at least one day.'));
          return;
        }
        saveConfig({ enabled: d.enabled, localTime: d.localTime || '08:00', timezone: d.timezone, weekdays: d.weekdays, notifyOnComplete: d.notifyOnComplete });
      });
    }
  }

  function renderInto(containerId, scope) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (signedOut) {
      container.innerHTML = `<p class="setting-sub pa-signed-out">${escapeHtml(t('settings.signInRequired', 'Sign in to view and change these settings.'))}</p><button type="button" class="btn-secondary" data-pa-signin>${escapeHtml(t('auth.signIn', 'Sign In'))}</button>`;
      const btn = container.querySelector('[data-pa-signin]');
      if (btn) btn.addEventListener('click', () => { if (window.NAGEX.showAuthModal) window.NAGEX.showAuthModal('signin'); });
      return;
    }
    if (!config) return;
    container.innerHTML = buildPanelHtml(config, scope);
    bindPanel(containerId);
  }

  function renderAll() {
    renderInto('proactive-assistant-panel', 'desktop');
    renderInto('mh-proactive-assistant-panel', 'mobile');
  }

  async function renderProactiveAssistant() {
    if (!configFetched) {
      configFetched = true;
      await fetchConfig();
    }
    renderAll();
  }

  async function reloadProactiveAssistant() {
    configFetched = true;
    draft = null;
    saveError = false;
    await fetchConfig();
    renderAll();
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderProactiveAssistant = renderProactiveAssistant;
  window.NAGEX.reloadProactiveAssistant = reloadProactiveAssistant;
})();
