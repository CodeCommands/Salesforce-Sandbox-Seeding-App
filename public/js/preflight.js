// Pre-flight validation. Static checks run before extraction; data checks run on extracted records
// and are what decide whether any insert is attempted.
import {
  fieldMap, getField, hasRecordTypes, isLookup, isOrgSetupLookup, isRequiredOnCreate, qualifyRt, selectedSourceFields, isSeedableField,
} from './schema.js';
import { compileQuery, compileCountQuery, clampLimit } from './soql.js';
import { dependencyEdges, checkOrder, findLoop, describeLink } from './planner.js';
import { effectiveRecordSource } from './template.js';
import { buildUserMap, referencedUserIds, resolveSuffixes } from './users.js';
import { MAX_SOQL_GET_LENGTH } from './sfapi.js';
import { fmtNum, plural } from './util.js';

export class Report {
  constructor() {
    this.items = [];
  }
  add(level, message, stepId = null) {
    this.items.push({ level, message, stepId });
  }
  error(m, s) { this.add('error', m, s); }
  warn(m, s) { this.add('warning', m, s); }
  info(m, s) { this.add('info', m, s); }
  ok(m, s) { this.add('ok', m, s); }
  get errors() { return this.items.filter((i) => i.level === 'error'); }
  get warnings() { return this.items.filter((i) => i.level === 'warning'); }
  get hasErrors() { return this.items.some((i) => i.level === 'error'); }
}

export function activeSteps(plan) {
  return plan.steps.filter((s) => s.enabled !== false);
}

/** Maps each step's chosen source fields onto the target describe. */
export function buildFieldPlan(step, sourceDescribe, targetDescribe, { preserve = new Set() } = {}) {
  const tmap = fieldMap(targetDescribe);
  const insertFields = [];
  const dropped = [];
  const orgDefaulted = []; // lookups to org setup data (Business Hours…): left for the Target org to fill in
  for (const f of selectedSourceFields(step, sourceDescribe)) {
    if (isOrgSetupLookup(f) && !f.referenceTo.some((r) => preserve.has(r.toLowerCase()))) {
      orgDefaulted.push({ name: f.name, referenceTo: f.referenceTo });
      continue;
    }
    const t = tmap.get(f.name.toLowerCase());
    if (!t) dropped.push({ name: f.name, reason: 'does not exist in target (or no field-level access)' });
    else if (!isSeedableField(t)) dropped.push({ name: f.name, reason: 'is not createable in target' });
    else insertFields.push({ name: t.name, src: f, tgt: t });
  }
  return { insertFields, dropped, orgDefaulted, targetHasRecordTypes: hasRecordTypes(targetDescribe) };
}

const preserveSet = (plan) => new Set(((plan.settings && plan.settings.preserveLookupsTo) || []).map((o) => o.toLowerCase()));

async function safeDescribe(client, name) {
  try {
    return { describe: await client.describe(name) };
  } catch (e) {
    return { error: e };
  }
}

async function safeLimits(client) {
  try {
    return await client.limits();
  } catch {
    return null;
  }
}

/** Checks storage and API headroom for an estimated number of records. */
function capacityChecks(report, ctx, totalRecords, targetLimits, sourceLimits, stepsCount, { reportOk = true } = {}) {
  const { appSettings } = ctx;
  if (totalRecords > appSettings.warnTotalRecords) {
    report.warn(`This run would insert about ${fmtNum(totalRecords)} records, above the ${fmtNum(appSettings.warnTotalRecords)} record warning threshold. Sandboxes have limited storage (Developer: 200 MB, Developer Pro: 1 GB).`);
  }
  if (targetLimits && targetLimits.DataStorageMB) {
    const { Max, Remaining } = targetLimits.DataStorageMB;
    const neededMb = (totalRecords * appSettings.estimatedKbPerRecord) / 1024;
    const needed = neededMb < 0.1 ? 'less than 0.1' : `about ${neededMb.toFixed(1)}`;
    const msg = `Target data storage: ${fmtNum(Remaining)} MB free of ${fmtNum(Max)} MB; this run needs ${needed} MB.`;
    if (neededMb > Remaining) report.error(`${msg} Not enough storage; reduce limits before running.`);
    else if (neededMb > Remaining * 0.8) report.warn(`${msg} This would use most of the remaining storage.`);
    else if (reportOk) report.ok(msg);
  }
  const estCalls = {
    source: stepsCount + Math.ceil(totalRecords / 2000) + stepsCount * 2,
    target: Math.ceil(totalRecords / 200) * 2 + stepsCount * 2,
  };
  for (const [role, lim] of [['source', sourceLimits], ['target', targetLimits]]) {
    if (lim && lim.DailyApiRequests) {
      const { Remaining, Max } = lim.DailyApiRequests;
      if (estCalls[role] > Remaining) report.error(`${role === 'source' ? 'Source' : 'Target'} org has ${fmtNum(Remaining)} API requests left today (of ${fmtNum(Max)}); this run needs about ${fmtNum(estCalls[role])}.`);
      else if (Remaining < Max * 0.1) report.warn(`${role === 'source' ? 'Source' : 'Target'} org has only ${fmtNum(Remaining)} of ${fmtNum(Max)} daily API requests left.`);
    }
  }
}

