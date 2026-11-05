// Extraction, relationship-aware insertion with in-memory Id mapping, back-fill updates, and rollback.
import { chunk, throwIfAborted, plural, fmtNum } from './util.js';
import { compileQuery, inCondition, clampLimit } from './soql.js';
import { getField, isRequiredOnCreate, qualifyRt } from './schema.js';
import { selfReferenceFields, extractionOrder } from './planner.js';

export { extractionOrder };
import { activeSteps } from './preflight.js';
import { effectiveRecordSource } from './template.js';
import { COLLECTION_MAX, MAX_SOQL_GET_LENGTH, dmlHeaders } from './sfapi.js';

const noop = () => {};

// ============================================================================
// Extraction
// ============================================================================

function keyPrefixOf(describe, ctx) {
  if (describe.keyPrefix) return describe.keyPrefix;
  for (const [prefix, name] of ctx.sourceKeyPrefixes || []) if (name.toLowerCase() === describe.name.toLowerCase()) return prefix;
  return null;
}

/** Ids of this object that other steps' records point to through the step's referencedBy entries. */
export function referencedIds(step, prefix, stepRecords, { includeSelf = false } = {}) {
  const ids = new Set();
  for (const ref of step.referencedBy || []) {
    if (!includeSelf && ref.stepId === step.id) continue;
    if (includeSelf && ref.stepId !== step.id) continue;
    for (const r of stepRecords.get(ref.stepId) || []) {
      const v = r[ref.field];
      if (v && (!prefix || String(v).startsWith(prefix))) ids.add(v);
    }
  }
  return ids;
}

/** Fetches exact records by Id (filters, order and LIMIT of the step do not apply). */
async function fetchByIds(ctx, step, describe, ids) {
  const { source, appSettings, signal } = ctx;
  if (!ids.length) return [];
  const bare = { ...step, filters: [], advancedWhere: '', orderBy: null, parentScopes: [] };
  const baseLen = compileQuery(bare, describe, { limit: 1, maxLimit: appSettings.maxRecordsPerObject }).length;
  const perChunk = Math.max(1, Math.min(500, Math.floor((MAX_SOQL_GET_LENGTH - baseLen - 60) / 21)));
  const out = [];
  for (const part of chunk(ids, perChunk)) {
    throwIfAborted(signal);
    const soql = compileQuery(bare, describe, { limit: part.length, maxLimit: 50000, extraConditions: [inCondition('Id', part)] });
    out.push(...await source.queryAll(soql, { signal, max: part.length }));
  }
  return out;
}

const MAX_HIERARCHY_LEVELS = 10;

/**
 * Pulls source records for every enabled step (see extractionOrder).
 * Records are de-duplicated by Id across steps (first extracted step wins ownership).
 */
