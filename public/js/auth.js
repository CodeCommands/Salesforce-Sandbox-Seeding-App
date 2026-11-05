// OAuth 2.0 for two orgs in one browser session.
// Authorization Code + PKCE only (External Client App, no client secret, no implicit/user-agent flow).
// Login runs in a popup so the SPA keeps its state; a full-page redirect is the fallback.
import { storage } from './util.js';
import { redirectUri } from './config.js';
import { transportFetch } from './sfapi.js';

export const ROLES = ['source', 'target'];
const PENDING_KEY = 'sfseed.oauth.pending';
const RESULT_KEY = 'sfseed.oauth.result';
const CHANNEL = 'sfseed-oauth';
const sessionKey = (role) => `sfseed.session.${role}`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export const ENVIRONMENTS = {
  production: { label: 'Production / Developer Edition', host: 'https://login.salesforce.com' },
  sandbox: { label: 'Sandbox', host: 'https://test.salesforce.com' },
  custom: { label: 'Custom domain (My Domain)', host: '' },
};

/** Accepts "acme--uat.sandbox.my.salesforce.com", "https://acme.my.salesforce.com/", etc. */
export function normalizeLoginHost(env, customDomain) {
  if (env !== 'custom') return ENVIRONMENTS[env] ? ENVIRONMENTS[env].host : ENVIRONMENTS.production.host;
  let d = String(customDomain || '').trim();
  if (!d) throw new Error('Enter your My Domain URL, e.g. acme--uat.sandbox.my.salesforce.com');
  if (!/^https?:\/\//i.test(d)) d = `https://${d}`;
  let url;
  try {
    url = new URL(d);
  } catch {
    throw new Error(`"${customDomain}" is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error('My Domain URL must use https');
  if (!/\.(salesforce\.com|force\.com|cloudforce\.com|salesforce\.mil|force\.mil|sfcrmproducts\.cn)$/i.test(url.hostname)) {
    throw new Error('That does not look like a Salesforce domain (expected *.my.salesforce.com)');
  }
  return `https://${url.hostname}`;
}

// ---------- Session storage ----------

export function getSession(role) {
  return storage.get('sessionStorage', sessionKey(role));
}

export function saveSession(role, session) {
  storage.set('sessionStorage', sessionKey(role), session);
}

export function clearSession(role) {
  storage.remove('sessionStorage', sessionKey(role));
}

// ---------- PKCE helpers ----------

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(len = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(len)));
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---------- Login ----------

let active = null; // { state, resolve, reject, cleanup }

export function cancelLogin() {
  if (active) {
    active.reject(new Error('Login cancelled'));
    active.cleanup();
  }
}

/**
 * Starts a login for `role`. Resolves with a session object once the callback page reports back.
 * @param opts { env, customDomain, clientId (optional per-org override), settings }
 */
export async function login(role, { env, customDomain, clientId, settings }) {
  const consumerKey = String(clientId || settings.clientId || '').trim();
  if (!consumerKey) throw new Error('Set the External Client App Consumer Key in Settings (or for this org on the Connect tab) first.');
  if (active) cancelLogin();
  const loginHost = normalizeLoginHost(env, customDomain);
  const state = `${role}.${randomString(16)}`;
  const verifier = randomString(48);
  const pending = {
    state, role, loginHost, env, customDomain: customDomain || '', clientId: consumerKey, verifier, createdAt: Date.now(), mode: 'popup',
  };

  // Authorization Code + PKCE (S256). No client secret is ever used or stored.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: consumerKey,
    redirect_uri: redirectUri(),
    state,
    scope: settings.scopes || 'api',
    prompt: 'login', // two orgs, one browser: always show the login screen
    display: 'popup',
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  const authorizeUrl = `${loginHost}/services/oauth2/authorize?${params}`;
  storage.set('sessionStorage', PENDING_KEY, pending);

  const w = 520;
  const hgt = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - hgt) / 2);
  const popup = window.open(authorizeUrl, 'sfseed-oauth', `width=${w},height=${hgt},left=${left},top=${top}`);
  if (!popup) {
    // Popup blocked: fall back to a full-page redirect. The plan draft is already saved.
    pending.mode = 'redirect';
    storage.set('sessionStorage', PENDING_KEY, pending);
    window.location.assign(authorizeUrl);
    return new Promise(() => {}); // page is navigating away
  }

  return new Promise((resolve, reject) => {
    let bc = null;
    const onMessage = (ev) => {
      if (ev.origin && ev.origin !== window.location.origin) return;
      const data = ev.data;
      if (!data || data.type !== CHANNEL || !data.params || data.params.state !== state) return;
      cleanup();
      completeLogin(data.params, settings).then(resolve, reject);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Login timed out'));
    }, LOGIN_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (bc) bc.close();
      active = null;
    }
    window.addEventListener('message', onMessage);
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (ev) => onMessage({ origin: window.location.origin, data: ev.data });
    } catch {
      bc = null;
    }
    active = { state, resolve, reject, cleanup };
  });
}

