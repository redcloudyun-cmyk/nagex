// R21 P1 — Home Hero "Most important" card. Real
// GET /api/v1/personal/morning-brief only (src/personal/personal-
// assistant.engine.ts, made real in this same milestone — see the file's
// own header comment for why it previously returned fixed fictional data).
// Fetched lazily once per Home visit, same pattern as daily-brief.js's own
// fetchBrief() — never on a timer.
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    const resolved = window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null;
    return resolved && resolved !== key ? resolved : (fallback || key);
  }

  let fetched = false;
  let briefData = null;
  const homeStartedAt = performance.now();

  function recordMetric(name, startedAt) {
    window.NAGEX_METRICS = window.NAGEX_METRICS || {};
    window.NAGEX_METRICS[name] = Math.max(0, Math.round(performance.now() - startedAt));
  }

  function formatTime(iso) {
    try {
      const locale = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko' ? 'ko-KR' : 'en-US';
      return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function render() {
    const card = document.getElementById('hero-brief-card');
    if (!card) return;

    if (!briefData) {
      card.hidden = true;
      return;
    }

    if (briefData.calendarStatus === 'DISCONNECTED' && briefData.gmailStatus === 'DISCONNECTED') {
      card.hidden = false;
      card.innerHTML =
        '<p class="hero-brief-empty">' + escapeHtml(t('heroBrief.noConnections', 'No calendar or email connected yet.')) + '</p>' +
        '<p class="hero-brief-empty-sub">' + escapeHtml(t('heroBrief.connectHint', 'Connect Calendar or Gmail and NAgex can help you get ready for your day.')) + '</p>';
      return;
    }

    const events = (briefData.schedule_summary && briefData.schedule_summary.events) || [];
    const rec = briefData.recommendation;

    if (!rec && events.length === 0) {
      card.hidden = false;
      card.innerHTML = '<p class="hero-brief-empty">' + escapeHtml(t('heroBrief.nothingToday', 'Nothing on your calendar right now.')) + '</p>';
      return;
    }

    card.hidden = false;
    const demoSummary = briefData.dataSource === 'DEMO'
      ? '<p class="hero-brief-demo-summary">' + escapeHtml(t('heroBrief.demoSummary', '3 meetings · 1 important email · 1 task due today')) + '</p>'
      : '';
    const alsoToday = events.slice(0, 3).map((e) =>
      '<li><span class="hero-brief-time">' + escapeHtml(formatTime(e.start_time)) + '</span> <span class="hero-brief-event-title">' + escapeHtml(e.title) + '</span></li>'
    ).join('');

    card.innerHTML = demoSummary +
      (rec ? (
        '<div class="hero-brief-most-important">' +
        '<span class="hero-brief-label">' + escapeHtml(t('heroBrief.mostImportant', 'Most important')) + '</span>' +
        '<p class="hero-brief-title">' + escapeHtml(rec.title) + '</p>' +
        '<p class="hero-brief-reason">' + escapeHtml(rec.reason) + '</p>' +
        (rec.action_type === 'MEETING_PREP' ? '<button class="btn-plan-action plan-status-ready" id="hero-brief-prepare-btn">' + escapeHtml(t('heroBrief.prepareMe', 'Prepare me')) + '</button>' : '') +
        '</div>'
      ) : '') +
      (alsoToday ? '<div class="hero-brief-also-today"><span class="hero-brief-label">' + escapeHtml(t('heroBrief.alsoToday', 'Also today')) + '</span><ul>' + alsoToday + '</ul></div>' : '');

    const prepareBtn = document.getElementById('hero-brief-prepare-btn');
    if (prepareBtn && rec) {
      prepareBtn.addEventListener('click', () => {
        if (window.NAGEX_MEETING_PREP) window.NAGEX_MEETING_PREP.open(rec.target_id);
      });
    }
    renderMobileCard(card, rec);
  }

  function renderMobileCard(sourceCard, rec) {
    const mobileCard = document.getElementById('mh-hero-brief-card');
    if (!mobileCard) return;
    if (!sourceCard || sourceCard.hidden || !briefData) {
      mobileCard.hidden = true;
      mobileCard.innerHTML = '';
      return;
    }
    mobileCard.hidden = false;
    mobileCard.innerHTML = sourceCard.innerHTML.replace('id="hero-brief-prepare-btn"', 'id="mh-hero-brief-prepare-btn"');
    const button = document.getElementById('mh-hero-brief-prepare-btn');
    if (button && rec) button.addEventListener('click', () => {
      if (window.NAGEX_MEETING_PREP) window.NAGEX_MEETING_PREP.open(rec.target_id);
    });
  }

  async function fetchAndRender() {
    if (fetched || !window.NAGEX || typeof window.NAGEX.apiFetch !== 'function') return;
    fetched = true;
    const startedAt = performance.now();
    const data = await window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
    if (data && !data.error) briefData = data;
    render();
    recordMetric('MORNING_BRIEF_RENDER_MS', startedAt);
    if (window.NAGEX_METRICS.HOME_INITIAL_RENDER_MS == null) recordMetric('HOME_INITIAL_RENDER_MS', homeStartedAt);
  }

  function init() {
    if (new URLSearchParams(window.location.search).get('demo') === '1') document.documentElement.classList.add('demo-mode');
    window.NAGEX = window.NAGEX || {};
    const priorHook = window.NAGEX.onHomeRender;
    window.NAGEX.onHomeRender = function () {
      if (typeof priorHook === 'function') priorHook();
      fetchAndRender();
    };
    fetchAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