export async function extract(ctx) {
  const { source, plan, appSettings, signal } = ctx;
  const log = ctx.log || noop;
  const progress = ctx.progress || noop;
  const steps = activeSteps(plan);
  const { order, cycle } = extractionOrder(steps);
  if (!order) throw new Error(`These steps depend on each other in a loop (scopes / referenced-by): ${cycle.join(', ')}. Remove one of the links.`);
  const extracted = new Map(); // sourceId -> { stepId, object, record }
  const stepSets = new Map(); // stepId -> Set of every Id the step matched (incl. duplicates)
  const stepRecords = new Map(); // stepId -> every record the step matched (incl. duplicates)
  const byStep = new Map(); // stepId -> records owned by the step
  const stats = new Map();
  let total = 0;

  for (let si = 0; si < order.length; si++) {
    const step = order[si];
    throwIfAborted(signal);
    const describe = await source.describe(step.object);
    const limit = clampLimit(step.limit, appSettings.maxRecordsPerObject);
    const mode = effectiveRecordSource(step);
    const prefix = keyPrefixOf(describe, ctx);
    progress({ phase: 'extract', label: `Extracting ${step.object}`, done: si, total: order.length });

    let records = [];
    let byQuery = 0;
    if (mode !== 'referenced') {
      const scopes = (step.parentScopes || []).filter((sc) => stepSets.has(sc.stepId) && getField(describe, sc.field));
      if (!scopes.length) {
        const soql = compileQuery(step, describe, { limit, maxLimit: appSettings.maxRecordsPerObject });
        log('debug', `${step.object}: ${soql}`);
        records = await source.queryAll(soql, { signal, max: limit });
      } else {
        records = await extractScoped(ctx, step, describe, scopes, stepSets, limit);
      }
      byQuery = records.length;
    }

    const have = new Set(records.map((r) => r.Id));
    let byReference = 0;
    let notFound = 0;
    if (mode !== 'query') {
      const want = [...referencedIds(step, prefix, stepRecords)].filter((id) => !have.has(id));
      const got = await fetchByIds(ctx, step, describe, want);
      for (const r of got) if (!have.has(r.Id)) { have.add(r.Id); records.push(r); byReference++; }
      notFound += want.length - got.length;
    }

    // Self-lookups listed in referencedBy (e.g. Account.ParentId): pull missing parents level by level.
    let byHierarchy = 0;
    const selfRefs = (step.referencedBy || []).filter((r) => r.stepId === step.id && getField(describe, r.field));
    const tried = new Set();
    for (let level = 0; selfRefs.length && level < MAX_HIERARCHY_LEVELS; level++) {
      const want = [...referencedIds(step, prefix, new Map([[step.id, records]]), { includeSelf: true })].filter((id) => !have.has(id) && !tried.has(id));
      if (!want.length) break;
      want.forEach((id) => tried.add(id));
      const got = await fetchByIds(ctx, step, describe, want);
      for (const r of got) if (!have.has(r.Id)) { have.add(r.Id); records.push(r); byHierarchy++; }
      notFound += want.length - got.length;
    }

    if (records.length > appSettings.maxRecordsPerObject) {
      log('warn', `${step.object}: ${fmtNum(records.length)} records exceed the ${fmtNum(appSettings.maxRecordsPerObject)} per-object cap; extra referenced records were dropped.`);
      records = records.slice(0, appSettings.maxRecordsPerObject);
    }
    if (notFound) log('warn', `${step.object}: ${plural(notFound, 'referenced record')} could not be read (deleted, or not shared with your Source user).`);

    const set = new Set();
    const owned = [];
    let duplicates = 0;
    for (const r of records) {
      set.add(r.Id);
      if (extracted.has(r.Id)) {
        duplicates++;
        continue;
      }
      extracted.set(r.Id, { stepId: step.id, object: describe.name, record: r });
      owned.push(r);
    }
    stepSets.set(step.id, set);
    stepRecords.set(step.id, records);
    byStep.set(step.id, owned);
    total += owned.length;
    stats.set(step.id, { extracted: owned.length, duplicates, byQuery, byReference, byHierarchy });
    const parts = [];
    if (byReference) parts.push(`${fmtNum(byReference)} referenced by other steps`);
    if (byHierarchy) parts.push(`${fmtNum(byHierarchy)} parent${byHierarchy === 1 ? '' : 's'} in the hierarchy`);
    if (duplicates) parts.push(`${fmtNum(duplicates)} already taken by another step`);
    log('info', `${step.object}: extracted ${plural(owned.length, 'record')}${parts.length ? ` (${parts.join(', ')})` : ''}.`);
  }
  progress({ phase: 'extract', label: 'Extraction complete', done: order.length, total: order.length });
  // `steps` stays in plan (= insert) order.
  return { steps, extracted, stepSets, stepRecords, byStep, stats, total };
}

