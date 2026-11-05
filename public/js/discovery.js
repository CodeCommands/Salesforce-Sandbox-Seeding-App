// "Find related records": scans the records a plan selects, finds lookups that point to records the
// plan does not include, previews those records, and adds them to the plan on request.
import { chunk } from './util.js';
import { quote } from './soql.js';
import { isLookup, isRequiredOnCreate, selectedSourceFields, isCopyableReference, nameFieldOf, getField } from './schema.js';
import { newStep } from './template.js';
import { extract } from './engine.js';
import { extractionOrder } from './planner.js';
import { activeSteps } from './preflight.js';

/**
 * Lookups in extracted records whose targets are not in the seed.
 * @param extraction result of extract()
 * @param env { describeFor(name) -> source describe, globalSobjects, keyPrefixes, plan }
 * @returns findings sorted with required lookups first.
 */
export function findMissingReferences(extraction, { describeFor, globalSobjects, keyPrefixes, plan }) {
  const findings = [];
  for (const step of extraction.steps) {
    const describe = describeFor(step.object);
    if (!describe) continue;
    const records = (extraction.stepRecords && extraction.stepRecords.get(step.id)) || extraction.byStep.get(step.id) || [];
    if (!records.length) continue;
    for (const f of selectedSourceFields(step, describe)) {
      if (!isLookup(f)) continue;
      const groups = new Map(); // refObject -> { populated, ids:Set }
      for (const r of records) {
        const v = r[f.name];
        if (!v) continue;
        const refObject = keyPrefixes.get(String(v).slice(0, 3));
        if (!refObject || !isCopyableReference(refObject, globalSobjects)) continue;
        if (!groups.has(refObject)) groups.set(refObject, { populated: 0, ids: new Set() });
        const g = groups.get(refObject);
        g.populated++;
        g.ids.add(v);
      }
      for (const [refObject, g] of groups) {
        const missingIds = [...g.ids].filter((id) => !extraction.extracted.has(id));
        if (!missingIds.length) continue;
        const selfRef = refObject.toLowerCase() === step.object.toLowerCase();
        findings.push({
          key: `${step.id}|${f.name}|${refObject}`,
          stepId: step.id,
          object: step.object,
          field: f.name,
          fieldLabel: f.label,
          refObject,
          required: isRequiredOnCreate(f),
          selfRef,
          total: records.length,
          populated: g.populated,
          distinct: g.ids.size,
          inSeed: g.ids.size - missingIds.length,
          missingIds,
          options: actionOptions(plan, step, f.name, refObject, selfRef),
        });
      }
    }
  }
  return findings.sort((a, b) => (b.required - a.required) || (b.missingIds.length - a.missingIds.length));
}

/** Ways to add the missing records; the first enabled option is the default. */
export function actionOptions(plan, step, field, refObject, selfRef) {
  const opts = [];
  if (selfRef) {
    opts.push({ value: 'hierarchy', label: `Also pull the missing parent ${refObject} records into this step (follows ${field} up the hierarchy)` });
  }
  const existing = plan.steps.filter((s) => s.enabled !== false && s.object.toLowerCase() === refObject.toLowerCase() && s.id !== step.id);
  for (const s of existing) {
    const n = plan.steps.indexOf(s) + 1;
    const cyc = wouldCycle(plan, s.id, step.id, field);
    opts.push({ value: `existing:${s.id}`, label: `Include them in step ${n} (${s.object})`, disabled: cyc, hint: cyc ? 'Not possible: that step is scoped to this one, which would create a loop' : '' });
  }
  opts.push({ value: 'new', label: `Add a new ${refObject} step with exactly these records` });
  // Preferred default: hierarchy for self-lookups, else an existing step, else a new step.
  const firstUsable = opts.find((o) => !o.disabled);
  return { list: opts, defaultValue: firstUsable ? firstUsable.value : 'new' };
}

function wouldCycle(plan, targetStepId, sourceStepId, field) {
  const steps = activeSteps(plan).map((s) => (s.id === targetStepId
    ? { ...s, referencedBy: [...(s.referencedBy || []), { stepId: sourceStepId, field }] }
    : s));
  return !extractionOrder(steps).order;
}

/**
 * Applies the chosen actions. Several findings pointing at the same object with action "new"
 * share one new step. New steps are placed before the step that references them.
 * @param choices [{ finding, action }]
 * @returns { created: step[], updated: step[] }
 */
export function applyChoices(plan, choices) {
  const created = [];
  const updated = new Set();
  const newByObject = new Map();
  const addRef = (target, ref) => {
    target.referencedBy = target.referencedBy || [];
    if (!target.referencedBy.some((r) => r.stepId === ref.stepId && r.field.toLowerCase() === ref.field.toLowerCase())) target.referencedBy.push(ref);
  };
  for (const { finding, action } of choices) {
    const source = plan.steps.find((s) => s.id === finding.stepId);
    if (!source) continue;
    const ref = { stepId: source.id, field: finding.field };
    if (action === 'hierarchy') {
      addRef(source, ref);
      updated.add(source);
    } else if (action.startsWith('existing:')) {
      const target = plan.steps.find((s) => s.id === action.slice(9));
      if (!target) continue;
      addRef(target, ref);
      if (target.recordSource !== 'referenced') target.recordSource = 'both';
      updated.add(target);
    } else {
      let target = newByObject.get(finding.refObject.toLowerCase());
      if (!target) {
        target = newStep(finding.refObject);
        target.recordSource = 'referenced';
        target.referencedBy = [];
        plan.steps.splice(plan.steps.indexOf(source), 0, target);
        newByObject.set(finding.refObject.toLowerCase(), target);
        created.push(target);
      } else if (plan.steps.indexOf(target) > plan.steps.indexOf(source)) {
        plan.steps.splice(plan.steps.indexOf(target), 1);
        plan.steps.splice(plan.steps.indexOf(source), 0, target);
      }
      addRef(target, ref);
    }
  }
  return { created, updated: [...updated].filter((s) => !created.includes(s)) };
}

/** Runs a read-only extraction of the plan and returns the findings. */
export async function scanPlan(ctx) {
  const extraction = await extract({ ...ctx, log: ctx.log || (() => {}) });
  await Promise.all(extraction.steps.map((s) => ctx.source.describe(s.object)));
  const findings = findMissingReferences(extraction, {
    describeFor: (n) => ctx.source.peekDescribe(n),
    globalSobjects: ctx.sourceGlobal,
    keyPrefixes: ctx.sourceKeyPrefixes,
    plan: ctx.plan,
  });
  return { extraction, findings };
}

/** Loads the Id and name of up to `max` referenced records for display. */
export async function previewRecords(source, object, ids, { max = 200, signal } = {}) {
  const describe = await source.describe(object);
  const nameField = nameFieldOf(describe);
  const fields = ['Id', nameField].filter(Boolean);
  const wanted = ids.slice(0, max);
  const rows = [];
  for (const part of chunk(wanted, 200)) {
    const recs = await source.queryAll(`SELECT ${fields.join(', ')} FROM ${describe.name} WHERE Id IN (${part.map(quote).join(',')})`, { signal });
    rows.push(...recs.map((r) => ({ Id: r.Id, name: nameField ? r[nameField] : '' })));
  }
  return { rows, nameLabel: nameField ? (getField(describe, nameField) || {}).label || nameField : 'Name', requested: wanted.length, notVisible: wanted.length - rows.length, truncated: ids.length > max };
}
