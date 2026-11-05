// Saved orgs: the sign-in details of orgs connected before (My Domain and Consumer Key), so the next
// session only needs "pick the org, sign in". Never stores passwords or tokens (tokens stay in
// sessionStorage for the tab).
//
// Stored in the app folder, data/saved-orgs.json, through the local server (GET/PUT /api/data/saved-orgs),
// so the list survives browser data clean-ups, other browsers and other ports. When the server cannot
// store it (an older server.ps1 / server.pl), this browser's localStorage is used instead.
//
// An org is identified by its My Domain host, which survives a sandbox refresh. The Consumer Key does
// not always survive one (the refreshed sandbox can get a new External Client App copy), so the key is
// editable and is saved again after the next successful sign-in.
import { storage, uid } from './util.js';
import { emit } from './store.js';

const ENDPOINT = '/api/data/saved-orgs';
const KEY = 'sfseed.orgs'; // localStorage fallback (and the format of the browser-only version)
const LAST_KEY = 'sfseed.orgs.last'; // { source: savedOrgId, target: savedOrgId }
const LEGACY_SETTINGS = 'sfseed.settings'; // earlier versions: { clientId } shared by every org
const LEGACY_PREFS = 'sfseed.loginPrefs'; // earlier versions: per role { env, customDomain, clientId }

// In-memory copy: { orgs: [savedOrg], lastUsed: { source, target } }
let data = null;
let fileBacked = false;
let writing = Promise.resolve();

const asList = (v) => (Array.isArray(v) ? v.filter((o) => o && typeof o.id === 'string' && typeof o.host === 'string') : []);
const asLast = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});

function readLocal() {
  return { orgs: asList(storage.get('localStorage', KEY, [])), lastUsed: asLast(storage.get('localStorage', LAST_KEY, {})) };
}

function current() {
  if (!data) data = readLocal(); // before loadSavedOrgs() (tests, or if the page skipped it)
  return data;
}

/**
 * Loads the saved orgs from the app folder (call once at startup). Orgs saved by the browser-only
 * version are merged into the file once, then removed from the browser.
 */
export async function loadSavedOrgs() {
  fileBacked = false;
  let doc = null;
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (res.ok) {
      doc = await res.json();
      fileBacked = true;
    }
  } catch {
    fileBacked = false;
  }
  const local = readLocal();
  if (!fileBacked) {
    data = local;
    return { fileBacked, count: data.orgs.length };
  }
  data = { orgs: asList(doc && doc.orgs), lastUsed: asLast(doc && doc.lastUsed) };
  const hosts = new Set(data.orgs.map((o) => o.host));
  const carried = local.orgs.filter((o) => !hosts.has(o.host));
  if (carried.length) {
    data.orgs.push(...carried);
    for (const [role, id] of Object.entries(local.lastUsed)) if (!data.lastUsed[role]) data.lastUsed[role] = id;
    if (await persist()) {
      storage.remove('localStorage', KEY);
      storage.remove('localStorage', LAST_KEY);
    }
  } else if (local.orgs.length) {
    storage.remove('localStorage', KEY);
    storage.remove('localStorage', LAST_KEY);
  }
  return { fileBacked, count: data.orgs.length };
}

/** Where the list is kept, for the Connect page. */
export function savedOrgsLocation() {
  return fileBacked ? 'file' : 'browser';
}

/** Writes the list (in call order). Resolves true when saved. */
function persist() {
  const snapshot = JSON.stringify({ version: 1, orgs: current().orgs, lastUsed: current().lastUsed }, null, 2);
  if (!fileBacked) {
    const d = current();
    return Promise.resolve(storage.set('localStorage', KEY, d.orgs) && storage.set('localStorage', LAST_KEY, d.lastUsed));
  }
  writing = writing.then(async () => {
    try {
      const res = await fetch(ENDPOINT, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Seeder-Request': '1' }, body: snapshot, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      emit('toast', { kind: 'error', text: `Could not save the org list to data/saved-orgs.json in the app folder (${e.message}). Is the start script still running?` });
      return false;
    }
  });
  return writing;
}

/** savedOrg = { id, host, name, isSandbox, orgId, username, clientId, lastUsedAt } */
export function listSavedOrgs() {
  return [...current().orgs].sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
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
  const d = current();
  d.orgs = [entry, ...list.filter((o) => o.id !== entry.id && o.host !== host)];
  d.lastUsed[role] = entry.id;
  persist();
  return entry;
}

export function forgetOrg(id) {
  const d = current();
  d.orgs = d.orgs.filter((o) => o.id !== id);
  for (const r of Object.keys(d.lastUsed)) if (d.lastUsed[r] === id) delete d.lastUsed[r];
  return persist();
}

export function lastUsed(role) {
  const id = current().lastUsed[role];
  return id && getSavedOrg(id) ? id : null;
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
