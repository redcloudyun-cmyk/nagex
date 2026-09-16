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
  let draftWeekdays = null; // in-progress edit, null until the user touches the day picker

  async function fetchConfig() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/proactive-assistant/config');
    if (data && !data.error) config = data;
    return config;
  }

  async function saveConfig(next) {
    if (!window.NAGEX.apiFetch || saving) return;
    saving = true;
    renderAll();
    try {
      const data = await window.NAGEX.apiFetch('/api/v1/proactive-assistant/config', { method: 'PUT', body: JSON.stringify(next) });
      if (data && !data.error) config = data;
    } finally {
      saving = false;
      draftWeekdays = null;
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

  function buildPanelHtml(cfg) {
    const weekdays = draftWeekdays || cfg.weekdays || [];
    const tz = cfg.timezone || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
    const zones = commonTimezones();

    const weekdayChips = WEEKDAYS.map((w) => `
      <button type="button" class="pa-weekday-chip ${weekdays.includes(w.id) ? 'pa-weekday-selected' : ''}" data-pa-weekday="${w.id}">${escapeHtml(t(w.key, w.fallback))}</button>
    `).join('');

    const zoneOptions = zones.map((z) => `<option value="${escapeHtml(z)}" ${z === tz ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('');

    return `
      <div class="pa-toggle-row">
        <span class="pa-toggle-label">${escapeHtml(t('proactiveAssistant.enable', 'Generate automatically'))}</span>
        <label class="mh-toggle-switch pa-toggle-switch">
          <input type="checkbox" id="pa-enabled" ${cfg.enabled ? 'checked' : ''}>
          <span class="mh-toggle-slider"></span>
        </label>
      </div>
      <div class="pa-field-row">
        <label class="pa-field-label" for="pa-time">${escapeHtml(t('proactiveAssistant.time', 'Generation time'))}</label>
        <input type="time" id="pa-time" class="pa-time-input" value="${escapeHtml(cfg.localTime || '08:00')}">
      </div>
      <div class="pa-field-row">
        <label class="pa-field-label" for="pa-timezone">${escapeHtml(t('proactiveAssistant.timezone', 'Timezone'))}</label>
        <select id="pa-timezone" class="pa-timezone-select">${zoneOptions}</select>
      </div>
      <div class="pa-field-row pa-weekdays-row">
        <span class="pa-field-label">${escapeHtml(t('proactiveAssistant.weekdays', 'Days'))}</span>
        <div class="pa-weekday-chips">${weekdayChips}</div>
      </div>
      <div class="pa-toggle-row">
        <span class="pa-toggle-label">${escapeHtml(t('proactiveAssistant.notify', 'Notify me when ready'))}</span>
        <label class="mh-toggle-switch pa-toggle-switch">
          <input type="checkbox" id="pa-notify" ${cfg.notifyOnComplete !== false ? 'checked' : ''}>
          <span class="mh-toggle-slider"></span>
        </label>
      </div>
      <button type="button" class="btn-secondary pa-save-btn" id="pa-save">${escapeHtml(saving ? t('proactiveAssistant.saving', 'Saving…') : t('proactiveAssistant.save', 'Save'))}</button>
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

    container.querySelectorAll('[data-pa-weekday]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-pa-weekday'));
        const current = draftWeekdays || (config ? config.weekdays.slice() : []);
        draftWeekdays = current.includes(id) ? current.filter((d) => d !== id) : [...current, id].sort();
        renderAll();
      });
    });

    const saveBtn = container.querySelector('#pa-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const enabled = container.querySelector('#pa-enabled').checked;
        const localTime = container.querySelector('#pa-time').value || '08:00';
        const timezone = container.querySelector('#pa-timezone').value;
        const notifyOnComplete = container.querySelector('#pa-notify').checked;
        const weekdays = draftWeekdays || (config ? config.weekdays : []);
        if (weekdays.length === 0) {
          alert(t('proactiveAssistant.needsDay', 'Select at least one day.'));
          return;
        }
        saveConfig({ enabled, localTime, timezone, weekdays, notifyOnComplete });
      });
    }
  }

  function renderInto(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !config) return;
    container.innerHTML = buildPanelHtml(config);
    bindPanel(containerId);
  }

  function renderAll() {
    renderInto('proactive-assistant-panel');
    renderInto('mh-proactive-assistant-panel');
  }

  async function renderProactiveAssistant() {
    if (!configFetched) {
      configFetched = true;
      await fetchConfig();
    }
    renderAll();
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderProactiveAssistant = renderProactiveAssistant;
})();
