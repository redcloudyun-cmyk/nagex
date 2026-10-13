// NAgex Identity & Account Lifecycle Web UI Controller (R13)
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    const resolved = window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null;
    return resolved && resolved !== key ? resolved : (fallback || key);
  }

  // shown once after the next Account render (a successful save re-renders the panel)
  let accountNotice = null; // { text, at }

  let currentUserState = {
    authenticated: false,
    user: null,
    profile: null,
    session: null,
  };

  async function checkSession() {
    try {
      const res = await window.NAGEX.apiFetch('/api/v1/auth/session');
      if (res && res.authenticated) {
        currentUserState = res;
      } else {
        currentUserState = { authenticated: false, user: null, profile: null, session: null };
      }
    } catch {
      currentUserState = { authenticated: false, user: null, profile: null, session: null };
    }
    updateUserHeader();
    applyAccountLocale();
    // R24.6B — the session result changes what Settings may show (Account
    // panel, per-user preferences). Re-render Settings from the new truth
    // instead of leaving the pre-session render on screen.
    renderAccountSettings();
    if (window.NAGEX && window.NAGEX.reloadSettingsPrefs) window.NAGEX.reloadSettingsPrefs();
  }

  // R24.6B — locale truth. For an authenticated account, profile.locale
  // ('en' | 'ko') is the canonical preference; localStorage 'nagex_locale'
  // is only the presentation cache for the current browser (it is all an
  // anonymous visitor has). The session applies the account locale to the
  // cache, and a language change made while signed in is written through to
  // the profile so the two cannot diverge.
  function canonicalLocale(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (v === 'en') return 'en';
    if (v === 'ko' || v === 'kr') return 'ko';
    return null;
  }

  function applyAccountLocale() {
    if (!currentUserState.authenticated || !window.NAGEX_I18N) return;
    const cachedLocale = canonicalLocale(localStorage.getItem('nagex_locale'));
    if (cachedLocale) return;
    const accountLocale = canonicalLocale(currentUserState.profile && currentUserState.profile.locale);
    if (accountLocale && accountLocale !== window.NAGEX_I18N.getLocale()) window.NAGEX_I18N.setLocale(accountLocale);
  }

  window.addEventListener('nagex:localechange', async (e) => {
    // R24.6D — the Account surface is painted from t() at render time, so a language change
    // must repaint it (Desktop's and Mobile's containers share this one renderer).
    renderAccountSettings();
    if (!currentUserState.authenticated) return;
    const next = canonicalLocale(e.detail && e.detail.locale);
    const current = canonicalLocale(currentUserState.profile && currentUserState.profile.locale);
    if (!next || next === current) return;
    const res = await window.NAGEX.apiFetch('/api/v1/account/profile', { method: 'PATCH', body: JSON.stringify({ locale: next }) });
    if (res && res.profile && !res.error) {
      currentUserState = { ...currentUserState, profile: { ...currentUserState.profile, locale: res.profile.locale } };
    }
  });

  function updateUserHeader() {
    const avatarEl = document.querySelector('.user-avatar-img');
    const mhAvatarEl = document.getElementById('mh-avatar');
    const userNameEl = document.querySelector('.user-name');
    const greetingSubEl = document.getElementById('header-greeting-sub');

    if (currentUserState.authenticated && currentUserState.user) {
      const name = currentUserState.profile?.displayName || currentUserState.user.email.split('@')[0];
      const initial = name.charAt(0).toUpperCase();

      if (avatarEl) avatarEl.textContent = initial;
      if (mhAvatarEl) mhAvatarEl.textContent = initial;
      if (userNameEl) userNameEl.innerHTML = `${escapeHtml(name)} <svg class="chevron-sm" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;
      if (greetingSubEl) greetingSubEl.textContent = `${currentUserState.user.accountState === 'DELETION_PENDING' ? t('shell.deletionPending', '[Deletion Pending]') : t('shell.signedInAs', 'Signed in as')}`;
    } else {
      if (avatarEl) avatarEl.textContent = '?';
      if (mhAvatarEl) mhAvatarEl.textContent = '?';
      if (userNameEl) userNameEl.innerHTML = `${escapeHtml(t('auth.signIn', 'Sign In'))} <svg class="chevron-sm" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;
      if (greetingSubEl) greetingSubEl.textContent = t('shell.welcome', 'Welcome,');
    }
  }

  // ── Render Auth Modal ──
  function ensureAuthModal() {
    let modal = document.getElementById('auth-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'auth-modal';
      modal.className = 'modal-backdrop';
      modal.hidden = true;
      modal.innerHTML = `
        <div class="modal-card auth-modal-card" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
          <div class="modal-header">
            <h3 id="auth-modal-title">Sign In</h3>
            <button class="modal-close-btn" id="auth-modal-close" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body" id="auth-modal-body"></div>
        </div>`;
      document.body.appendChild(modal);

      document.getElementById('auth-modal-close')?.addEventListener('click', hideAuthModal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) hideAuthModal();
      });
    }
    return modal;
  }

  async function loadAuthProviders() {
    try {
      const res = await window.NAGEX.apiFetch('/api/v1/auth/providers');
      return res && res.providers ? res.providers : {};
    } catch {
      return {};
    }
  }

  async function showAuthModal(view = 'signin', params = {}) {
    const modal = ensureAuthModal();
    const body = document.getElementById('auth-modal-body');
    const title = document.getElementById('auth-modal-title');
    if (!body || !title) return;

    modal.hidden = false;

    title.textContent = t('auth.welcome', 'Welcome to NAgex');
    body.innerHTML = `<p class="auth-subtitle">${escapeHtml(t('auth.loadingProviders', 'Loading sign-in options...'))}</p>`;

    const providers = await loadAuthProviders();
    const buttons = [];
    if (providers.google && providers.google.enabled) {
      buttons.push(`
        <button type="button" class="auth-provider-btn auth-provider-google" id="btn-auth-google">
          <svg class="provider-icon google-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
          </svg>
          <span>${escapeHtml(t('auth.continueGoogle', 'Continue with Google'))}</span>
        </button>`);
    }
    if (providers.microsoft && providers.microsoft.enabled) {
      buttons.push(`
        <button type="button" class="auth-provider-btn auth-provider-microsoft" id="btn-auth-microsoft">
          <svg class="provider-icon microsoft-icon" width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
            <path fill="#f35325" d="M1 1h10v10H1z"/>
            <path fill="#81bc06" d="M12 1h10v10H1z"/>
            <path fill="#05a6f0" d="M1 12h10v10H1z"/>
            <path fill="#ffba08" d="M12 12h10v10H1z"/>
          </svg>
          <span>${escapeHtml(t('auth.continueMicrosoft', 'Continue with Microsoft'))}</span>
        </button>`);
    }

    body.innerHTML = `
      <div class="auth-provider-first">
        <p class="auth-subtitle">${escapeHtml(t('auth.subtitle', 'Your personal AI for getting things done.'))}</p>
        ${buttons.length ? buttons.join('') : `<p class="auth-info-text">${escapeHtml(t('auth.noProviders', 'Sign-in is not configured for this runtime.'))}</p>`}
        <div class="auth-msg-area" id="auth-msg-area"></div>
      </div>
      <div class="auth-legal"><a href="privacy.html">${escapeHtml(t('auth.privacy', 'Privacy'))}</a><span>·</span><a href="terms.html">${escapeHtml(t('auth.terms', 'Terms'))}</a></div>`;

    const beginProvider = (provider) => {
      const button = document.getElementById(`btn-auth-${provider}`);
      if (button) { button.disabled = true; button.textContent = t('auth.redirecting', 'Opening secure sign-in...'); }
      window.location.assign(`/api/v1/auth/oauth/${provider}/start`);
    };
    document.getElementById('btn-auth-google')?.addEventListener('click', () => beginProvider('google'));
    document.getElementById('btn-auth-microsoft')?.addEventListener('click', () => beginProvider('microsoft'));
  }

  async function showLegacyMigrationModal(token) {
    const modal = ensureAuthModal();
    const body = document.getElementById('auth-modal-body');
    const title = document.getElementById('auth-modal-title');
    modal.hidden = false;
    title.textContent = t('auth.legacyMigrationTitle', 'Existing NAgex account found');
    body.innerHTML = `<p class="auth-subtitle">${escapeHtml(t('auth.loadingMigration', 'Loading account migration...'))}</p>`;
    try {
      const res = await window.NAGEX.apiFetch(`/api/v1/auth/oauth/migration/${encodeURIComponent(token)}`);
      const migration = res.migration;
      const providerLabel = migration.provider === 'google' ? 'Google' : 'Microsoft';
      body.innerHTML = `
        <div class="auth-provider-first">
          <p class="auth-info-text">${escapeHtml(t('auth.legacyMigrationBody', 'NAgex found an existing account for this verified email. The existing account will be preserved and future sign-in will use this OAuth provider.'))}</p>
          <p class="auth-info-text"><strong>${escapeHtml(migration.email)}</strong><br>${escapeHtml(providerLabel)}</p>
          <button type="button" class="btn btn-primary" id="btn-confirm-oauth-migration">${escapeHtml(t('auth.confirmOAuthMigration', `Connect existing account to ${providerLabel}`))}</button>
          <button type="button" class="btn btn-secondary" id="btn-cancel-oauth-migration">${escapeHtml(t('auth.cancel', 'Cancel'))}</button>
          <div class="auth-msg-area" id="auth-msg-area"></div>
        </div>`;
      document.getElementById('btn-cancel-oauth-migration')?.addEventListener('click', hideAuthModal);
      document.getElementById('btn-confirm-oauth-migration')?.addEventListener('click', async () => {
        const msgArea = document.getElementById('auth-msg-area');
        try {
          await window.NAGEX.apiFetch(`/api/v1/auth/oauth/migration/${encodeURIComponent(token)}`, { method: 'POST' });
          await checkSession();
          hideAuthModal();
          if (window.NAGEX.renderMobileSettings) window.NAGEX.renderMobileSettings();
        } catch {
          if (msgArea) msgArea.innerHTML = `<p class="form-error" role="alert">${escapeHtml(t('auth.migrationFailed', 'This migration request could not be completed. Please start sign-in again.'))}</p>`;
        }
      });
    } catch {
      body.innerHTML = `<p class="form-error" role="alert">${escapeHtml(t('auth.migrationExpired', 'This migration request expired. Please start sign-in again.'))}</p>`;
    }
  }

  // ── Disable / delete an account that signs in with Google or Microsoft ──
  // The server requires a session created by a provider sign-in within the last few minutes plus the typed account email. When the session is older it answers
  // REAUTH_REQUIRED; the person signs in again and this dialog reopens (remembered in sessionStorage for the same account only, for a few minutes).
  const PENDING_LIFECYCLE_KEY = 'nagex.pendingAccountLifecycle';

  function rememberLifecycleIntent(kind, email) {
    try { sessionStorage.setItem(PENDING_LIFECYCLE_KEY, JSON.stringify({ kind, email, at: Date.now() })); } catch { /* storage unavailable: the person simply starts again */ }
  }

  function takeLifecycleIntent() {
    try {
      const raw = sessionStorage.getItem(PENDING_LIFECYCLE_KEY);
      sessionStorage.removeItem(PENDING_LIFECYCLE_KEY);
      const intent = raw ? JSON.parse(raw) : null;
      return intent && (intent.kind === 'disable' || intent.kind === 'delete') && Date.now() - Number(intent.at) < 10 * 60000 ? intent : null;
    } catch { return null; }
  }

  function showAccountLifecycleModal(kind) {
    const user = currentUserState.user;
    if (!user) return;
    const provider = String(user.authProvider || '');
    const providerLabel = provider === 'microsoft' ? 'Microsoft' : 'Google';
    const isDelete = kind === 'delete';
    const modal = ensureAuthModal();
    const body = document.getElementById('auth-modal-body');
    document.getElementById('auth-modal-title').textContent = isDelete ? t('account.lifecycle.deleteTitle', 'Delete your account?') : t('account.lifecycle.disableTitle', 'Disable your account?');
    modal.hidden = false;
    body.innerHTML = `
      <div class="auth-provider-first" id="account-lifecycle-dialog" data-kind="${isDelete ? 'delete' : 'disable'}">
        <p class="auth-info-text">${escapeHtml(isDelete
          ? t('account.lifecycle.deleteBody', 'Your account and data will be scheduled for deletion in 14 days and every device will be signed out. Signing in again within 14 days lets you cancel the deletion.')
          : t('account.lifecycle.disableBody', 'Your account will be turned off and every device will be signed out. Nothing is deleted, and you can turn it back on by signing in again.'))}</p>
        <label class="auth-label" for="lifecycle-confirm-email">${escapeHtml(t('account.lifecycle.emailLabel', 'Type your account email to confirm'))}</label>
        <input class="form-input" id="lifecycle-confirm-email" type="email" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(user.email || '')}">
        <button type="button" class="btn btn-primary" id="btn-lifecycle-confirm" disabled>${escapeHtml(isDelete ? t('account.lifecycle.confirmDelete', 'Delete account') : t('account.lifecycle.confirmDisable', 'Disable account'))}</button>
        <button type="button" class="btn btn-secondary" id="btn-lifecycle-cancel">${escapeHtml(t('auth.cancel', 'Cancel'))}</button>
        <div class="auth-msg-area" id="auth-msg-area" role="status"></div>
      </div>`;
    const input = document.getElementById('lifecycle-confirm-email');
    const confirm = document.getElementById('btn-lifecycle-confirm');
    const msgArea = document.getElementById('auth-msg-area');
    const typedMatches = () => input.value.trim().toLowerCase() === String(user.email || '').trim().toLowerCase();
    input.addEventListener('input', () => { confirm.disabled = !typedMatches(); });
    document.getElementById('btn-lifecycle-cancel')?.addEventListener('click', hideAuthModal);
    confirm.addEventListener('click', async () => {
      if (!typedMatches()) return;
      confirm.disabled = true;
      const res = await window.NAGEX.apiFetch(isDelete ? '/api/v1/account/delete' : '/api/v1/account/disable', { method: 'POST', body: JSON.stringify({ confirmEmail: input.value.trim() }) });
      if (res && res.error && res.error.code === 'REAUTH_REQUIRED') {
        const path = (res.error.details && res.error.details.reauthPath) || `/api/v1/auth/oauth/${provider}/start`;
        msgArea.innerHTML = `<p class="auth-info-text" role="alert">${escapeHtml(t('account.lifecycle.reauth', 'For your safety, sign in again to confirm this change.'))}</p>
          <button type="button" class="btn btn-primary" id="btn-lifecycle-reauth">${escapeHtml(t('account.lifecycle.reauthButton', 'Sign in again'))} (${escapeHtml(providerLabel)})</button>`;
        document.getElementById('btn-lifecycle-reauth')?.addEventListener('click', () => { rememberLifecycleIntent(kind, user.email); window.location.assign(path); });
        return;
      }
      if (res && !res.error) {
        body.innerHTML = `<div class="auth-provider-first"><p class="auth-info-text" role="status">${escapeHtml(isDelete
          ? t('account.lifecycle.deletedDone', 'Deletion is scheduled. Sign in within 14 days if you change your mind.')
          : t('account.lifecycle.disabledDone', 'Your account is disabled. Sign in again any time to turn it back on.'))}</p>
          <button type="button" class="btn btn-secondary" id="btn-lifecycle-close">${escapeHtml(t('account.lifecycle.close', 'Close'))}</button></div>`;
        document.getElementById('btn-lifecycle-close')?.addEventListener('click', hideAuthModal);
        await checkSession();
        renderAccountSettings();
        return;
      }
      confirm.disabled = !typedMatches();
      msgArea.innerHTML = `<p class="form-error" role="alert">${escapeHtml((res && res.error && res.error.message) || t('account.lifecycle.failed', 'That could not be completed. Please try again.'))}</p>`;
    });
    input.focus();
  }

  // ── A provider sign-in on a disabled / deletion-pending account: no session is opened; the person chooses explicitly ──
  async function showAccountRecoveryModal(token) {
    const modal = ensureAuthModal();
    const body = document.getElementById('auth-modal-body');
    const title = document.getElementById('auth-modal-title');
    modal.hidden = false;
    title.textContent = t('auth.recoveryLoading', 'Checking your account...');
    body.innerHTML = '';
    const info = await window.NAGEX.apiFetch(`/api/v1/auth/oauth/recovery/${encodeURIComponent(token)}`);
    const recovery = info && info.recovery;
    if (!recovery) {
      title.textContent = t('auth.signIn', 'Sign In');
      body.innerHTML = `<p class="form-error" role="alert">${escapeHtml(t('auth.recoveryExpired', 'This request expired. Please sign in again.'))}</p>`;
      return;
    }
    const pending = recovery.state === 'DELETION_PENDING';
    title.textContent = pending ? t('auth.recoveryTitlePending', 'Your account is scheduled for deletion') : t('auth.recoveryTitleDisabled', 'Your account is disabled');
    body.innerHTML = `
      <div class="auth-provider-first" id="account-recovery-dialog" data-state="${escapeHtml(recovery.state)}">
        <p class="auth-info-text">${escapeHtml(pending
          ? t('auth.recoveryBodyPending', 'This account is scheduled for deletion. Do you want to cancel the deletion and keep it?')
          : t('auth.recoveryBodyDisabled', 'Do you want to turn this account back on?'))}</p>
        <p class="auth-info-text"><strong>${escapeHtml(recovery.email || '')}</strong></p>
        <button type="button" class="btn btn-primary" id="btn-account-recover">${escapeHtml(pending ? t('auth.recoveryCancelDeletion', 'Cancel deletion and keep my account') : t('auth.recoveryReactivate', 'Turn account back on'))}</button>
        <button type="button" class="btn btn-secondary" id="btn-account-recover-leave">${escapeHtml(t('auth.recoveryLeave', 'Leave it as it is'))}</button>
        <div class="auth-msg-area" id="auth-msg-area" role="status"></div>
      </div>`;
    document.getElementById('btn-account-recover-leave')?.addEventListener('click', hideAuthModal);
    document.getElementById('btn-account-recover')?.addEventListener('click', async () => {
      const done = await window.NAGEX.apiFetch(`/api/v1/auth/oauth/recovery/${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ action: pending ? 'CANCEL_DELETION' : 'REACTIVATE' }) });
      if (done && !done.error) {
        await checkSession();
        hideAuthModal();
        renderAccountSettings();
        if (window.NAGEX.renderMobileSettings) window.NAGEX.renderMobileSettings();
        return;
      }
      const msgArea = document.getElementById('auth-msg-area');
      if (msgArea) msgArea.innerHTML = `<p class="form-error" role="alert">${escapeHtml(t('auth.recoveryExpired', 'This request expired. Please sign in again.'))}</p>`;
    });
  }

  function hideAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.hidden = true;
  }

  // ── Render Settings Account surface ──
  // R24.6D — ONE implementation and ONE state (currentUserState + the account APIs) feeds
  // every container that exists: Mobile's #mh-account-panel (original ids, unprefixed) and
  // Desktop's #desktop-account-panel (ids prefixed "dk-" so both can coexist without
  // duplicate DOM ids). renderAccountSettings() repaints all present containers.
  const ACCOUNT_CONTAINERS = [
    { id: 'mh-account-panel', prefix: '' },
    { id: 'desktop-account-panel', prefix: 'dk-' },
  ];

  async function renderAccountSettings() {
    const targets = ACCOUNT_CONTAINERS.filter((c) => document.getElementById(c.id));
    if (!targets.length) return;
    // One sessions fetch shared by every container (no per-container state/requests).
    const sessionsPromise = currentUserState.authenticated
      ? window.NAGEX.apiFetch('/api/v1/account/sessions').catch(() => null)
      : Promise.resolve(null);
    await Promise.all(targets.map((c) => renderAccountInto(c.id, c.prefix, sessionsPromise)));

  }

  async function renderAccountInto(containerId, idp, sessionsPromise) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!currentUserState.authenticated) {
      el.innerHTML = `
        <div class="mh-settings-row">
          <div class="mh-settings-row-body">
            <span class="mh-settings-row-title">${escapeHtml(t('account.signInPrompt', 'Sign in to manage your account'))}</span>
            <span class="mh-row-detail">${escapeHtml(t('account.signInPromptDesc', 'Access your profile, credentials, active sessions, and data lifecycle settings.'))}</span>
          </div>
          <button class="mh-settings-action-btn" id="${idp}btn-account-signin-trigger">${escapeHtml(t('auth.signIn', 'Sign In'))}</button>
        </div>`;
      document.getElementById(idp + 'btn-account-signin-trigger')?.addEventListener('click', () => showAuthModal('signin'));
      return;
    }

    const { user, profile } = currentUserState;
    // Disable / delete are confirmed with a password; accounts that sign in with Google or Microsoft have none,
    // so those controls could never succeed. They are only offered where they can work.
    const provider = String(user.authProvider || '');
    const passwordLifecycle = provider === 'local';
    // Google / Microsoft accounts confirm with a fresh provider sign-in + their typed email (no password exists); other providers are managed by their organization.
    const providerLifecycle = provider === 'google' || provider === 'microsoft';
    const lifecycleControls = passwordLifecycle || providerLifecycle;
    const methodLabel = provider ? t('account.method.' + provider, provider) : '';
    let sessionsHtml = `<div class="nagex-loading-row">${escapeHtml(t('account.loadingSessions', 'Loading active sessions...'))}</div>`;

    el.innerHTML = `
      <div class="mh-settings-account-section">
        <!-- Profile Form -->
        <h4 class="mh-settings-subheading">${escapeHtml(t('account.profile', 'Profile'))}</h4>
        <div class="mh-settings-row">
          <div class="mh-settings-row-body">
            <span class="mh-settings-row-title">${escapeHtml(t('account.email', 'Email'))}</span>
            <span class="mh-row-detail" id="${idp}acc-email">${escapeHtml(user.email || '')}</span>
          </div>
        </div>
        ${methodLabel ? `<div class="mh-settings-row">
          <div class="mh-settings-row-body">
            <span class="mh-settings-row-title">${escapeHtml(t('account.signInMethod', 'Sign-in method'))}</span>
            <span class="mh-row-detail" id="${idp}acc-method">${escapeHtml(methodLabel)}</span>
          </div>
        </div>` : ''}
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label for="${idp}acc-profile-name">${escapeHtml(t('account.displayName', 'Display Name'))}</label>
            <input type="text" id="${idp}acc-profile-name" class="mh-input" value="${escapeHtml(profile?.displayName || '')}">
          </div>
        </div>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.locale', 'Language / Locale'))}</label>
            <select id="${idp}acc-profile-locale" class="mh-select">
              <option value="en" ${canonicalLocale(profile?.locale) === 'en' ? 'selected' : ''}>English (EN)</option>
              <option value="ko" ${canonicalLocale(profile?.locale) === 'ko' ? 'selected' : ''}>한국어 (KR)</option>
            </select>
          </div>
        </div>
        <div class="mh-settings-row">
          <button class="mh-settings-action-btn" id="${idp}btn-save-profile">${escapeHtml(t('account.saveProfile', 'Save Profile'))}</button>
        </div>
        <div id="${idp}acc-profile-msg" role="status"></div>

        <!-- Sessions Manager -->
        <h4 class="mh-settings-subheading">${escapeHtml(t('account.sessions', 'Active Sessions'))}</h4>
        <div id="${idp}acc-sessions-list">${sessionsHtml}</div>
        <div class="mh-settings-row">
          <button class="mh-settings-action-btn mh-btn-danger" id="${idp}btn-logout-all">${escapeHtml(t('account.logoutAll', 'Log Out All Devices'))}</button>
        </div>

        <!-- Danger Zone -->
        <h4 class="mh-settings-subheading mh-subheading-danger">${escapeHtml(t('account.dangerZone', 'Danger Zone'))}</h4>
        <div class="mh-settings-danger-card">
          ${passwordLifecycle ? '' : `<div class="mh-settings-row"><div class="mh-settings-row-body"><span class="mh-row-detail" id="${idp}acc-lifecycle-note">${providerLifecycle ? escapeHtml(t('account.oauthLifecycleNote', 'To disable or delete this account, you sign in with your provider again and type your account email.')) : escapeHtml(t('account.managedLifecycleNote', 'This account is managed by your organization. Ask your administrator to disable or remove it.'))}</span></div></div>`}
          ${lifecycleControls ? `<div class="mh-settings-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(t('account.disableAccount', 'Disable Account'))}</span>
              <span class="mh-row-detail">${escapeHtml(t('account.disableAccountDesc', 'Temporarily disable your account.'))}</span>
            </div>
            <button class="mh-settings-action-btn mh-btn-danger" id="${idp}btn-disable-account">${escapeHtml(t('account.disableAccount', 'Disable'))}</button>
          </div>
          <div class="mh-settings-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(t('account.deleteAccount', 'Delete Account'))}</span>
              <span class="mh-row-detail">${escapeHtml(t('account.deleteAccountDesc', 'Request account & data deletion (14-day grace period).'))}</span>
            </div>
            ${user.accountState === 'DELETION_PENDING'
              ? (passwordLifecycle ? `<button class="mh-settings-action-btn" id="${idp}btn-cancel-delete">${escapeHtml(t('account.cancelDeletion', 'Cancel Deletion'))}</button>` : `<span class="mh-row-detail">${escapeHtml(t('account.lifecycle.deletedDone', 'Deletion is scheduled. Sign in within 14 days if you change your mind.'))}</span>`)
              : `<button class="mh-settings-action-btn mh-btn-danger" id="${idp}btn-delete-account">${escapeHtml(t('account.deleteAccount', 'Delete'))}</button>`
            }
          </div>` : ''}
        </div>
      </div>`;
    // a save re-renders the panel (and the session refresh can re-render it again): keep the confirmation visible for a few seconds
    if (accountNotice && Date.now() - accountNotice.at < 6000) {
      const noticeEl = document.getElementById(idp + 'acc-profile-msg');
      if (noticeEl) noticeEl.innerHTML = `<p class="form-success" role="status">${escapeHtml(accountNotice.text)}</p>`;
    }

    // Bind profile save
    document.getElementById(idp + 'btn-save-profile')?.addEventListener('click', async () => {
      const displayName = document.getElementById(idp + 'acc-profile-name').value;
      const locale = document.getElementById(idp + 'acc-profile-locale').value;
      const res = await window.NAGEX.apiFetch('/api/v1/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, locale }),
      });
      if (res && !res.error) accountNotice = { text: t('account.profileSaved', 'Profile saved.'), at: Date.now() };
      if (!res || res.error) {
        const msg = document.getElementById(idp + 'acc-profile-msg');
        if (msg) msg.innerHTML = `<p class="form-error">${escapeHtml((res && res.error && res.error.message) || t('settings.saveFailed', 'Could not save settings.'))}</p>`;
        return;
      }
      await checkSession();
      // the account language is the canonical UI language: apply it right away
      if (window.NAGEX_I18N && canonicalLocale(locale) && canonicalLocale(locale) !== window.NAGEX_I18N.getLocale()) window.NAGEX_I18N.setLocale(canonicalLocale(locale));
    });

    // Bind logout all
    document.getElementById(idp + 'btn-logout-all')?.addEventListener('click', async () => {
      if (!window.confirm(t('account.logoutAllConfirm', 'Sign out of all devices, including this one?'))) return;
      await window.NAGEX.apiFetch('/api/v1/auth/logout-all', { method: 'POST' });
      await checkSession();
      renderAccountSettings();
    });

    // Bind disable account with password confirmation dialog
    document.getElementById(idp + 'btn-disable-account')?.addEventListener('click', async () => {
      if (providerLifecycle) { showAccountLifecycleModal('disable'); return; }
      const password = prompt(t('account.disablePrompt', 'Enter your password to confirm disabling your account:'));
      if (!password) return;
      const res = await window.NAGEX.apiFetch('/api/v1/account/disable', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res && res.message) {
        alert(res.message);
        await checkSession();
        renderAccountSettings();
      } else {
        alert(res?.error?.message || t('account.disableFailed', 'Failed to disable account.'));
      }
    });

    // Bind delete account with password confirmation dialog
    document.getElementById(idp + 'btn-delete-account')?.addEventListener('click', async () => {
      if (providerLifecycle) { showAccountLifecycleModal('delete'); return; }
      const password = prompt(t('account.deletePrompt', 'CONFIRMATION REQUIRED: Enter your password to request account deletion (14-day grace period):'));
      if (!password) return;
      const res = await window.NAGEX.apiFetch('/api/v1/account/delete', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res && res.message) {
        alert(res.message);
        await checkSession();
        renderAccountSettings();
      } else {
        alert(res?.error?.message || t('account.deleteFailed', 'Failed to request deletion.'));
      }
    });

    // R24.6D — "Cancel Deletion" was rendered for a DELETION_PENDING account but had NO handler (a dead
    // control). The supported API is POST /api/v1/account/delete/cancel (email + password); no new account
    // capability is invented here, the existing one is wired.
    document.getElementById(idp + 'btn-cancel-delete')?.addEventListener('click', async () => {
      const password = prompt(t('account.cancelDeletePrompt', 'Enter your password to cancel the pending account deletion:'));
      if (!password) return;
      const res = await window.NAGEX.apiFetch('/api/v1/account/delete/cancel', {
        method: 'POST',
        body: JSON.stringify({ email: user.email, password }),
      });
      if (res && res.message && !res.error) {
        alert(res.message);
        await checkSession();
      } else {
        alert(res?.error?.message || t('account.cancelDeleteFailed', 'Failed to cancel deletion.'));
      }
    });

    // Render sessions from the one shared fetch
    try {
      const sessRes = await sessionsPromise;
      const sessionsListEl = document.getElementById(idp + 'acc-sessions-list');
      if (sessionsListEl && sessRes && sessRes.sessions) {
        sessionsListEl.innerHTML = sessRes.sessions.map((sess) => `
          <div class="mh-settings-row mh-session-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(sess.userAgent || t('account.unknownDevice', 'Unknown Device'))} ${sess.isCurrent ? `<span class="mh-settings-tag mh-settings-tag-ok">${escapeHtml(t('account.currentSession', 'Current'))}</span>` : ''}</span>
              <span class="mh-row-detail">${escapeHtml(t('account.ipLabel', 'IP'))}: ${escapeHtml(sess.ipAddress || '127.0.0.1')} · ${escapeHtml(t('account.createdLabel', 'Created'))}: ${escapeHtml(new Date(sess.createdAt).toLocaleDateString())}</span>
            </div>
            ${!sess.isCurrent ? `<button class="mh-settings-action-btn btn-revoke-session" data-session-id="${escapeHtml(sess.sessionId)}">${escapeHtml(t('account.revokeSession', 'Revoke'))}</button>` : ''}
          </div>`).join('');

        sessionsListEl.querySelectorAll('.btn-revoke-session').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const sid = btn.getAttribute('data-session-id');
            await window.NAGEX.apiFetch(`/api/v1/account/sessions/${sid}`, { method: 'DELETE' });
            renderAccountSettings();
          });
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Initialize header pill click handlers
  document.addEventListener('DOMContentLoaded', () => {
    checkSession().then(() => {
      // returning from "Sign in again" for a disable / delete: reopen that confirmation for the same signed-in account
      const intent = takeLifecycleIntent();
      const user = currentUserState.user;
      if (intent && currentUserState.authenticated && user && String(user.email || '').toLowerCase() === String(intent.email || '').toLowerCase()) showAccountLifecycleModal(intent.kind);
    });

    const authParams = new URLSearchParams(window.location.search);
    if (authParams.get('auth') === 'provider') {
      const status = authParams.get('status');
      const migration = authParams.get('migration');
      const recoveryToken = authParams.get('recovery');
      if ((status === 'account-disabled' || status === 'deletion-pending') && recoveryToken) {
        showAccountRecoveryModal(recoveryToken);
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        return;
      }
      if (status === 'migration-required' && migration) {
        showLegacyMigrationModal(migration);
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        return;
      }
      showAuthModal('signin').then(() => {
        const msgArea = document.getElementById('auth-msg-area');
        if (!msgArea) return;
        const message = status === 'account-deleted'
          ? t('auth.accountDeleted', 'This account was deleted and cannot be signed in to.')
          : status === 'link-required'
          ? t('auth.linkRequired', 'That email is already in use and cannot be linked automatically.')
          : status === 'unavailable'
            ? t('auth.providerUnavailable', 'That sign-in option is not available on this runtime.')
            : t('auth.providerFailed', "We couldn't sign you in. Please try again.");
        msgArea.innerHTML = `<p class="form-error" role="alert">${escapeHtml(message)}</p>`;
      });
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }

    const triggers = document.querySelectorAll('.user-pill-header, #mh-avatar');
    triggers.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        if (!currentUserState.authenticated) {
          showAuthModal('signin');
        } else {
          if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-settings');
          // R24.6D — Desktop Settings now has an Account category; the user control lands there.
          if (window.NAGEX.switchSettingsCategory && document.getElementById('cat-tab-account')) window.NAGEX.switchSettingsCategory('account');
        }
      });
    });
  });

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.checkSession = checkSession;
  window.NAGEX.showAuthModal = showAuthModal;
  window.NAGEX.renderAccountSettings = renderAccountSettings;
  window.NAGEX.getCurrentUser = () => currentUserState;
})();
