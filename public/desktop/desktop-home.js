// NAgex Desktop Home (R22.8) — Consolidated Personal AI Surface
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  function emptyState(text) {
    return `<div class="nagex-empty-state" style="padding:0.75rem; font-size:0.82rem; color:var(--color-text-secondary,#94a3b8);">${escapeHtml(text)}</div>`;
  }

  // ── Hero greeting — real local time-of-day, never a fabricated name ──
  function renderGreeting() {
    const el = document.getElementById('desktop-hero-greeting');
    const headerSub = document.getElementById('header-greeting-sub');
    const hour = new Date().getHours();
    const key = hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening';
    const fallback = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const textVal = t(key, fallback);
    if (el) {
      el.textContent = textVal;
      el.setAttribute('data-i18n', key);
    }
    if (headerSub) {
      headerSub.textContent = `${fallback},`;
    }
  }

  function renderNotificationBell() {
    const badge = document.getElementById('notif-badge');
    if (!badge || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const notifications = (state.notifications && state.notifications.items) || [];
    const count = notifications.filter((item) => !item.read).length;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
    }
  }

  function renderRightNowSection(rightNow) {
    const section = document.getElementById('home-section-right-now');
    if (!section) return;

    if (!rightNow) {
      section.hidden = true;
      section.innerHTML = '';
      return;
    }

    section.hidden = false;
    section.innerHTML = `
      <div class="nagex-section-heading" style="margin-bottom:0.5rem;">
        <div class="heading-title-group">
          <span class="card-icon-tile red-tile">⚡</span>
          <h2 data-i18n="home.rightNowHeader">${escapeHtml(t('home.rightNowHeader', 'Right now'))}</h2>
        </div>
      </div>
      <div class="right-now-card" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 1rem;">
        <strong style="font-size: 1rem; display: block; color: var(--color-text-primary); margin-bottom: 0.35rem;">${escapeHtml(rightNow.title)}</strong>
        <p style="font-size: 0.85rem; color: var(--color-text-secondary); margin: 0 0 0.75rem 0;">${escapeHtml(rightNow.summary)}</p>
        ${rightNow.action ? `<button class="btn-primary" onclick="window.NAGEX.handleHomeItemAction('${escapeHtml(rightNow.type)}', '${escapeHtml(rightNow.sourceRef)}')">${escapeHtml(rightNow.action.label)}</button>` : ''}
      </div>
    `;
  }

  function renderTodaySection(today, sourceStatus) {
    const summaryBar = document.getElementById('today-summary-bar');
    const staleBadge = document.getElementById('today-stale-badge');
    const listEl = document.getElementById('desktop-today-list');

    if (staleBadge) {
      staleBadge.hidden = today?.freshness !== 'STALE';
    }

    if (summaryBar && today) {
      const counts = today.counts || { meetings: 0, emails: 0, tasks: 0, approvals: 0 };
      const totalItems = counts.meetings + counts.emails + counts.tasks + counts.approvals;

      if (totalItems === 0 && sourceStatus?.calendar !== 'UNAVAILABLE') {
        summaryBar.textContent = t('home.zeroDataOnboarding', 'Connect your calendar or email to help NAgex understand your day.');
      } else {
        const calText = sourceStatus?.calendar === 'UNAVAILABLE'
          ? t('home.calendarUnavailable', 'Calendar unavailable')
          : `${counts.meetings} ${t('home.meetings', 'meetings')}`;
        summaryBar.textContent = `${calText} · ${counts.emails} ${t('home.emails', 'emails')} · ${counts.tasks} ${t('home.tasks', 'tasks')} · ${counts.approvals} ${t('home.approvalsWaiting', 'approvals waiting')}`;
      }
    }

    if (listEl && today) {
      const meetings = today.meetings || [];
      if (meetings.length === 0) {
        listEl.innerHTML = sourceStatus?.calendar === 'UNAVAILABLE'
          ? emptyState(t('home.calendarUnavailable', 'Calendar unavailable'))
          : emptyState(t('home.todayEmpty', 'Nothing scheduled right now.'));
      } else {
        const loc = (window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko') ? 'ko-KR' : 'en-US';
        listEl.innerHTML = meetings.map((ev) => {
          const startTime = ev.startsAt ? new Date(ev.startsAt).toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' }) : '9:00 AM';
          return `
            <div class="timeline-row" style="display:flex; gap:0.75rem; align-items:center; padding:0.4rem 0; border-bottom:1px solid rgba(255,255,255,0.05);">
              <div class="timeline-time" style="font-size:0.8rem; width:4.5rem; color:var(--color-text-secondary);">${escapeHtml(startTime)}</div>
              <div class="timeline-content" style="flex:1;">
                <strong class="timeline-title" style="font-size:0.85rem; display:block;">${escapeHtml(ev.title)}</strong>
                ${ev.summary ? `<span class="timeline-meta" style="font-size:0.75rem; color:var(--color-text-muted);">${escapeHtml(ev.summary)}</span>` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  function renderNeedsAttentionSection(items) {
    const listEl = document.getElementById('list-needs-attention');
    if (!listEl) return;

    if (!items || items.length === 0) {
      listEl.innerHTML = emptyState(t('home.nothingNeedsAttention', 'Nothing needs your attention right now.'));
      return;
    }

    listEl.innerHTML = items.map((item) => `
      <div class="inbox-item-card" style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.75rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.03); border-radius:6px;">
        <div class="inbox-item-main" style="flex:1; margin-right:0.5rem;">
          <strong style="font-size:0.85rem; display:block;">${escapeHtml(item.title)}</strong>
          ${item.summary ? `<span style="font-size:0.75rem; color:var(--color-text-secondary);">${escapeHtml(item.summary)}</span>` : ''}
        </div>
        ${item.action ? `<button class="btn-secondary" style="font-size:0.75rem; padding:3px 8px;" onclick="window.NAGEX.handleHomeItemAction('${escapeHtml(item.type)}', '${escapeHtml(item.sourceRef)}')">${escapeHtml(item.action.label)}</button>` : ''}
      </div>
    `).join('');
  }

  function renderPreparedForYouSection(items) {
    const listEl = document.getElementById('list-prepared-for-you');
    if (!listEl) return;

    if (!items || items.length === 0) {
      listEl.innerHTML = emptyState(t('home.nothingPrepared', 'Nothing prepared right now.'));
      return;
    }

    listEl.innerHTML = items.map((item) => `
      <div class="inbox-item-card" style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.75rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.03); border-radius:6px;">
        <div class="inbox-item-main" style="flex:1; margin-right:0.5rem;">
          <strong style="font-size:0.85rem; display:block;">${escapeHtml(item.title)}</strong>
          ${item.summary ? `<span style="font-size:0.75rem; color:var(--color-text-secondary);">${escapeHtml(item.summary)}</span>` : ''}
        </div>
        ${item.action ? `<button class="btn-secondary" style="font-size:0.75rem; padding:3px 8px;" onclick="window.NAGEX.handleHomeItemAction('${escapeHtml(item.type)}', '${escapeHtml(item.sourceRef)}')">${escapeHtml(item.action.label)}</button>` : ''}
      </div>
    `).join('');
  }

  function renderWorkingForYouSection(items) {
    const listEl = document.getElementById('list-nagex-working');
    if (!listEl) return;

    if (!items || items.length === 0) {
      listEl.innerHTML = emptyState(t('home.nothingWorking', 'No active tasks running right now.'));
      return;
    }

    listEl.innerHTML = items.map((item) => `
      <div class="inbox-item-card" style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.75rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.03); border-radius:6px;">
        <div class="inbox-item-main">
          <strong style="font-size:0.85rem; display:block;">${escapeHtml(item.title)}</strong>
          ${item.summary ? `<span style="font-size:0.75rem; color:var(--color-text-secondary);">${escapeHtml(item.summary)}</span>` : ''}
        </div>
        <span class="badge-status status-RUNNING" style="font-size:0.7rem;">RUNNING</span>
      </div>
    `).join('');
  }

  function renderRecentResultsSection(items) {
    const listEl = document.getElementById('desktop-recent-actions-list');
    if (!listEl) return;

    if (!items || items.length === 0) {
      listEl.innerHTML = emptyState(t('home.noRecentResults', 'No recent results yet.'));
      return;
    }

    listEl.innerHTML = items.map((item) => `
      <div class="recent-action-card" style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0.75rem; margin-bottom:0.4rem; background:rgba(255,255,255,0.02); border-radius:6px;">
        <div class="recent-action-body">
          <strong style="font-size:0.82rem; display:block;">${escapeHtml(item.title)}</strong>
          ${item.summary ? `<small style="font-size:0.72rem; color:var(--color-text-muted);">${escapeHtml(item.summary)}</small>` : ''}
        </div>
        <span class="badge-status status-COMPLETED" style="font-size:0.68rem; padding:1px 5px;">DONE</span>
      </div>
    `).join('');
  }

  async function renderDesktopHome() {
    if (!document.querySelector('.nagex-desktop-home')) return;
    renderGreeting();
    renderNotificationBell();

    if (!window.NAGEX || typeof window.NAGEX.apiFetch !== 'function') return;

    const data = await window.NAGEX.apiFetch('/api/v1/personal/home');
    if (!data) return;

    renderRightNowSection(data.rightNow);
    renderTodaySection(data.today, data.sourceStatus);
    renderNeedsAttentionSection(data.needsAttention);
    renderPreparedForYouSection(data.preparedForYou);
    renderWorkingForYouSection(data.workingForYou);
    renderRecentResultsSection(data.recentResults);
  }

  function init() {
    window.NAGEX = window.NAGEX || {};
    window.NAGEX.onHomeRender = renderDesktopHome;
    window.NAGEX.handleHomeItemAction = function (type, sourceRef) {
      if (!type) return;
      const upperType = type.toUpperCase();
      if (upperType.includes('APPROVAL')) {
        if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-approvals');
      } else if (upperType.includes('TASK')) {
        if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-executions');
      } else if (upperType.includes('PREPARE') || upperType.includes('MEETING') || upperType.includes('CALENDAR')) {
        if (window.NAGEX_MEETING_PREP && typeof window.NAGEX_MEETING_PREP.open === 'function') {
          window.NAGEX_MEETING_PREP.open(sourceRef);
        } else if (window.NAGEX.switchTab) {
          window.NAGEX.switchTab('tab-my-space');
        }
      } else {
        if (window.NAGEX.switchTab) window.NAGEX.switchTab('tab-inbox');
      }
    };

    renderDesktopHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
