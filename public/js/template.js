// Seeding template: the portable JSON document describing a plan. See docs/TEMPLATE_SCHEMA.md.
import { uid, downloadText, slugify } from './util.js';
import { OPERATORS } from './soql.js';

export const TEMPLATE_FORMAT = 'sf-sandbox-seeding-template';
export const SCHEMA_VERSION = 2; // 1 = plan only; 2 adds the optional "data" block (captured records)
export const DATA_FORMAT = 'records-v1';
const ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export const DEFAULT_PLAN_SETTINGS = Object.freeze({
  matchUsersByUsername: true, // User lookups (OwnerId…) are mapped to the target user with the same Username (sandbox suffixes handled)
  preserveLookupsTo: [], // objects whose Ids are kept verbatim (e.g. "User" between sandboxes of the same production org)
  allowDuplicateSave: true, // Sforce-Duplicate-Rule-Header: allowSave=true (only bypasses "Alert" duplicate rules)
  disableAssignmentRules: true, // Sforce-Auto-Assign: FALSE
  batchSize: 200,
});

export function newPlan(name = 'Untitled seeding plan') {
  const now = new Date().toISOString();
  return {
    name,
    description: '',
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_PLAN_SETTINGS, preserveLookupsTo: [] },
    steps: [],
  };
}

export function newStep(object) {
  return {
    id: uid('step'),
    object,
    enabled: true,
    fieldMode: 'all',
    fields: [],
    filters: [],
    filterLogic: { mode: 'all', expression: '' },
    advancedWhere: '',
    orderBy: { field: '', direction: 'ASC' },
    limit: 100,
    parentScopes: [],
    // Which records the step takes: "query" (filters + LIMIT), "referenced" (exactly the records other
    // steps point to via referencedBy), or "both". referencedBy: [{ stepId, field }] ; stepId may be the
    // step itself for self-lookups (e.g. Account.ParentId), which pulls in the parent hierarchy.
    recordSource: 'query',
    referencedBy: [],
  };
}

export const RECORD_SOURCES = ['query', 'referenced', 'both'];

/** Effective record source: a step with references but mode "query" also takes the references. */
export function effectiveRecordSource(step) {
  const hasRefs = (step.referencedBy || []).length > 0;
  if (!hasRefs) return 'query';
  return step.recordSource === 'referenced' ? 'referenced' : 'both';
}

export function newFilter() {
  return { id: uid('flt'), field: '', operator: 'eq', value: '' };
}

/**
 * Produces the exported document (stable key order, no runtime-only data).
 * With `snapshot`, the captured records are included so the template can run with only a Target org.
 */
export function toTemplate(plan, { snapshot = null } = {}) {
  const doc = {
    format: TEMPLATE_FORMAT,
    schemaVersion: snapshot ? 2 : 1,
    name: plan.name,
    description: plan.description || '',
    createdAt: plan.createdAt,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_PLAN_SETTINGS, ...plan.settings },
    steps: plan.steps.map((s, i) => ({
      id: s.id,
      order: i + 1,
      object: s.object,
      enabled: s.enabled !== false,
      fieldMode: s.fieldMode === 'selected' ? 'selected' : 'all',
      fields: s.fieldMode === 'selected' ? [...(s.fields || [])] : [],
      filters: (s.filters || []).map((f) => ({ field: f.field, operator: f.operator, value: f.value ?? '' })),
      filterLogic: { mode: s.filterLogic?.mode || 'all', expression: s.filterLogic?.expression || '' },
      advancedWhere: s.advancedWhere || '',
      orderBy: s.orderBy && s.orderBy.field ? { field: s.orderBy.field, direction: s.orderBy.direction === 'DESC' ? 'DESC' : 'ASC' } : null,
      limit: s.limit,
      parentScopes: (s.parentScopes || []).map((p) => ({ field: p.field, stepId: p.stepId })),
      recordSource: effectiveRecordSource(s),
      referencedBy: (s.referencedBy || []).map((r) => ({ stepId: r.stepId, field: r.field })),
    })),
  };
  if (snapshot) doc.data = serializeData(snapshot, plan);
  return doc;
}

