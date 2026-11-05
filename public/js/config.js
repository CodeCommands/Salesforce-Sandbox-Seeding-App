// Safety limits: built-in defaults, optionally overridden for every user of this copy in public/config.json.
// There is no settings screen; per-org sign-in details live in saved orgs (savedOrgs.js).

// Used only if an org's /services/data/ version list cannot be read; otherwise the latest is detected per org.
export const FALLBACK_API_VERSION = '68.0';

export const DEFAULT_SETTINGS = Object.freeze({
  maxRecordsPerObject: 10000, // hard ceiling for any step LIMIT
  warnTotalRecords: 5000, // global warning threshold for one run
  estimatedKbPerRecord: 2, // Salesforce counts most records as 2 KB of data storage
  allowProductionTarget: false,
});

export async function loadConfig() {
  let fileConfig = {};
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) fileConfig = await res.json();
  } catch {
    fileConfig = {};
  }
  return settingsFrom(fileConfig);
}

export function settingsFrom(fileConfig) {
  const merged = { ...DEFAULT_SETTINGS, ...pickKnown(fileConfig) };
  merged.maxRecordsPerObject = clampInt(merged.maxRecordsPerObject, 1, 50000, DEFAULT_SETTINGS.maxRecordsPerObject);
  merged.warnTotalRecords = clampInt(merged.warnTotalRecords, 1, 1000000, DEFAULT_SETTINGS.warnTotalRecords);
  merged.estimatedKbPerRecord = Math.max(1, parseFloat(merged.estimatedKbPerRecord) || DEFAULT_SETTINGS.estimatedKbPerRecord);
  merged.allowProductionTarget = merged.allowProductionTarget === true;
  return merged;
}

export function redirectUri() {
  return `${window.location.origin}/oauth/callback.html`;
}

function pickKnown(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Picks the highest version from a /services/data/ response ([{ version: "68.0", ... }]). */
export function latestApiVersion(versions) {
  const nums = (Array.isArray(versions) ? versions : [])
    .map((v) => parseFloat(v && v.version))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums).toFixed(1) : FALLBACK_API_VERSION;
}