/** Child records whose lookup points at records already extracted by a parent step. */
async function extractScoped(ctx, step, describe, scopes, stepSets, limit) {
  const { source, appSettings, signal } = ctx;
  const log = ctx.log || noop;
  // Chunk on the scope with the fewest parent Ids; the remaining scopes are AND-ed.
  const sorted = scopes.slice().sort((a, b) => stepSets.get(a.stepId).size - stepSets.get(b.stepId).size);
  const [primary, ...rest] = sorted;
  const primaryIds = [...stepSets.get(primary.stepId)];
  if (!primaryIds.length) {
    log('info', `${step.object}: parent step for ${primary.field} returned no records, so nothing to extract.`);
    return [];
  }
  const primaryField = getField(describe, primary.field).name;
  const restConds = rest.map((sc) => ({ sc, field: getField(describe, sc.field).name, ids: [...stepSets.get(sc.stepId)] }));
  if (restConds.some((rc) => !rc.ids.length)) return [];

  // Push additional scopes into SOQL when they fit, else filter client-side.
  const baseLen = compileQuery(step, describe, { limit, maxLimit: appSettings.maxRecordsPerObject }).length;
  let restSoql = restConds.map((rc) => inCondition(rc.field, rc.ids));
  const restLen = restSoql.reduce((n, s) => n + s.length + 7, 0);
  let clientFilter = false;
  if (baseLen + restLen > MAX_SOQL_GET_LENGTH - 2000) {
    restSoql = [];
    clientFilter = restConds.length > 0;
    if (clientFilter) log('warn', `${step.object}: additional parent scopes are too large for one query and are applied after download; fewer than LIMIT records may be returned.`);
  }
  const budget = MAX_SOQL_GET_LENGTH - baseLen - restSoql.reduce((n, s) => n + s.length + 7, 0) - 40;
  const perChunk = Math.max(1, Math.min(500, Math.floor(budget / 21)));

  const out = [];
  const restSets = restConds.map((rc) => ({ field: rc.field, set: stepSets.get(rc.sc.stepId) }));
  for (const ids of chunk(primaryIds, perChunk)) {
    throwIfAborted(signal);
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const soql = compileQuery(step, describe, {
      limit: remaining,
      maxLimit: appSettings.maxRecordsPerObject,
      extraConditions: [inCondition(primaryField, ids), ...restSoql],
    });
    log('debug', `${step.object}: scoped query on ${primaryField} (${ids.length} parent Ids)`);
    const batch = await source.queryAll(soql, { signal, max: remaining });
    for (const r of batch) {
      if (clientFilter && !restSets.every((rs) => r[rs.field] && rs.set.has(r[rs.field]))) continue;
      out.push(r);
    }
  }
  return out.slice(0, limit);
}

// ============================================================================
// Insertion
// ============================================================================

export function createLoadResult() {
  return {
    idMap: new Map(), // sourceId -> targetId
    failed: new Map(), // sourceId -> message
    created: [], // { stepId, object, sourceId, targetId }
    failures: [], // { stepId, object, sourceId, stage, message }
    stepStats: new Map(), // stepId -> counters
    cleared: new Map(), // "Object.Field" -> { count, reasons:Set }
    deferredCount: 0,
    updated: 0,
    updateFailed: 0,
  };
}

function statsFor(result, step, extracted) {
  if (!result.stepStats.has(step.id)) {
    result.stepStats.set(step.id, { object: step.object, extracted, inserted: 0, failed: 0, skipped: 0, deferred: 0, updated: 0, passes: 0 });
  }
  return result.stepStats.get(step.id);
}

/**
 * Decides what to do with one lookup value.
 * Returns { set } | { defer } | { clear } | { skip }.
 */
export function resolveLookup(value, field, st) {
  if (st.idMap.has(value)) return { set: st.idMap.get(value) };
  if (st.userMap && st.userMap.has(value)) return { set: st.userMap.get(value) };
  const refObj = st.keyPrefixes.get(String(value).slice(0, 3)) || null;
  const inSeed = st.extracted.has(value);
  if (inSeed && !st.failed.has(value)) {
    // Parent will be inserted later in this run (cycle, later step, or deeper hierarchy level).
    if (field.nillable && field.updateable) return { defer: true };
    return { skip: `Required lookup ${field.name} points to a ${refObj || 'record'} that is inserted later; move that step earlier.` };
  }
  if (refObj && st.preserve.has(refObj.toLowerCase())) return { set: value };
  let reason;
  if (refObj === 'User' && st.userMap) reason = 'no active Target user has a matching Username';
  else if (inSeed) reason = 'its parent failed to insert';
  else if (refObj && st.planObjects.has(refObj.toLowerCase())) reason = `the referenced ${refObj} was not extracted`;
  else reason = `${refObj || 'the referenced object'} is not part of the plan`;
  if (isRequiredOnCreate(field)) return { skip: `Required lookup ${field.name} cannot be resolved: ${reason}.` };
  return { clear: reason };
}

