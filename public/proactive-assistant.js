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
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function paIcon(name) {
    const icons = {
      approval: 'M9 12l2 2 4-5m5 3a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
      completion: 'M20 6 9 17l-5-5',
      attention: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
      brief: 'M5 4h14v16H5V4Zm4 4h6M9 12h6M9 16h4',
      condition: 'M4 12a8 8 0 0 1 8-8m0 0v4m0-4h4m4 8a8 8 0 0 1-8 8m0 0v-4m0 4H8',
      suggestion: 'M9 18h6m-5 3h4m-2-18a7 7 0 0 0-4 12.7V16h8v-.3A7 7 0 0 0 12 3Z',
      clock: 'M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
      timezone: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2.4 4-5.5 4-9s-1.5-6.6-4-9m0 18c-2.5-2.4-4-5.5-4-9s1.5-6.6 4-9M3.6 9h16.8M3.6 15h16.8',
    };
    return '<svg class="settings-semantic-icon pa-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="' + (icons[name] || icons.brief) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function statusPill(on, onLabel, offLabel) {
    return '<span class="settings-state-pill ' + (on ? 'on' : '') + '">' + escapeHtml(on ? onLabel : offLabel) + '</span>';
  }

  function toggleControl(id, field, checked) {
    return '<label class="settings-toggle pa-settings-toggle" for="' + id + '"><input type="checkbox" id="' + id + '" data-pa-field="' + field + '" ' + (checked ? 'checked' : '') + '><span class="settings-toggle-track" aria-hidden="true"></span><span class="nagex-sr-only">' + escapeHtml(field) + '</span></label>';
  }

  function nextBriefLabel(cfg) {
    const formatted = formatDateTime(cfg.nextRunAt);
    if (formatted) return formatted;
    return cfg.enabled ? t('proactiveAssistant.nextFallback', 'Scheduled after the next update') : t('proactiveAssistant.notScheduled', 'Not scheduled');
  }

  function lastDeliveredLabel(cfg) {
    const formatted = formatDateTime(cfg.lastRunAt);
    if (formatted) return formatted;
    return t('proactiveAssistant.noneDelivered', 'No deliveries yet');
  }

  // scope ('desktop' | 'mobile') makes every id unique per panel — both
  // panels exist in the DOM at once, so shared ids would be duplicates.
  function buildPanelHtml(cfg, scope) {
    const form = draft || formFromConfig(cfg);
    const zones = commonTimezones();
    if (form.timezone && !zones.includes(form.timezone)) zones.unshift(form.timezone);
    const id = (name) => 'pa-' + scope + '-' + name;

    const weekdayChips = WEEKDAYS.map((w) => '<button type="button" class="pa-weekday-chip settings-day-chip ' + (form.weekdays.includes(w.id) ? 'pa-weekday-selected active' : '') + '" data-pa-weekday="' + w.id + '" aria-pressed="' + (form.weekdays.includes(w.id) ? 'true' : 'false') + '">' + escapeHtml(t(w.key, w.fallback)) + '</button>').join('');

    const zoneOptions = zones.map((z) => '<option value="' + escapeHtml(z) + '" ' + (z === form.timezone ? 'selected' : '') + '>' + escapeHtml(z) + '</option>').join('');

    const preferences = [
      ['approval', 'Approval needed', 'When NAgex needs your decision'],
      ['completion', 'Work completed', 'When background work finishes'],
      ['attention', 'Needs attention', 'When NAgex cannot continue safely'],
      ['brief', 'Scheduled brief', 'Daily or recurring summaries'],
      ['condition', 'Condition matched', 'When a watched condition becomes true'],
      ['suggestion', 'Proactive suggestions', 'Useful next actions from NAgex'],
    ];

    return '<div class="settings-notifications-grid">' +
      '<section class="settings-pro-card settings-notification-card">' +
        '<div class="settings-card-title-row"><div><h3>Notification preferences</h3><p class="setting-sub">Choose the updates NAgex should surface.</p></div></div>' +
        '<div class="settings-notification-rows">' + preferences.map(([icon, title, subtitle]) =>
          '<div class="settings-row-lite settings-notification-row"><span class="settings-row-leading">' + paIcon(icon) + '<span><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(subtitle) + '</small></span></span>' + statusPill(true, 'ON', 'OFF') + '</div>'
        ).join('') + '</div>' +
      '</section>' +
      '<section class="settings-pro-card settings-notification-card">' +
        '<div class="settings-card-title-row"><div><h3>Daily brief</h3><p class="setting-sub">Daily or recurring summaries from NAgex.</p></div>' + toggleControl(id('enabled'), 'enabled', form.enabled) + '</div>' +
        '<div class="settings-form-grid">' +
          '<label class="settings-field"><span>' + paIcon('clock') + ' Time</span><input type="time" id="' + id('time') + '" data-pa-field="localTime" class="settings-time-picker pa-time-input" value="' + escapeHtml(form.localTime) + '"></label>' +
          '<label class="settings-field"><span>' + paIcon('timezone') + ' Timezone</span><select id="' + id('timezone') + '" data-pa-field="timezone" class="settings-select pa-timezone-select">' + zoneOptions + '</select></label>' +
        '</div>' +
        '<div class="settings-field settings-days-field"><span>Days</span><div class="settings-day-selector pa-weekday-chips">' + weekdayChips + '</div></div>' +
        '<div class="settings-row-lite settings-notification-row"><span class="settings-row-leading"><span><strong>Notify me when ready</strong><small>Show a notification after the brief is prepared.</small></span></span>' + toggleControl(id('notify'), 'notifyOnComplete', form.notifyOnComplete) + '</div>' +
        '<div class="settings-brief-status"><div><span>Next brief</span><strong>' + escapeHtml(nextBriefLabel(cfg)) + '</strong></div><div><span>Last delivered</span><strong>' + escapeHtml(lastDeliveredLabel(cfg)) + '</strong></div></div>' +
        '<button type="button" class="settings-primary-action pa-save-btn" data-pa-save>' + escapeHtml(saving ? t('proactiveAssistant.saving', 'Saving...') : t('proactiveAssistant.saveChanges', 'Save changes')) + '</button>' +
        (saveError ? '<p class="pa-save-error" role="alert">' + escapeHtml(t('settings.saveFailed', 'Could not save settings.')) + '</p>' : '') +
      '</section>' +
    '</div>';
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
      container.innerHTML = `<section class="settings-pro-card settings-notification-card settings-notifications-signed-out"><div class="settings-card-title-row"><div><h3>Notification preferences</h3><p class="setting-sub">${escapeHtml(t('settings.signInRequired', 'Sign in to view and change these settings.'))}</p></div></div><button type="button" class="settings-primary-action" data-pa-signin>${escapeHtml(t('auth.signIn', 'Sign In'))}</button></section>`;
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
