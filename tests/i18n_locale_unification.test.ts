import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const app = () => fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const i18n = () => fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8');
const index = () => fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('NO_MIXED_LOCALE_UI: shell and Settings labels share the canonical NAGEX_I18N locale source', () => {
  const appJs = app();
  const i18nJs = i18n();
  const html = index();

  assert.match(i18nJs, /const STORAGE_KEY = 'nagex_locale'/);
  assert.match(i18nJs, /getLocale/);
  assert.match(appJs, /window\.NAGEX_I18N \? window\.NAGEX_I18N\.getLocale\(\)/);
  assert.doesNotMatch(appJs, /getLanguage\(\)/);

  for (const key of ['nav.home', 'nav.inbox', 'nav.create', 'nav.canvas', 'nav.tasks', 'nav.knowledge', 'nav.activity', 'nav.settings']) {
    assert.match(html, new RegExp(`data-i18n="${key}"`));
  }

  for (const label of ['Home', 'Inbox', 'Create', 'Canvas', 'Tasks', 'Knowledge', 'Activity', 'Settings']) {
    assert.match(i18nJs, new RegExp(`'[^']+': '${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  for (const label of ['홈', '인박스', '생성', '캔버스', '할 일', '지식 베이스', '활동', '설정']) {
    assert.match(i18nJs, new RegExp(label));
  }

  for (const label of ['Account', 'Connections', 'Devices', 'Permissions', 'Notifications', 'Personalization', 'Privacy & Security', 'Appearance', 'Advanced']) {
    assert.match(i18nJs, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const label of ['계정', '연결', '기기', '권한', '알림', '개인화', '개인정보 및 보안', '화면 설정', '고급']) {
    assert.match(i18nJs, new RegExp(label));
  }

  assert.match(appJs, /dataset\.settingsLocale === currentSettingsLocale/);
  assert.match(appJs, /nagex:localechange/);
});
