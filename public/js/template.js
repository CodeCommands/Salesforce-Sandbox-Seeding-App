// Seeding template: the portable JSON document describing a plan. See docs/TEMPLATE_SCHEMA.md.
import { uid, downloadText, slugify } from './util.js';
import { OPERATORS } from './soql.js';

export const TEMPLATE_FORMAT = 'sf-sandbox-seeding-template';
export const SCHEMA_VERSION = 1;

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

/** Produces the exported document (stable key order, no runtime-only data). */
export function toTemplate(plan) {
  return {
    format: TEMPLATE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
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
}

export function exportTemplate(plan) {
  const doc = toTemplate(plan);
  downloadText(`${slugify(plan.name)}.seed.json`, JSON.stringify(doc, null, 2));
  return doc;
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
  return { plan, warnings };
}

function clampBatch(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DEFAULT_PLAN_SETTINGS.batchSize;
  return Math.min(200, Math.max(1, n));
}

/** Plans are persisted between page loads as drafts in the same shape as templates. */
export function planFromDraft(draft) {
  if (!draft) return null;
  try {
    return parseTemplate(draft, { keepIds: true }).plan;
  } catch {
    return null;
  }
}