/** Builds the insert payload for one source record. */
export function transformRecord(record, objectName, fieldPlan, st) {
  const payload = { attributes: { type: objectName } };
  const deferred = [];
  const cleared = [];
  for (const { src, tgt } of fieldPlan.insertFields) {
    const v = record[src.name];
    if (v === null || v === undefined) continue;
    if (tgt.type === 'reference') {
      const r = resolveLookup(v, tgt, st);
      if (r.set) payload[tgt.name] = r.set;
      else if (r.defer) deferred.push({ field: tgt.name, ref: v });
      else if (r.clear) cleared.push({ field: tgt.name, reason: r.clear });
      else if (r.skip) return { skip: r.skip };
      continue;
    }
    payload[tgt.name] = v;
  }
  if (record.RecordTypeId && record.RecordType) {
    const q = qualifyRt(record.RecordType.NamespacePrefix, record.RecordType.DeveloperName);
    const targetRtId = st.rtResolution.get(`${objectName.toLowerCase()}::${q.toLowerCase()}`);
    if (!targetRtId) return { skip: `Record type "${q}" has no match in the Target org.` };
    payload.RecordTypeId = targetRtId;
  }
  return { payload, deferred, cleared };
}

function isFatal(err) {
  // Unknown batch outcome (network) or auth/limit problems: stop instead of guessing.
  return err && (err.name === 'AbortError' || err.status === 0 || err.status === 401 || err.status === 403
    || err.errorCode === 'REQUEST_LIMIT_EXCEEDED' || err.errorCode === 'PROXY');
}

/**
 * Inserts extracted records into the target.
 * - Steps run in plan order; lookups are rewritten from the Id map.
 * - Self-referencing objects are inserted level by level (roots first).
 * - Lookups to records inserted later are back-filled with updates at the end.
 * `result` is mutated in place so partial progress survives a stop or failure.
 */
