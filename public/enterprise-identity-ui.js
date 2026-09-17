// NAgex Enterprise Identity Federation & Provisioning Web UI (R16)
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  function getFocusableElements(container) {
    if (!container) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(container.querySelectorAll(selector)).filter((el) => el.offsetParent !== null);
  }

  // Same shared modal accessibility pattern as rbac-ui.js's
  // wireModalAccessibility — Escape/focus-trap/backdrop-click, reusing
  // window.NAGEX_MODAL_BEHAVIOR.
  function wireModalAccessibility(modal, onClose) {
    const focusable = getFocusableElements(modal);
    if (focusable.length > 0) focusable[0].focus();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keydownHandler, true);
      modal.remove();
      if (onClose) onClose();
    }
    function keydownHandler(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab' && window.NAGEX_MODAL_BEHAVIOR) {
        const target = window.NAGEX_MODAL_BEHAVIOR.computeFocusTrapTarget(getFocusableElements(modal), document.activeElement, event.shiftKey);
        if (target) { event.preventDefault(); target.focus(); }
      }
    }
    document.addEventListener('keydown', keydownHandler, true);
    modal.addEventListener('click', (event) => {
      const isBackdropClick = window.NAGEX_MODAL_BEHAVIOR ? window.NAGEX_MODAL_BEHAVIOR.isBackdropSelfClick(event.target, modal) : event.target === modal;
      if (isBackdropClick) close();
    });
    return close;
  }

  const eiState = { activeSubTab: 'sso' };

  // ── Entry point (called by org-ui.js's data-org-tab="enterprise-identity" branch) ──
  async function renderTab(container, orgId) {
    container.innerHTML = `
      <div class="settings-subnav" id="ei-subnav">
        <button class="subnav-btn ${eiState.activeSubTab === 'sso' ? 'active' : ''}" data-ei-tab="sso">${escapeHtml(t('ei.ssoTab', 'SSO'))}</button>
        <button class="subnav-btn ${eiState.activeSubTab === 'domains' ? 'active' : ''}" data-ei-tab="domains">${escapeHtml(t('ei.domainsTab', 'Domains'))}</button>
        <button class="subnav-btn ${eiState.activeSubTab === 'provisioning' ? 'active' : ''}" data-ei-tab="provisioning">${escapeHtml(t('ei.provisioningTab', 'Provisioning'))}</button>
        <button class="subnav-btn ${eiState.activeSubTab === 'security' ? 'active' : ''}" data-ei-tab="security">${escapeHtml(t('ei.securityTab', 'Security'))}</button>
      </div>
      <div id="ei-tab-content" class="org-tab-content"></div>`;

    container.querySelectorAll('[data-ei-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        eiState.activeSubTab = btn.getAttribute('data-ei-tab');
        loadEiSubTab(orgId);
        container.querySelectorAll('[data-ei-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    await loadEiSubTab(orgId);
  }

  async function loadEiSubTab(orgId) {
    const content = document.getElementById('ei-tab-content');
    if (!content) return;
    if (eiState.activeSubTab === 'sso') return renderSsoTab(content, orgId);
    if (eiState.activeSubTab === 'domains') return renderDomainsTab(content, orgId);
    if (eiState.activeSubTab === 'provisioning') return renderProvisioningTab(content, orgId);
    if (eiState.activeSubTab === 'security') return renderSecurityTab(content, orgId);
  }

  // ── SSO Providers tab (§46) ──
  async function renderSsoTab(content, orgId) {
    content.innerHTML = `<div class="nagex-loading-row"></div>`;
    const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/identity-providers`);
    const providers = (res && res.providers) || [];
    content.innerHTML = `
      <div class="tab-action-bar">
        <h4>${escapeHtml(t('ei.identityProviders', 'Identity Providers'))}</h4>
        <button class="btn btn-primary" id="btn-add-oidc-provider">+ ${escapeHtml(t('ei.addOidcProvider', 'Add OIDC Provider'))}</button>
        <button class="btn btn-secondary" id="btn-add-saml-provider">+ ${escapeHtml(t('ei.addSamlProvider', 'Add SAML Provider'))}</button>
      </div>
      <div class="idp-cards-container" id="idp-cards">
        ${providers.length === 0 ? `<p class="text-sub">${escapeHtml(t('ei.noProviders', 'No identity providers configured yet.'))}</p>` : providers.map((p) => renderProviderCard(p)).join('')}
      </div>`;

    document.getElementById('btn-add-oidc-provider')?.addEventListener('click', () => showProviderEditorModal(orgId, 'OIDC'));
    document.getElementById('btn-add-saml-provider')?.addEventListener('click', () => showProviderEditorModal(orgId, 'SAML'));

    content.querySelectorAll('[data-idp-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const providerId = btn.getAttribute('data-idp-id');
        const action = btn.getAttribute('data-idp-action');
        if (action === 'enable' || action === 'disable') {
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/identity-providers/${providerId}/${action}`, { method: 'POST' });
          renderSsoTab(content, orgId);
        } else if (action === 'delete') {
          if (!confirm(t('ei.confirmDeleteProvider', 'Delete this identity provider? Users linked through it will need to re-link.'))) return;
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/identity-providers/${providerId}`, { method: 'DELETE' });
          renderSsoTab(content, orgId);
        } else if (action === 'test') {
          const startUrl = `/api/v1/auth/${btn.getAttribute('data-idp-type').toLowerCase()}/${providerId}/start?organizationId=${orgId}`;
          window.open(startUrl, '_blank');
        }
      });
    });
  }

  function renderProviderCard(p) {
    const statusClass = p.status === 'ACTIVE' ? 'badge-success' : p.status === 'ERROR' ? 'badge-danger' : 'badge-warn';
    return `
      <div class="idp-card" data-provider-id="${escapeHtml(p.providerId)}">
        <div class="idp-card-header">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="badge badge-sm">${escapeHtml(p.providerType)}</span>
          <span class="badge badge-sm ${statusClass}">${escapeHtml(p.status)}</span>
        </div>
        <div class="idp-card-actions">
          ${p.status === 'ACTIVE'
            ? `<button class="btn-small" data-idp-action="disable" data-idp-id="${escapeHtml(p.providerId)}">${escapeHtml(t('ei.disable', 'Disable'))}</button>`
            : `<button class="btn-small btn-primary" data-idp-action="enable" data-idp-id="${escapeHtml(p.providerId)}">${escapeHtml(t('ei.enable', 'Enable'))}</button>`}
          <button class="btn-small" data-idp-action="test" data-idp-id="${escapeHtml(p.providerId)}" data-idp-type="${escapeHtml(p.providerType)}">${escapeHtml(t('ei.testConnection', 'Test Connection'))}</button>
          <button class="btn-small danger" data-idp-action="delete" data-idp-id="${escapeHtml(p.providerId)}">${escapeHtml(t('ei.delete', 'Delete'))}</button>
        </div>
      </div>`;
  }

  function showProviderEditorModal(orgId, providerType) {
    const modal = document.createElement('div');
    modal.id = 'provider-editor-modal';
    modal.className = 'modal-backdrop';
    const isOidc = providerType === 'OIDC';
    modal.innerHTML = `
      <div class="modal-card modal-card-lg" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title">
        <div class="modal-header">
          <h3 id="provider-editor-title">${isOidc ? escapeHtml(t('ei.addOidcProvider', 'Add OIDC Provider')) : escapeHtml(t('ei.addSamlProvider', 'Add SAML Provider'))}</h3>
          <button class="modal-close-btn" id="close-provider-editor">&times;</button>
        </div>
        <form id="form-provider-editor" class="modal-body auth-form">
          <fieldset class="perm-group-fieldset">
            <legend>${escapeHtml(t('ei.providerBasics', 'Provider'))}</legend>
            <div class="form-group">
              <label for="idp-input-name">${escapeHtml(t('ei.providerName', 'Name'))}</label>
              <input type="text" id="idp-input-name" class="form-control" required placeholder="${isOidc ? 'Okta' : 'Azure AD'}">
            </div>
          </fieldset>
          ${isOidc ? `
          <fieldset class="perm-group-fieldset">
            <legend>${escapeHtml(t('ei.oidcConfig', 'OIDC Configuration'))}</legend>
            <div class="form-group"><label for="idp-oidc-issuer">${escapeHtml(t('ei.issuer', 'Issuer'))}</label><input type="text" id="idp-oidc-issuer" class="form-control" required placeholder="https://idp.example.com"></div>
            <div class="form-group"><label for="idp-oidc-client-id">${escapeHtml(t('ei.clientId', 'Client ID'))}</label><input type="text" id="idp-oidc-client-id" class="form-control" required></div>
            <div class="form-group"><label for="idp-oidc-client-secret">${escapeHtml(t('ei.clientSecret', 'Client Secret'))}</label><input type="password" id="idp-oidc-client-secret" class="form-control" required autocomplete="new-password"></div>
            <div class="form-group"><label for="idp-oidc-authz">${escapeHtml(t('ei.authorizationEndpoint', 'Authorization Endpoint'))}</label><input type="text" id="idp-oidc-authz" class="form-control" required></div>
            <div class="form-group"><label for="idp-oidc-token">${escapeHtml(t('ei.tokenEndpoint', 'Token Endpoint'))}</label><input type="text" id="idp-oidc-token" class="form-control" required></div>
            <div class="form-group"><label for="idp-oidc-jwks">${escapeHtml(t('ei.jwksUri', 'JWKS URI'))}</label><input type="text" id="idp-oidc-jwks" class="form-control" required></div>
          </fieldset>` : `
          <fieldset class="perm-group-fieldset">
            <legend>${escapeHtml(t('ei.samlConfig', 'SAML Configuration'))}</legend>
            <div class="form-group"><label for="idp-saml-entity">${escapeHtml(t('ei.entityId', 'Entity ID'))}</label><input type="text" id="idp-saml-entity" class="form-control" required></div>
            <div class="form-group"><label for="idp-saml-sso-url">${escapeHtml(t('ei.ssoUrl', 'SSO URL'))}</label><input type="text" id="idp-saml-sso-url" class="form-control" required></div>
            <div class="form-group"><label for="idp-saml-cert">${escapeHtml(t('ei.x509Certificate', 'x509 Certificate (PEM)'))}</label><textarea id="idp-saml-cert" class="form-control" rows="6" required></textarea></div>
          </fieldset>`}
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-save-provider">${escapeHtml(t('ei.save', 'Save'))}</button>
          </div>
          <div class="auth-msg-area" id="provider-editor-msg"></div>
        </form>
      </div>`;
    document.body.appendChild(modal);
    const close = wireModalAccessibility(modal);
    document.getElementById('close-provider-editor')?.addEventListener('click', () => close());

    document.getElementById('form-provider-editor')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msgArea = document.getElementById('provider-editor-msg');
      const name = document.getElementById('idp-input-name').value.trim();
      const payload = { providerType, name };
      if (isOidc) {
        payload.oidcConfig = {
          issuer: document.getElementById('idp-oidc-issuer').value.trim(),
          clientId: document.getElementById('idp-oidc-client-id').value.trim(),
          clientSecret: document.getElementById('idp-oidc-client-secret').value,
          authorizationEndpoint: document.getElementById('idp-oidc-authz').value.trim(),
          tokenEndpoint: document.getElementById('idp-oidc-token').value.trim(),
          jwksUri: document.getElementById('idp-oidc-jwks').value.trim(),
        };
      } else {
        payload.samlConfig = {
          entityId: document.getElementById('idp-saml-entity').value.trim(),
          ssoUrl: document.getElementById('idp-saml-sso-url').value.trim(),
          x509Certificate: document.getElementById('idp-saml-cert').value.trim(),
        };
      }
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/identity-providers`, { method: 'POST', body: JSON.stringify(payload) });
      if (res && res.error) {
        msgArea.innerHTML = `<p class="form-error">${escapeHtml(res.error.message || 'Save failed.')}</p>`;
        return;
      }
      close();
      const content = document.getElementById('ei-tab-content');
      if (content) renderSsoTab(content, orgId);
    });
  }

  // ── Domains tab (§47) ──
  async function renderDomainsTab(content, orgId) {
    content.innerHTML = `<div class="nagex-loading-row"></div>`;
    const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/domains`);
    const domains = (res && res.domains) || [];
    content.innerHTML = `
      <div class="tab-action-bar">
        <h4>${escapeHtml(t('ei.domains', 'Domains'))}</h4>
        <button class="btn btn-primary" id="btn-add-domain">+ ${escapeHtml(t('ei.addDomain', 'Add Domain'))}</button>
      </div>
      <table class="data-table" id="domains-table">
        <thead><tr><th>${escapeHtml(t('ei.domain', 'Domain'))}</th><th>${escapeHtml(t('ei.status', 'Status'))}</th><th>${escapeHtml(t('ei.verificationMethod', 'Verification Method'))}</th><th>${escapeHtml(t('ei.verifiedAt', 'Verified At'))}</th><th></th></tr></thead>
        <tbody>
          ${domains.length === 0 ? `<tr><td colspan="5" class="text-sub">${escapeHtml(t('ei.noDomains', 'No domains added yet.'))}</td></tr>` : domains.map((d) => `
          <tr data-domain-id="${escapeHtml(d.domainId)}">
            <td>${escapeHtml(d.domain)}</td>
            <td><span class="badge badge-sm ${d.status === 'VERIFIED' ? 'badge-success' : d.status === 'REVOKED' ? 'badge-danger' : 'badge-warn'}">${escapeHtml(d.status)}</span></td>
            <td>DNS TXT</td>
            <td>${d.verifiedAt ? escapeHtml(new Date(d.verifiedAt).toLocaleString()) : '—'}</td>
            <td>
              ${d.status === 'PENDING' ? `<button class="btn-small" data-domain-action="recheck" data-domain-id="${escapeHtml(d.domainId)}">${escapeHtml(t('ei.recheck', 'Recheck'))}</button>` : ''}
              ${d.status !== 'REVOKED' ? `<button class="btn-small danger" data-domain-action="revoke" data-domain-id="${escapeHtml(d.domainId)}">${escapeHtml(t('ei.revoke', 'Revoke'))}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    document.getElementById('btn-add-domain')?.addEventListener('click', () => showAddDomainModal(orgId));
    content.querySelectorAll('[data-domain-action="revoke"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('ei.confirmRevokeDomain', 'Revoke this domain? SSO discovery will stop working for it immediately.'))) return;
        await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/domains/${btn.getAttribute('data-domain-id')}/revoke`, { method: 'POST' });
        renderDomainsTab(content, orgId);
      });
    });
  }

  function showAddDomainModal(orgId) {
    const modal = document.createElement('div');
    modal.id = 'domain-add-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="domain-add-title">
        <div class="modal-header"><h3 id="domain-add-title">${escapeHtml(t('ei.addDomain', 'Add Domain'))}</h3><button class="modal-close-btn" id="close-domain-add">&times;</button></div>
        <div class="modal-body">
          <form id="form-add-domain" class="auth-form">
            <div class="form-group"><label for="domain-input">${escapeHtml(t('ei.domain', 'Domain'))}</label><input type="text" id="domain-input" class="form-control" required placeholder="corp.example.com"></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">${escapeHtml(t('ei.addDomain', 'Add Domain'))}</button></div>
          </form>
          <div id="domain-verify-instructions" hidden>
            <p>${escapeHtml(t('ei.dnsInstructions', 'Add this TXT record to your DNS, then click Verify:'))}</p>
            <pre class="dns-record-value" id="dns-record-value"></pre>
            <button class="btn btn-primary" id="btn-verify-domain">${escapeHtml(t('ei.verify', 'Verify'))}</button>
            <div class="auth-msg-area" id="domain-verify-msg"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = wireModalAccessibility(modal);
    document.getElementById('close-domain-add')?.addEventListener('click', () => close());

    let createdDomain = null;
    let rawToken = null;
    document.getElementById('form-add-domain')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const domain = document.getElementById('domain-input').value.trim();
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/domains`, { method: 'POST', body: JSON.stringify({ domain }) });
      if (!res || res.error) return;
      createdDomain = res.domain;
      rawToken = res.rawVerificationToken;
      document.getElementById('dns-record-value').textContent = res.dnsRecordValue;
      document.getElementById('domain-verify-instructions').hidden = false;
      document.getElementById('form-add-domain').hidden = true;
    });

    document.getElementById('btn-verify-domain')?.addEventListener('click', async () => {
      const msgArea = document.getElementById('domain-verify-msg');
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/domains/${createdDomain.domainId}/verify`, { method: 'POST', body: JSON.stringify({ rawVerificationToken: rawToken }) });
      if (res && res.error) {
        msgArea.innerHTML = `<p class="form-error">${escapeHtml(res.error.message)}</p>`;
        return;
      }
      close();
      const content = document.getElementById('ei-tab-content');
      if (content) renderDomainsTab(content, orgId);
    });
  }

  // ── Provisioning tab (§48, SCIM tokens + group mappings) ──
  async function renderProvisioningTab(content, orgId) {
    content.innerHTML = `<div class="nagex-loading-row"></div>`;
    const [tokensRes, mappingsRes] = await Promise.all([
      window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/scim/tokens`),
      window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/group-mappings`),
    ]);
    const tokens = (tokensRes && tokensRes.tokens) || [];
    const mappings = (mappingsRes && mappingsRes.groupMappings) || [];
    content.innerHTML = `
      <div class="tab-action-bar">
        <h4>${escapeHtml(t('ei.scimProvisioning', 'SCIM Provisioning'))}</h4>
        <button class="btn btn-primary" id="btn-generate-scim-token">+ ${escapeHtml(t('ei.generateToken', 'Generate Token'))}</button>
      </div>
      <p class="text-sub">${escapeHtml(t('ei.scimEndpoint', 'SCIM endpoint'))}: <code>/scim/v2</code></p>
      <table class="data-table">
        <thead><tr><th>${escapeHtml(t('ei.name', 'Name'))}</th><th>${escapeHtml(t('ei.status', 'Status'))}</th><th>${escapeHtml(t('ei.created', 'Created'))}</th><th>${escapeHtml(t('ei.lastUsed', 'Last Used'))}</th><th></th></tr></thead>
        <tbody>
          ${tokens.length === 0 ? `<tr><td colspan="5" class="text-sub">${escapeHtml(t('ei.noTokens', 'No SCIM tokens yet.'))}</td></tr>` : tokens.map((tk) => `
          <tr>
            <td>${escapeHtml(tk.name)}</td>
            <td><span class="badge badge-sm ${tk.revokedAt ? 'badge-danger' : 'badge-success'}">${tk.revokedAt ? escapeHtml(t('ei.revoked', 'Revoked')) : escapeHtml(t('ei.active', 'Active'))}</span></td>
            <td>${escapeHtml(new Date(tk.createdAt).toLocaleString())}</td>
            <td>${tk.lastUsedAt ? escapeHtml(new Date(tk.lastUsedAt).toLocaleString()) : '—'}</td>
            <td>${!tk.revokedAt ? `
              <button class="btn-small" data-token-action="rotate" data-token-id="${escapeHtml(tk.scimTokenId)}">${escapeHtml(t('ei.rotate', 'Rotate'))}</button>
              <button class="btn-small danger" data-token-action="revoke" data-token-id="${escapeHtml(tk.scimTokenId)}">${escapeHtml(t('ei.revoke', 'Revoke'))}</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <h4>${escapeHtml(t('ei.groupRoleMapping', 'Group -> Role Mapping'))}</h4>
      <table class="data-table">
        <thead><tr><th>${escapeHtml(t('ei.externalGroup', 'IdP Group'))}</th><th>${escapeHtml(t('ei.mappedRole', 'NAgex Role'))}</th></tr></thead>
        <tbody>
          ${mappings.length === 0 ? `<tr><td colspan="2" class="text-sub">${escapeHtml(t('ei.noMappings', 'No group mappings configured.'))}</td></tr>` : mappings.map((m) => `<tr><td>${escapeHtml(m.externalGroupName)}</td><td>${escapeHtml(m.roleId)}</td></tr>`).join('')}
        </tbody>
      </table>`;

    document.getElementById('btn-generate-scim-token')?.addEventListener('click', async () => {
      const name = prompt(t('ei.tokenName', 'Token name (e.g. Okta SCIM)')) || 'SCIM Token';
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/scim/tokens`, { method: 'POST', body: JSON.stringify({ name }) });
      if (!res || res.error) return;
      showTokenOnceModal(res.rawToken);
      renderProvisioningTab(content, orgId);
    });

    content.querySelectorAll('[data-token-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-token-action');
        const tokenId = btn.getAttribute('data-token-id');
        if (action === 'revoke' && !confirm(t('ei.confirmRevokeToken', 'Revoke this SCIM token? Provisioning from this IdP will stop working immediately.'))) return;
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/scim/tokens/${tokenId}/${action}`, { method: 'POST' });
        if (action === 'rotate' && res && res.rawToken) showTokenOnceModal(res.rawToken);
        renderProvisioningTab(content, orgId);
      });
    });
  }

  function showTokenOnceModal(rawToken) {
    const modal = document.createElement('div');
    modal.id = 'token-once-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="token-once-title">
        <div class="modal-header"><h3 id="token-once-title">${escapeHtml(t('ei.tokenGenerated', 'Token Generated'))}</h3><button class="modal-close-btn" id="close-token-once">&times;</button></div>
        <div class="modal-body">
          <p>${escapeHtml(t('ei.tokenShownOnce', 'Copy this token now — it will not be shown again.'))}</p>
          <div class="token-display-row">
            <input type="text" class="form-control" id="token-once-value" value="${escapeHtml(rawToken)}" readonly aria-label="${escapeHtml(t('ei.scimToken', 'SCIM token'))}">
            <button class="btn btn-secondary" id="btn-copy-token">${escapeHtml(t('ei.copy', 'Copy'))}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = wireModalAccessibility(modal);
    document.getElementById('close-token-once')?.addEventListener('click', () => close());
    document.getElementById('btn-copy-token')?.addEventListener('click', () => {
      const input = document.getElementById('token-once-value');
      input.select();
      if (navigator.clipboard) navigator.clipboard.writeText(rawToken).catch(() => {});
    });
  }

  // ── Security tab (§49, SSO policy) ──
  async function renderSecurityTab(content, orgId) {
    content.innerHTML = `<div class="nagex-loading-row"></div>`;
    const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/sso-policy`);
    const policy = (res && res.ssoPolicy) || { ssoEnforcement: 'SSO_OPTIONAL', localLoginPolicy: 'ALLOW', jitProvisioningEnabled: false, scimEnabled: false };
    content.innerHTML = `
      <form id="form-sso-policy" class="auth-form">
        <fieldset class="perm-group-fieldset">
          <legend>${escapeHtml(t('ei.ssoEnforcement', 'SSO Enforcement'))}</legend>
          <div class="form-group">
            <label><input type="radio" name="ssoEnforcement" value="SSO_OPTIONAL" ${policy.ssoEnforcement === 'SSO_OPTIONAL' ? 'checked' : ''}> ${escapeHtml(t('ei.ssoOptional', 'SSO Optional'))}</label>
            <label><input type="radio" name="ssoEnforcement" value="SSO_REQUIRED" ${policy.ssoEnforcement === 'SSO_REQUIRED' ? 'checked' : ''}> ${escapeHtml(t('ei.ssoRequired', 'SSO Required'))}</label>
          </div>
        </fieldset>
        <fieldset class="perm-group-fieldset">
          <legend>${escapeHtml(t('ei.localLoginPolicy', 'Local Login Policy'))}</legend>
          <select id="local-login-policy-select" class="form-control">
            <option value="ALLOW" ${policy.localLoginPolicy === 'ALLOW' ? 'selected' : ''}>${escapeHtml(t('ei.allow', 'Allow'))}</option>
            <option value="RESTRICT" ${policy.localLoginPolicy === 'RESTRICT' ? 'selected' : ''}>${escapeHtml(t('ei.restrict', 'Restrict'))}</option>
            <option value="BREAK_GLASS_ONLY" ${policy.localLoginPolicy === 'BREAK_GLASS_ONLY' ? 'selected' : ''}>${escapeHtml(t('ei.breakGlassOnly', 'Break-glass Only'))}</option>
          </select>
        </fieldset>
        <fieldset class="perm-group-fieldset">
          <legend>${escapeHtml(t('ei.provisioning', 'Provisioning'))}</legend>
          <label><input type="checkbox" id="jit-enabled-checkbox" ${policy.jitProvisioningEnabled ? 'checked' : ''}> ${escapeHtml(t('ei.jitEnabled', 'Enable JIT Provisioning'))}</label>
          <label><input type="checkbox" id="scim-enabled-checkbox" ${policy.scimEnabled ? 'checked' : ''}> ${escapeHtml(t('ei.scimEnabledLabel', 'Enable SCIM Provisioning'))}</label>
        </fieldset>
        <div class="form-actions"><button type="submit" class="btn btn-primary" id="btn-save-sso-policy">${escapeHtml(t('ei.save', 'Save'))}</button></div>
        <div class="auth-msg-area" id="sso-policy-msg"></div>
      </form>`;

    document.getElementById('form-sso-policy')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newEnforcement = content.querySelector('input[name="ssoEnforcement"]:checked')?.value;
      const msgArea = document.getElementById('sso-policy-msg');
      // §49 — confirmation required before a dangerous setting change.
      if (newEnforcement === 'SSO_REQUIRED' && policy.ssoEnforcement !== 'SSO_REQUIRED') {
        if (!confirm(t('ei.confirmSsoRequired', 'Require SSO for all sign-ins? Local password login will be restricted per your Local Login Policy setting.'))) return;
      }
      const body = {
        ssoEnforcement: newEnforcement,
        localLoginPolicy: document.getElementById('local-login-policy-select').value,
        jitProvisioningEnabled: document.getElementById('jit-enabled-checkbox').checked,
        scimEnabled: document.getElementById('scim-enabled-checkbox').checked,
      };
      const saveRes = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/sso-policy`, { method: 'PUT', body: JSON.stringify(body) });
      if (saveRes && saveRes.error) {
        msgArea.innerHTML = `<p class="form-error">${escapeHtml(saveRes.error.message)}</p>`;
      } else {
        msgArea.innerHTML = `<p class="form-success">${escapeHtml(t('ei.saved', 'Saved.'))}</p>`;
      }
    });
  }

  window.NAGEX_ENTERPRISE_IDENTITY_UI = {
    renderTab,
  };
})();
