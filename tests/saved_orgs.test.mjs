import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { listSavedOrgs, rememberOrg, forgetOrg, lastUsed, legacyPrefill, dropLegacySettings, hostOf } from '../public/js/savedOrgs.js';
import { settingsFrom, DEFAULT_SETTINGS } from '../public/js/config.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
beforeEach(() => { globalThis.window = { localStorage: memoryStorage() }; });

const UAT = 'https://Acme--UAT.sandbox.my.salesforce.com';

test('a connected org is saved by My Domain with its key, and becomes the last used org for that role', () => {
  const e = rememberOrg('target', { instanceUrl: UAT, clientId: ' 3MVG9old ', org: { Id: '00DA', Name: 'Acme UAT', IsSandbox: true }, user: { Username: 'ada@acme.com.uat' } });
  assert.equal(e.host, 'acme--uat.sandbox.my.salesforce.com');
  assert.equal(e.clientId, '3MVG9old');
  assert.equal(lastUsed('target'), e.id);
  assert.equal(lastUsed('source'), null);
  assert.equal(listSavedOrgs().length, 1);
});

test('after a sandbox refresh the same entry gets the new key and org Id (matched by My Domain)', () => {
  const first = rememberOrg('target', { instanceUrl: UAT, clientId: '3MVG9old', org: { Id: '00DA', Name: 'Acme UAT', IsSandbox: true } });
  const again = rememberOrg('target', { id: first.id, instanceUrl: `${UAT}/`, clientId: '3MVG9new', org: { Id: '00DB', Name: 'Acme UAT', IsSandbox: true } });
  assert.equal(again.id, first.id);
  assert.equal(listSavedOrgs().length, 1);
  assert.equal(listSavedOrgs()[0].clientId, '3MVG9new');
  assert.equal(listSavedOrgs()[0].orgId, '00DB');
});

test('newest first; forgetting an org clears it as last used', () => {
  const a = rememberOrg('source', { instanceUrl: 'https://acme.my.salesforce.com', clientId: 'k1', org: { Name: 'Acme', IsSandbox: false } });
  const b = rememberOrg('target', { instanceUrl: UAT, clientId: 'k2', org: { Name: 'Acme UAT', IsSandbox: true } });
  assert.deepEqual(listSavedOrgs().map((o) => o.id), [b.id, a.id]);
  forgetOrg(a.id);
  assert.equal(lastUsed('source'), null);
  assert.deepEqual(listSavedOrgs().map((o) => o.id), [b.id]);
});

test('key and login choice from earlier versions prefill a new org once, then are removed', () => {
  window.localStorage.setItem('sfseed.settings', JSON.stringify({ clientId: '3MVG9shared', scopes: 'api web' }));
  window.localStorage.setItem('sfseed.loginPrefs', JSON.stringify({ target: { env: 'custom', customDomain: 'acme--uat.sandbox.my.salesforce.com', clientId: '' } }));
  assert.deepEqual(legacyPrefill('target'), { env: 'custom', customDomain: 'acme--uat.sandbox.my.salesforce.com', clientId: '3MVG9shared' });
  assert.equal(legacyPrefill('source').clientId, '3MVG9shared');
  dropLegacySettings();
  assert.deepEqual(legacyPrefill('source'), { env: '', customDomain: '', clientId: '' });
});

test('hostOf accepts bare domains and URLs', () => {
  assert.equal(hostOf('acme.my.salesforce.com'), 'acme.my.salesforce.com');
  assert.equal(hostOf('https://ACME.my.salesforce.com/lightning'), 'acme.my.salesforce.com');
  assert.equal(hostOf(''), '');
});

test('safety limits come from config.json only; sign-in settings there are ignored', () => {
  const s = settingsFrom({ clientId: 'x', scopes: 'api web', maxRecordsPerObject: '999999', allowProductionTarget: 'yes' });
  assert.ok(!('clientId' in s) && !('scopes' in s));
  assert.equal(s.maxRecordsPerObject, 50000, 'clamped');
  assert.equal(s.allowProductionTarget, false, 'only a real true allows it');
  assert.deepEqual(settingsFrom({}), { ...DEFAULT_SETTINGS });
});