export function exportTemplate(plan, { snapshot = null } = {}) {
  const doc = toTemplate(plan, { snapshot });
  // Records make the file large; indenting it would roughly double the size.
  const text = snapshot ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
  downloadText(`${slugify(plan.name)}${snapshot ? '.seed-data' : '.seed'}.json`, text);
  return doc;
}

// ---------------------------------------------------------------------------
// Captured data ("data" block): the records a plan extracted, plus the bits of Source metadata the
// insert needs (field describes, Id prefixes, usernames), so a run needs only the Target org.
// ---------------------------------------------------------------------------

function serializeData(snap, plan) {
  const steps = {};
  for (const s of plan.steps) if (snap.steps[s.id]) steps[s.id] = snap.steps[s.id];
  return {
    format: DATA_FORMAT,
    capturedAt: snap.capturedAt,
    source: snap.source,
    total: Object.values(steps).reduce((n, x) => n + x.records.length, 0),
    keyPrefixes: snap.keyPrefixes,
    objects: snap.objects,
    users: snap.users,
    steps,
  };
}

const str = (v, max = 255) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validates an imported "data" block. Step keys are re-pointed with idRemap. Throws when unusable. */
export function parseData(data, idRemap) {
  if (!isObj(data)) throw new Error('"data" must be an object');
  if (data.format !== DATA_FORMAT) throw new Error(`Unknown data format "${data.format}"`);
  if (!isObj(data.objects) || !isObj(data.steps)) throw new Error('"data" is missing "objects" or "steps"');
  const objects = {};
  for (const [name, d] of Object.entries(data.objects)) {
    if (!API_NAME.test(name) || !isObj(d) || !Array.isArray(d.fields)) throw new Error(`"data.objects.${name}" is not a valid object description`);
    objects[name] = {
      name: API_NAME.test(d.name) ? d.name : name,
      label: str(d.label) || name,
      labelPlural: str(d.labelPlural) || str(d.label) || name,
      keyPrefix: typeof d.keyPrefix === 'string' ? d.keyPrefix.slice(0, 3) : null,
      queryable: true,
      createable: d.createable !== false,
      fields: d.fields.filter((f) => isObj(f) && typeof f.name === 'string' && API_NAME.test(f.name)).map((f) => ({
        name: f.name,
        label: str(f.label) || f.name,
        type: str(f.type, 40),
        referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo.filter((r) => typeof r === 'string' && API_NAME.test(r)) : [],
        relationshipName: typeof f.relationshipName === 'string' ? f.relationshipName : null,
        nillable: f.nillable !== false,
        createable: !!f.createable,
        updateable: !!f.updateable,
        defaultedOnCreate: !!f.defaultedOnCreate,
        nameField: !!f.nameField,
        filterable: !!f.filterable,
        sortable: !!f.sortable,
      })),
    };
  }
  const keyPrefixes = {};
  for (const [k, v] of Object.entries(isObj(data.keyPrefixes) ? data.keyPrefixes : {})) {
    if (/^[a-zA-Z0-9]{3}$/.test(k) && typeof v === 'string' && API_NAME.test(v)) keyPrefixes[k] = v;
  }
  const users = {};
  for (const [k, v] of Object.entries(isObj(data.users) ? data.users : {})) {
    if (ID_RE.test(k) && isObj(v)) users[k] = { Username: str(v.Username), Name: str(v.Name), IsActive: v.IsActive !== false };
  }
  const steps = {};
  let total = 0;
  for (const [oldId, entry] of Object.entries(data.steps)) {
    const id = idRemap.get(oldId);
    if (!id || !isObj(entry) || !Array.isArray(entry.records)) continue;
    const records = entry.records.filter((r) => isObj(r) && typeof r.Id === 'string' && ID_RE.test(r.Id));
    steps[id] = { records, stats: isObj(entry.stats) ? entry.stats : {} };
    total += records.length;
  }
  const src = isObj(data.source) ? data.source : {};
  return {
    capturedAt: str(data.capturedAt, 40),
    source: {
      orgId: str(src.orgId, 18),
      orgName: str(src.orgName),
      isSandbox: !!src.isSandbox,
      instanceUrl: str(src.instanceUrl, 300),
      username: str(src.username),
    },
    keyPrefixes,
    objects,
    users,
    steps,
    total,
  };
}

