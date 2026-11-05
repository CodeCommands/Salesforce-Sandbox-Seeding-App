// Orchestrates validation, dry runs, seeding runs and rollback; owns state.run and the run log.
import { state, emit, getLastRun, saveLastRun, clearLastRun, runsFromSnapshot } from './store.js';
import { staticPreflight, dataPreflight } from './preflight.js';
import { extract, load, createLoadResult, rollback } from './engine.js';
import { refreshLimits } from './connections.js';
import { orgUserInfo } from './users.js';
import { findMissingReferences, scanPlan } from './discovery.js';
import { SnapshotSource, snapshotExtraction, snapshotKeyPrefixes, captureSnapshot } from './snapshot.js';
import { timestamp, toCsv, downloadText, fileStamp, slugify, fmtNum, plural } from './util.js';

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
    const ok = await confirm({
      total: extraction.total,
      targetName: t ? t.Name : 'Target',
      targetIsSandbox: t ? t.IsSandbox : null,
      steps: extraction.steps.map((s) => ({ object: s.object, count: (extraction.byStep.get(s.id) || []).length })),
      warnings: [...sp.report.warnings, ...dp.report.warnings].length,
    });
    if (!ok) {
      log('info', 'Run cancelled before inserting.');
      return finish('cancelled');
    }

    setLabel('Inserting records');
    run.result = createLoadResult();
    const last = {
      planName: state.plan.name,
      startedAt: run.startedAt,
      targetOrgId: t ? t.Id : '',
      targetOrgName: t ? t.Name : '',
      targetInstance: state.conn.target.session.instanceUrl,
      created: [],
    };
    saveLastRun(last);
    c.onCreated = (created) => {
      for (const x of created) last.created.push({ o: x.object, s: x.sourceId, t: x.targetId });
      saveLastRun(last);
      emit('run');
    };
    await load(c, extraction, dp, run.result);
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

/** Records available for rollback: current run, else the persisted last run for this target org. */
export function rollbackCandidates() {
  if (state.run && state.run.result && state.run.result.created.length) {
    return { source: 'current', created: state.run.result.created };
  }
  const last = getLastRun();
  const t = state.conn.target.org;
  if (last && last.created && last.created.length && t && last.targetOrgId === t.Id) {
    return {
      source: 'stored',
      label: `${last.planName} (${new Date(last.startedAt).toLocaleString()})`,
      created: last.created.map((x) => ({ object: x.o, sourceId: x.s, targetId: x.t })),
    };
  }
  return null;
}

export async function rollbackRun() {
  if (isBusy()) return;
  const cand = rollbackCandidates();
  if (!cand) return;
  const prev = state.run;
  state.run = freshRun('rollback');
  if (prev) {
    state.run.staticReport = prev.staticReport;
    state.run.dataReport = prev.dataReport;
    state.run.extraction = prev.extraction;
    state.run.result = prev.result;
    state.run.counts = prev.counts;
  }
  setLabel('Rolling back');
  log('info', `Deleting ${plural(cand.created.length, 'record')} created by the last run…`);
  try {
    const res = await rollback(state.conn.target.client, cand.created, { log, progress, signal: state.run.abort.signal });
    state.run.rollbackResult = res;
    for (const f of res.failures.slice(0, 50)) log('error', `Could not delete ${f.id}: ${f.message}`);
    if (!res.failures.length) {
      clearLastRun();
      if (state.run.result) state.run.result.created = [];
    }
    finish('done');
  } catch (e) {
    handleFailure(e);
  } finally {
    refreshLimits('target');
  }
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
