// Run history: which records each seeding run created, so they can be deleted later, also after the
// browser was closed. Kept in this browser's localStorage, never in the template: a template is shared
// between people and orgs, while created record Ids belong to one Target org.
//
// Each run is linked to the template's permanent templateId and to the Target org Id, so running the
// same template again (also after editing, exporting or re-importing it) finds the earlier runs.
import { storage, uid } from './util.js';

const KEY = 'sfseed.runs';
const LEGACY_KEY = 'sfseed.lastRun'; // single "last run" kept by earlier versions
const MAX_RUNS = 50;

/**
 * run = { id, templateId, templateName, startedAt, finishedAt, status, targetOrgId, targetOrgName,
 *         targetInstance, targetUser, dataFrom ('captured' | 'source'), sourceOrgName, created: [{ o, s, t }] }
 * created: object, Source Id, Target Id (insert order).
 */
export function listRuns() {
  let runs = storage.get('localStorage', KEY, null);
  if (!Array.isArray(runs)) runs = [];
  const legacy = storage.get('localStorage', LEGACY_KEY, null);
  if (legacy && Array.isArray(legacy.created)) {
    if (legacy.created.length) {
      runs.unshift({
        id: uid('run'), templateId: null, templateName: legacy.planName || 'Earlier plan', startedAt: legacy.startedAt, finishedAt: null,
        status: 'done', targetOrgId: legacy.targetOrgId, targetOrgName: legacy.targetOrgName, targetInstance: legacy.targetInstance,
        targetUser: '', dataFrom: '', sourceOrgName: '', created: legacy.created,
      });
    }
    if (write(runs)) storage.remove('localStorage', LEGACY_KEY);
  }
  return runs;
}

function write(runs) {
  return storage.set('localStorage', KEY, runs);
}

/**
 * Inserts or replaces a run (newest first). When the browser storage is full, the oldest other runs
 * are dropped until it fits. Returns { saved, dropped } (dropped: runs that had to be forgotten).
 */
export function saveRun(run) {
  const runs = listRuns().filter((r) => r.id !== run.id);
  runs.unshift(run);
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const dropped = [];
  while (runs.length > MAX_RUNS) dropped.push(runs.pop());
  while (!write(runs)) {
    let i = runs.length - 1; // oldest first, never the run being saved
    while (i >= 0 && runs[i].id === run.id) i--;
    if (i < 0) return { saved: false, dropped };
    dropped.push(...runs.splice(i, 1));
  }
  return { saved: true, dropped };
}

/** Removes deleted records from runs; runs with nothing left are removed from the history. */
export function forgetRecords(runIds, deletedTargetIds) {
  const gone = new Set(deletedTargetIds);
  const ids = new Set(runIds);
  const runs = listRuns()
    .map((r) => (ids.has(r.id) ? { ...r, created: r.created.filter((c) => !gone.has(c.t)) } : r))
    .filter((r) => r.created.length);
  write(runs);
}

export function removeRun(runId) {
  write(listRuns().filter((r) => r.id !== runId));
}

const sameOrg = (a, b) => !!a && !!b && String(a).slice(0, 15) === String(b).slice(0, 15);

/** Runs with records left in the given Target org, split into this template's runs and the others. */
export function runsInOrg(targetOrgId, templateId) {
  const runs = listRuns().filter((r) => sameOrg(r.targetOrgId, targetOrgId) && r.created.length);
  return {
    mine: runs.filter((r) => templateId && r.templateId === templateId),
    others: runs.filter((r) => !templateId || r.templateId !== templateId),
  };
}
