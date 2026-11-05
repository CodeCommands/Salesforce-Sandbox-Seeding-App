// Maps Source users to Target users by Username, so OwnerId and other User lookups keep their owner.
// Sandbox usernames carry a suffix: production "ada@acme.com" is "ada@acme.com.uat" in the "uat"
// sandbox, so matching compares usernames with each org's sandbox suffix removed.
import { chunk } from './util.js';
import { quote } from './soql.js';

const USER_PREFIX = '005';
const CHUNK = 150;

/** Sandbox name from a My Domain host such as "acme--uat.sandbox.my.salesforce.com" -> "uat". */
export function sandboxSuffixFromUrl(instanceUrl) {
  try {
    const host = new URL(instanceUrl).hostname.toLowerCase();
    const m = host.match(/^[a-z0-9-]+?--([a-z0-9]+)\.(?:sandbox\.)?my\.salesforce\.com$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Works out the username suffix of an org: from its My Domain, else by comparing the running users
 * ("ada@acme.com" in production vs "ada@acme.com.uat" in the sandbox -> "uat").
 */
export function orgUsernameSuffix(info, other) {
  if (!info || !info.isSandbox) return null;
  const fromUrl = sandboxSuffixFromUrl(info.instanceUrl);
  if (fromUrl) return fromUrl;
  const mine = (info.username || '').toLowerCase();
  const theirs = (other && other.username ? other.username : '').toLowerCase();
  if (mine && theirs) {
    const theirBase = other.isSandbox && other.suffix && theirs.endsWith(`.${other.suffix}`) ? theirs.slice(0, -(other.suffix.length + 1)) : theirs;
    if (mine.startsWith(`${theirBase}.`)) {
      const rest = mine.slice(theirBase.length + 1);
      if (/^[a-z0-9]+$/.test(rest)) return rest;
    }
  }
  return null;
}

export function baseUsername(username, suffix) {
  const u = String(username || '').toLowerCase();
  return suffix && u.endsWith(`.${suffix}`) ? u.slice(0, -(suffix.length + 1)) : u;
}

/** Candidate target usernames for one source username, best first. */
export function candidateUsernames(sourceUsername, sourceSuffix, targetSuffix) {
  const exact = String(sourceUsername || '').toLowerCase();
  const base = baseUsername(exact, sourceSuffix);
  const out = [];
  if (targetSuffix) out.push(`${base}.${targetSuffix}`);
  out.push(exact);
  out.push(base);
  return [...new Set(out)];
}

/** All Source user Ids referenced by User lookups in the extracted records. */
export function referencedUserIds(extraction, fieldPlans) {
  const ids = new Set();
  for (const step of extraction.steps) {
    const fp = fieldPlans.get(step.id);
    if (!fp) continue;
    const userFields = fp.insertFields.filter((f) => f.tgt.type === 'reference' && (f.tgt.referenceTo || []).includes('User'));
    if (!userFields.length) continue;
    for (const r of extraction.byStep.get(step.id) || []) {
      for (const { src } of userFields) {
        const v = r[src.name];
        if (v && String(v).startsWith(USER_PREFIX)) ids.add(v);
      }
    }
  }
  return ids;
}

/**
 * Builds sourceUserId -> targetUserId. Only active target users are used (inactive users cannot own records).
 * @returns { map, matched: [{ sourceId, username, targetUsername }], unmatched: [{ sourceId, username, reason }] }
 */
export async function buildUserMap({ source, target, sourceInfo, targetInfo, signal }, userIds) {
  const map = new Map();
  const matched = [];
  const unmatched = [];
  if (!userIds.size) return { map, matched, unmatched };

  const srcUsers = [];
  for (const ids of chunk([...userIds], CHUNK)) {
    const recs = await source.queryAll(`SELECT Id, Username, Name, IsActive FROM User WHERE Id IN (${ids.map(quote).join(',')})`, { signal });
    srcUsers.push(...recs);
  }
  const found = new Set(srcUsers.map((u) => u.Id));
  for (const id of userIds) if (!found.has(id)) unmatched.push({ sourceId: id, username: '', reason: 'not visible in the Source org' });

  const sSuffix = sourceInfo.suffix;
  const tSuffix = targetInfo.suffix;
  const candidatesBySource = new Map(srcUsers.map((u) => [u.Id, candidateUsernames(u.Username, sSuffix, tSuffix)]));
  const allCandidates = [...new Set([...candidatesBySource.values()].flat())];
  const targetByUsername = new Map();
  for (const names of chunk(allCandidates, CHUNK)) {
    const recs = await target.queryAll(`SELECT Id, Username, IsActive FROM User WHERE Username IN (${names.map(quote).join(',')})`, { signal });
    for (const r of recs) targetByUsername.set(String(r.Username).toLowerCase(), r);
  }
  for (const u of srcUsers) {
    const cands = candidatesBySource.get(u.Id);
    const hits = cands.map((c) => targetByUsername.get(c)).filter(Boolean);
    const active = hits.find((t) => t.IsActive);
    if (active) {
      map.set(u.Id, active.Id);
      matched.push({ sourceId: u.Id, username: u.Username, targetUsername: active.Username });
    } else {
      unmatched.push({ sourceId: u.Id, username: u.Username, reason: hits.length ? 'inactive in the Target org' : 'no user with this Username in the Target org' });
    }
  }
  return { map, matched, unmatched };
}

/** Describes how the org names its users, for matching. */
export function orgUserInfo(conn) {
  return {
    isSandbox: !!(conn.org && conn.org.IsSandbox),
    instanceUrl: conn.session ? conn.session.instanceUrl : '',
    username: conn.user ? conn.user.Username : '',
    suffix: null,
  };
}

export function resolveSuffixes(sourceInfo, targetInfo) {
  sourceInfo.suffix = orgUsernameSuffix(sourceInfo, targetInfo);
  targetInfo.suffix = orgUsernameSuffix(targetInfo, sourceInfo);
  return { sourceInfo, targetInfo };
}

