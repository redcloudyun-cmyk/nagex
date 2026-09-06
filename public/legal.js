// NAgex Legal Pages — minimal, standalone EN/KR toggle (no dependency on app.js/i18n.js).
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('legal-lang-toggle');
    const blocks = document.querySelectorAll('[data-lang]');
    if (!toggle || !blocks.length) return;

    let lang = 'en';

    function apply() {
      blocks.forEach((block) => {
        block.hidden = block.getAttribute('data-lang') !== lang;
      });
      toggle.textContent = lang === 'en' ? 'KR' : 'EN';
      document.documentElement.lang = lang;
    }

    toggle.addEventListener('click', () => {
      lang = lang === 'en' ? 'kr' : 'en';
      apply();
    });

    apply();
  });
})();
