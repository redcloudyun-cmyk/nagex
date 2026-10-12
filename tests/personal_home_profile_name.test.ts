import assert from 'node:assert/strict';
import test from 'node:test';
import { PersonalHomeService } from '../src/home/personal-home.service.js';

// PersonalHomeResponse.userProfile.name must come from the account's real ProfileRecord.displayName (the field is not called "name"),
// and a missing profile or the store's "User" placeholder must give null so the UI falls back to a time-of-day greeting.

async function homeFor(getProfile: (userId: string) => unknown) {
  const calls: string[] = [];
  const identityStore = { getProfile: (userId: string) => { calls.push(userId); return getProfile(userId); } };
  const service = new PersonalHomeService({ identityStore: identityStore as never });
  const home = await service.getPersonalHome({ tenantId: 'ten_a', principalId: 'usr_a' });
  return { name: home.userProfile?.name ?? null, calls };
}

test('userProfile.name is the signed-in account displayName, looked up by the caller principal only', async () => {
  const { name, calls } = await homeFor(() => ({ userId: 'usr_a', displayName: 'Ada Lovelace', locale: 'en' }));
  assert.equal(name, 'Ada Lovelace');
  assert.deepEqual(calls, ['usr_a']);
});

test('userProfile.name is trimmed', async () => {
  assert.equal((await homeFor(() => ({ displayName: '  김서연  ' }))).name, '김서연');
});

test('placeholder, empty, missing and failing profiles give null instead of a fabricated name', async () => {
  assert.equal((await homeFor(() => ({ displayName: 'User' }))).name, null);
  assert.equal((await homeFor(() => ({ displayName: '   ' }))).name, null);
  assert.equal((await homeFor(() => ({ name: 'Legacy field is not a profile field' }))).name, null);
  assert.equal((await homeFor(() => null)).name, null);
  assert.equal((await homeFor(() => { throw new Error('store unavailable'); })).name, null);
});