export async function load(ctx, extraction, pf, result = createLoadResult()) {
  const { target, plan, signal } = ctx;
  const log = ctx.log || noop;
  const progress = ctx.progress || noop;
  const onCreated = ctx.onCreated || noop;
  const headers = dmlHeaders(plan.settings);
  const batchSize = Math.min(COLLECTION_MAX, Math.max(1, plan.settings.batchSize || COLLECTION_MAX));
  const st = {
    idMap: result.idMap,
    failed: result.failed,
    extracted: extraction.extracted,
    keyPrefixes: ctx.sourceKeyPrefixes,
    preserve: new Set((plan.settings.preserveLookupsTo || []).map((o) => o.toLowerCase())),
    planObjects: new Set(extraction.steps.map((s) => s.object.toLowerCase())),
    rtResolution: pf.rtResolution,
    userMap: pf.userMap || null,
  };
  const deferred = []; // { stepId, object, sourceId, field, ref }
  let processed = 0;
  const report = () => progress({ phase: 'insert', label: 'Inserting records', done: processed, total: extraction.total });

  const fail = (step, sourceId, stage, message) => {
    result.failed.set(sourceId, message);
    result.failures.push({ stepId: step.id, object: step.object, sourceId, stage, message });
  };

  for (const step of extraction.steps) {
    const records = extraction.byStep.get(step.id) || [];
    const stats = statsFor(result, step, records.length);
    if (!records.length) continue;
    const fp = pf.fieldPlans.get(step.id);
    const tDesc = await target.describe(step.object);
    const objectName = tDesc.name;
    const selfFields = selfReferenceFields(step, await ctx.source.describe(step.object)).map((f) => f.name);
    log('info', `${objectName}: inserting ${plural(records.length, 'record')}${selfFields.length ? ` (self-lookup ${selfFields.join(', ')}: parents first)` : ''}.`);

    const resolved = (id) => !id || st.idMap.has(id) || st.failed.has(id) || !st.extracted.has(id);
    let pending = records;
    while (pending.length) {
      throwIfAborted(signal);
      stats.passes++;
      let ready = selfFields.length ? pending.filter((r) => selfFields.every((f) => resolved(r[f]))) : pending;
      if (!ready.length) {
        log('warn', `${objectName}: circular self-references among ${plural(pending.length, 'record')}; inserting them without the parent link and back-filling it afterwards.`);
        ready = pending;
      }
      const readySet = new Set(ready);
      pending = pending.filter((r) => !readySet.has(r));

      const payloads = [];
      const sources = [];
      for (const r of ready) {
        const t = transformRecord(r, objectName, fp, st);
        if (t.skip) {
          fail(step, r.Id, 'skipped', t.skip);
          stats.skipped++;
          processed++;
          continue;
        }
        for (const c of t.cleared) {
          const key = `${objectName}.${c.field}`;
          if (!result.cleared.has(key)) result.cleared.set(key, { count: 0, reasons: new Set() });
          const entry = result.cleared.get(key);
          entry.count++;
          entry.reasons.add(c.reason);
        }
        for (const d of t.deferred) deferred.push({ stepId: step.id, object: objectName, sourceId: r.Id, field: d.field, ref: d.ref });
        stats.deferred += t.deferred.length;
        payloads.push(t.payload);
        sources.push(r);
      }
      report();

      for (let b = 0; b < payloads.length; b += batchSize) {
        throwIfAborted(signal);
        const batch = payloads.slice(b, b + batchSize);
        const batchSources = sources.slice(b, b + batchSize);
        let res;
        try {
          res = await target.insert(batch, { headers, signal });
        } catch (err) {
          if (isFatal(err)) {
            if (err.status === 0) log('error', `${objectName}: lost contact with Salesforce during an insert batch; its outcome is unknown. Check the Target org before re-running.`);
            throw err;
          }
          for (const r of batchSources) fail(step, r.Id, 'insert', err.message);
          stats.failed += batchSources.length;
          processed += batchSources.length;
          log('error', `${objectName}: batch of ${batch.length} rejected: ${err.message}`);
          report();
          continue;
        }
        const created = [];
        res.forEach((item, i) => {
          const src = batchSources[i];
          if (item.success) {
            st.idMap.set(src.Id, item.id);
            const c = { stepId: step.id, object: objectName, sourceId: src.Id, targetId: item.id };
            result.created.push(c);
            created.push(c);
            stats.inserted++;
          } else {
            const msg = (item.errors || []).map((e) => `${e.statusCode}: ${e.message}${e.fields && e.fields.length ? ` [${e.fields.join(', ')}]` : ''}`).join('; ') || 'Unknown error';
            fail(step, src.Id, 'insert', msg);
            stats.failed++;
          }
        });
        processed += batchSources.length;
        onCreated(created);
        report();
      }
    }
    log(stats.failed || stats.skipped ? 'warn' : 'success', `${objectName}: ${fmtNum(stats.inserted)} inserted, ${fmtNum(stats.failed)} failed, ${fmtNum(stats.skipped)} skipped${stats.passes > 1 ? ` in ${stats.passes} passes` : ''}.`);
  }

  for (const [key, entry] of result.cleared) {
    log('warn', `${key} left blank on ${plural(entry.count, 'record')} (${[...entry.reasons].join('; ')}).`);
  }

  result.deferredCount = deferred.length;
  if (deferred.length) await backfill(ctx, deferred, result, headers, batchSize);
  progress({ phase: 'done', label: 'Load complete', done: extraction.total, total: extraction.total });
  return result;
}

