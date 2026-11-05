import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { listSavedOrgs, rememberOrg, forgetOrg, lastUsed, legacyPrefill, dropLegacySettings, hostOf, loadSavedOrgs, savedOrgsLocation } from '../public/js/savedOrgs.js';
import { settingsFrom, DEFAULT_SETTINGS } from '../public/js/config.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const realFetch = globalThis.fetch;
beforeEach(async () => {
  globalThis.window = { localStorage: memoryStorage() };
  globalThis.fetch = async () => { throw new TypeError('no server in unit tests'); };
  await loadSavedOrgs(); // no server: falls back to (this test's empty) browser storage
});

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

/** Fake local server for /api/data/saved-orgs, like server.ps1 / server.pl. */
function fakeServer(initial = null) {
  const srv = { file: initial === null ? null : JSON.stringify(initial), puts: 0 };
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(url, '/api/data/saved-orgs');
    if ((init.method || 'GET') === 'PUT') {
      assert.equal(init.headers['X-Seeder-Request'], '1');
      srv.file = init.body;
      srv.puts++;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(srv.file || 'null') };
  };
  return srv;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('with the start script running, saved orgs go to data/saved-orgs.json, not the browser', async () => {
  const srv = fakeServer();
  await loadSavedOrgs();
  assert.equal(savedOrgsLocation(), 'file');
  const e = rememberOrg('source', { instanceUrl: 'https://acme.my.salesforce.com', clientId: 'k1', org: { Name: 'Acme', IsSandbox: false } });
  await tick();
  const doc = JSON.parse(srv.file);
  assert.equal(doc.orgs[0].clientId, 'k1');
  assert.equal(doc.lastUsed.source, e.id);
  assert.equal(window.localStorage.getItem('sfseed.orgs'), null, 'nothing in the browser');

  // A later session (fresh page) reads them back from the file.
  globalThis.window = { localStorage: memoryStorage() };
  await loadSavedOrgs();
  assert.equal(listSavedOrgs()[0].host, 'acme.my.salesforce.com');
  assert.equal(lastUsed('source'), e.id);
  globalThis.fetch = realFetch;
});

test('orgs saved in the browser by the previous version move into the file once', async () => {
  window.localStorage.setItem('sfseed.orgs', JSON.stringify([{ id: 'org_old', host: 'old.my.salesforce.com', name: 'Old', clientId: 'k0', lastUsedAt: '2026-11-01' }]));
  window.localStorage.setItem('sfseed.orgs.last', JSON.stringify({ target: 'org_old' }));
  const srv = fakeServer({ version: 1, orgs: [{ id: 'org_new', host: 'new.my.salesforce.com', name: 'New', clientId: 'k9', lastUsedAt: '2026-11-05' }], lastUsed: {} });
  await loadSavedOrgs();
  await tick();
  assert.deepEqual(listSavedOrgs().map((o) => o.host), ['new.my.salesforce.com', 'old.my.salesforce.com']);
  assert.equal(lastUsed('target'), 'org_old');
  assert.equal(JSON.parse(srv.file).orgs.length, 2);
  assert.equal(window.localStorage.getItem('sfseed.orgs'), null, 'browser copy removed after the move');
  globalThis.fetch = realFetch;
});
