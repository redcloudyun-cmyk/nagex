// NAgex Roles & Permissions (RBAC) Web UI Controller (R15)
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

  // Wires Escape-to-close, a Tab/Shift+Tab focus trap, backdrop-click-to-
  // close, and initial focus for a dynamically-appended modal — reusing
  // the same window.NAGEX_MODAL_BEHAVIOR pure helpers app.js's ambient
  // modal already uses (public/modal-behavior.js), so every modal in the
  // app shares one focus-trap/backdrop-click implementation rather than
  // each screen inventing its own. Returns a close() function that
  // removes both the modal and its keydown listener exactly once.
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
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab' && window.NAGEX_MODAL_BEHAVIOR) {
        const target = window.NAGEX_MODAL_BEHAVIOR.computeFocusTrapTarget(getFocusableElements(modal), document.activeElement, event.shiftKey);
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }
    }
    document.addEventListener('keydown', keydownHandler, true);

    modal.addEventListener('click', (event) => {
      const isBackdropClick = window.NAGEX_MODAL_BEHAVIOR
        ? window.NAGEX_MODAL_BEHAVIOR.isBackdropSelfClick(event.target, modal)
        : event.target === modal;
      if (isBackdropClick) close();
    });

    return close;
  }

  const ALL_PERMISSIONS = [
    { key: 'organization.read', label: 'Read Organization', scope: 'ORGANIZATION', category: 'Organization' },
    { key: 'organization.update', label: 'Update Organization', scope: 'ORGANIZATION', category: 'Organization' },
    { key: 'organization.delete', label: 'Delete Organization', scope: 'ORGANIZATION', category: 'Organization', dangerous: true },
    { key: 'member.read', label: 'Read Members', scope: 'ORGANIZATION', category: 'Members' },
    { key: 'member.invite', label: 'Invite Members', scope: 'ORGANIZATION', category: 'Members' },
    { key: 'member.remove', label: 'Remove Members', scope: 'ORGANIZATION', category: 'Members', dangerous: true },
    { key: 'role.read', label: 'Read Roles', scope: 'ORGANIZATION', category: 'Roles' },
    { key: 'role.create', label: 'Create Roles', scope: 'ORGANIZATION', category: 'Roles' },
    { key: 'role.update', label: 'Update Roles', scope: 'ORGANIZATION', category: 'Roles' },
    { key: 'role.delete', label: 'Delete Roles', scope: 'ORGANIZATION', category: 'Roles', dangerous: true },
    { key: 'role.assign', label: 'Assign Roles', scope: 'ORGANIZATION', category: 'Roles', dangerous: true },
    { key: 'audit.read', label: 'Read Audit Logs', scope: 'ORGANIZATION', category: 'Audit' },
    { key: 'workspace.read', label: 'Read Workspaces', scope: 'WORKSPACE', category: 'Workspace' },
    { key: 'workspace.create', label: 'Create Workspaces', scope: 'WORKSPACE', category: 'Workspace' },
    { key: 'workspace.update', label: 'Update Workspaces', scope: 'WORKSPACE', category: 'Workspace' },
    { key: 'workspace.archive', label: 'Archive Workspaces', scope: 'WORKSPACE', category: 'Workspace' },
    { key: 'workspace.delete', label: 'Delete Workspaces', scope: 'WORKSPACE', category: 'Workspace', dangerous: true },
  ];

  async function renderRolesTab(container, orgId) {
    try {
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/roles`);
      const roles = res?.roles || [];

      let html = `
        <div class="tab-action-bar">
          <h4 data-i18n="rbac.roles">Roles & Permissions</h4>
          <div class="action-btn-group">
            <button class="btn btn-sm btn-outline" id="btn-view-effective-perms" data-i18n="rbac.effectivePermissions">Effective Permissions</button>
            <button class="btn btn-sm btn-primary" id="btn-open-create-role" data-i18n="rbac.createRole">+ Create Custom Role</button>
          </div>
        </div>
        <div class="roles-cards-container">`;

      roles.forEach((r) => {
        const permCount = r.permissions ? r.permissions.length : 0;
        const typeBadge = r.isSystem
          ? `<span class="badge badge-subdued" data-i18n="rbac.systemRole">System</span>`
          : `<span class="badge badge-info" data-i18n="rbac.customRole">Custom</span>`;

        html += `
          <div class="role-card" data-role-id="${r.roleId}">
            <div class="role-card-header">
              <div class="role-title-group">
                <span class="role-name">${escapeHtml(r.name)}</span>
                ${typeBadge}
              </div>
              ${
                !r.isSystem
                  ? `<div class="role-actions">
                      <button class="btn-xs btn-outline btn-edit-role" data-role-id="${r.roleId}">Edit</button>
                      <button class="btn-xs btn-danger btn-delete-role" data-role-id="${r.roleId}">Delete</button>
                     </div>`
                  : ''
              }
            </div>
            <p class="role-desc">${escapeHtml(r.description || 'No description.')}</p>
            <div class="role-perms-summary">
              <span class="perms-count">${permCount} Permissions</span>
              <div class="perms-chips">`;

        r.permissions.slice(0, 6).forEach((p) => {
          const isDanger = ['organization.delete', 'member.remove', 'role.assign', 'role.delete'].includes(p.permissionKey);
          html += `<span class="perm-chip ${isDanger ? 'perm-chip-danger' : ''}">${escapeHtml(p.permissionKey)}</span>`;
        });
        if (permCount > 6) {
          html += `<span class="perm-chip perm-chip-more">+${permCount - 6} more</span>`;
        }

        html += `
              </div>
            </div>
          </div>`;
      });

      html += `</div>`;
      container.innerHTML = html;

      document.getElementById('btn-open-create-role')?.addEventListener('click', () => {
        showRoleEditorModal(orgId);
      });

      document.getElementById('btn-view-effective-perms')?.addEventListener('click', () => {
        showEffectivePermissionsModal(orgId);
      });

      container.querySelectorAll('.btn-edit-role').forEach((btn) => {
        btn.addEventListener('click', () => {
          const roleId = btn.getAttribute('data-role-id');
          const role = roles.find((r) => r.roleId === roleId);
          if (role) showRoleEditorModal(orgId, role);
        });
      });

      container.querySelectorAll('.btn-delete-role').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const roleId = btn.getAttribute('data-role-id');
          if (confirm('Are you sure you want to delete this custom role?')) {
            try {
              const delRes = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/roles/${roleId}`, { method: 'DELETE' });
              if (delRes && delRes.error) {
                alert(delRes.error.message || 'Failed to delete role.');
              } else {
                renderRolesTab(container, orgId);
              }
            } catch (err) {
              alert('Failed to delete role.');
            }
          }
        });
      });
    } catch {
      container.innerHTML = `<p class="form-error">Failed to load roles.</p>`;
    }
  }

  function showRoleEditorModal(orgId, roleToEdit = null) {
    const modal = document.createElement('div');
    modal.id = 'role-editor-modal';
    modal.className = 'modal-backdrop';

    const isEdit = Boolean(roleToEdit);
    const title = isEdit ? 'Edit Custom Role' : 'Create Custom Role';
    const selectedKeys = new Set(roleToEdit?.permissions ? roleToEdit.permissions.map((p) => p.permissionKey) : []);

    let permsHtml = '';
    const categories = ['Organization', 'Members', 'Roles', 'Audit', 'Workspace'];
    categories.forEach((cat) => {
      const catPerms = ALL_PERMISSIONS.filter((p) => p.category === cat);
      permsHtml += `<fieldset class="perm-group-fieldset"><legend>${cat}</legend><div class="perm-checkboxes-grid">`;
      catPerms.forEach((p) => {
        const isChecked = selectedKeys.has(p.key);
        permsHtml += `
          <label class="perm-checkbox-label ${p.dangerous ? 'label-dangerous' : ''}">
            <input type="checkbox" class="perm-cb" name="role-perm" value="${p.key}" data-scope="${p.scope}" ${isChecked ? 'checked' : ''}>
            <span>${escapeHtml(p.label)}</span>
            ${p.dangerous ? '<span class="badge badge-danger badge-xs" data-i18n="rbac.dangerPermission">Dangerous</span>' : ''}
          </label>`;
      });
      permsHtml += `</div></fieldset>`;
    });

    modal.innerHTML = `
      <div class="modal-card modal-card-lg" role="dialog" aria-modal="true" aria-labelledby="role-editor-title">
        <div class="modal-header">
          <h3 id="role-editor-title">${escapeHtml(title)}</h3>
          <button class="modal-close-btn" id="close-role-editor">&times;</button>
        </div>
        <form id="form-role-editor" class="modal-body auth-form">
          <div class="form-group">
            <label for="role-input-name">${escapeHtml(t('rbac.roleName', 'Role Name'))}</label>
            <input type="text" id="role-input-name" class="form-control" required value="${escapeHtml(roleToEdit?.name || '')}" placeholder="e.g. Project Manager">
          </div>
          <div class="form-group">
            <label for="role-input-desc">${escapeHtml(t('rbac.roleDesc', 'Description'))}</label>
            <input type="text" id="role-input-desc" class="form-control" value="${escapeHtml(roleToEdit?.description || '')}" placeholder="Role purpose and permissions scope">
          </div>
          <div class="form-group">
            <label>Permissions</label>
            <div class="perm-editor-scroll">${permsHtml}</div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-save-role">${isEdit ? 'Save Changes' : 'Create Role'}</button>
          </div>
          <div class="auth-msg-area" id="role-editor-msg"></div>
        </form>
      </div>`;

    document.body.appendChild(modal);
    const closeRoleEditor = wireModalAccessibility(modal);

    document.getElementById('close-role-editor')?.addEventListener('click', () => closeRoleEditor());

    document.getElementById('form-role-editor')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('role-input-name').value.trim();
      const description = document.getElementById('role-input-desc').value.trim();
      const msgArea = document.getElementById('role-editor-msg');

      const checkedInputs = modal.querySelectorAll('input[name="role-perm"]:checked');
      const permissions = Array.from(checkedInputs).map((chk) => ({
        permissionKey: chk.value,
        scope: chk.getAttribute('data-scope'),
      }));

      try {
        const url = isEdit
          ? `/api/v1/organizations/${orgId}/roles/${roleToEdit.roleId}`
          : `/api/v1/organizations/${orgId}/roles`;
        const method = isEdit ? 'PATCH' : 'POST';

        const res = await window.NAGEX.apiFetch(url, {
          method,
          body: JSON.stringify({ name, description, permissions }),
        });

        if (res && res.error) {
          msgArea.innerHTML = `<p class="form-error">${escapeHtml(res.error.message || 'Action failed.')}</p>`;
        } else {
          closeRoleEditor();
          const rolesContainer = document.querySelector('.roles-cards-container')?.parentElement;
          if (rolesContainer) renderRolesTab(rolesContainer, orgId);
        }
      } catch (err) {
        msgArea.innerHTML = `<p class="form-error">An unexpected error occurred.</p>`;
      }
    });
  }

  async function showEffectivePermissionsModal(orgId) {
    const modal = document.createElement('div');
    modal.id = 'effective-perms-modal';
    modal.className = 'modal-backdrop';

    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="effective-perms-title">
        <div class="modal-header">
          <h3 id="effective-perms-title" data-i18n="rbac.effectivePermissions">Effective Permissions</h3>
          <button class="modal-close-btn" id="close-effective-perms">&times;</button>
        </div>
        <div class="modal-body">
          <div id="effective-perms-body">Loading...</div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    const closeEffectivePerms = wireModalAccessibility(modal);
    document.getElementById('close-effective-perms')?.addEventListener('click', () => closeEffectivePerms());

    try {
      const res = await window.NAGEX.apiFetch(`/api/v1/organizations/${orgId}/effective-permissions`);
      const perms = res?.permissions || [];
      const bodyEl = document.getElementById('effective-perms-body');
      if (bodyEl) {
        if (perms.length === 0) {
          bodyEl.innerHTML = `<p class="text-sub">No effective permissions granted.</p>`;
        } else {
          let listHtml = `<div class="effective-perms-grid">`;
          perms.forEach((p) => {
            listHtml += `<div class="effective-perm-item"><strong>${escapeHtml(p.permissionKey)}</strong> <span class="badge badge-sm">${escapeHtml(p.scope)}</span></div>`;
          });
          listHtml += `</div>`;
          bodyEl.innerHTML = listHtml;
        }
      }
    } catch {
      const bodyEl = document.getElementById('effective-perms-body');
      if (bodyEl) bodyEl.innerHTML = `<p class="form-error">Could not load permissions.</p>`;
    }
  }

  window.NAGEX_RBAC_UI = {
    renderRolesTab,
    showRoleEditorModal,
    showEffectivePermissionsModal,
  };
})();