/**
 * Static checks: connections, org safety, schema compatibility, query validity, ordering,
 * parent scopes, preview counts, storage and API headroom. Does not read record data.
 */
export async function staticPreflight(ctx, { withCounts = true } = {}) {
  const report = new Report();
  const { source, target, plan, appSettings, orgs } = ctx;
  const counts = new Map();
  if (!source) report.error('Connect the Source org, or import a template that includes captured record data.');
  if (!target) report.error('Connect a Target org first.');
  if (!source || !target) return { report, counts, total: 0 };
  // Captured data: the records already exist, so only Target-side and ordering checks apply.
  const captured = !!source.isSnapshot;
  if (captured) report.info('Using captured record data: the Source org is not queried.');

  if (orgs.target && orgs.target.IsSandbox === false) {
    if (appSettings.allowProductionTarget) report.warn(`Target "${orgs.target.Name}" is a PRODUCTION org. Production targets are allowed in public/config.json.`);
    else report.error(`Target "${orgs.target.Name}" is a production org. This tool only seeds sandboxes.`);
  }
  if (orgs.source && orgs.target && orgs.source.Id === orgs.target.Id) {
    report.warn('Source and Target are the same org: every selected record will be duplicated.');
  }

  const steps = activeSteps(plan);
  if (!steps.length) {
    report.error('The plan has no enabled steps. Add at least one object on the Build Plan tab.');
    return { report, counts, total: 0 };
  }

  const sd = new Map();
  const td = new Map();
  await Promise.all(steps.map(async (s) => {
    const [a, b] = await Promise.all([safeDescribe(source, s.object), safeDescribe(target, s.object)]);
    if (a.error) report.error(captured ? `${s.object}: not part of the captured data. Connect the Source org, or disable this step.` : `${s.object}: not available in the Source org (${a.error.message}).`, s.id);
    else sd.set(s.id, a.describe);
    if (b.error) report.error(`${s.object}: not available in the Target org (${b.error.message}).`, s.id);
    else td.set(s.id, b.describe);
  }));

  for (const step of steps) {
    const sDesc = sd.get(step.id);
    const tDesc = td.get(step.id);
    if (!sDesc) continue;
    if (!sDesc.queryable) report.error(`${step.object} cannot be queried in the Source org.`, step.id);
    if (tDesc && !tDesc.createable) report.error(`${step.object}: your user cannot create records in the Target org.`, step.id);

    if (step.fieldMode === 'selected') {
      const unknown = (step.fields || []).filter((n) => !getField(sDesc, n));
      if (unknown.length) report.warn(`${step.object}: ${unknown.join(', ')} not found in Source org; ignored.`, step.id);
      const notSeedable = (step.fields || []).map((n) => getField(sDesc, n)).filter((f) => f && !isSeedableField(f));
      if (notSeedable.length) report.warn(`${step.object}: ${notSeedable.map((f) => f.name).join(', ')} cannot be inserted (read-only or unsupported type); ignored.`, step.id);
    }

    if (tDesc) {
      const fp = buildFieldPlan(step, sDesc, tDesc, { preserve: preserveSet(plan) });
      if (fp.orgDefaulted.length) {
        const refs = [...new Set(fp.orgDefaulted.flatMap((f) => f.referenceTo))];
        report.info(`${step.object}: ${fp.orgDefaulted.map((f) => f.name).join(', ')} ${fp.orgDefaulted.length === 1 ? 'is' : 'are'} not copied. ${refs.join(', ')} ${refs.length === 1 ? 'is' : 'are'} set up separately in each org, so the Target org fills ${fp.orgDefaulted.length === 1 ? 'it' : 'them'} in${refs.includes('BusinessHours') ? ' (Business Hours: the Target org\'s default Business Hours)' : ''}. To copy the Ids as-is (only when both orgs share them, such as a sandbox and its production org), add ${refs.join(', ')} under Template settings > Keep Ids as-is.`, step.id);
      }
      if (!fp.insertFields.length) report.error(`${step.object}: none of the selected fields can be inserted in the Target org.`, step.id);
      if (fp.dropped.length) {
        report.warn(`${step.object}: ${plural(fp.dropped.length, 'field')} will be skipped: ${fp.dropped.map((d) => `${d.name} (${d.reason})`).join('; ')}.`, step.id);
      }
      const seeded = new Set([...fp.insertFields, ...fp.orgDefaulted].map((f) => f.name.toLowerCase()));
      const missingRequired = tDesc.fields.filter((f) => isRequiredOnCreate(f) && !seeded.has(f.name.toLowerCase()) && f.name !== 'RecordTypeId');
      if (missingRequired.length) {
        report.warn(`${step.object}: Target requires ${missingRequired.map((f) => f.name).join(', ')}, which ${missingRequired.length === 1 ? 'is' : 'are'} not being copied. Inserts will fail unless a default or automation fills ${missingRequired.length === 1 ? 'it' : 'them'}.`, step.id);
      }
    }

    if (captured) continue;

    // Query validity
    try {
      const soql = compileQuery(step, sDesc, { maxLimit: appSettings.maxRecordsPerObject });
      if (soql.length > MAX_SOQL_GET_LENGTH) report.error(`${step.object}: the query is ${fmtNum(soql.length)} characters, too long for the REST API. Choose fewer fields.`, step.id);
    } catch (e) {
      report.error(`${step.object}: ${e.message}`, step.id);
      continue;
    }
    const lim = parseInt(step.limit, 10);
    if (!Number.isFinite(lim) || lim < 1) report.error(`${step.object}: LIMIT must be a positive number.`, step.id);
    else if (lim > appSettings.maxRecordsPerObject) report.warn(`${step.object}: LIMIT ${fmtNum(lim)} will be capped at ${fmtNum(appSettings.maxRecordsPerObject)} (the per-object maximum).`, step.id);

    // Record type filter values
    for (const flt of step.filters || []) {
      if (flt.field !== 'RecordTypeId' || flt.operator === 'isNull' || flt.operator === 'notNull') continue;
      const values = String(flt.value || '').split(',').map((v) => v.trim()).filter(Boolean);
      for (const v of values) {
        if (!ctx.sourceRt.get(step.object, v)) report.warn(`${step.object}: record type "${v}" used in a filter does not exist in the Source org.`, step.id);
      }
    }

    // Parent scopes
    for (const sc of step.parentScopes || []) {
      const parent = plan.steps.find((p) => p.id === sc.stepId);
      const f = getField(sDesc, sc.field);
      if (!parent) report.error(`${step.object}: parent scope refers to a step that no longer exists.`, step.id);
      else if (parent.enabled === false) report.error(`${step.object}: scoped to ${parent.object}, but that step is disabled.`, step.id);
      if (!f || !isLookup(f)) report.error(`${step.object}: scope field ${sc.field} is not a lookup.`, step.id);
      else if (parent && !f.referenceTo.some((r) => r.toLowerCase() === parent.object.toLowerCase())) report.error(`${step.object}.${f.name} does not reference ${parent.object}.`, step.id);
    }

    // Referenced-by links (records added because other steps point to them)
    for (const ref of step.referencedBy || []) {
      const from = plan.steps.find((p) => p.id === ref.stepId);
      if (!from) { report.error(`${step.object}: "referenced by" points to a step that no longer exists.`, step.id); continue; }
      if (from.enabled === false) { report.warn(`${step.object}: referenced by ${from.object}.${ref.field}, but that step is disabled, so no records come from it.`, step.id); continue; }
      const fromDesc = sd.get(from.id);
      if (!fromDesc) continue;
      const rf = getField(fromDesc, ref.field);
      if (!rf || !isLookup(rf) || !rf.referenceTo.some((r) => r.toLowerCase() === step.object.toLowerCase())) {
        report.error(`${step.object}: ${from.object}.${ref.field} is not a lookup to ${step.object}.`, step.id);
      } else if (!selectedSourceFields(from, fromDesc).some((x) => x.name === rf.name)) {
        report.error(`${step.object}: referenced by ${from.object}.${rf.name}, but that field is not selected in the ${from.object} step. Add it to that step's fields.`, step.id);
      }
    }
  }

  const loop = captured ? null : findLoop(steps);
  if (loop) {
    const objs = [...new Set(loop.stepIds.map((id) => (plan.steps.find((x) => x.id === id) || {}).object))];
    report.error(`${objs.join(' and ')} wait for each other in a loop, so neither can be extracted first: ${loop.links.map((l) => describeLink(l, plan.steps)).join('; and ')}. Remove one of these links on the Build plan tab (it shows a Fix button).`, loop.stepIds[0]);
  }

  // Ordering
  const edges = dependencyEdges(steps, (name) => source.peekDescribe(name));
  const { errors: orderErrors, backfills } = checkOrder(steps, edges);
  for (const e of orderErrors) report.error(e.message, e.child);
  for (const e of backfills) report.info(e.message, e.child);

  // Preview counts
  let total = 0;
  if (withCounts && !report.hasErrors) {
    for (const step of steps) {
      const sDesc = sd.get(step.id);
      if (!sDesc) continue;
      const lim = clampLimit(step.limit, appSettings.maxRecordsPerObject);
      const recordSource = effectiveRecordSource(step);
      if (captured) {
        const data = source.snapshot.steps[step.id];
        const n = data ? data.records.length : 0;
        if (!data) report.warn(`${step.object}: no records were captured for this step (it was disabled or added after capture).`, step.id);
        counts.set(step.id, { count: n, expected: n, scoped: false, referenced: false, captured: true, limit: lim });
        total += n;
        continue;
      }
      if (recordSource === 'referenced') {
        counts.set(step.id, { count: null, expected: 0, scoped: false, referenced: true, limit: lim });
        continue;
      }
      try {
        const count = await source.count(compileCountQuery(step, sDesc), { signal: ctx.signal });
        const scoped = (step.parentScopes || []).length > 0;
        const expected = Math.min(count, lim);
        counts.set(step.id, { count, expected, scoped, referenced: recordSource === 'both', limit: lim });
        total += expected;
      } catch (e) {
        report.error(`${step.object}: count query failed: ${e.message}`, step.id);
      }
    }
    if (counts.size) {
      const vals = [...counts.values()];
      const scopedNote = vals.some((c) => c.scoped) ? ' (upper bound: scoped steps only take children of extracted parents)' : '';
      const refNote = vals.some((c) => c.referenced) ? ', plus the records other steps reference (known after extraction: use Dry run)' : '';
      if (captured) report.ok(`Captured data: ${plural(total, 'record')} across ${plural(counts.size, 'step')}.`);
      else report.ok(`Preview: up to ${plural(total, 'record')} across ${plural(counts.size, 'object step')}${scopedNote}${refNote}.`);
    }
    const [tl, sl] = await Promise.all([safeLimits(target), safeLimits(source)]);
    capacityChecks(report, ctx, total, tl, sl, steps.length);
  }

  if (!report.hasErrors) report.ok('Schema, queries and ordering look good.');
  return { report, counts, total, edges };
}

