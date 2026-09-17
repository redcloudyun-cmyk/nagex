// NAgex Organization & Workspace Web UI Controller (R14)
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  let orgState = {
    userOrgs: [],
    currentOrg: null,
    workspaces: [],
    currentWorkspace: null,
    members: [],
    invitations: [],
    activeTab: 'general',
  };

  async function loadOrgContext() {
    try {
      const orgsRes = await window.NAGEX.apiFetch('/api/v1/organizations');
      if (orgsRes && Array.isArray(orgsRes.organizations)) {
        orgState.userOrgs = orgsRes.organizations;
      } else {
        orgState.userOrgs = [];
      }

      if (orgState.userOrgs.length > 0) {
        const savedOrgId = localStorage.getItem('nagex_active_org_id');
        const found = orgState.userOrgs.find((o) => o.organizationId === savedOrgId);
        orgState.currentOrg = found || orgState.userOrgs[0];
        localStorage.setItem('nagex_active_org_id', orgState.currentOrg.organizationId);

        // Load Workspaces for current org
        const wsRes = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgState.currentOrg.organizationId}/workspaces`);
        if (wsRes && Array.isArray(wsRes.workspaces)) {
          orgState.workspaces = wsRes.workspaces;
        } else {
          orgState.workspaces = [];
        }

        const savedWsId = localStorage.getItem(`nagex_active_ws_${orgState.currentOrg.organizationId}`);
        const foundWs = orgState.workspaces.find((w) => w.workspaceId === savedWsId);
        orgState.currentWorkspace = foundWs || orgState.workspaces.find((w) => w.status === 'ACTIVE') || orgState.workspaces[0] || null;
        if (orgState.currentWorkspace) {
          localStorage.setItem(`nagex_active_ws_${orgState.currentOrg.organizationId}`, orgState.currentWorkspace.workspaceId);
        }
      } else {
        orgState.currentOrg = null;
        orgState.workspaces = [];
        orgState.currentWorkspace = null;
      }
    } catch {
      orgState.userOrgs = [];
      orgState.currentOrg = null;
      orgState.workspaces = [];
      orgState.currentWorkspace = null;
    }

    renderSwitchers();
    renderOrgSettingsPanel();
  }

  function renderSwitchers() {
    // Render Organization Switcher
    const name = orgState.currentOrg ? orgState.currentOrg.name : t('org.createOrg', 'Create Org');
    const orgBtns = document.querySelectorAll('.btn-org-switcher, #btn-org-switcher, #mh-btn-org-switcher');
    orgBtns.forEach((btn) => {
      btn.innerHTML = `<span class="switcher-label">${escapeHtml(name)}</span> <svg class="chevron-sm" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;
    });

    // Render Workspace Switcher
    const wsName = orgState.currentWorkspace ? orgState.currentWorkspace.name : t('workspace.createWorkspace', 'General');
    const wsBtns = document.querySelectorAll('.btn-workspace-switcher, #btn-workspace-switcher, #mh-btn-workspace-switcher');
    wsBtns.forEach((btn) => {
      btn.innerHTML = `<span class="switcher-label">${escapeHtml(wsName)}</span> <svg class="chevron-sm" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;
    });
  }

  function toggleOrgDropdown(e) {
    if (e) e.stopPropagation();
    let menu = document.getElementById('org-dropdown-menu');
    if (menu) {
      menu.remove();
      return;
    }

    const btn = (e && e.currentTarget) || document.querySelector('.btn-org-switcher') || document.getElementById('btn-org-switcher') || document.getElementById('mh-btn-org-switcher');
    if (!btn) return;

    menu = document.createElement('div');
    menu.id = 'org-dropdown-menu';
    menu.className = 'switcher-dropdown';

    let html = '<div class="dropdown-header">Organizations</div>';
    orgState.userOrgs.forEach((org) => {
      const isSelected = orgState.currentOrg && orgState.currentOrg.organizationId === org.organizationId;
      html += `
        <button class="dropdown-item ${isSelected ? 'active' : ''}" data-org-id="${org.organizationId}">
          <span>${escapeHtml(org.name)}</span>
          ${isSelected ? '<span class="badge badge-sm">Active</span>' : ''}
        </button>`;
    });
    html += `<div class="dropdown-divider"></div>`;
    html += `<button class="dropdown-item dropdown-action" id="btn-open-create-org">+ ${escapeHtml(t('org.createOrg', 'Create Organization'))}</button>`;

    menu.innerHTML = html;
    btn.parentElement.appendChild(menu);

    menu.querySelectorAll('[data-org-id]').forEach((item) => {
      item.addEventListener('click', async () => {
        const orgId = item.getAttribute('data-org-id');
        const targetOrg = orgState.userOrgs.find((o) => o.organizationId === orgId);
        if (targetOrg) {
          orgState.currentOrg = targetOrg;
          localStorage.setItem('nagex_active_org_id', targetOrg.organizationId);
          await loadOrgContext();
        }
        menu.remove();
      });
    });

    document.getElementById('btn-open-create-org')?.addEventListener('click', () => {
      menu.remove();
      showCreateOrgModal();
    });

    document.addEventListener('click', function closeMenu(evt) {
      if (!menu.contains(evt.target) && evt.target !== btn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }

  function toggleWorkspaceDropdown(e) {
    if (e) e.stopPropagation();
    let menu = document.getElementById('ws-dropdown-menu');
    if (menu) {
      menu.remove();
      return;
    }

    const btn = (e && e.currentTarget) || document.querySelector('.btn-workspace-switcher') || document.getElementById('btn-workspace-switcher') || document.getElementById('mh-btn-workspace-switcher');
    if (!btn || !orgState.currentOrg) return;

    menu = document.createElement('div');
    menu.id = 'ws-dropdown-menu';
    menu.className = 'switcher-dropdown';

    let html = '<div class="dropdown-header">Workspaces</div>';
    orgState.workspaces.forEach((ws) => {
      const isSelected = orgState.currentWorkspace && orgState.currentWorkspace.workspaceId === ws.workspaceId;
      html += `
        <button class="dropdown-item ${isSelected ? 'active' : ''}" data-ws-id="${ws.workspaceId}">
          <span>${escapeHtml(ws.name)}</span>
          ${ws.status === 'ARCHIVED' ? '<span class="badge badge-warn badge-sm">Archived</span>' : ''}
          ${isSelected ? '<span class="badge badge-sm">Active</span>' : ''}
        </button>`;
    });
    html += `<div class="dropdown-divider"></div>`;
    html += `<button class="dropdown-item dropdown-action" id="btn-open-create-ws">+ ${escapeHtml(t('workspace.createWorkspace', 'Create Workspace'))}</button>`;

    menu.innerHTML = html;
    btn.parentElement.appendChild(menu);

    menu.querySelectorAll('[data-ws-id]').forEach((item) => {
      item.addEventListener('click', () => {
        const wsId = item.getAttribute('data-ws-id');
        const targetWs = orgState.workspaces.find((w) => w.workspaceId === wsId);
        if (targetWs) {
          orgState.currentWorkspace = targetWs;
          localStorage.setItem(`nagex_active_ws_${orgState.currentOrg.organizationId}`, targetWs.workspaceId);
          renderSwitchers();
        }
        menu.remove();
      });
    });

    document.getElementById('btn-open-create-ws')?.addEventListener('click', () => {
      menu.remove();
      showCreateWorkspaceModal();
    });

    document.addEventListener('click', function closeMenu(evt) {
      if (!menu.contains(evt.target) && evt.target !== btn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }

  // ── Modals ──
  function showCreateOrgModal() {
    const modal = document.createElement('div');
    modal.id = 'org-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-org-title">
        <div class="modal-header">
          <h3 id="create-org-title">${escapeHtml(t('org.createOrg', 'Create Organization'))}</h3>
          <button class="modal-close-btn" id="close-create-org">&times;</button>
        </div>
        <form id="form-create-org" class="modal-body auth-form">
          <div class="form-group">
            <label for="create-org-name">${escapeHtml(t('org.orgName', 'Organization Name'))}</label>
            <input type="text" id="create-org-name" class="form-control" required placeholder="e.g. Acme Corporation">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-create-org">${escapeHtml(t('org.createOrg', 'Create'))}</button>
          </div>
          <div class="auth-msg-area" id="create-org-msg"></div>
        </form>
      </div>`;
    document.body.appendChild(modal);

    const closeBtn = document.getElementById('close-create-org');
    closeBtn?.addEventListener('click', () => modal.remove());

    document.getElementById('form-create-org')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('create-org-name').value;
      const msgArea = document.getElementById('create-org-msg');
      try {
        const res = await window.NAGEX.apiFetch('/api/v1/organizations', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        if (res && res.organization) {
          localStorage.setItem('nagex_active_org_id', res.organization.organizationId);
          modal.remove();
          await loadOrgContext();
        } else {
          msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Failed to create organization.')}</p>`;
        }
      } catch (err) {
        msgArea.innerHTML = `<p class="form-error">Failed to create organization.</p>`;
      }
    });
  }

  function showCreateWorkspaceModal() {
    if (!orgState.currentOrg) return;
    const modal = document.createElement('div');
    modal.id = 'ws-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-ws-title">
        <div class="modal-header">
          <h3 id="create-ws-title">${escapeHtml(t('workspace.createWorkspace', 'Create Workspace'))}</h3>
          <button class="modal-close-btn" id="close-create-ws">&times;</button>
        </div>
        <form id="form-create-ws" class="modal-body auth-form">
          <div class="form-group">
            <label for="create-ws-name">${escapeHtml(t('workspace.workspaceName', 'Workspace Name'))}</label>
            <input type="text" id="create-ws-name" class="form-control" required placeholder="e.g. Research & Dev">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-create-ws">${escapeHtml(t('workspace.createWorkspace', 'Create'))}</button>
          </div>
          <div class="auth-msg-area" id="create-ws-msg"></div>
        </form>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('close-create-ws')?.addEventListener('click', () => modal.remove());

    document.getElementById('form-create-ws')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('create-ws-name').value;
      const msgArea = document.getElementById('create-ws-msg');
      try {
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgState.currentOrg.organizationId}/workspaces`, {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        if (res && res.workspace) {
          modal.remove();
          await loadOrgContext();
        } else {
          msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Failed to create workspace.')}</p>`;
        }
      } catch (err) {
        msgArea.innerHTML = `<p class="form-error">Failed to create workspace.</p>`;
      }
    });
  }

  function showInviteMemberModal() {
    if (!orgState.currentOrg) return;
    const modal = document.createElement('div');
    modal.id = 'invite-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
        <div class="modal-header">
          <h3 id="invite-modal-title">${escapeHtml(t('org.inviteMember', 'Invite Member'))}</h3>
          <button class="modal-close-btn" id="close-invite-modal">&times;</button>
        </div>
        <form id="form-invite-member" class="modal-body auth-form">
          <div class="form-group">
            <label for="invite-email">Email Address</label>
            <input type="email" id="invite-email" class="form-control" required placeholder="colleague@example.com">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-submit-invite">${escapeHtml(t('org.inviteMember', 'Send Invitation'))}</button>
          </div>
          <div class="auth-msg-area" id="invite-msg-area"></div>
        </form>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('close-invite-modal')?.addEventListener('click', () => modal.remove());

    document.getElementById('form-invite-member')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('invite-email').value;
      const msgArea = document.getElementById('invite-msg-area');
      try {
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgState.currentOrg.organizationId}/invitations`, {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        if (res && res.invitation) {
          modal.remove();
          await loadOrgSettingsSubTab('invitations');
        } else {
          msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Invitation failed.')}</p>`;
        }
      } catch (err) {
        msgArea.innerHTML = `<p class="form-error">Invitation failed.</p>`;
      }
    });
  }

  // ── Render Settings Organization Panel ──
  async function renderOrgSettingsPanel() {
    const container = document.getElementById('mh-org-settings-content');
    if (!container) return;

    if (!orgState.currentOrg) {
      container.innerHTML = `
        <div class="account-card">
          <h4>No Organization Selected</h4>
          <p class="text-sub">Create or select an organization to manage members, workspaces, and settings.</p>
          <button class="btn btn-primary" id="btn-settings-create-org">+ ${escapeHtml(t('org.createOrg', 'Create Organization'))}</button>
        </div>`;
      document.getElementById('btn-settings-create-org')?.addEventListener('click', showCreateOrgModal);
      return;
    }

    container.innerHTML = `
      <div class="account-card">
        <div class="settings-subnav">
          <button class="subnav-btn ${orgState.activeTab === 'general' ? 'active' : ''}" data-org-tab="general">${escapeHtml(t('org.generalTab', 'General'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'members' ? 'active' : ''}" data-org-tab="members">${escapeHtml(t('org.membersTab', 'Members'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'roles' ? 'active' : ''}" data-org-tab="roles">${escapeHtml(t('org.rolesTab', 'Roles & Permissions'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'enterprise-identity' ? 'active' : ''}" data-org-tab="enterprise-identity">${escapeHtml(t('org.enterpriseIdentityTab', 'Enterprise Identity'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'invitations' ? 'active' : ''}" data-org-tab="invitations">${escapeHtml(t('org.invitationsTab', 'Invitations'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'workspaces' ? 'active' : ''}" data-org-tab="workspaces">${escapeHtml(t('org.workspacesTab', 'Workspaces'))}</button>
          <button class="subnav-btn ${orgState.activeTab === 'danger' ? 'active' : ''}" data-org-tab="danger">${escapeHtml(t('org.dangerZoneTab', 'Danger Zone'))}</button>
        </div>
        <div id="org-tab-content" class="org-tab-content"></div>
      </div>`;

    container.querySelectorAll('[data-org-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-org-tab');
        orgState.activeTab = tab;
        loadOrgSettingsSubTab(tab);
      });
    });

    await loadOrgSettingsSubTab(orgState.activeTab);
  }

  async function loadOrgSettingsSubTab(tab) {
    const content = document.getElementById('org-tab-content');
    if (!content || !orgState.currentOrg) return;

    const orgId = orgState.currentOrg.organizationId;

    if (tab === 'general') {
      content.innerHTML = `
        <form id="form-org-general" class="auth-form">
          <div class="form-group">
            <label for="org-input-name">Organization Name</label>
            <input type="text" id="org-input-name" class="form-control" value="${escapeHtml(orgState.currentOrg.name)}">
          </div>
          <div class="form-group">
            <label>Slug</label>
            <input type="text" class="form-control" disabled value="${escapeHtml(orgState.currentOrg.slug)}">
          </div>
          <div class="form-group">
            <label>Status</label>
            <span class="badge ${orgState.currentOrg.status === 'ACTIVE' ? 'badge-success' : 'badge-warn'}">${escapeHtml(orgState.currentOrg.status)}</span>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-save-org-general">Save Changes</button>
          </div>
          <div class="auth-msg-area" id="org-general-msg"></div>
        </form>`;

      document.getElementById('form-org-general')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('org-input-name').value;
        const msgArea = document.getElementById('org-general-msg');
        try {
          const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}`, {
            method: 'PATCH',
            body: JSON.stringify({ name }),
          });
          if (res && res.organization) {
            msgArea.innerHTML = `<p class="form-success">Organization updated!</p>`;
            await loadOrgContext();
          } else {
            msgArea.innerHTML = `<p class="form-error">${escapeHtml(res?.error?.message || 'Update failed.')}</p>`;
          }
        } catch {
          msgArea.innerHTML = `<p class="form-error">Update failed.</p>`;
        }
      });
    } else if (tab === 'enterprise-identity') {
      if (window.NAGEX_ENTERPRISE_IDENTITY_UI) {
        window.NAGEX_ENTERPRISE_IDENTITY_UI.renderTab(content, orgId);
      } else {
        content.innerHTML = 'Loading...';
      }
    } else if (tab === 'roles') {
      if (window.NAGEX_RBAC_UI) {
        window.NAGEX_RBAC_UI.renderRolesTab(content, orgId);
      } else {
        content.innerHTML = `<p class="text-sub">Loading Roles & Permissions...</p>`;
      }
    } else if (tab === 'members') {
      try {
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/members`);
        orgState.members = (res && res.members) || [];
      } catch {
        orgState.members = [];
      }

      let cardsHtml = `
        <div class="tab-action-bar">
          <h4>Organization Members (${orgState.members.length})</h4>
          <button class="btn btn-sm btn-primary" id="btn-members-invite">+ ${escapeHtml(t('org.inviteMember', 'Invite Member'))}</button>
        </div>
        <div class="members-cards-container">`;

      orgState.members.forEach((m) => {
        cardsHtml += `
          <div class="member-card">
            <div class="member-card-header">
              <span class="member-name">${escapeHtml(m.displayName || 'Member')}</span>
              <span class="badge ${m.role === 'OWNER' ? 'badge-primary' : 'badge-subtle'}">${escapeHtml(m.role)}</span>
            </div>
            ${m.email ? `<div class="member-email text-sub">${escapeHtml(m.email)}</div>` : ''}
            <div class="member-card-actions">
              <button class="btn btn-xs btn-outline-danger" data-remove-member="${m.userId}">Remove</button>
              ${m.role !== 'OWNER' ? `<button class="btn btn-xs btn-outline" data-transfer-owner="${m.userId}">Make Owner</button>` : ''}
            </div>
          </div>`;
      });
      cardsHtml += `</div>`;

      content.innerHTML = cardsHtml;

      document.getElementById('btn-members-invite')?.addEventListener('click', showInviteMemberModal);

      content.querySelectorAll('[data-remove-member]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetId = btn.getAttribute('data-remove-member');
          if (confirm('Are you sure you want to remove this member?')) {
            await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/members/${targetId}`, { method: 'DELETE' });
            await loadOrgSettingsSubTab('members');
          }
        });
      });

      content.querySelectorAll('[data-transfer-owner]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetId = btn.getAttribute('data-transfer-owner');
          if (confirm('Transfer ownership to this member? You will become a standard member.')) {
            await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/transfer-owner`, {
              method: 'POST',
              body: JSON.stringify({ targetUserId: targetId }),
            });
            await loadOrgContext();
          }
        });
      });
    } else if (tab === 'invitations') {
      try {
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/invitations`);
        orgState.invitations = (res && res.invitations) || [];
      } catch {
        orgState.invitations = [];
      }

      let invHtml = `
        <div class="tab-action-bar">
          <h4>Pending Invitations (${orgState.invitations.filter((i) => i.status === 'PENDING').length})</h4>
          <button class="btn btn-sm btn-primary" id="btn-invites-add">+ ${escapeHtml(t('org.inviteMember', 'Invite Member'))}</button>
        </div>
        <div class="invitations-list">`;

      orgState.invitations.forEach((inv) => {
        invHtml += `
          <div class="member-card">
            <div class="member-card-header">
              <span class="member-email">${escapeHtml(inv.email)}</span>
              <span class="badge ${inv.status === 'PENDING' ? 'badge-warn' : 'badge-subtle'}">${escapeHtml(inv.status)}</span>
            </div>
            <div class="member-card-actions">
              ${inv.status === 'PENDING' ? `<button class="btn btn-xs btn-outline-danger" data-revoke-inv="${inv.invitationId}">Revoke</button>` : ''}
            </div>
          </div>`;
      });
      invHtml += `</div>`;

      content.innerHTML = invHtml;

      document.getElementById('btn-invites-add')?.addEventListener('click', showInviteMemberModal);

      content.querySelectorAll('[data-revoke-inv]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const invId = btn.getAttribute('data-revoke-inv');
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/invitations/${invId}`, { method: 'DELETE' });
          await loadOrgSettingsSubTab('invitations');
        });
      });
    } else if (tab === 'workspaces') {
      try {
        const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/workspaces`);
        orgState.workspaces = (res && res.workspaces) || [];
      } catch {
        orgState.workspaces = [];
      }

      let wsHtml = `
        <div class="tab-action-bar">
          <h4>Workspaces (${orgState.workspaces.length})</h4>
          <button class="btn btn-sm btn-primary" id="btn-ws-create">+ ${escapeHtml(t('workspace.createWorkspace', 'Create Workspace'))}</button>
        </div>
        <div class="workspaces-list">`;

      orgState.workspaces.forEach((ws) => {
        wsHtml += `
          <div class="member-card">
            <div class="member-card-header">
              <span class="member-name">${escapeHtml(ws.name)}</span>
              <span class="badge ${ws.status === 'ACTIVE' ? 'badge-success' : 'badge-warn'}">${escapeHtml(ws.status)}</span>
            </div>
            <div class="member-card-actions">
              ${ws.status === 'ACTIVE' ? `<button class="btn btn-xs btn-outline-warn" data-archive-ws="${ws.workspaceId}">Archive</button>` : ''}
              ${ws.status === 'ARCHIVED' ? `<button class="btn btn-xs btn-outline-success" data-restore-ws="${ws.workspaceId}">Restore</button>` : ''}
              <button class="btn btn-xs btn-outline-danger" data-delete-ws="${ws.workspaceId}">Delete</button>
            </div>
          </div>`;
      });
      wsHtml += `</div>`;

      content.innerHTML = wsHtml;

      document.getElementById('btn-ws-create')?.addEventListener('click', showCreateWorkspaceModal);

      content.querySelectorAll('[data-archive-ws]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const wsId = btn.getAttribute('data-archive-ws');
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/workspaces/${wsId}/archive`, { method: 'POST' });
          await loadOrgContext();
        });
      });

      content.querySelectorAll('[data-restore-ws]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const wsId = btn.getAttribute('data-restore-ws');
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/workspaces/${wsId}/restore`, { method: 'POST' });
          await loadOrgContext();
        });
      });

      content.querySelectorAll('[data-delete-ws]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const wsId = btn.getAttribute('data-delete-ws');
          if (confirm('Delete this workspace?')) {
            await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/workspaces/${wsId}/delete`, { method: 'POST' });
            await loadOrgContext();
          }
        });
      });
    } else if (tab === 'danger') {
      const isPending = orgState.currentOrg.status === 'DELETION_PENDING';
      content.innerHTML = `
        <div class="danger-zone-box">
          <h4>Organization Danger Zone</h4>
          <p class="text-sub">Deleting an organization disables workspace mutations and queues it for permanent purging after a 14-day grace period.</p>
          ${
            isPending
              ? `<button class="btn btn-outline-success" id="btn-cancel-org-delete">${escapeHtml(t('org.cancelDelete', 'Cancel Deletion'))}</button>`
              : `<button class="btn btn-danger" id="btn-delete-org">${escapeHtml(t('org.deleteOrg', 'Delete Organization'))}</button>`
          }
        </div>`;

      document.getElementById('btn-delete-org')?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete this organization? A 14-day grace period applies.')) {
          await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/delete`, { method: 'POST' });
          await loadOrgContext();
        }
      });

      document.getElementById('btn-cancel-org-delete')?.addEventListener('click', async () => {
        await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/delete/cancel`, { method: 'POST' });
        await loadOrgContext();
      });
    }
  }

  // ── Init & Export ──
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.btn-org-switcher, #btn-org-switcher, #mh-btn-org-switcher').forEach((btn) => {
      btn.addEventListener('click', toggleOrgDropdown);
    });

    document.querySelectorAll('.btn-workspace-switcher, #btn-workspace-switcher, #mh-btn-workspace-switcher').forEach((btn) => {
      btn.addEventListener('click', toggleWorkspaceDropdown);
    });

    loadOrgContext();
  });

  window.NAGEX_ORG_UI = {
    loadOrgContext,
    renderOrgSettingsPanel,
    showCreateOrgModal,
    showCreateWorkspaceModal,
    showInviteMemberModal,
    getOrgState: () => orgState,
  };
})();
