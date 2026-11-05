// Orchestrates validation, dry runs, seeding runs and rollback; owns state.run and the run log.
import { state, emit, runsFromSnapshot } from './store.js';
import { listRuns, saveRun, forgetRecords, runsInOrg } from './runHistory.js';
import { staticPreflight, dataPreflight } from './preflight.js';
import { extract, load, createLoadResult, rollback } from './engine.js';
import { refreshLimits } from './connections.js';
import { orgUserInfo } from './users.js';
import { findMissingReferences, scanPlan } from './discovery.js';
import { SnapshotSource, snapshotExtraction, snapshotKeyPrefixes, captureSnapshot, dataSignature } from './snapshot.js';
import { timestamp, toCsv, downloadText, fileStamp, slugify, fmtNum, plural, uid } from './util.js';

const MAX_LOG = 5000;

function freshRun(mode) {
  return {
    mode, // 'validate' | 'dry' | 'run' | 'rollback'
    status: 'running', // running | done | failed | stopped | cancelled | blocked
    label: '',
    progress: null,
    staticReport: null,
    dataReport: null,
    counts: null,
    extraction: null,
    result: null,
    rollbackResult: null,
    related: null, // lookups to records outside the seed (from the last extraction)
    logs: state.run ? state.run.logs : [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    abort: new AbortController(),
  };
}

export function isBusy() {
  return !!(state.run && state.run.status === 'running');
}

export function log(level, message) {
  if (!state.run) state.run = { ...freshRun('validate'), status: 'done' };
  const line = { t: timestamp(), level, message };
  state.run.logs.push(line);
  if (state.run.logs.length > MAX_LOG) state.run.logs.splice(0, state.run.logs.length - MAX_LOG);
  emit('run:log', line);
}

function progress(p) {
  state.run.progress = p;
  emit('run:progress', p);
}

function setLabel(label) {
  state.run.label = label;
  emit('run');
}

function ctx(signal = state.run.abort.signal, { live = false } = {}) {
  const s = state.conn.source;
  const t = state.conn.target;
  if (!live && runsFromSnapshot()) {
    // Captured data stands in for the Source org (which may not be connected at all).
    const snap = state.snapshot;
    return {
      fromSnapshot: true,
      sourceGlobal: [],
      userInfo: { source: { isSandbox: snap.source.isSandbox, instanceUrl: snap.source.instanceUrl, username: snap.source.username, suffix: null }, target: orgUserInfo(t) },
      source: new SnapshotSource(snap),
      target: t.status === 'connected' ? t.client : null,
      orgs: { source: { Id: snap.source.orgId, Name: snap.source.orgName, IsSandbox: snap.source.isSandbox }, target: t.org },
      sourceRt: null,
      targetRt: t.rt,
      sourceKeyPrefixes: snapshotKeyPrefixes(snap),
      plan: state.plan,
      appSettings: state.settings,
      signal,
      log,
      progress,
    };
  }
  return {
    sourceGlobal: s.global || [],
    userInfo: { source: orgUserInfo(s), target: orgUserInfo(t) },
    source: s.status === 'connected' ? s.client : null,
    target: t.status === 'connected' ? t.client : null,
    orgs: { source: s.org, target: t.org },
    sourceRt: s.rt,
    targetRt: t.rt,
    sourceKeyPrefixes: s.keyPrefixes || new Map(),
    plan: state.plan,
    appSettings: state.settings,
    signal,
    log,
    progress,
  };
}

function finish(status) {
  state.run.status = status;
  state.run.finishedAt = new Date().toISOString();
  state.run.progress = null;
  emit('run');
}

function logReport(report, title) {
  const e = report.errors.length;
  const w = report.warnings.length;
  log(e ? 'error' : w ? 'warn' : 'success', `${title}: ${plural(e, 'error')}, ${plural(w, 'warning')}.`);
  for (const item of report.items) {
    if (item.level === 'error') log('error', item.message);
    else if (item.level === 'warning') log('warn', item.message);
  }
}

function handleFailure(err) {
  if (err && err.name === 'AbortError') {
    log('warn', 'Stopped by user. Records inserted so far are listed below and can be rolled back.');
    finish('stopped');
  } else {
    log('error', err && err.message ? err.message : String(err));
    console.error(err);
    finish('failed');
  }
}

/** Validate button: static checks + preview counts. */
export async function validate() {
  if (isBusy()) return;
  state.run = freshRun('validate');
  setLabel('Validating plan');
  log('info', `Validating "${state.plan.name}"…`);
  try {
    const c = ctx();
    const { report, counts } = await staticPreflight(c, { withCounts: true });
    state.run.staticReport = report;
    state.run.counts = counts;
    logReport(report, 'Validation');
    finish(report.hasErrors ? 'blocked' : 'done');
  } catch (e) {
    handleFailure(e);
  }
}

/**
 * Full run (or dry run). The `confirm` callback receives a summary and must resolve true to insert.
 */
export async function execute({ dryRun = false, confirm }) {
  if (isBusy()) return;
  state.run = freshRun(dryRun ? 'dry' : 'run');
  const run = state.run;
  log('info', `${dryRun ? 'Dry run' : 'Seeding run'} started for "${state.plan.name}".`);
  try {
    const c = ctx();
    setLabel('Pre-flight: schema and limits');
    const sp = await staticPreflight(c, { withCounts: true });
    run.staticReport = sp.report;
    run.counts = sp.counts;
    logReport(sp.report, 'Static pre-flight');
    if (sp.report.hasErrors) {
      log('error', 'Run halted before extraction. Fix the errors above and try again.');
      return finish('blocked');
    }

    setLabel(c.fromSnapshot ? 'Loading captured records' : 'Extracting source records');
    const extraction = c.fromSnapshot ? snapshotExtraction(state.plan, state.snapshot) : await extract(c);
    if (c.fromSnapshot) log('info', `Using ${plural(extraction.total, 'captured record')} instead of querying the Source org.`);
    run.extraction = extraction;
    emit('run');

    setLabel('Pre-flight: record types and relationships');
    const dp = await dataPreflight(c, extraction);
    run.dataReport = dp.report;
    run.related = relatedFindings(c, extraction);
    if (run.related.length) {
      const n = run.related.reduce((sum, f) => sum + f.missingIds.length, 0);
      dp.report.info(`${plural(n, 'referenced record')} (${run.related.map((f) => `${f.object}.${f.field} → ${f.refObject}`).slice(0, 4).join(', ')}${run.related.length > 4 ? ', …' : ''}) are not part of this seed, so those lookups will be left blank. Use "Find related records" to add them.`);
    }
    logReport(dp.report, 'Data pre-flight');
    if (dp.report.hasErrors) {
      log('error', 'Run halted: no records were inserted. Fix the issues above (for example create the missing record types in the Target org) and run again.');
      return finish('blocked');
    }
    if (dryRun) {
      log('success', `Dry run complete: ${plural(extraction.total, 'record')} would be inserted. Nothing was written to the Target org.`);
      return finish('done');
    }
    if (!extraction.total) {
      log('warn', 'No records matched; nothing to insert.');
      return finish('done');
    }

    const t = state.conn.target.org;
    const earlier = runsInOrg(t ? t.Id : '', state.plan.templateId).mine;
    const ok = await confirm({
      total: extraction.total,
      targetName: t ? t.Name : 'Target',
      targetIsSandbox: t ? t.IsSandbox : null,
      steps: extraction.steps.map((s) => ({ object: s.object, count: (extraction.byStep.get(s.id) || []).length })),
      warnings: [...sp.report.warnings, ...dp.report.warnings].length,
      earlier: { runs: earlier.length, records: earlier.reduce((n, r) => n + r.created.length, 0) },
    });
    if (!ok) {
      log('info', 'Run cancelled before inserting.');
      return finish('cancelled');
    }

    setLabel('Inserting records');
    run.result = createLoadResult();
    const s = state.conn.source;
    const rec = {
      id: uid('run'),
      templateId: state.plan.templateId,
      templateName: state.plan.name,
      startedAt: run.startedAt,
      finishedAt: null,
      status: 'running',
      targetOrgId: t ? t.Id : '',
      targetOrgName: t ? t.Name : '',
      targetInstance: state.conn.target.session.instanceUrl,
      targetUser: state.conn.target.user ? state.conn.target.user.Username : '',
      dataFrom: c.fromSnapshot ? 'captured' : 'source',
      sourceOrgName: c.fromSnapshot ? state.snapshot.source.orgName : (s.org ? s.org.Name : ''),
      created: [],
    };
    run.historyRec = rec; // saved once the first records exist
    c.onCreated = (created) => {
      for (const x of created) rec.created.push({ o: x.object, s: x.sourceId, t: x.targetId });
      persistRun(rec);
      emit('run');
    };
    try {
      await load(c, extraction, dp, run.result);
    } finally {
      rec.status = run.abort.signal.aborted ? 'stopped' : 'done';
      rec.finishedAt = new Date().toISOString();
      if (rec.created.length) persistRun(rec);
      else forgetRecords([rec.id], []);
    }
    const r = run.result;
    log(r.failures.length ? 'warn' : 'success', `Run finished: ${fmtNum(r.created.length)} inserted, ${fmtNum(r.failures.filter((f) => f.stage !== 'update').length)} not inserted, ${fmtNum(r.updated)} lookups back-filled.`);
    finish('done');
  } catch (e) {
    handleFailure(e);
  } finally {
    refreshLimits('target');
  }
}

export function stop() {
  if (isBusy()) {
    state.run.abort.abort();
    log('warn', 'Stopping after the current request…');
  }
}

let historyWarned = false;
/** Saves a run's record of created Ids in this browser; warns once when it cannot. */
function persistRun(rec) {
  const { saved, dropped } = saveRun(rec);
  for (const d of dropped) log('warn', `Browser storage is full: forgot the run "${d.templateName}" of ${new Date(d.startedAt).toLocaleString()} (${plural(d.created.length, 'record')} in ${d.targetOrgName}). Those records can no longer be deleted from here.`);
  if (!saved && !historyWarned) {
    historyWarned = true;
    log('warn', 'Could not save this run in the browser (storage full). Download the Id map now: the records can be deleted from this page only until it is closed.');
  }
}

/**
 * Runs that created records in the connected Target org: { mine, others }, newest first. "mine" are runs
 * of the current template (same templateId). The current run is included even if it could not be saved.
 */
export function seededRuns() {
  const t = state.conn.target;
  if (t.status !== 'connected' || !t.org) return { mine: [], others: [] };
  const res = runsInOrg(t.org.Id, state.plan.templateId);
  const cur = state.run && state.run.historyRec;
  if (cur && cur.created.length && cur.targetOrgId === t.org.Id && ![...res.mine, ...res.others].some((r) => r.id === cur.id)) {
    (cur.templateId === state.plan.templateId ? res.mine : res.others).unshift(cur);
  }
  return res;
}

/** Deletes the records created by the given runs (newest run first, children before parents). */
export async function deleteSeededRecords(runIds) {
  if (isBusy()) return;
  const all = [...listRuns(), ...(state.run && state.run.historyRec ? [state.run.historyRec] : [])];
  const ids = new Set(runIds);
  const runs = [...new Map(all.filter((r) => ids.has(r.id)).map((r) => [r.id, r])).values()]
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  // rollback() deletes in reverse order: oldest run first here means the newest run is deleted first.
  const created = runs.flatMap((r) => r.created.map((x) => ({ object: x.o, sourceId: x.s, targetId: x.t })));
  if (!created.length) return;
  const prev = state.run;
  state.run = freshRun('rollback');
  if (prev) {
    state.run.staticReport = prev.staticReport;
    state.run.dataReport = prev.dataReport;
    state.run.extraction = prev.extraction;
    state.run.result = prev.result;
    state.run.counts = prev.counts;
  }
  setLabel('Deleting seeded records');
  log('info', `Deleting ${plural(created.length, 'record')} created by ${plural(runs.length, 'earlier run')}…`);
  try {
    const res = await rollback(state.conn.target.client, created, { log, progress, signal: state.run.abort.signal });
    state.run.rollbackResult = res;
    for (const f of res.failures.slice(0, 50)) log('error', `Could not delete ${f.id}: ${f.message}`);
    const failed = new Set(res.failures.map((f) => f.id));
    const deleted = created.map((x) => x.targetId).filter((id) => !failed.has(id));
    forgetRecords(runs.map((r) => r.id), deleted);
    for (const r of runs) if (r === (prev && prev.historyRec)) r.created = r.created.filter((x) => failed.has(x.t));
    if (state.run.result) state.run.result.created = state.run.result.created.filter((x) => failed.has(x.targetId));
    finish('done');
  } catch (e) {
    handleFailure(e);
  } finally {
    refreshLimits('target');
  }
}

/**
 * Read-only extraction of the whole plan from the Source org to count the records each step would take.
 * Stored in state.recordCounts with the plan signature, so the counts show as out of date after edits.
 */
export async function countRecords({ signal } = {}) {
  const s = state.conn.source;
  if (s.status !== 'connected') throw new Error('Connect the Source org to count records.');
  const c = { ...ctx(signal || new AbortController().signal, { live: true }), log: () => {}, progress: () => {} };
  c.target = null;
  const ex = await extract(c);
  state.recordCounts = { signature: dataSignature(state.plan), at: new Date().toISOString(), stats: ex.stats, total: ex.total };
  emit('plan');
  return state.recordCounts;
}

// ---------- Downloads ----------

function base() {
  return `${slugify(state.plan.name)}-${fileStamp()}`;
}

export function downloadIdMap() {
  const r = state.run && state.run.result;
  if (!r) return;
  const rows = r.created.map((c) => ({ object: c.object, sourceId: c.sourceId, targetId: c.targetId }));
  downloadText(`${base()}-id-map.csv`, toCsv(['object', 'sourceId', 'targetId'], rows), 'text/csv');
}

export function downloadFailures() {
  const r = state.run && state.run.result;
  if (!r) return;
  downloadText(`${base()}-errors.csv`, toCsv(['object', 'sourceId', 'stage', 'message'], r.failures), 'text/csv');
}

export function downloadLog() {
  const lines = (state.run ? state.run.logs : []).map((l) => `${l.t} [${l.level.toUpperCase()}] ${l.message}`);
  downloadText(`${base()}-log.txt`, lines.join('\r\n'), 'text/plain');
}

export function clearLog() {
  if (state.run) state.run.logs = [];
  emit('run');
}

// ---------- Related records ----------

function relatedFindings(c, extraction) {
  try {
    return findMissingReferences(extraction, {
      describeFor: (n) => c.source.peekDescribe(n),
      globalSobjects: c.sourceGlobal,
      keyPrefixes: c.sourceKeyPrefixes,
      plan: state.plan,
    });
  } catch (e) {
    console.error(e);
    return [];
  }
}

/**
 * Extracts the plan from the Source org (read-only) and returns captured data for export.
 * Does not touch state.run, so it can run from the export dialog at any time.
 */
export async function captureData({ signal, onProgress } = {}) {
  const s = state.conn.source;
  if (s.status !== 'connected') throw new Error('Connect the Source org to capture records.');
  if (!state.plan.steps.some((x) => x.enabled !== false)) throw new Error('Add at least one object to the plan first.');
  const base = {
    source: s.client,
    plan: state.plan,
    appSettings: state.settings,
    sourceKeyPrefixes: s.keyPrefixes || new Map(),
    signal: signal || new AbortController().signal,
    log: () => {},
    progress: onProgress || (() => {}),
    sourceInfo: {
      orgId: s.org ? s.org.Id : '',
      orgName: s.org ? s.org.Name : '',
      isSandbox: !!(s.org && s.org.IsSandbox),
      instanceUrl: s.session ? s.session.instanceUrl : '',
      username: s.user ? s.user.Username : '',
    },
  };
  return captureSnapshot(base);
}

/**
 * Read-only scan of the Source org for lookups that point outside the plan (used by the
 * "Find related records" dialog). Needs only the Source connection.
 */
export async function scanRelatedRecords({ signal, onProgress } = {}) {
  const s = state.conn.source;
  if (s.status !== 'connected') throw new Error('Connect the Source org first.');
  if (!state.plan.steps.some((x) => x.enabled !== false)) throw new Error('Add at least one object to the plan first.');
  const c = {
    ...ctx(signal || new AbortController().signal, { live: true }),
    log: () => {},
    progress: onProgress || (() => {}),
  };
  c.target = null;
  return scanPlan(c);
}
