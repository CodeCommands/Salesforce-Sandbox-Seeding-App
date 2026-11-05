// Saved orgs: the sign-in details of orgs connected before (My Domain and Consumer Key), so the next
// session only needs "pick the org, sign in". Kept in this browser's localStorage. Never stores
// passwords or tokens (tokens stay in sessionStorage for the tab).
//
// An org is identified by its My Domain host, which survives a sandbox refresh. The Consumer Key does
// not always survive one (the refreshed sandbox can get a new External Client App copy), so the key is
// editable and is saved again after the next successful sign-in.
import { storage, uid } from './util.js';

const KEY = 'sfseed.orgs';
const LAST_KEY = 'sfseed.orgs.last'; // { source: savedOrgId, target: savedOrgId }
const LEGACY_SETTINGS = 'sfseed.settings'; // earlier versions: { clientId } shared by every org
const LEGACY_PREFS = 'sfseed.loginPrefs'; // earlier versions: per role { env, customDomain, clientId }

/** savedOrg = { id, host, name, isSandbox, orgId, username, clientId, lastUsedAt } */
export function listSavedOrgs() {
  const list = storage.get('localStorage', KEY, []);
  return (Array.isArray(list) ? list : []).sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
}

export function getSavedOrg(id) {
  return listSavedOrgs().find((o) => o.id === id) || null;
}

/** "https://Acme--UAT.sandbox.my.salesforce.com/" -> "acme--uat.sandbox.my.salesforce.com" */
export function hostOf(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Records a successful sign-in. Matches an existing entry by `id` (the saved org the user picked) or by
 * My Domain host, so a refreshed sandbox updates its entry (new key, new org Id) instead of adding one.
 */
export function rememberOrg(role, { id, instanceUrl, clientId, org, user }) {
  const host = hostOf(instanceUrl);
  if (!host) return null;
  const list = listSavedOrgs();
  const byHost = list.find((o) => o.host === host);
  const existing = byHost || (id && list.find((o) => o.id === id)) || null;
  const entry = {
    id: existing ? existing.id : uid('org'),
    host,
    name: (org && org.Name) || (existing && existing.name) || host,
    isSandbox: org ? !!org.IsSandbox : !!(existing && existing.isSandbox),
    orgId: (org && org.Id) || (existing && existing.orgId) || '',
    username: (user && user.Username) || (existing && existing.username) || '',
    clientId: String(clientId || '').trim(),
    lastUsedAt: new Date().toISOString(),
  };
  const next = [entry, ...list.filter((o) => o.id !== entry.id && o.host !== host)];
  storage.set('localStorage', KEY, next);
  setLastUsed(role, entry.id);
  return entry;
}

export function forgetOrg(id) {
  storage.set('localStorage', KEY, listSavedOrgs().filter((o) => o.id !== id));
  const last = storage.get('localStorage', LAST_KEY, {}) || {};
  for (const r of Object.keys(last)) if (last[r] === id) delete last[r];
  storage.set('localStorage', LAST_KEY, last);
}

export function lastUsed(role) {
  const last = storage.get('localStorage', LAST_KEY, {}) || {};
  return last[role] && getSavedOrg(last[role]) ? last[role] : null;
}

function setLastUsed(role, id) {
  const last = storage.get('localStorage', LAST_KEY, {}) || {};
  last[role] = id;
  storage.set('localStorage', LAST_KEY, last);
}

/**
 * Prefill for a new org on this card, taken once from the settings of earlier versions (a shared key
 * and the last login choice per role). Empty when there is nothing to carry over.
 */
export function legacyPrefill(role) {
  const settings = storage.get('localStorage', LEGACY_SETTINGS, {}) || {};
  const prefs = (storage.get('localStorage', LEGACY_PREFS, {}) || {})[role] || {};
  return {
    env: prefs.env || '',
    customDomain: prefs.customDomain || '',
    clientId: prefs.clientId || settings.clientId || '',
  };
}

/** Removes the settings of earlier versions once every card has a saved org to use instead. */
export function dropLegacySettings() {
  storage.remove('localStorage', LEGACY_SETTINGS);
  storage.remove('localStorage', LEGACY_PREFS);
}
