// P06-01 ~ P06-05: Module Registry Tests
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ModuleRegistry } from '../src/modules/module.registry.js';
import type { ModuleDefinition } from '../src/modules/module.types.js';

describe('ModuleRegistry Tests', () => {
  it('P06-01: registers default canonical modules (gmail, calendar, browser)', () => {
    const registry = new ModuleRegistry();
    const modules = registry.list();
    assert.equal(modules.length, 3);
    assert.ok(registry.has('module.calendar'));
    assert.ok(registry.has('module.gmail'));
    assert.ok(registry.has('module.browser'));
  });

  it('P06-02: throws when registering a duplicate module ID', () => {
    const registry = new ModuleRegistry();
    const duplicateDef: ModuleDefinition = {
      moduleId: 'module.gmail',
      name: 'Duplicate Gmail',
      version: '2.0.0',
      category: 'Communication',
      description: 'Duplicate',
      capabilities: ['gmail.custom'],
      requiredPermissions: [],
      enabledByDefault: true,
    };

    assert.throws(
      () => registry.register(duplicateDef),
      /Duplicate module registration: module.gmail/
    );
  });

  it('P06-03: throws when registering a capability already claimed by another module', () => {
    const registry = new ModuleRegistry();
    const conflictingDef: ModuleDefinition = {
      moduleId: 'module.custom_calendar',
      name: 'Custom Calendar',
      version: '1.0.0',
      category: 'Productivity',
      description: 'Custom',
      capabilities: ['google_calendar.create_event'], // Already claimed by module.calendar
      requiredPermissions: [],
      enabledByDefault: true,
    };

    assert.throws(
      () => registry.register(conflictingDef),
      /Duplicate module capability claim: capability "google_calendar.create_event" already claimed by module "module.calendar"/
    );
  });

  it('P06-04: resolves canonical capability IDs to target ModuleDefinition', () => {
    const registry = new ModuleRegistry();

    const calMod = registry.getByCapability('google_calendar.create_event');
    assert.ok(calMod);
    assert.equal(calMod.moduleId, 'module.calendar');

    const gmailMod = registry.getByCapability('gmail.send_email');
    assert.ok(gmailMod);
    assert.equal(gmailMod.moduleId, 'module.gmail');

    const browserMod = registry.getByCapability('browser.open');
    assert.ok(browserMod);
    assert.equal(browserMod.moduleId, 'module.browser');
  });

  it('P06-05: resolves capability aliases to target ModuleDefinition', () => {
    const registry = new ModuleRegistry();

    const calAlias = registry.getByCapability('calendar.create_event');
    assert.ok(calAlias);
    assert.equal(calAlias.moduleId, 'module.calendar');

    const gmailAlias = registry.getByCapability('gmail.send');
    assert.ok(gmailAlias);
    assert.equal(gmailAlias.moduleId, 'module.gmail');

    const browserAlias = registry.getByCapability('browser.page.navigate');
    assert.ok(browserAlias);
    assert.equal(browserAlias.moduleId, 'module.browser');
  });
});