/** Second pass: set lookups whose parent was inserted after the child. */
async function backfill(ctx, deferred, result, headers, batchSize) {
  const { target, signal } = ctx;
  const log = ctx.log || noop;
  const progress = ctx.progress || noop;
  const byTarget = new Map(); // targetId -> payload
  const owner = new Map(); // targetId -> deferred entry (for stats/errors)
  let unresolved = 0;
  for (const d of deferred) {
    const childId = result.idMap.get(d.sourceId);
    const parentId = result.idMap.get(d.ref);
    if (!childId) continue; // child failed; nothing to update
    if (!parentId) {
      unresolved++;
      continue;
    }
    if (!byTarget.has(childId)) {
      byTarget.set(childId, { attributes: { type: d.object }, Id: childId });
      owner.set(childId, d);
    }
    byTarget.get(childId)[d.field] = parentId;
  }
  if (unresolved) log('warn', `${plural(unresolved, 'back-filled lookup')} could not be set because the parent record failed to insert.`);
  if (!byTarget.size) return;
  log('info', `Back-filling lookups on ${plural(byTarget.size, 'record')}.`);

  const byObject = new Map();
  for (const p of byTarget.values()) {
    if (!byObject.has(p.attributes.type)) byObject.set(p.attributes.type, []);
    byObject.get(p.attributes.type).push(p);
  }
  let done = 0;
  for (const [object, payloads] of byObject) {
    for (const batch of chunk(payloads, batchSize)) {
      throwIfAborted(signal);
      progress({ phase: 'update', label: `Back-filling ${object} lookups`, done, total: byTarget.size });
      let res;
      try {
        res = await target.update(batch, { headers, signal });
      } catch (err) {
        if (isFatal(err)) throw err;
        result.updateFailed += batch.length;
        for (const p of batch) {
          const d = owner.get(p.Id);
          result.failures.push({ stepId: d.stepId, object, sourceId: d.sourceId, stage: 'update', message: err.message });
        }
        log('error', `${object}: back-fill batch rejected: ${err.message}`);
        continue;
      }
      res.forEach((item, i) => {
        const d = owner.get(batch[i].Id);
        const stats = result.stepStats.get(d.stepId);
        if (item.success) {
          result.updated++;
          if (stats) stats.updated++;
        } else {
          result.updateFailed++;
          const msg = (item.errors || []).map((e) => `${e.statusCode}: ${e.message}`).join('; ');
          result.failures.push({ stepId: d.stepId, object, sourceId: d.sourceId, stage: 'update', message: msg });
        }
      });
      done += batch.length;
    }
  }
  log(result.updateFailed ? 'warn' : 'success', `Back-fill complete: ${fmtNum(result.updated)} updated, ${fmtNum(result.updateFailed)} failed.`);
}

// ============================================================================
// Rollback
// ============================================================================

/** Deletes records created by a run, newest first (children before parents). */
export async function rollback(target, created, { log = noop, progress = noop, signal } = {}) {
  const ids = created.map((c) => c.targetId).reverse();
  let deleted = 0;
  const failures = [];
  const batches = chunk(ids, COLLECTION_MAX);
  for (let i = 0; i < batches.length; i++) {
    throwIfAborted(signal);
    progress({ phase: 'rollback', label: 'Deleting created records', done: deleted + failures.length, total: ids.length });
    const res = await target.del(batches[i], { signal });
    res.forEach((item, j) => {
      const alreadyGone = (item.errors || []).some((e) => e.statusCode === 'ENTITY_IS_DELETED' || e.statusCode === 'INVALID_CROSS_REFERENCE_KEY');
      if (item.success || alreadyGone) deleted++;
      else failures.push({ id: batches[i][j], message: (item.errors || []).map((e) => `${e.statusCode}: ${e.message}`).join('; ') });
    });
  }
  progress({ phase: 'done', label: 'Rollback complete', done: ids.length, total: ids.length });
  log(failures.length ? 'warn' : 'success', `Rollback: ${fmtNum(deleted)} deleted, ${fmtNum(failures.length)} could not be deleted.`);
  return { deleted, failures };
}
