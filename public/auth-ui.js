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
  }

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
      if (greetingSubEl) greetingSubEl.textContent = `${currentUserState.user.accountState === 'DELETION_PENDING' ? '[Deletion Pending]' : 'Signed in as'}`;
    } else {
      if (avatarEl) avatarEl.textContent = '?';
      if (mhAvatarEl) mhAvatarEl.textContent = '?';
      if (userNameEl) userNameEl.innerHTML = `${escapeHtml(t('auth.signIn', 'Sign In'))} <svg class="chevron-sm" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;
      if (greetingSubEl) greetingSubEl.textContent = 'Welcome,';
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

  function showAuthModal(view = 'signin', params = {}) {
    const modal = ensureAuthModal();
    const body = document.getElementById('auth-modal-body');
    const title = document.getElementById('auth-modal-title');
    if (!body || !title) return;

    modal.hidden = false;

    if (view === 'signin') {
      title.textContent = t('auth.welcome', 'Welcome to NAgex');
      body.innerHTML = `
        <div class="auth-provider-first">
          <p class="auth-subtitle">${escapeHtml(t('auth.subtitle', 'Your personal AI for getting things done.'))}</p>
          <button type="button" class="auth-provider-btn auth-provider-google" id="btn-auth-google"><span aria-hidden="true" class="provider-mark provider-google">G</span>${escapeHtml(t('auth.continueGoogle', 'Continue with Google'))}</button>
          <button type="button" class="auth-provider-btn auth-provider-microsoft" id="btn-auth-microsoft"><span aria-hidden="true" class="provider-mark provider-microsoft">⊞</span>${escapeHtml(t('auth.continueMicrosoft', 'Continue with Microsoft'))}</button>
          <div class="auth-divider"><span>${escapeHtml(t('auth.or', 'or'))}</span></div>
        </div>
        <form id="auth-form-signin" class="auth-form auth-email-first">
          <div class="form-group">
            <label for="signin-email">${escapeHtml(t('auth.email', 'Email address'))}</label>
            <input type="email" id="signin-email" class="form-control" required autocomplete="email" value="${escapeHtml(params.email || '')}">
          </div>
          <div class="form-group" id="signin-password-group" hidden>
            <label for="signin-password">${escapeHtml(t('auth.password', 'Password'))}</label>
            <input type="password" id="signin-password" class="form-control" autocomplete="current-password">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-signin">${escapeHtml(t('auth.continueEmail', 'Continue with email'))}</button>
          </div>
          <div class="auth-msg-area" id="auth-msg-area"></div>
          <div class="auth-links">
            <a href="#" id="link-forgot-password" hidden>${escapeHtml(t('auth.forgotPassword', 'Forgot password?'))}</a>
            <span>${escapeHtml(t('auth.newToNagex', 'New to NAgex?'))} <a href="#" id="link-goto-signup">${escapeHtml(t('auth.createAccount', 'Create an account'))}</a></span>
          </div>
        </form>
        <div class="auth-legal"><a href="privacy.html">${escapeHtml(t('auth.privacy', 'Privacy'))}</a><span>·</span><a href="terms.html">${escapeHtml(t('auth.terms', 'Terms'))}</a></div>`;

      const beginProvider = (provider) => {
        const button = document.getElementById(`btn-auth-${provider}`);
        if (button) { button.disabled = true; button.textContent = t('auth.redirecting', 'Opening secure sign-in...'); }
        window.location.assign(`/api/v1/auth/oauth/${provider}/start`);
      };
      document.getElementById('btn-auth-google')?.addEventListener('click', () => beginProvider('google'));
      document.getElementById('btn-auth-microsoft')?.addEventListener('click', () => beginProvider('microsoft'));

      document.getElementById('link-forgot-password')?.addEventListener('click', (e) => { e.preventDefault(); showAuthModal('forgot'); });
      document.getElementById('link-goto-signup')?.addEventListener('click', (e) => { e.preventDefault(); showAuthModal('signup'); });

      document.getElementById('auth-form-signin')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('signin-email').value;
        const passwordGroup = document.getElementById('signin-password-group');
        const passwordInput = document.getElementById('signin-password');
        if (passwordGroup.hidden && !passwordInput.value) {
          passwordGroup.hidden = false;
          passwordInput.required = true;
          document.getElementById('link-forgot-password').hidden = false;
          document.getElementById('btn-submit-signin').textContent = t('auth.signIn', 'Sign in');
          passwordInput.focus();
          return;
        }
        const password = passwordInput.value;
        const msgArea = document.getElementById('auth-msg-area');

        try {
          const res = await window.NAGEX.apiFetch('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          if (res && res.status === 'SUCCESS') {
            await checkSession();
            hideAuthModal();
            if (window.NAGEX.renderMobileSettings) window.NAGEX.renderMobileSettings();
          } else {
            msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Invalid email or password.')}</p>`;
          }
        } catch (err) {
          msgArea.innerHTML = `<p class="form-error">Invalid email or password.</p>`;
        }
      });
    } else if (view === 'signup') {
      title.textContent = t('auth.signUp', 'Create Account');
      body.innerHTML = `
        <form id="auth-form-signup" class="auth-form">
          <div class="form-group">
            <label for="signup-email">${escapeHtml(t('auth.email', 'Email address'))}</label>
            <input type="email" id="signup-email" class="form-control" required autocomplete="email">
          </div>
          <div class="form-group">
            <label for="signup-password">${escapeHtml(t('auth.password', 'Password (min 8 chars)'))}</label>
            <input type="password" id="signup-password" class="form-control" required autocomplete="new-password">
          </div>
          <div class="form-group">
            <label for="signup-confirm">${escapeHtml(t('auth.passwordConfirmation', 'Confirm password'))}</label>
            <input type="password" id="signup-confirm" class="form-control" required autocomplete="new-password">
          </div>
          <div class="form-group form-check">
            <label><input type="checkbox" id="signup-terms" required> ${escapeHtml(t('auth.termsAccept', 'I accept the Terms of Service'))}</label>
          </div>
          <div class="form-group form-check">
            <label><input type="checkbox" id="signup-privacy" required> ${escapeHtml(t('auth.privacyAccept', 'I accept the Privacy Policy'))}</label>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-signup">${escapeHtml(t('auth.signUp', 'Create Account'))}</button>
          </div>
          <div class="auth-msg-area" id="auth-msg-area"></div>
          <div class="auth-links">
            <a href="#" id="link-goto-signin">${escapeHtml(t('auth.alreadyHaveAccount', 'Already have an account? Sign in'))}</a>
          </div>
        </form>`;

      document.getElementById('link-goto-signin')?.addEventListener('click', (e) => { e.preventDefault(); showAuthModal('signin'); });

      document.getElementById('auth-form-signup')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;
        const passwordConfirmation = document.getElementById('signup-confirm').value;
        const termsAccepted = document.getElementById('signup-terms').checked;
        const privacyAccepted = document.getElementById('signup-privacy').checked;
        const msgArea = document.getElementById('auth-msg-area');

        try {
          const res = await window.NAGEX.apiFetch('/api/v1/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password, passwordConfirmation, termsAccepted, privacyAccepted }),
          });
          if (res && res.status === 'PENDING_VERIFICATION') {
            showAuthModal('verify', { email, token: res.devVerificationToken });
          } else {
            msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Account creation failed.')}</p>`;
          }
        } catch (err) {
          msgArea.innerHTML = `<p class="form-error">Account creation failed.</p>`;
        }
      });
    } else if (view === 'verify') {
      title.textContent = t('auth.verifyEmail', 'Verify Email');
      body.innerHTML = `
        <form id="auth-form-verify" class="auth-form">
          <p class="auth-info-text">Please enter the verification token sent to <strong>${escapeHtml(params.email || '')}</strong>.</p>
          <div class="form-group">
            <label for="verify-token">Verification Token</label>
            <input type="text" id="verify-token" class="form-control" required value="${escapeHtml(params.token || '')}">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-verify">${escapeHtml(t('auth.verifyEmail', 'Verify Email'))}</button>
          </div>
          <div class="auth-msg-area" id="auth-msg-area"></div>
        </form>`;

      document.getElementById('auth-form-verify')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = document.getElementById('verify-token').value;
        const msgArea = document.getElementById('auth-msg-area');

        try {
          const res = await window.NAGEX.apiFetch('/api/v1/auth/verify-email', {
            method: 'POST',
            body: JSON.stringify({ token }),
          });
          if (res && res.status === 'ACTIVE') {
            msgArea.innerHTML = `<p class="form-success">Email verified! Redirecting to sign in...</p>`;
            setTimeout(() => showAuthModal('signin', { email: params.email }), 1000);
          } else {
            msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Verification failed.')}</p>`;
          }
        } catch (err) {
          msgArea.innerHTML = `<p class="form-error">Verification failed.</p>`;
        }
      });
    } else if (view === 'forgot') {
      title.textContent = t('auth.forgotPassword', 'Forgot Password');
      body.innerHTML = `
        <form id="auth-form-forgot" class="auth-form">
          <div class="form-group">
            <label for="forgot-email">${escapeHtml(t('auth.email', 'Email address'))}</label>
            <input type="email" id="forgot-email" class="form-control" required autocomplete="email">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Send Reset Instructions</button>
          </div>
          <div class="auth-msg-area" id="auth-msg-area"></div>
          <div class="auth-links">
            <a href="#" id="link-goto-signin-2">${escapeHtml(t('auth.alreadyHaveAccount', 'Sign in'))}</a>
          </div>
        </form>`;

      document.getElementById('link-goto-signin-2')?.addEventListener('click', (e) => { e.preventDefault(); showAuthModal('signin'); });

      document.getElementById('auth-form-forgot')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('forgot-email').value;
        const msgArea = document.getElementById('auth-msg-area');

        try {
          const res = await window.NAGEX.apiFetch('/api/v1/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email }),
          });
          if (res && res.devResetToken) {
            showAuthModal('reset', { token: res.devResetToken });
          } else {
            msgArea.innerHTML = `<p class="form-success">${escapeHtml(res?.message || 'Password reset instructions sent.')}</p>`;
          }
        } catch (err) {
          msgArea.innerHTML = `<p class="form-error">Failed to send reset instructions.</p>`;
        }
      });
    } else if (view === 'reset') {
      title.textContent = t('auth.resetPassword', 'Reset Password');
      body.innerHTML = `
        <form id="auth-form-reset" class="auth-form">
          <div class="form-group">
            <label for="reset-token">Reset Token</label>
            <input type="text" id="reset-token" class="form-control" required value="${escapeHtml(params.token || '')}">
          </div>
          <div class="form-group">
            <label for="reset-new-password">New Password</label>
            <input type="password" id="reset-new-password" class="form-control" required autocomplete="new-password">
          </div>
          <div class="form-group">
            <label for="reset-confirm-password">Confirm New Password</label>
            <input type="password" id="reset-confirm-password" class="form-control" required autocomplete="new-password">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Reset Password</button>
          </div>
          <div class="auth-msg-area" id="auth-msg-area"></div>
        </form>`;

      document.getElementById('auth-form-reset')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = document.getElementById('reset-token').value;
        const newPassword = document.getElementById('reset-new-password').value;
        const newPasswordConfirmation = document.getElementById('reset-confirm-password').value;
        const msgArea = document.getElementById('auth-msg-area');

        try {
          const res = await window.NAGEX.apiFetch('/api/v1/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ token, newPassword, newPasswordConfirmation }),
          });
          if (res && res.message) {
            msgArea.innerHTML = `<p class="form-success">${escapeHtml(res.message)} Redirecting to sign in...</p>`;
            setTimeout(() => showAuthModal('signin'), 1200);
          } else {
            msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Password reset failed.')}</p>`;
          }
        } catch (err) {
          msgArea.innerHTML = `<p class="form-error">Password reset failed.</p>`;
        }
      });
    }
  }

  function hideAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.hidden = true;
  }

  // ── Render Settings Account Sub-Tab ──
  async function renderAccountSettings() {
    const el = document.getElementById('mh-account-panel');
    if (!el) return;

    if (!currentUserState.authenticated) {
      el.innerHTML = `
        <div class="mh-settings-row">
          <div class="mh-settings-row-body">
            <span class="mh-settings-row-title">Sign in to manage your account</span>
            <span class="mh-row-detail">Access your profile, credentials, active sessions, and data lifecycle settings.</span>
          </div>
          <button class="mh-settings-action-btn" id="btn-account-signin-trigger">${escapeHtml(t('auth.signIn', 'Sign In'))}</button>
        </div>`;
      document.getElementById('btn-account-signin-trigger')?.addEventListener('click', () => showAuthModal('signin'));
      return;
    }

    const { user, profile } = currentUserState;
    let sessionsHtml = '<div class="nagex-loading-row">Loading active sessions...</div>';

    el.innerHTML = `
      <div class="mh-settings-account-section">
        <!-- Profile Form -->
        <h4 class="mh-settings-subheading">${escapeHtml(t('account.profile', 'Profile'))}</h4>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.displayName', 'Display Name'))}</label>
            <input type="text" id="acc-profile-name" class="mh-input" value="${escapeHtml(profile?.displayName || '')}">
          </div>
        </div>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.locale', 'Language / Locale'))}</label>
            <select id="acc-profile-locale" class="mh-select">
              <option value="EN" ${profile?.locale === 'EN' ? 'selected' : ''}>English (EN)</option>
              <option value="KR" ${profile?.locale === 'KR' ? 'selected' : ''}>한국어 (KR)</option>
            </select>
          </div>
        </div>
        <div class="mh-settings-row">
          <button class="mh-settings-action-btn" id="btn-save-profile">${escapeHtml(t('account.saveProfile', 'Save Profile'))}</button>
        </div>

        <!-- Password Change -->
        <h4 class="mh-settings-subheading">${escapeHtml(t('account.changePassword', 'Change Password'))}</h4>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.currentPassword', 'Current Password'))}</label>
            <input type="password" id="acc-pwd-current" class="mh-input">
          </div>
        </div>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.newPassword', 'New Password'))}</label>
            <input type="password" id="acc-pwd-new" class="mh-input">
          </div>
        </div>
        <div class="mh-settings-row">
          <div class="mh-settings-form-row">
            <label>${escapeHtml(t('account.newPasswordConfirmation', 'Confirm New Password'))}</label>
            <input type="password" id="acc-pwd-confirm" class="mh-input">
          </div>
        </div>
        <div class="mh-settings-row">
          <button class="mh-settings-action-btn" id="btn-change-password">${escapeHtml(t('account.updatePassword', 'Update Password'))}</button>
        </div>
        <div id="acc-pwd-msg"></div>

        <!-- Sessions Manager -->
        <h4 class="mh-settings-subheading">${escapeHtml(t('account.sessions', 'Active Sessions'))}</h4>
        <div id="acc-sessions-list">${sessionsHtml}</div>
        <div class="mh-settings-row">
          <button class="mh-settings-action-btn mh-btn-danger" id="btn-logout-all">${escapeHtml(t('account.logoutAll', 'Log Out All Devices'))}</button>
        </div>

        <!-- Danger Zone -->
        <h4 class="mh-settings-subheading mh-subheading-danger">${escapeHtml(t('account.dangerZone', 'Danger Zone'))}</h4>
        <div class="mh-settings-danger-card">
          <div class="mh-settings-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(t('account.disableAccount', 'Disable Account'))}</span>
              <span class="mh-row-detail">${escapeHtml(t('account.disableAccountDesc', 'Temporarily disable your account.'))}</span>
            </div>
            <button class="mh-settings-action-btn mh-btn-danger" id="btn-disable-account">${escapeHtml(t('account.disableAccount', 'Disable'))}</button>
          </div>
          <div class="mh-settings-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(t('account.deleteAccount', 'Delete Account'))}</span>
              <span class="mh-row-detail">${escapeHtml(t('account.deleteAccountDesc', 'Request account & data deletion (14-day grace period).'))}</span>
            </div>
            ${user.accountState === 'DELETION_PENDING'
              ? `<button class="mh-settings-action-btn" id="btn-cancel-delete">${escapeHtml(t('account.cancelDeletion', 'Cancel Deletion'))}</button>`
              : `<button class="mh-settings-action-btn mh-btn-danger" id="btn-delete-account">${escapeHtml(t('account.deleteAccount', 'Delete'))}</button>`
            }
          </div>
        </div>
      </div>`;

    // Bind profile save
    document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
      const displayName = document.getElementById('acc-profile-name').value;
      const locale = document.getElementById('acc-profile-locale').value;
      await window.NAGEX.apiFetch('/api/v1/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, locale }),
      });
      await checkSession();
      renderAccountSettings();
    });

    // Bind password change
    document.getElementById('btn-change-password')?.addEventListener('click', async () => {
      const currentPassword = document.getElementById('acc-pwd-current').value;
      const newPassword = document.getElementById('acc-pwd-new').value;
      const newPasswordConfirmation = document.getElementById('acc-pwd-confirm').value;
      const msgArea = document.getElementById('acc-pwd-msg');

      const res = await window.NAGEX.apiFetch('/api/v1/account/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword, newPasswordConfirmation }),
      });

      if (res && res.message) {
        msgArea.innerHTML = `<p class="form-success">${escapeHtml(res.message)}</p>`;
      } else {
        msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Password update failed.')}</p>`;
      }
    });

    // Bind logout all
    document.getElementById('btn-logout-all')?.addEventListener('click', async () => {
      await window.NAGEX.apiFetch('/api/v1/auth/logout-all', { method: 'POST' });
      await checkSession();
      renderAccountSettings();
    });

    // Bind disable account with password confirmation dialog
    document.getElementById('btn-disable-account')?.addEventListener('click', async () => {
      const password = prompt('Enter your password to confirm disabling your account:');
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
        alert(res?.error?.message || 'Failed to disable account.');
      }
    });

    // Bind delete account with password confirmation dialog
    document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
      const password = prompt('CONFIRMATION REQUIRED: Enter your password to request account deletion (14-day grace period):');
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
        alert(res?.error?.message || 'Failed to request deletion.');
      }
    });

    // Fetch and render sessions
    try {
      const sessRes = await window.NAGEX.apiFetch('/api/v1/account/sessions');
      const sessionsListEl = document.getElementById('acc-sessions-list');
      if (sessionsListEl && sessRes && sessRes.sessions) {
        sessionsListEl.innerHTML = sessRes.sessions.map((s) => `
          <div class="mh-settings-row mh-session-row">
            <div class="mh-settings-row-body">
              <span class="mh-settings-row-title">${escapeHtml(s.userAgent || 'Unknown Device')} ${s.isCurrent ? `<span class="mh-settings-tag mh-settings-tag-ok">Current</span>` : ''}</span>
              <span class="mh-row-detail">IP: ${escapeHtml(s.ipAddress || '127.0.0.1')} · Created: ${escapeHtml(new Date(s.createdAt).toLocaleDateString())}</span>
            </div>
            ${!s.isCurrent ? `<button class="mh-settings-action-btn btn-revoke-session" data-session-id="${escapeHtml(s.sessionId)}">${escapeHtml(t('account.revokeSession', 'Revoke'))}</button>` : ''}
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
    checkSession();

    const authParams = new URLSearchParams(window.location.search);
    if (authParams.get('auth') === 'provider') {
      const status = authParams.get('status');
      showAuthModal('signin');
      const msgArea = document.getElementById('auth-msg-area');
      if (msgArea) {
        const message = status === 'link-required'
          ? t('auth.linkRequired', 'That email is already in use. Sign in first to connect this account.')
          : status === 'unavailable'
            ? t('auth.providerUnavailable', 'That sign-in option is not available right now. Try email instead.')
            : t('auth.providerFailed', "We couldn't sign you in. Please try again.");
        msgArea.innerHTML = `<p class="form-error" role="alert">${escapeHtml(message)}</p>`;
      }
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }

    const triggers = document.querySelectorAll('.user-pill-header, #mh-avatar');
    triggers.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        if (!currentUserState.authenticated) {
          showAuthModal('signin');
        } else {
          if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-settings');
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