/**
 * Fixes a pair of links that contradict each other on the same lookup, e.g. Contact limited to the
 * children of the Account step (via AccountId) while the Account step also takes "the Accounts those
 * Contacts point to" (via AccountId). Each would have to be extracted before the other.
 * - Account takes only referenced records: keep that, drop the Contact scope (Contacts use their own filters).
 * - Otherwise the reference adds nothing (every scoped Contact already points to an extracted Account): drop it.
 * Returns human-readable messages for what was changed.
 */
export function resolveContradictoryLinks(plan) {
  const messages = [];
  for (const child of plan.steps) {
    for (const sc of [...(child.parentScopes || [])]) {
      const parent = plan.steps.find((s) => s.id === sc.stepId);
      if (!parent || parent.id === child.id) continue;
      const ref = (parent.referencedBy || []).find((r) => r.stepId === child.id && r.field.toLowerCase() === sc.field.toLowerCase());
      if (!ref) continue;
      if (effectiveRecordSource(parent) === 'referenced') {
        child.parentScopes = child.parentScopes.filter((x) => x !== sc);
        messages.push(`Fixed a loop between ${parent.object} and ${child.object}: ${parent.object} takes the ${parent.object} records your ${child.object} records point to, so ${child.object} can no longer also be limited to those ${parent.object} records. ${child.object} now uses its own filters and LIMIT.`);
      } else {
        parent.referencedBy = parent.referencedBy.filter((x) => x !== ref);
        if (!parent.referencedBy.length) parent.recordSource = 'query';
        messages.push(`Fixed a loop between ${parent.object} and ${child.object}: ${child.object} already takes only the ${child.object} records of the selected ${parent.object} records, so the extra link "${parent.object} records that ${child.object} points to" was removed. It added no records.`);
      }
    }
  }
  return messages;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Validates and normalizes an imported template into a plan.
 * Returns { plan, warnings }. Throws on documents that cannot be used at all.
 */
export function parseTemplate(text, { keepIds = false } = {}) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  if (!isObj(doc)) throw new Error('Template must be a JSON object');
  if (doc.format && doc.format !== TEMPLATE_FORMAT) throw new Error(`Unknown template format "${doc.format}"`);
  if (!Array.isArray(doc.steps)) throw new Error('Template is missing a "steps" array');
  if (doc.schemaVersion && doc.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Template schemaVersion ${doc.schemaVersion} is newer than this app supports (${SCHEMA_VERSION})`);
  }
  const warnings = [];
  const plan = newPlan(typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'Imported plan');
  plan.description = typeof doc.description === 'string' ? doc.description : '';
  if (doc.createdAt) plan.createdAt = String(doc.createdAt);

  const s = isObj(doc.settings) ? doc.settings : {};
  plan.settings = {
    matchUsersByUsername: s.matchUsersByUsername !== undefined ? !!s.matchUsersByUsername : DEFAULT_PLAN_SETTINGS.matchUsersByUsername,
    preserveLookupsTo: Array.isArray(s.preserveLookupsTo) ? s.preserveLookupsTo.filter((x) => typeof x === 'string' && API_NAME.test(x)) : [],
    allowDuplicateSave: s.allowDuplicateSave !== undefined ? !!s.allowDuplicateSave : DEFAULT_PLAN_SETTINGS.allowDuplicateSave,
    disableAssignmentRules: s.disableAssignmentRules !== undefined ? !!s.disableAssignmentRules : DEFAULT_PLAN_SETTINGS.disableAssignmentRules,
    batchSize: clampBatch(s.batchSize),
  };

  // Execution order: by "order" when given (stable), steps without one keep their position at the end.
  const orderOf = (st) => (isObj(st) && Number.isFinite(st.order) ? st.order : Infinity);
  const rawSteps = doc.steps
    .map((st, i) => ({ st, i }))
    .sort((a, b) => (orderOf(a.st) - orderOf(b.st)) || (a.i - b.i))
    .map((x) => x.st);

  const idRemap = new Map();
  rawSteps.forEach((raw, idx) => {
    if (!isObj(raw) || typeof raw.object !== 'string' || !API_NAME.test(raw.object)) {
      warnings.push(`Step ${idx + 1} skipped: missing or invalid "object"`);
      return;
    }
    const step = newStep(raw.object);
    const oldId = typeof raw.id === 'string' && raw.id ? raw.id : null;
    if (oldId && keepIds && !idRemap.has(oldId) && /^[A-Za-z0-9_-]{1,64}$/.test(oldId)) step.id = oldId;
    if (oldId && !idRemap.has(oldId)) idRemap.set(oldId, step.id);
    step.enabled = raw.enabled !== false;
    step.fieldMode = raw.fieldMode === 'selected' ? 'selected' : 'all';
    step.fields = Array.isArray(raw.fields) ? [...new Set(raw.fields.filter((f) => typeof f === 'string' && API_NAME.test(f)))] : [];
    if (step.fieldMode === 'selected' && !step.fields.length) {
      warnings.push(`${raw.object}: fieldMode "selected" without fields; switched to all fields`);
      step.fieldMode = 'all';
    }
    step.filters = (Array.isArray(raw.filters) ? raw.filters : [])
      .filter((f) => isObj(f) && typeof f.field === 'string')
      .map((f) => {
        let op = typeof f.operator === 'string' ? f.operator : 'eq';
        if (!OPERATORS[op]) {
          warnings.push(`${raw.object}: unknown operator "${op}" replaced with "equals"`);
          op = 'eq';
        }
        return { id: uid('flt'), field: f.field, operator: op, value: Array.isArray(f.value) ? f.value.join(', ') : (f.value ?? '') };
      });
    const fl = isObj(raw.filterLogic) ? raw.filterLogic : {};
    step.filterLogic = { mode: ['all', 'any', 'custom'].includes(fl.mode) ? fl.mode : 'all', expression: typeof fl.expression === 'string' ? fl.expression : '' };
    step.advancedWhere = typeof raw.advancedWhere === 'string' ? raw.advancedWhere : '';
    if (isObj(raw.orderBy) && typeof raw.orderBy.field === 'string') {
      step.orderBy = { field: raw.orderBy.field, direction: raw.orderBy.direction === 'DESC' ? 'DESC' : 'ASC' };
    }
    const lim = parseInt(raw.limit, 10);
    step.limit = Number.isFinite(lim) && lim > 0 ? lim : 100;
    step.parentScopes = (Array.isArray(raw.parentScopes) ? raw.parentScopes : [])
      .filter((p) => isObj(p) && typeof p.field === 'string' && typeof p.stepId === 'string')
      .map((p) => ({ field: p.field, stepId: p.stepId }));
    step.referencedBy = (Array.isArray(raw.referencedBy) ? raw.referencedBy : [])
      .filter((r) => isObj(r) && typeof r.field === 'string' && API_NAME.test(r.field) && typeof r.stepId === 'string')
      .map((r) => ({ field: r.field, stepId: r.stepId }));
    step.recordSource = RECORD_SOURCES.includes(raw.recordSource) ? raw.recordSource : 'query';
    if (!step.referencedBy.length) step.recordSource = 'query';
    plan.steps.push(step);
  });

  // Re-point parent scopes at the freshly generated step ids.
  for (const step of plan.steps) {
    step.parentScopes = step.parentScopes
      .map((p) => {
        const mapped = idRemap.get(p.stepId);
        if (!mapped) warnings.push(`${step.object}: parent scope on ${p.field} refers to a missing step and was removed`);
        return mapped ? { field: p.field, stepId: mapped } : null;
      })
      .filter(Boolean);
    step.referencedBy = step.referencedBy
      .map((r) => {
        const mapped = idRemap.get(r.stepId);
        if (!mapped) warnings.push(`${step.object}: referenced-by ${r.field} refers to a missing step and was removed`);
        return mapped ? { field: r.field, stepId: mapped } : null;
      })
      .filter(Boolean);
    if (!step.referencedBy.length) step.recordSource = 'query';
  }
  if (!plan.steps.length) warnings.push('Template contains no usable steps');
  let snapshot = null;
  if (doc.data !== undefined && doc.data !== null) {
    try {
      snapshot = parseData(doc.data, idRemap);
    } catch (e) {
      warnings.push(`The captured record data could not be used (${e.message}). The plan was imported without it.`);
    }
  }
  // Only after the data is mapped: fixing links changes what would be extracted, so captured data
  // for a plan with contradictory links would not exist in the first place.
  warnings.push(...resolveContradictoryLinks(plan));
  return { plan, warnings, snapshot };
}

function clampBatch(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DEFAULT_PLAN_SETTINGS.batchSize;
  return Math.min(200, Math.max(1, n));
}

/** Plans are persisted between page loads as drafts in the same shape as templates. */
export function planFromDraft(draft) {
  const res = draftFromStorage(draft);
  return res ? res.plan : null;
}

/** Like planFromDraft, but also returns the messages for links that were repaired. */
export function draftFromStorage(draft) {
  if (!draft) return null;
  try {
    const { plan, warnings } = parseTemplate(draft, { keepIds: true });
    return { plan, warnings: warnings.filter((w) => w.startsWith('Fixed a loop')) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Links between steps. link = { owner, kind: 'scope' | 'reference', other, field }
//   scope:     owner takes only records whose `field` points to a record of step `other` (children of other)
//   reference: owner takes the records that step `other` points to through other.`field` (parents of other);
//              other === owner is a parent hierarchy (e.g. Account.ParentId)
// ---------------------------------------------------------------------------

const sameField = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const nonSelfRefs = (step) => (step.referencedBy || []).filter((r) => r.stepId !== step.id);

export function hasLink(step, link) {
  if (link.kind === 'scope') return (step.parentScopes || []).some((p) => p.stepId === link.other && sameField(p.field, link.field));
  return (step.referencedBy || []).some((r) => r.stepId === link.other && sameField(r.field, link.field));
}

/** All links a step owns, in the order they were added. */
export function linksOf(step) {
  return [
    ...(step.parentScopes || []).map((p) => ({ owner: step.id, kind: 'scope', other: p.stepId, field: p.field })),
    ...(step.referencedBy || []).map((r) => ({ owner: step.id, kind: 'reference', other: r.stepId, field: r.field })),
  ];
}

export function addLink(plan, link) {
  const step = plan.steps.find((s) => s.id === link.owner);
  if (!step || hasLink(step, link)) return step || null;
  if (link.kind === 'scope') {
    step.parentScopes = [...(step.parentScopes || []), { field: link.field, stepId: link.other }];
    return step;
  }
  step.referencedBy = [...(step.referencedBy || []), { stepId: link.other, field: link.field }];
  // The first link to other steps decides the default: only those records, unless the step has its own filters.
  if (link.other !== step.id && nonSelfRefs(step).length === 1 && step.recordSource !== 'both') {
    step.recordSource = (step.filters || []).length || (step.advancedWhere || '').trim() ? 'both' : 'referenced';
  }
  return step;
}

export function removeLink(plan, link) {
  const step = plan.steps.find((s) => s.id === link.owner);
  if (!step) return null;
  if (link.kind === 'scope') {
    step.parentScopes = (step.parentScopes || []).filter((p) => !(p.stepId === link.other && sameField(p.field, link.field)));
  } else {
    step.referencedBy = (step.referencedBy || []).filter((r) => !(r.stepId === link.other && sameField(r.field, link.field)));
    if (!nonSelfRefs(step).length) step.recordSource = 'query';
  }
  return step;
}
