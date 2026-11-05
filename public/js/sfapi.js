// Salesforce REST API client. Pure fetch; no SDKs.
import { sleep } from './util.js';

export const COLLECTION_MAX = 200; // sObject Collections hard limit per request
export const MAX_SOQL_GET_LENGTH = 14000; // keep the encoded GET URL safely under Salesforce's ~16 KB URI limit

export class SfError extends Error {
  constructor(message, { status = 0, errorCode = '', details = null } = {}) {
    super(message);
    this.name = 'SfError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

/** Sends a request through the local server's relay (server.ps1 / server.pl), which forwards it to Salesforce. */
export function proxyFetch(url, init) {
  const headers = { ...(init.headers || {}), 'X-SF-Endpoint': url };
  return fetch('/api/proxy', { ...init, headers });
}

function networkError(err, url) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  const hint = ' Check that the start script (start.bat on Windows, start.command on macOS) is still running and that this computer can reach Salesforce (corporate proxy / firewall).';
  return new SfError(`Network error calling ${host}: ${err.message || err}.${hint}`, { status: 0, errorCode: 'NETWORK' });
}

export function parseSfError(status, data) {
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    const msg = data.map((e) => `${e.errorCode || e.statusCode || 'ERROR'}: ${e.message}`).join('; ');
    return new SfError(msg, { status, errorCode: first.errorCode || first.statusCode || '', details: data });
  }
  if (data && typeof data === 'object') {
    if (data.error) {
      return new SfError(`${data.error}: ${data.error_description || ''}`.trim(), { status, errorCode: data.error, details: data });
    }
    if (data.message) return new SfError(data.message, { status, errorCode: data.errorCode || '', details: data });
  }
  const text = typeof data === 'string' && data ? data.slice(0, 300) : `HTTP ${status}`;
  return new SfError(text, { status, details: data });
}

export class SfClient {
  constructor({ instanceUrl, accessToken, apiVersion, label = '', onUnauthorized = null }) {
    this.instanceUrl = String(instanceUrl).replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.label = label;
    this.onUnauthorized = onUnauthorized;
    this.callCount = 0;
    this._describe = new Map(); // name -> describe result
    this._describePending = new Map(); // name -> promise
    this._describeErrors = new Map(); // name -> error
    this._global = null;
  }

  get dataPath() {
    return `/services/data/v${this.apiVersion}`;
  }

  /** Switches this client to the newest REST API version the org supports. */
  async useLatestVersion(pick, fallback) {
    try {
      const versions = await this.request('GET', '/services/data/');
      this.apiVersion = pick(versions);
    } catch (e) {
      if (e.status === 401) throw e;
      this.apiVersion = fallback;
    }
    return this.apiVersion;
  }

  async request(method, path, { body, headers = {}, signal, retries } = {}) {
    const url = /^https:\/\//i.test(path) ? path : this.instanceUrl + path;
    const idempotent = method === 'GET';
    const maxAttempts = retries ?? (idempotent ? 3 : 1);
    const h = { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}`, ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    }
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        this.callCount++;
        res = await proxyFetch(url, { method, headers: h, body: payload, signal, cache: 'no-store', credentials: 'omit' });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (attempt < maxAttempts) {
          await sleep(400 * attempt * attempt, signal);
          continue;
        }
        throw networkError(err, url);
      }
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok) return data;
      if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts) {
        await sleep(800 * attempt * attempt, signal);
        continue;
      }
      if (res.status === 502 && data && data.proxyError) {
        throw new SfError(`Local proxy could not reach Salesforce: ${data.proxyError}`, { status: 502, errorCode: 'PROXY' });
      }
      const err = parseSfError(res.status, data);
      if (res.status === 401 && this.onUnauthorized) this.onUnauthorized(err);
      throw err;
    }
  }

  /**
   * One-time sign-in link for the Salesforce UI (frontdoor.jsp with a single-use code). Needs a token
   * with the "web" or "full" scope; otherwise Salesforce answers with an invalid scope error.
   */
  async singleAccessUrl({ signal } = {}) {
    const data = await this.request('POST', '/services/oauth2/singleaccess', {
      body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal,
    });
    if (!data || typeof data.frontdoor_uri !== 'string') throw new SfError('Salesforce did not return a sign-in link', { errorCode: 'NO_FRONTDOOR' });
    return data.frontdoor_uri;
  }

  // ---------- Query ----------
  query(soql, { signal } = {}) {
    return this.request('GET', `${this.dataPath}/query?q=${encodeURIComponent(soql)}`, { signal });
  }

  /** Follows nextRecordsUrl until done or `max` records are collected. */
  async queryAll(soql, { signal, max = Infinity, onPage } = {}) {
    let res = await this.query(soql, { signal });
    const records = [...(res.records || [])];
    if (onPage) onPage(records.length, res.totalSize);
    while (!res.done && res.nextRecordsUrl && records.length < max) {
      res = await this.request('GET', res.nextRecordsUrl, { signal });
      records.push(...(res.records || []));
      if (onPage) onPage(records.length, res.totalSize);
    }
    return records.length > max ? records.slice(0, max) : records;
  }

  async count(soql, { signal } = {}) {
    const res = await this.query(soql, { signal });
    return res.totalSize;
  }

  // ---------- Metadata ----------
  async describeGlobal() {
    if (!this._global) {
      const res = await this.request('GET', `${this.dataPath}/sobjects/`);
      this._global = res.sobjects || [];
    }
    return this._global;
  }

  peekGlobal() {
    return this._global;
  }

  peekDescribe(name) {
    return this._describe.get(String(name).toLowerCase());
  }

  describeError(name) {
    return this._describeErrors.get(String(name).toLowerCase());
  }

  describe(name) {
    const key = String(name).toLowerCase();
    if (this._describe.has(key)) return Promise.resolve(this._describe.get(key));
    if (this._describePending.has(key)) return this._describePending.get(key);
    const p = this.request('GET', `${this.dataPath}/sobjects/${encodeURIComponent(name)}/describe/`)
      .then((d) => {
        this._describe.set(key, d);
        this._describeErrors.delete(key);
        return d;
      })
      .catch((err) => {
        this._describeErrors.set(key, err);
        throw err;
      })
      .finally(() => this._describePending.delete(key));
    this._describePending.set(key, p);
    return p;
  }

  limits() {
    return this.request('GET', `${this.dataPath}/limits/`);
  }

  // ---------- DML via sObject Collections (allOrNone = false) ----------
  insert(records, { headers, signal } = {}) {
    return this.request('POST', `${this.dataPath}/composite/sobjects`, { body: { allOrNone: false, records }, headers, signal });
  }

  update(records, { headers, signal } = {}) {
    return this.request('PATCH', `${this.dataPath}/composite/sobjects`, { body: { allOrNone: false, records }, headers, signal });
  }

  del(ids, { signal } = {}) {
    const q = `ids=${ids.map(encodeURIComponent).join(',')}&allOrNone=false`;
    return this.request('DELETE', `${this.dataPath}/composite/sobjects?${q}`, { signal });
  }
}

/** Builds Sforce-* request headers for DML from template settings. */
export function dmlHeaders(planSettings = {}) {
  const headers = {};
  if (planSettings.allowDuplicateSave) headers['Sforce-Duplicate-Rule-Header'] = 'allowSave=true';
  if (planSettings.disableAssignmentRules) headers['Sforce-Auto-Assign'] = 'FALSE';
  return headers;
}
