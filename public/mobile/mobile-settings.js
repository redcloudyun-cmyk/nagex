// NAgex Mobile Settings (UI-5 R5) — the fifth and final native view inside
// the shared #mobile-app-shell (see mobile-home.js's updateShellVisibility(),
// the ONLY place deciding when #mobile-view-settings is shown). Never
// rendered while hidden — mobile-home.js only calls
// window.NAGEX.renderMobileSettings() when the active tab really is
// 'tab-settings' on a real mobile viewport.
//
// Exactly the real settings that exist today (verified in the R5
// preflight, not assumed): Quick Wake (5 real toggles), Autonomy Level (4
// real options), Google Calendar & Gmail connection, plus real navigation
// shortcuts to Memory/Automations/Advanced (Knowledge/Approvals/Skills/
// Tools) — none of which have a native mobile view yet, so tapping them
// correctly falls through to the legacy responsive tree by the existing
// shell-visibility contract. Deliberately NOT implemented (confirmed to
// not exist anywhere in this app, not fabricated to "look like a real
// app"): Model Gateway status (Desktop's own version is a static MOCK
// with zero real backing endpoint — not reproduced here), Dark Mode,
// notification preferences, any security/MFA/biometric control, any
// model/provider picker, any API key input, any integration beyond
// Google. No new backend endpoint, no invented field.
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  // ── Quick Wake — exactly the 5 real options Desktop's own renderSettings()
  // exposes (app.js:1744-1751). Real backend fields headset_button/
  // accessibility_shortcut exist but are not surfaced in any UI today —
  // not added here either (directive §6). ──
  const QUICKWAKE_OPTIONS = [
    { key: 'floating_button', labelKey: 'mobileSettings.qwFloatingButton', fallback: 'Floating NAgex Button' },
    { key: 'quick_settings_tile', labelKey: 'mobileSettings.qwQuickSettingsTile', fallback: 'Quick Settings Tile (Android)' },
    { key: 'lock_screen_shortcut', labelKey: 'mobileSettings.qwLockScreenShortcut', fallback: 'Lock Screen Shortcut' },
    { key: 'voice_wake', labelKey: 'mobileSettings.qwVoiceWake', fallback: 'Voice Wake Command' },
    { key: 'double_tap_shortcut', labelKey: 'mobileSettings.qwDoubleTapShortcut', fallback: 'Double-Tap Shortcut' },
  ];

  // R24.6B — Quick Wake / Autonomy render ONLY from the shared, server-
  // loaded state (state.quickWakeConfig / autonomyConfig / settingsPrefsStatus
  // — the same state Desktop renders from). Before the data is loaded nothing
  // is shown (never a default value); signed-out / failed loads say so. The
  // bridge in app.js owns the write, the "Saved."/error result, and the
  // re-render of both Settings views, so no local refetch or optimistic
  // mutation happens here.
  function prefsUnavailableHtml(status) {
    if (status === 'SIGNED_OUT') {
      return `
      <div class="mh-settings-row">
        <div class="mh-settings-row-body"><span class="mh-settings-row-title">${escapeHtml(t('settings.signInRequired', 'Sign in to view and change these settings.'))}</span></div>
        <button class="mh-settings-action-btn" type="button" data-prefs-signin>${escapeHtml(t('auth.signIn', 'Sign In'))}</button>
      </div>`;
    }
    if (status === 'ERROR') {
      return `<div class="mh-settings-row"><span class="mh-settings-row-title">${escapeHtml(t('settings.prefsUnavailable', 'These settings could not be loaded. Try again.'))}</span></div>`;
    }
    return '';
  }

  function bindPrefsSignIn(el) {
    const btn = el.querySelector('[data-prefs-signin]');
    if (btn) btn.addEventListener('click', () => { if (window.NAGEX.showAuthModal) window.NAGEX.showAuthModal('signin'); });
  }

  function renderQuickWake() {
    const el = document.getElementById('mh-quickwake-list');
    if (!el || !window.NAGEX.getState) return;
    const st = window.NAGEX.getState();
    if (st.settingsPrefsStatus !== 'OK') {
      el.innerHTML = prefsUnavailableHtml(st.settingsPrefsStatus);
      bindPrefsSignIn(el);
      return;
    }
    const config = st.quickWakeConfig || {};

    const rows = QUICKWAKE_OPTIONS.map((opt) => `
      <div class="mh-settings-row">
        <span class="mh-settings-row-title">${escapeHtml(t(opt.labelKey, opt.fallback))}</span>
        <label class="mh-toggle-switch">
          <input type="checkbox" ${config[opt.key] ? 'checked' : ''} data-qw-key="${opt.key}">
          <span class="mh-toggle-slider"></span>
        </label>
      </div>`).join('');

    const fingerprintRow = `
      <div class="mh-settings-row">
        <span class="mh-settings-row-title">${escapeHtml(t('mobileSettings.qwFingerprintButton', 'Fingerprint Sensor Button'))}</span>
        <span class="mh-settings-tag">${escapeHtml(t('mobileSettings.qwFingerprintNotSupported', 'Not supported on this device'))}</span>
      </div>`;

    const note = config.runtime_effect === 'NONE'
      ? `<div class="mh-settings-row"><span class="mh-row-detail" id="mh-quickwake-pref-note">${escapeHtml(t('settings.preferenceOnlyQuickWake', 'Saved as your preference. No NAgex app applies these shortcuts yet.'))}</span></div>`
      : '';

    el.innerHTML = rows + fingerprintRow + note;

    el.querySelectorAll('input[data-qw-key]').forEach((input) => {
      input.addEventListener('change', (e) => {
        window.NAGEX.toggleQuickWakeOpt(e.target.getAttribute('data-qw-key'), e.target.checked);
      });
    });
  }

  // ── Autonomy Level — exactly the 4 real levels Desktop exposes
  // (app.js:1772-1777). Desktop's own titles/descriptions are hardcoded
  // English never run through t() — Mobile does not repeat that gap, real
  // i18n keys carrying the same real meaning are used instead (directive
  // §9). ──
  const AUTONOMY_LEVELS = [
    { id: 'L0', titleKey: 'mobileSettings.autonomyL0Title', titleFallback: 'Always ask', descKey: 'mobileSettings.autonomyL0Desc', descFallback: 'Check with you before making any change.' },
    { id: 'L1', titleKey: 'mobileSettings.autonomyL1Title', titleFallback: 'Read and suggest', descKey: 'mobileSettings.autonomyL1Desc', descFallback: 'Find information and suggest next steps without making changes.' },
    { id: 'L2', titleKey: 'mobileSettings.autonomyL2Title', titleFallback: 'Help with routine tasks', descKey: 'mobileSettings.autonomyL2Desc', descFallback: 'Check with you before sending or changing anything important.' },
    { id: 'L3', titleKey: 'mobileSettings.autonomyL3Title', titleFallback: 'Use trusted routines', descKey: 'mobileSettings.autonomyL3Desc', descFallback: 'Run routines you have already reviewed and allowed.' },
  ];

  function renderAutonomy() {
    const el = document.getElementById('mh-autonomy-list');
    if (!el || !window.NAGEX.getState) return;
    const st = window.NAGEX.getState();
    if (st.settingsPrefsStatus !== 'OK') {
      el.innerHTML = prefsUnavailableHtml(st.settingsPrefsStatus);
      bindPrefsSignIn(el);
      return;
    }
    const current = (st.autonomyConfig || {}).level;

    const note = (st.autonomyConfig || {}).runtime_effect === 'NONE'
      ? `<div class="mh-settings-row"><span class="mh-row-detail" id="mh-autonomy-pref-note">${escapeHtml(t('settings.preferenceOnlyAutonomy', 'Saved as your preference. It does not change how NAgex acts yet — consequential actions still always need your approval.'))}</span></div>`
      : '';

    el.innerHTML = AUTONOMY_LEVELS.map((lvl) => `
      <button class="mh-autonomy-card ${current === lvl.id ? 'selected' : ''}" data-autonomy-id="${lvl.id}">
        <span class="mh-settings-row-title">${escapeHtml(t(lvl.titleKey, lvl.titleFallback))}</span>
        <span class="mh-row-detail">${escapeHtml(t(lvl.descKey, lvl.descFallback))}</span>
      </button>`).join('') + note;

    el.querySelectorAll('[data-autonomy-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.NAGEX.selectAutonomy(btn.getAttribute('data-autonomy-id'));
      });
    });
  }

  // ── Google Calendar & Gmail — the only real integration in this app
  // (directive §10/§11). Connect is a real full-page redirect; Disconnect
  // reuses the exact real POST + status-refetch Desktop's own handler
  // already does (app.js:1819-1831) — not a new OAuth implementation.
  //
  // R3 §7: the two per-product scope rows below are derived entirely from
  // the real `scopes` array GET /api/v1/oauth/google/status already
  // returns (token.store.ts's getStatus(), scope string split on space) —
  // never a hardcoded connected=true. A scope string containing
  // "calendar"/"gmail" is a real granted-scope substring match against the
  // exact URLs this app requests (oauth.client.ts's GOOGLE_CALENDAR_SCOPES/
  // GMAIL_SCOPES), not an invented status. ──
  function renderConnections() {
    const el = document.getElementById('mh-connections-row');
    if (!el || !window.NAGEX.getState) return;
    if (window.NAGEX.getState().googleOAuthSignedOut) {
      el.innerHTML = prefsUnavailableHtml('SIGNED_OUT');
      bindPrefsSignIn(el);
      return;
    }
    const oauth = window.NAGEX.getState().googleOAuth || { configured: false, connected: false, scopes: [] };
    const scopes = oauth.scopes || [];

    const statusLabel = oauth.connected
      ? t('settings.connected', 'Connected')
      : oauth.configured
        ? t('settings.notConnected', 'Not connected')
        : t('settings.notConfigured', 'Not configured on this server');

    function scopeRow(labelKey, labelFallback, matchSubstr) {
      const has = scopes.some((s) => s.includes(matchSubstr));
      const scopeLabel = !oauth.connected
        ? t('mobileSettings.scopeNotConnected', 'Not connected')
        : has
          ? t('mobileSettings.scopeOk', 'Connected · Scope OK')
          : t('mobileSettings.scopeMissing', 'Reconnect needed');
      const tagClass = !oauth.connected ? 'mh-settings-tag-muted' : has ? 'mh-settings-tag-ok' : 'mh-settings-tag-warn';
      return `
      <div class="mh-settings-row mh-settings-row-indent">
        <span class="mh-settings-row-title">${escapeHtml(t(labelKey, labelFallback))}</span>
        <span class="mh-settings-tag ${tagClass}">${escapeHtml(scopeLabel)}</span>
      </div>`;
    }

    el.innerHTML = `
      <div class="mh-settings-row">
        <div class="mh-settings-row-body">
          <span class="mh-settings-row-title">${escapeHtml(t('mobileSettings.googleService', 'Google Calendar & Gmail'))}</span>
          <span class="mh-settings-tag ${oauth.connected ? 'mh-settings-tag-ok' : ''}">${escapeHtml(statusLabel)}</span>
        </div>
        <button class="mh-settings-action-btn" id="mh-google-toggle" ${!oauth.configured ? 'disabled' : ''}>
          ${escapeHtml(oauth.connected ? t('settings.disconnect', 'Disconnect') : t('settings.connect', 'Connect'))}
        </button>
      </div>
      ${oauth.configured ? scopeRow('mobileSettings.googleCalendarScope', 'Calendar', 'calendar') + scopeRow('mobileSettings.googleGmailScope', 'Gmail', 'gmail') : ''}`;

    const btn = document.getElementById('mh-google-toggle');
    if (btn && oauth.configured) {
      btn.onclick = async () => {
        if (oauth.connected) {
          await window.NAGEX.apiFetch('/api/v1/oauth/google/disconnect', { method: 'POST' });
          const fresh = await window.NAGEX.apiFetch('/api/v1/oauth/google/status');
          if (fresh) window.NAGEX.getState().googleOAuth = fresh;
          renderConnections();
        } else {
          window.location.href = '/api/v1/oauth/google/start';
        }
      };
    }
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-settings-lang-toggle');
  }

  // R7 §2/§3 — real GET /api/v1/providers/status only (state.providerStatus,
  // already fetched once by app.js's loadAllData(); same shared state
  // Desktop's renderSettingsAiModel() reads, no second fetch). Read-only:
  // no provider-switching UI exists because no backend contract for that
  // exists yet.
  const STATUS_BADGE_TAG_CLASS = { UNCONFIGURED: 'mh-settings-tag-muted', CONFIGURED: '', LIVE: 'mh-settings-tag-ok', DEGRADED: 'mh-settings-tag-warn' };
  const STATUS_LABEL_KEY = { UNCONFIGURED: 'settings.providerStatusUnconfigured', CONFIGURED: 'settings.providerStatusConfigured', LIVE: 'settings.providerStatusLive', DEGRADED: 'settings.providerStatusDegraded' };
  const STATUS_LABEL_FALLBACK = { UNCONFIGURED: 'Not configured', CONFIGURED: 'Configured — not yet used', LIVE: 'Live', DEGRADED: 'Degraded' };

  function renderAiModel() {
    const el = document.getElementById('mh-ai-model-status');
    if (!el || !window.NAGEX.getState) return;
    const data = window.NAGEX.getState().providerStatus;
    const providers = ((data && data.providers) || []).filter((p) => p.status !== 'UNCONFIGURED');

    if (providers.length === 0) {
      el.innerHTML = `<div class="mh-settings-row"><span class="mh-settings-row-title">${escapeHtml(t('settings.providerNoneConfigured', 'No model provider is configured on this server.'))}</span></div>`;
      return;
    }

    el.innerHTML = providers.map((p) => {
      const isActive = data.activeProvider === p.provider;
      const roleLabel = isActive ? t('settings.providerActive', 'Active') : t('settings.providerFallback', 'Fallback');
      return `
      <div class="mh-settings-row">
        <div class="mh-settings-row-body">
          <span class="mh-settings-row-title">${escapeHtml(p.provider)}${p.model ? ` · ${escapeHtml(p.model)}` : ''}</span>
          <span class="mh-settings-tag mh-settings-tag-muted">${escapeHtml(roleLabel)}</span>
        </div>
        <span class="mh-settings-tag ${STATUS_BADGE_TAG_CLASS[p.status] || ''}">${escapeHtml(t(STATUS_LABEL_KEY[p.status], STATUS_LABEL_FALLBACK[p.status] || p.status))}</span>
      </div>`;
    }).join('');
  }

  // ── Advanced — local, ephemeral expand/collapse only, same as Desktop's
  // own wireSettingsAdvancedToggle() (app.js:1837-1849). No persistence
  // needed or added. ──
  function initAdvancedToggle() {
    const toggle = document.getElementById('mh-settings-advanced-toggle');
    const list = document.getElementById('mh-settings-advanced-list');
    if (!toggle || !list || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      toggle.classList.toggle('mh-settings-advanced-open', !expanded);
    });
  }

  // opts.dataOnly: re-render only the sections driven by loaded app state
  // (Quick Wake, Autonomy, Connections, AI model). Account, Organization and
  // Proactive Assistant own in-progress form input, so a data refresh (boot
  // load, polling, a Settings write) must never repaint them.
  function renderMobileSettings(opts) {
    if (!document.getElementById('mobile-view-settings')) return;
    const dataOnly = Boolean(opts && opts.dataOnly);
    if (!dataOnly) {
      initLangToggle();
      initAdvancedToggle();
    }
    // No fetch of its own: state.quickWakeConfig/autonomyConfig/googleOAuth
    // come from app.js's loadAllData(). R24.6B — app.js re-invokes this
    // after loadAllData()/checkSession()/every Settings write, so a cold load
    // never leaves pre-load values on screen.
    renderQuickWake();
    renderAutonomy();
    renderConnections();
    renderAiModel();
    if (dataOnly) return;
    if (window.NAGEX.renderAccountSettings) window.NAGEX.renderAccountSettings();
    if (window.NAGEX_ORG_UI && window.NAGEX_ORG_UI.renderOrgSettingsPanel) window.NAGEX_ORG_UI.renderOrgSettingsPanel();
    if (window.NAGEX.renderProactiveAssistant) window.NAGEX.renderProactiveAssistant();
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileSettings = renderMobileSettings;
})();
