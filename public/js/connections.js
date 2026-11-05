// Source/Target org connections: login, restore from sessionStorage, org introspection.
import { state, emit, emptyConnection } from './store.js';
import { SfClient, SfError } from './sfapi.js';
import { login, getSession, clearSession, consumeRedirectResult, cancelLogin, ROLES } from './auth.js';
import { RecordTypeIndex, RT_SOQL, isSeedableObject, keyPrefixMap } from './schema.js';
import { quote } from './soql.js';
import { storage } from './util.js';
import { FALLBACK_API_VERSION, latestApiVersion, saveSettings } from './config.js';

const PREFS_KEY = 'sfseed.loginPrefs';

export function getLoginPrefs(role) {
  const all = storage.get('localStorage', PREFS_KEY, {}) || {};
  return { env: role === 'source' ? 'production' : 'sandbox', customDomain: '', clientId: '', ...(all[role] || {}) };
}

export function saveLoginPrefs(role, prefs) {
  const all = storage.get('localStorage', PREFS_KEY, {}) || {};
  all[role] = prefs;
  storage.set('localStorage', PREFS_KEY, all);
}

function buildClient(role, session) {
  return new SfClient({
    instanceUrl: session.instanceUrl,
    accessToken: session.accessToken,
    apiVersion: session.apiVersion || FALLBACK_API_VERSION,
    label: role,
    onUnauthorized: () => markExpired(role),
  });
}

function markExpired(role) {
  const c = state.conn[role];
  if (c.status === 'connected') {
    c.status = 'expired';
    c.error = 'Session expired or was revoked. Reconnect to continue.';
    clearSession(role);
    emit('connections');
  }
}

/** Loads everything the UI and engine need about an org. */
async function introspect(role, session) {
  const conn = state.conn[role];
  conn.session = session;
  conn.client = buildClient(role, session);
  conn.status = 'connecting';
  conn.error = null;
  emit('connections');
  try {
    const client = conn.client;
    // Always use the newest REST API version this org offers (e.g. v68.0).
    session.apiVersion = await client.useLatestVersion(latestApiVersion, FALLBACK_API_VERSION);
    const [orgRes, global, rtRows] = await Promise.all([
      client.query('SELECT Id, Name, IsSandbox, OrganizationType, InstanceName FROM Organization LIMIT 1'),
      client.describeGlobal(),
      client.queryAll(RT_SOQL),
    ]);
    conn.org = orgRes.records[0] || null;
    if (session.userId && /^[a-zA-Z0-9]{15,18}$/.test(session.userId)) {
      const u = await client.query(`SELECT Id, Name, Username FROM User WHERE Id = ${quote(session.userId)}`);
      conn.user = u.records[0] || null;
    }
    conn.global = global;
    conn.seedable = global.filter(isSeedableObject).sort((a, b) => a.label.localeCompare(b.label));
    conn.keyPrefixes = keyPrefixMap(global);
    conn.rt = new RecordTypeIndex(rtRows);
    conn.limits = await client.limits().catch(() => null);
    conn.status = 'connected';
  } catch (e) {
    conn.status = 'error';
    conn.error = e instanceof SfError || e instanceof Error ? e.message : String(e);
    if (e.status === 401) clearSession(role);
  }
  emit('connections');
  return conn;
}

export async function connect(role, { env, customDomain, clientId = '' }) {
  const key = String(clientId || '').trim();
  if (key && !state.settings.clientId) {
    // The first key entered becomes the shared default, so the other org's card can be left blank.
    state.settings = saveSettings({ clientId: key });
    saveLoginPrefs(role, { env, customDomain, clientId: '' });
  } else {
    saveLoginPrefs(role, { env, customDomain, clientId: key === state.settings.clientId ? '' : key });
  }
  const conn = state.conn[role];
  conn.status = 'authorizing';
  conn.error = null;
  emit('connections');
  try {
    const session = await login(role, { env, customDomain, clientId, settings: state.settings });
    return await introspect(role, session);
  } catch (e) {
    if (conn.status === 'authorizing') conn.status = conn.session ? 'connected' : 'disconnected';
    conn.error = e.message;
    emit('connections');
    throw e;
  }
}

export function cancelConnect(role) {
  cancelLogin();
  const conn = state.conn[role];
  if (conn.status === 'authorizing') {
    conn.status = 'disconnected';
    emit('connections');
  }
}

export function disconnect(role) {
  clearSession(role);
  state.conn[role] = emptyConnection();
  emit('connections');
}

/** On startup: finish a redirect-mode login, then restore sessions kept in sessionStorage. */
export async function restoreConnections() {
  try {
    const s = await consumeRedirectResult(state.settings);
    if (s) emit('toast', { kind: 'success', text: `Signed in to ${s.role} org` });
  } catch (e) {
    emit('toast', { kind: 'error', text: e.message });
  }
  await Promise.all(ROLES.map(async (role) => {
    const session = getSession(role);
    if (session) await introspect(role, session);
  }));
}

export async function refreshLimits(role) {
  const c = state.conn[role];
  if (!c.client) return;
  c.limits = await c.client.limits().catch(() => c.limits);
  emit('connections');
}

export function isConnected(role) {
  return state.conn[role].status === 'connected';
}