/**
 * Data checks on extracted records. Builds the Record Type resolution map
 * (source DeveloperName -> target RecordTypeId) and the per-step field plans used for insert.
 */
export async function dataPreflight(ctx, extraction) {
  const report = new Report();
  const { source, target } = ctx;
  const fieldPlans = new Map();
  const rtResolution = new Map();
  const preserve = new Set((ctx.plan.settings.preserveLookupsTo || []).map((o) => o.toLowerCase()));

  for (const step of extraction.steps) {
    const records = extraction.byStep.get(step.id) || [];
    const sDesc = await source.describe(step.object);
    const tDesc = await target.describe(step.object);
    const fp = buildFieldPlan(step, sDesc, tDesc, { preserve });
    fieldPlans.set(step.id, fp);
    if (!records.length) continue;

    // ----- Record types: every DeveloperName used must exist (and be active) in the target -----
    if (hasRecordTypes(sDesc)) {
      const used = new Map();
      let invisible = 0;
      for (const r of records) {
        if (!r.RecordTypeId) continue;
        if (!r.RecordType) {
          invisible++;
          continue;
        }
        const q = qualifyRt(r.RecordType.NamespacePrefix, r.RecordType.DeveloperName);
        used.set(q, (used.get(q) || 0) + 1);
      }
      if (invisible) report.warn(`${step.object}: ${plural(invisible, 'record')} have a record type your Source user cannot read; the target default record type will be used.`, step.id);
      for (const [q, n] of used) {
        const key = `${step.object.toLowerCase()}::${q.toLowerCase()}`;
        if (!fp.targetHasRecordTypes) {
          report.error(`${step.object}: record type "${q}" (${plural(n, 'record')}) is missing in the Target org, which has no record types for ${step.object}.`, step.id);
          continue;
        }
        const res = ctx.targetRt.resolve(step.object, q);
        if (res.ambiguous) {
          report.error(`${step.object}: record type "${q}" matches several target record types in different namespaces (${res.ambiguous.map((r) => qualifyRt(r.NamespacePrefix, r.DeveloperName)).join(', ')}).`, step.id);
        } else if (!res.row) {
          report.error(`${step.object}: record type "${q}" (used by ${plural(n, 'record')}) is missing in the Target org.`, step.id);
        } else if (!res.row.IsActive) {
          report.error(`${step.object}: record type "${q}" exists in the Target org but is inactive (${plural(n, 'record')}).`, step.id);
        } else {
          rtResolution.set(key, res.row.Id);
          if (res.namespaceMismatch) {
            report.warn(`${step.object}: record type "${q}" matched target "${qualifyRt(res.row.NamespacePrefix, res.row.DeveloperName)}" by DeveloperName only (namespace differs).`, step.id);
          }
          const rti = (tDesc.recordTypeInfos || []).find((x) => x.recordTypeId && x.recordTypeId.slice(0, 15) === res.row.Id.slice(0, 15));
          if (rti && rti.available === false) {
            report.warn(`${step.object}: record type "${q}" is not assigned to your Target user's profile; inserts may fail.`, step.id);
          }
        }
      }
      if (used.size && !report.items.some((i) => i.level === 'error' && i.stepId === step.id && i.message.includes('record type'))) {
        report.ok(`${step.object}: all ${plural(used.size, 'record type')} resolved in the Target org.`, step.id);
      }
    }

    // ----- Required lookups that cannot be resolved -----
    for (const { src, tgt } of fp.insertFields) {
      if (!isLookup(tgt) || !isRequiredOnCreate(tgt)) continue;
      let blank = 0;
      let unresolvable = 0;
      for (const r of records) {
        const v = r[src.name];
        if (!v) blank++;
        else if (!extraction.extracted.has(v)) {
          const refObj = ctx.sourceKeyPrefixes.get(String(v).slice(0, 3));
          if (refObj === 'User' && ctx.plan.settings.matchUsersByUsername !== false) continue; // reported by the user check
          if (!refObj || !preserve.has(refObj.toLowerCase())) unresolvable++;
        }
      }
      if (unresolvable) {
        report.warn(`${step.object}: ${plural(unresolvable, 'record')} will be skipped because required lookup ${tgt.name} points to records that are not part of this seed. Add the parent object earlier in the plan, or scope this step to it.`, step.id);
      }
      if (blank) report.warn(`${step.object}: ${plural(blank, 'record')} have a blank required ${tgt.name} and will fail.`, step.id);
    }
  }

  // ----- Users: match by Username -----
  let userMap = null;
  if (ctx.plan.settings.matchUsersByUsername !== false && ctx.userInfo) {
    const ids = referencedUserIds(extraction, fieldPlans);
    if (ids.size) {
      const { sourceInfo, targetInfo } = resolveSuffixes({ ...ctx.userInfo.source }, { ...ctx.userInfo.target });
      try {
        const res = await buildUserMap({ source, target, sourceInfo, targetInfo, signal: ctx.signal }, ids);
        userMap = res.map;
        const how = targetInfo.suffix || sourceInfo.suffix
          ? ` (sandbox suffix ${[sourceInfo.suffix && `".${sourceInfo.suffix}"`, targetInfo.suffix && `".${targetInfo.suffix}"`].filter(Boolean).join(' → ')} handled)`
          : '';
        if (res.matched.length) report.ok(`Users: ${res.matched.length} of ${ids.size} referenced users matched by Username${how}.`);
        if (res.unmatched.length) {
          const list = res.unmatched.slice(0, 8).map((u) => `${u.username || u.sourceId} (${u.reason})`).join('; ');
          report.warn(`Users: ${plural(res.unmatched.length, 'user')} could not be matched: ${list}${res.unmatched.length > 8 ? '; …' : ''}. Their lookups are left blank, so you become the owner.`);
        }
      } catch (e) {
        report.warn(`Users: Username matching failed (${e.message}); user lookups will be left blank.`);
      }
    }
  }

  // Extraction is done, so only the target's headroom matters now.
  const tl = await safeLimits(target);
  capacityChecks(report, ctx, extraction.total, tl, null, extraction.steps.length, { reportOk: false });
  if (!report.hasErrors) report.ok(`Data checks passed for ${plural(extraction.total, 'record')}.`);
  return { report, fieldPlans, rtResolution, userMap };
}