/** Called on page load: finishes a login that used the full-page redirect fallback. */
export async function consumeRedirectResult(settings) {
  const params = storage.get('sessionStorage', RESULT_KEY);
  if (!params) return null;
  storage.remove('sessionStorage', RESULT_KEY);
  const session = await completeLogin(params, settings);
  return session;
}

async function completeLogin(params, settings) {
  const pending = storage.get('sessionStorage', PENDING_KEY);
  storage.remove('sessionStorage', PENDING_KEY);
  if (!pending || pending.state !== params.state) throw new Error('Login response did not match the request (state mismatch). Please try again.');
  if (Date.now() - pending.createdAt > LOGIN_TIMEOUT_MS) throw new Error('Login took too long. Please try again.');
  if (params.error) {
    throw new Error(explainOAuthError(params.error, params.error_description));
  }
  if (!params.code) throw new Error('Salesforce did not return an authorization code');
  const tokenData = await exchangeCode(pending, params.code, settings);
  if (!tokenData.access_token || !tokenData.instance_url) throw new Error('Salesforce did not return an access token');
  const idParts = String(tokenData.id || '').split('/');
  const session = {
    role: pending.role,
    accessToken: tokenData.access_token,
    instanceUrl: tokenData.instance_url,
    idUrl: tokenData.id || '',
    orgId: idParts.length >= 2 ? idParts[idParts.length - 2] : '',
    userId: idParts.length >= 1 ? idParts[idParts.length - 1] : '',
    issuedAt: Number(tokenData.issued_at) || Date.now(),
    loginHost: pending.loginHost,
    env: pending.env,
    customDomain: pending.customDomain,
    clientId: pending.clientId,
  };
  saveSession(pending.role, session);
  return session;
}

async function exchangeCode(pending, code, settings) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: pending.clientId,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  let res;
  try {
    res = await transportFetch(settings.transport, `${pending.loginHost}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      credentials: 'omit',
    });
  } catch (e) {
    throw new Error(settings.transport === 'proxy'
      ? `Token exchange failed (${e.message}). Check that the start script (start.bat or start.command) is still running.`
      : `Token exchange failed (${e.message}). With Direct transport, enable "Enable CORS for OAuth endpoints" in Setup > CORS, or switch Transport to "Local proxy".`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainOAuthError(data.error || `HTTP ${res.status}`, data.error_description));
  return data;
}

export function explainOAuthError(code, description) {
  const d = description ? `: ${description}` : '';
  const hints = {
    redirect_uri_mismatch: `The External Client App's Callback URL must be exactly ${redirectUri()}`,
    invalid_client_id: 'Check the Consumer Key. A Local External Client App only works in the org where it exists; for other orgs enter that org\'s own key on the Connect tab. New apps can take a few minutes to become active.',
    access_denied: 'Login was cancelled or the app was not approved.',
    OAUTH_APPROVAL_ERROR_GENERIC: 'The org rejected the app. Check Permitted Users / IP Relaxation in the External Client App policies.',
    invalid_grant: 'The authorization code was rejected. In the External Client App, uncheck "Require secret for Web Server Flow" and keep PKCE required.',
    invalid_request: 'Make sure PKCE is enabled ("Require Proof Key for Code Exchange") on the External Client App.',
  };
  return `${code}${d}${hints[code] ? `. ${hints[code]}` : ''}`;
}
