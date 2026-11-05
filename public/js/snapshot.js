// Captured data: a copy of the records a plan extracts, so the plan can later run with only a Target
// org connected. Capturing needs the Source; replaying it does not.
import { chunk, plural } from './util.js';
import { quote } from './soql.js';
import { selectedSourceFields } from './schema.js';
import { effectiveRecordSource, stripEmpty, keptFieldNames } from './template.js';
import { extract } from './engine.js';
import { activeSteps } from './preflight.js';

const DESCRIBE_KEYS = ['name', 'label', 'type', 'referenceTo', 'relationshipName', 'nillable', 'createable', 'updateable', 'defaultedOnCreate', 'nameField', 'filterable', 'sortable'];

/** What decides which records and fields a plan extracts. Order, enabled flags and settings are excluded. */
export function dataSignature(plan) {
  return JSON.stringify(plan.steps.map((s) => [
    s.id, s.object, s.fieldMode, s.fieldMode === 'selected' ? s.fields : [],
    (s.filters || []).map((f) => [f.field, f.operator, f.value]),
    s.filterLogic ? [s.filterLogic.mode, s.filterLogic.expression] : null,
    s.advancedWhere || '', s.orderBy ? [s.orderBy.field, s.orderBy.direction] : null, s.limit,
    s.parentScopes || [], effectiveRecordSource(s), s.referencedBy || [],
  ]));
}

/**
 * The parts of a describe a captured run needs, for the fields in `keep` only (see keptFieldNames)
 * plus Id and the name field. Full describes are large; most fields are never copied.
 */
function trimDescribe(d, keep) {
  const nameField = (d.fields.find((f) => f.nameField) || {}).name;
  return {
    name: d.name,
    label: d.label,
    labelPlural: d.labelPlural || d.label,
    keyPrefix: d.keyPrefix || null,
    queryable: true,
    createable: d.createable !== false,
    fields: d.fields.filter((f) => f.name === 'Id' || f.name === nameField || keep.has(f.name)).map((f) => Object.fromEntries(DESCRIBE_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]))),
  };
}

/**
 * Extracts the plan from the Source (read-only) and returns a snapshot.
 * @param ctx same context as extract() plus { sourceInfo: { orgId, orgName, isSandbox, instanceUrl, username } }
 */
export async function captureSnapshot(ctx) {
  const extraction = await extract(ctx);
  const { source, sourceKeyPrefixes, signal } = ctx;
  const objects = {};
  const keyPrefixes = {};
  const userIds = new Set();
  const steps = {};
  const describes = new Map();
  for (const step of extraction.steps) {
    const d = await source.describe(step.object);
    describes.set(d.name, d);
    if (d.keyPrefix) keyPrefixes[d.keyPrefix] = d.name;
    const refFields = selectedSourceFields(step, d).filter((f) => f.type === 'reference');
    const records = (extraction.byStep.get(step.id) || []).map(stripEmpty);
    for (const r of records) {
      for (const f of refFields) {
        const v = r[f.name];
        if (!v) continue;
        const obj = sourceKeyPrefixes.get(String(v).slice(0, 3));
        if (!obj) continue;
        keyPrefixes[String(v).slice(0, 3)] = obj;
        if (obj === 'User') userIds.add(v);
      }
    }
    steps[step.id] = { records };
  }
  for (const [name, d] of describes) objects[name] = trimDescribe(d, keptFieldNames(ctx.plan, steps, name));
  const users = {};
  for (const ids of chunk([...userIds], 150)) {
    const recs = await source.queryAll(`SELECT Id, Username, Name, IsActive FROM User WHERE Id IN (${ids.map(quote).join(',')})`, { signal });
    for (const u of recs) users[u.Id] = { Username: u.Username, Name: u.Name, IsActive: u.IsActive !== false };
  }
  return {
    capturedAt: new Date().toISOString(),
    source: ctx.sourceInfo,
    keyPrefixes,
    objects,
    users,
    steps,
    total: extraction.total,
    signature: dataSignature(ctx.plan),
  };
}

/** Rebuilds the structure extract() returns from captured records (enabled steps, plan order). */
export function snapshotExtraction(plan, snap) {
  const steps = activeSteps(plan);
  const extracted = new Map();
  const stepSets = new Map();
  const stepRecords = new Map();
  const byStep = new Map();
  const stats = new Map();
  let total = 0;
  for (const step of steps) {
    const records = (snap.steps[step.id] && snap.steps[step.id].records) || [];
    const owned = [];
    for (const r of records) {
      if (extracted.has(r.Id)) continue;
      extracted.set(r.Id, { stepId: step.id, object: step.object, record: r });
      owned.push(r);
    }
    stepSets.set(step.id, new Set(records.map((r) => r.Id)));
    stepRecords.set(step.id, records);
    byStep.set(step.id, owned);
    stats.set(step.id, { extracted: owned.length, duplicates: records.length - owned.length, byQuery: 0, byReference: 0, byHierarchy: 0 });
    total += owned.length;
  }
  return { steps, extracted, stepSets, stepRecords, byStep, stats, total, fromSnapshot: true };
}

export function snapshotRecordCount(snap, step) {
  const data = snap && snap.steps[step.id];
  return data ? data.records.length : 0;
}

export function snapshotSummary(snap) {
  const when = snap.capturedAt ? new Date(snap.capturedAt).toLocaleString() : 'an unknown time';
  return `${plural(snap.total || 0, 'record')} captured from ${snap.source && snap.source.orgName ? snap.source.orgName : 'the Source org'} on ${when}`;
}

/**
 * Stands in for the Source SfClient when a run uses captured data. Answers describes from the
 * snapshot and username lookups for user matching; anything that would query the Source fails.
 */
export class SnapshotSource {
  constructor(snap) {
    this.snapshot = snap;
    this.isSnapshot = true;
    this._d = new Map(Object.values(snap.objects).map((d) => [d.name.toLowerCase(), d]));
  }

  peekDescribe(name) {
    return this._d.get(String(name).toLowerCase());
  }

  describeError(name) {
    return this.peekDescribe(name) ? undefined : new Error(`${name} is not part of the captured data`);
  }

  describe(name) {
    const d = this.peekDescribe(name);
    return d ? Promise.resolve(d) : Promise.reject(new Error(`${name} is not part of the captured data. Connect the Source org to use it.`));
  }

  /** Source users by Id, as captured (used by Username matching). */
  async lookupUsers(ids) {
    return ids.filter((id) => this.snapshot.users[id]).map((id) => ({ Id: id, ...this.snapshot.users[id] }));
  }

  async queryAll() {
    throw new Error('This run uses captured data, so the Source org is not queried. Connect the Source org to extract fresh records.');
  }

  async count() {
    return this.queryAll();
  }

  async limits() {
    return null;
  }
}

/** Id prefix -> object name, as a Map (the shape ctx.sourceKeyPrefixes uses). */
export function snapshotKeyPrefixes(snap) {
  return new Map(Object.entries(snap.keyPrefixes || {}));
}
