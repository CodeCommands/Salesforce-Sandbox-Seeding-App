// Tab 2: build the seeding plan (objects, fields, filters, scopes, order).
import { h, clear, fmtNum, plural } from '../util.js';
import { state, emit, planChanged, selectedStep } from '../store.js';
import { newStep, newFilter, DEFAULT_PLAN_SETTINGS, effectiveRecordSource } from '../template.js';
import {
  OPERATORS, operatorsFor, compileQuery, compileCountQuery, splitList, RECORD_TYPE_FIELD,
} from '../soql.js';
import { getField, isLookup, isRequiredOnCreate, isSeedableField, seedableFields, qualifyRt } from '../schema.js';
import { dependencyEdges, suggestOrder, checkOrder } from '../planner.js';
import { MAX_SOQL_GET_LENGTH } from '../sfapi.js';
import { badge, combobox, emptyState, formRow, select, spinner, toast, confirmModal } from './components.js';
import { openRelatedDialog } from './relatedDialog.js';

let refs = null; // { stepsPanel, editorPanel, preview }

const src = () => (state.conn.source.status === 'connected' ? state.conn.source : null);

function objectLabel(name) {
  const s = src();
  const g = s && s.global ? s.global.find((x) => x.name === name) : null;
  return g ? g.label : name;
}

/** Returns the describe if cached; otherwise starts loading it and re-renders when ready. */
function describeOrLoad(object) {
  const s = src();
  if (!s) return { missing: 'nosource' };
  const d = s.client.peekDescribe(object);
  if (d) return { describe: d };
  const err = s.client.describeError(object);
  if (err) return { error: err };
  s.client.describe(object).then(() => emit('plan:describe'), () => emit('plan:describe'));
  return { loading: true };
}

export function renderPlanView(container) {
  const plan = state.plan;
  const stepsPanel = h('aside', { class: 'steps-panel card' });
  const editorPanel = h('div', { class: 'editor-panel' });
  refs = { stepsPanel, editorPanel, preview: null };

  container.appendChild(h('section', { class: 'view plan-view' },
    h('div', { class: 'plan-header card' },
      h('div', { class: 'plan-meta' },
        h('input', {
          class: 'input input-title', type: 'text', value: plan.name, 'aria-label': 'Plan name', maxlength: 120,
          oninput: (e) => { plan.name = e.target.value; planChanged({ render: false }); emit('plan:name'); },
        }),
        h('input', {
          class: 'input', type: 'text', value: plan.description || '', placeholder: 'Description (optional)', 'aria-label': 'Plan description',
          oninput: (e) => { plan.description = e.target.value; planChanged({ render: false }); },
        })),
      planSettings()),
    !src() ? h('div', { class: 'callout callout-info' }, 'Connect the Source org to browse objects and fields. You can still review an imported template.') : null,
    h('div', { class: 'plan-layout' }, stepsPanel, editorPanel)));

  renderStepsPanel();
  renderEditor();
}

/** Re-render pieces without rebuilding the whole view (keeps focus in text inputs). */
export function refreshPlanParts(kind) {
  if (!refs || !refs.stepsPanel.isConnected) return false;
  if (kind === 'silent') {
    renderStepsPanel();
    if (refs.preview) refs.preview();
    return true;
  }
  if (kind === 'describe') {
    renderStepsPanel();
    renderEditor();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plan-level settings
// ---------------------------------------------------------------------------

function planSettings() {
  const ps = state.plan.settings;
  return h('details', { class: 'plan-settings' },
    h('summary', null, 'Template settings'),
    h('div', { class: 'settings-row' },
      formRow('Keep Ids as-is for lookups to', h('input', {
        class: 'input', type: 'text', value: (ps.preserveLookupsTo || []).join(', '), placeholder: 'e.g. User, Pricebook2',
        oninput: (e) => { ps.preserveLookupsTo = splitList(e.target.value).filter((x) => /^[A-Za-z][A-Za-z0-9_]*$/.test(x)); planChanged({ render: false }); },
      }), 'Only when those records have the same Ids in both orgs (e.g. Users in sandboxes of one production org). Other lookups to objects outside the plan are left blank.'),
      formRow('Batch size', h('input', {
        class: 'input input-narrow', type: 'number', min: 1, max: 200, value: ps.batchSize || DEFAULT_PLAN_SETTINGS.batchSize,
        oninput: (e) => { ps.batchSize = Math.min(200, Math.max(1, parseInt(e.target.value, 10) || 200)); planChanged({ render: false }); },
      }), 'Records per sObject Collections request (max 200).'),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: ps.matchUsersByUsername !== false, onchange: (e) => { ps.matchUsersByUsername = e.target.checked; planChanged({ render: false }); } }),
        'Match users by Username (OwnerId and other User lookups point to the same person in the Target; sandbox suffixes such as ".uat" are handled)'),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: !!ps.allowDuplicateSave, onchange: (e) => { ps.allowDuplicateSave = e.target.checked; planChanged({ render: false }); } }),
        'Save despite duplicate-rule alerts (Sforce-Duplicate-Rule-Header)'),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: !!ps.disableAssignmentRules, onchange: (e) => { ps.disableAssignmentRules = e.target.checked; planChanged({ render: false }); } }),
        'Skip lead/case assignment rules (Sforce-Auto-Assign: FALSE)')));
}

// ---------------------------------------------------------------------------
// Steps panel (execution order)
// ---------------------------------------------------------------------------

function orderAnalysis() {
  const s = src();
  if (!s) return null;
  const steps = state.plan.steps.filter((st) => st.enabled !== false && !s.client.describeError(st.object));
  let missing = false;
  for (const st of steps) {
    if (!s.client.peekDescribe(st.object)) {
      describeOrLoad(st.object); // re-renders when loaded
      missing = true;
    }
  }
  if (missing) return null;
  const edges = dependencyEdges(steps, (n) => s.client.peekDescribe(n));
  return { edges, ...checkOrder(steps, edges) };
}

function renderStepsPanel() {
  const panel = clear(refs.stepsPanel);
  const plan = state.plan;
  const s = src();

  panel.appendChild(h('div', { class: 'panel-title' },
    h('h2', null, 'Execution order'),
    h('div', { class: 'inline-actions' },
      plan.steps.length > 1 ? h('button', { class: 'btn btn-small', onclick: autoOrder, disabled: !s, title: 'Sort so parents are inserted before children' }, 'Auto-order') : null)));
  if (plan.steps.length) {
    panel.appendChild(h('button', {
      class: 'btn btn-small btn-block', disabled: !s, onclick: () => openRelatedDialog(),
      title: 'Scan the records this plan selects for lookups to records that are not in the plan',
    }, 'Find related records…'));
  }

  if (s && s.seedable) {
    const used = new Set(plan.steps.map((st) => st.object));
    panel.appendChild(combobox({
      placeholder: '+ Add object (e.g. Account)',
      items: s.seedable.map((g) => ({ value: g.name, label: g.label, sub: `${g.name}${used.has(g.name) ? ' · in plan' : ''}` })),
      onPick: addStep,
    }));
  }

  if (!plan.steps.length) {
    panel.appendChild(h('p', { class: 'muted small pad' }, 'Add the objects to seed. Put parents (e.g. Account) before children (e.g. Contact), or use Auto-order.'));
    return;
  }

  const analysis = orderAnalysis();
  const issuesByStep = new Map();
  if (analysis) {
    for (const e of analysis.errors) issuesByStep.set(e.child, 'error');
    for (const e of analysis.backfills) if (!issuesByStep.has(e.child)) issuesByStep.set(e.child, 'backfill');
  }

  const list = h('ol', { class: 'step-list' });
  plan.steps.forEach((step, idx) => {
    const issue = issuesByStep.get(step.id);
    const meta = [];
    if (effectiveRecordSource(step) !== 'referenced') meta.push(`LIMIT ${fmtNum(parseInt(step.limit, 10) || 0)}`);
    if ((step.filters || []).length) meta.push(plural(step.filters.length, 'filter'));
    if (step.fieldMode === 'selected') meta.push(plural(step.fields.length, 'field'));
    list.appendChild(h('li', {
      class: ['step-item', step.id === state.selectedStepId && 'selected', step.enabled === false && 'disabled'],
      onclick: () => { state.selectedStepId = step.id; emit('plan'); },
    },
      h('span', { class: 'step-num' }, String(idx + 1)),
      h('div', { class: 'step-main' },
        h('div', { class: 'step-name' }, objectLabel(step.object), objectLabel(step.object) !== step.object ? h('span', { class: 'mono muted small' }, ` ${step.object}`) : null),
        h('div', { class: 'step-meta small muted' }, meta.join(' · '),
          (step.parentScopes || []).length ? badge('scoped', 'info', 'Only children of extracted parents') : null,
          effectiveRecordSource(step) !== 'query' ? badge(effectiveRecordSource(step) === 'referenced' ? 'referenced' : '+ referenced', 'info', 'Takes the records other steps point to') : null,
          step.enabled === false ? badge('off', 'neutral') : null,
          issue === 'error' ? badge('order', 'danger', 'A required parent runs after this step') : null,
          issue === 'backfill' ? badge('back-fill', 'warning', 'A lookup parent runs later; it will be set by an update') : null)),
      h('div', { class: 'step-actions', onclick: (e) => e.stopPropagation() },
        h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
        h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: idx === plan.steps.length - 1, onclick: () => move(idx, 1) }, '↓'))));
  });
  panel.appendChild(list);

  if (analysis && analysis.errors.length) {
    panel.appendChild(h('div', { class: 'callout callout-danger small' }, analysis.errors.map((e) => h('div', null, e.message))));
  }
}

function addStep(object) {
  const step = newStep(object);
  const s = src();
  // Suggest a parent scope automatically when an earlier step is a required parent (e.g. Contact -> Account)
  state.plan.steps.push(step);
  state.selectedStepId = step.id;
  planChanged();
  if (s) {
    s.client.describe(object).then((d) => {
      const idx = state.plan.steps.indexOf(step);
      const earlier = state.plan.steps.slice(0, Math.max(0, idx)).filter((p) => p.object !== object && p.enabled !== false);
      const candidates = [];
      for (const f of d.fields) {
        if (!isLookup(f) || !isSeedableField(f) || !f.filterable || f.referenceTo.length !== 1) continue;
        const parent = earlier.find((p) => p.object.toLowerCase() === f.referenceTo[0].toLowerCase());
        if (parent) candidates.push({ field: f, parent });
      }
      // Prefer a required parent (master-detail); otherwise suggest only when the choice is unambiguous.
      const pick = candidates.find((c) => isRequiredOnCreate(c.field)) || (candidates.length === 1 ? candidates[0] : null);
      if (pick && !step.parentScopes.length) {
        step.parentScopes = [{ field: pick.field.name, stepId: pick.parent.id }];
        toast(`${object} is limited to children of the extracted ${pick.parent.object} records (via ${pick.field.name}). Change this under "Related records".`, 'info');
        planChanged();
      }
    }).catch(() => {});
  }
}

function move(idx, delta) {
  const steps = state.plan.steps;
  const j = idx + delta;
  if (j < 0 || j >= steps.length) return;
  [steps[idx], steps[j]] = [steps[j], steps[idx]];
  planChanged();
}

async function autoOrder() {
  const s = src();
  if (!s) return;
  try {
    await Promise.all(state.plan.steps.map((st) => s.client.describe(st.object)));
  } catch (e) {
    toast(`Could not load object details: ${e.message}`, 'error');
    return;
  }
  const steps = state.plan.steps;
  const enabled = steps.filter((st) => st.enabled !== false);
  const edges = dependencyEdges(enabled, (n) => s.client.peekDescribe(n));
  const { order, brokenEdges, requiredCycle } = suggestOrder(steps, edges);
  const pos = new Map(order.map((id, i) => [id, i]));
  const before = steps.map((st) => st.id).join();
  steps.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  planChanged();
  if (requiredCycle.length) toast('Some required lookups form a cycle and cannot be ordered automatically.', 'error');
  else if (brokenEdges.length) toast(`Order updated. ${plural(brokenEdges.length, 'lookup')} in a cycle will be back-filled after insert.`, 'info');
  else toast(before === steps.map((st) => st.id).join() ? 'Order is already correct.' : 'Order updated: parents now run before children.', 'success');
}

// ---------------------------------------------------------------------------
// Step editor
// ---------------------------------------------------------------------------

function renderEditor() {
  const panel = clear(refs.editorPanel);
  refs.preview = null;
  const step = selectedStep();
  if (!step) {
    panel.appendChild(h('div', { class: 'card' }, emptyState('No object selected', state.plan.steps.length ? 'Select a step on the left to edit it.' : 'Add an object to start building your plan.')));
    return;
  }
  const d = describeOrLoad(step.object);

  panel.appendChild(h('div', { class: 'card editor-header' },
    h('div', null,
      h('h2', null, objectLabel(step.object), objectLabel(step.object) !== step.object ? [' ', h('span', { class: 'mono muted' }, step.object)] : null),
      h('p', { class: 'muted small' }, 'Step ', String(state.plan.steps.indexOf(step) + 1), ' of ', String(state.plan.steps.length))),
    h('div', { class: 'editor-header-actions' },
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: step.enabled !== false, onchange: (e) => { step.enabled = e.target.checked; planChanged(); } }),
        'Enabled'),
      h('button', { class: 'btn btn-danger-ghost', onclick: () => removeStep(step) }, 'Remove'))));

  if (d.missing) {
    panel.appendChild(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Connect the Source org to edit fields and filters.'), basicsSection(step, null)));
    return;
  }
  if (d.loading) {
    panel.appendChild(h('div', { class: 'card' }, spinner(`Loading ${step.object} fields…`)));
    return;
  }
  if (d.error) {
    panel.appendChild(h('div', { class: 'card callout callout-danger' }, `Could not describe ${step.object} in the Source org: ${d.error.message}`));
    return;
  }
  const describe = d.describe;
  const sources = sourcesSection(step, describe);
  if (sources) panel.appendChild(h('div', { class: 'card' }, sources));
  if (effectiveRecordSource(step) === 'referenced') {
    panel.appendChild(h('div', { class: 'card' }, h('p', { class: 'muted small' },
      'This step takes exactly the records other steps reference, so LIMIT and filters do not apply (the per-object cap in Settings still does). Choose "Both" above to also take records matching filters.')));
  } else {
    panel.appendChild(h('div', { class: 'card' }, basicsSection(step, describe)));
    panel.appendChild(h('div', { class: 'card' }, filtersSection(step, describe)));
  }
  panel.appendChild(h('div', { class: 'card' }, scopeSection(step, describe)));
  panel.appendChild(h('div', { class: 'card' }, fieldsSection(step, describe)));
  panel.appendChild(h('div', { class: 'card' }, previewSection(step, describe)));
}

async function removeStep(step) {
  const dependents = state.plan.steps.filter((s) => (s.parentScopes || []).some((p) => p.stepId === step.id));
  const ok = await confirmModal({
    title: `Remove ${step.object}?`,
    message: dependents.length ? `${dependents.map((s) => s.object).join(', ')} ${dependents.length === 1 ? 'is' : 'are'} scoped to this step; those scopes will be removed too.` : 'The step and its filters will be removed from the plan.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  for (const s of dependents) s.parentScopes = s.parentScopes.filter((p) => p.stepId !== step.id);
  const idx = state.plan.steps.indexOf(step);
  state.plan.steps.splice(idx, 1);
  const next = state.plan.steps[idx] || state.plan.steps[idx - 1];
  state.selectedStepId = next ? next.id : null;
  planChanged();
}

function section(title, hint, ...body) {
  return [h('div', { class: 'section-title' }, h('h3', null, title), hint ? h('p', { class: 'muted small' }, hint) : null), ...body];
}

// ----- Records to take (query / referenced / both) -----

function referenceCandidates(step) {
  const s = src();
  const out = [];
  if (!s) return out;
  for (const other of state.plan.steps) {
    if (other.enabled === false) continue;
    const d = s.client.peekDescribe(other.object);
    if (!d) continue;
    for (const f of d.fields) {
      if (!isLookup(f) || !f.referenceTo.some((r) => r.toLowerCase() === step.object.toLowerCase())) continue;
      if ((step.referencedBy || []).some((r) => r.stepId === other.id && r.field === f.name)) continue;
      out.push({ stepId: other.id, field: f.name, label: other.id === step.id ? `Parent hierarchy via ${f.label} (${f.name})` : `${other.object}.${f.name} (step ${state.plan.steps.indexOf(other) + 1})` });
    }
  }
  return out;
}

function sourcesSection(step) {
  const refs = step.referencedBy || [];
  const candidates = referenceCandidates(step);
  if (!refs.length && !candidates.length) return null;
  const mode = effectiveRecordSource(step);
  const refItems = refs.map((r, i) => {
    const from = state.plan.steps.find((x) => x.id === r.stepId);
    const text = !from ? `(missing step).${r.field}`
      : from.id === step.id ? `Parent hierarchy: records this step's ${r.field} points to (up to 10 levels)`
        : `Records that ${from.object}.${r.field} points to (step ${state.plan.steps.indexOf(from) + 1})`;
    return h('li', { class: 'ref-item' }, h('span', null, text),
      h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': 'Remove reference', onclick: () => {
        step.referencedBy.splice(i, 1);
        if (!step.referencedBy.length) step.recordSource = 'query';
        planChanged();
      } }, '×'));
  });
  const radio = (value, label, disabled) => h('label', { class: 'check-row' },
    h('input', { type: 'radio', name: `rs-${step.id}`, checked: mode === value, disabled, onchange: () => { step.recordSource = value; planChanged(); } }), label);
  const addSel = candidates.length ? select([{ value: '', label: '+ Add a reference…' }, ...candidates.map((c, i) => ({ value: String(i), label: c.label }))], '', (v) => {
    if (v === '') return;
    const c = candidates[parseInt(v, 10)];
    step.referencedBy = [...refs, { stepId: c.stepId, field: c.field }];
    if (step.recordSource === 'query') step.recordSource = refs.length ? 'both' : (step.filters.length ? 'both' : 'referenced');
    planChanged();
  }, { 'aria-label': 'Add a referenced-by link' }) : null;
  return h('div', null, ...section('Records to take', 'Besides filters, a step can take exactly the records that other steps point to, so their lookups stay connected.',
    h('div', { class: 'radio-row' },
      radio('query', 'Matching filters (LIMIT)', false),
      radio('referenced', 'Only records referenced by other steps', !refs.length),
      radio('both', 'Both', !refs.length)),
    refs.length ? h('ul', { class: 'ref-list' }, refItems) : h('p', { class: 'muted small' }, 'No references yet.'),
    addSel ? h('div', { class: 'ref-add' }, addSel) : null));
}

// ----- Limit and order -----

function basicsSection(step, describe) {
  const max = state.settings.maxRecordsPerObject;
  const limitInput = h('input', {
    class: 'input input-narrow', type: 'number', min: 1, max, value: step.limit,
    oninput: (e) => { step.limit = parseInt(e.target.value, 10) || 0; planChanged({ render: false }); },
  });
  const sortable = describe ? describe.fields.filter((f) => f.sortable).sort((a, b) => a.label.localeCompare(b.label)) : [];
  const ob = step.orderBy || { field: '', direction: 'ASC' };
  return h('div', null, ...section('Records', null,
    h('div', { class: 'inline-fields' },
      formRow('LIMIT (required)', limitInput, `Max ${fmtNum(max)} per object (Settings).`),
      describe ? formRow('Order by', select([{ value: '', label: '— none —' }, ...sortable.map((f) => ({ value: f.name, label: `${f.label} (${f.name})` }))], ob.field, (v) => {
        step.orderBy = { field: v, direction: ob.direction || 'ASC' };
        planChanged();
      })) : null,
      describe && ob.field ? formRow('Direction', select([{ value: 'ASC', label: 'Ascending' }, { value: 'DESC', label: 'Descending' }], ob.direction, (v) => {
        step.orderBy = { ...ob, direction: v };
        planChanged({ render: false });
      })) : null)));
}

// ----- Filters -----

function filterableFields(describe) {
  return describe.fields
    .filter((f) => f.filterable || f.name === RECORD_TYPE_FIELD)
    .sort((a, b) => {
      if (a.name === RECORD_TYPE_FIELD) return -1;
      if (b.name === RECORD_TYPE_FIELD) return 1;
      return a.label.localeCompare(b.label);
    });
}

function filtersSection(step, describe) {
  const fields = filterableFields(describe);
  const fieldOptions = [{ value: '', label: '— choose field —' }, ...fields.map((f) => ({
    value: f.name,
    label: f.name === RECORD_TYPE_FIELD ? 'Record Type (by DeveloperName)' : `${f.label} (${f.name})`,
  }))];
  const rows = (step.filters || []).map((flt, idx) => filterRow(step, describe, flt, idx, fieldOptions));
  const logic = step.filterLogic || { mode: 'all', expression: '' };
  const exprInput = h('input', {
    class: 'input mono', type: 'text', value: logic.expression, placeholder: '1 AND (2 OR 3)',
    oninput: (e) => { step.filterLogic = { ...step.filterLogic, expression: e.target.value }; planChanged({ render: false }); },
  });
  const refOnly = effectiveRecordSource(step) === 'referenced';
  return h('div', null, ...section('Filters', 'Builds the WHERE clause. Record Type filters are stored by DeveloperName so templates work in any org.',
    refOnly ? h('p', { class: 'callout callout-info small' }, 'This step takes exactly the records other steps reference, so filters and LIMIT are not used. Switch "Records to take" to "Both" to add records matching filters as well.') : null,
    rows.length ? h('div', { class: 'filter-rows' }, rows) : h('p', { class: 'muted small' }, 'No filters: the newest/first records up to LIMIT are taken.'),
    h('div', { class: 'filter-footer' },
      h('button', { class: 'btn btn-small', onclick: () => { step.filters.push(newFilter()); planChanged(); } }, '+ Add filter'),
      rows.length > 1 ? h('div', { class: 'logic-row' },
        select([{ value: 'all', label: 'All conditions (AND)' }, { value: 'any', label: 'Any condition (OR)' }, { value: 'custom', label: 'Custom logic' }], logic.mode, (v) => {
          step.filterLogic = { mode: v, expression: logic.expression || (step.filters.map((_, i) => i + 1).join(' AND ')) };
          planChanged();
        }),
        logic.mode === 'custom' ? exprInput : null) : null),
    h('details', { class: 'advanced' },
      h('summary', null, 'Advanced: extra SOQL WHERE condition'),
      h('textarea', {
        class: 'input mono', rows: 2, placeholder: "e.g. CreatedDate = LAST_N_DAYS:90 AND Owner.IsActive = true", value: step.advancedWhere || '',
        oninput: (e) => { step.advancedWhere = e.target.value; planChanged({ render: false }); },
      }),
      h('p', { class: 'hint' }, 'AND-ed with the filters above. Raw SOQL: you are responsible for its syntax.'))));
}

function filterRow(step, describe, flt, idx, fieldOptions) {
  const field = flt.field ? getField(describe, flt.field) : null;
  const ops = operatorsFor(field);
  if (field && !ops.includes(flt.operator)) flt.operator = ops[0];
  const fieldSel = select(fieldOptions, field ? field.name : '', (v) => {
    flt.field = v;
    const f = getField(describe, v);
    flt.operator = operatorsFor(f)[0];
    flt.value = '';
    planChanged();
  }, { 'aria-label': `Filter ${idx + 1} field` });
  const opSel = select(ops.map((o) => ({ value: o, label: OPERATORS[o].label })), flt.operator, (v) => {
    const wasList = OPERATORS[flt.operator] && OPERATORS[flt.operator].list;
    flt.operator = v;
    if (!!OPERATORS[v].list !== !!wasList && !OPERATORS[v].list) flt.value = splitList(flt.value)[0] || '';
    planChanged();
  }, { 'aria-label': `Filter ${idx + 1} operator`, disabled: !field });
  return h('div', { class: 'filter-row' },
    h('span', { class: 'filter-num' }, String(idx + 1)),
    fieldSel,
    opSel,
    valueInput(step, describe, flt, field),
    h('button', { class: 'icon-btn', title: 'Remove filter', 'aria-label': `Remove filter ${idx + 1}`, onclick: () => { step.filters.splice(idx, 1); planChanged(); } }, '×'));
}

function multiSelect(options, values, onChange, label) {
  const set = new Set(values);
  const el = h('select', { class: 'input multi', multiple: true, size: Math.min(5, Math.max(2, options.length)), 'aria-label': label,
    onchange: (e) => onChange([...e.target.selectedOptions].map((o) => o.value)) },
  options.map((o) => h('option', { value: o.value, selected: set.has(o.value) }, o.label)));
  return el;
}

function valueInput(step, describe, flt, field) {
  if (!field) return h('input', { class: 'input', type: 'text', disabled: true, placeholder: 'value' });
  const op = OPERATORS[flt.operator] || OPERATORS.eq;
  if (op.noValue) return h('span', { class: 'muted small value-placeholder' }, '(no value needed)');
  const silent = (v) => { flt.value = v; planChanged({ render: false }); };

  if (field.name === RECORD_TYPE_FIELD) {
    const rts = state.conn.source.rt ? state.conn.source.rt.forObject(step.object) : [];
    const opts = rts.map((r) => {
      const q = qualifyRt(r.NamespacePrefix, r.DeveloperName);
      return { value: q, label: `${r.Name} (${q})${r.IsActive ? '' : ' – inactive'}` };
    });
    const current = splitList(flt.value);
    for (const v of current) if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: `${v} (not in Source org)` });
    if (!opts.length) return h('span', { class: 'muted small value-placeholder' }, 'No record types on this object');
    if (op.list) return multiSelect(opts, current, (vals) => silent(vals.join(', ')), 'Record types');
    return select([{ value: '', label: '— choose record type —' }, ...opts], flt.value, silent, { 'aria-label': 'Record type' });
  }

  if (field.type === 'boolean') return select(['true', 'false'], flt.value || 'true', silent, { 'aria-label': 'Value' });

  if ((field.type === 'picklist' || field.type === 'multipicklist') && field.picklistValues && field.picklistValues.length) {
    const opts = field.picklistValues.filter((p) => p.active).map((p) => ({ value: p.value, label: p.label === p.value ? p.value : `${p.label} (${p.value})` }));
    if (op.list) return multiSelect(opts, splitList(flt.value), (vals) => silent(vals.join(', ')), 'Values');
    return select([{ value: '', label: '— choose —' }, ...opts], flt.value, silent, { 'aria-label': 'Value' });
  }

  const placeholders = {
    date: 'YYYY-MM-DD or LAST_N_DAYS:30',
    datetime: 'YYYY-MM-DD, ISO time, or THIS_YEAR',
    time: 'hh:mm',
    reference: '18-character Id',
    id: '18-character Id',
  };
  return h('input', {
    class: 'input', type: 'text', value: flt.value ?? '', 'aria-label': 'Value', spellcheck: 'false',
    placeholder: op.list ? 'Comma-separated values' : (placeholders[field.type] || 'value'),
    oninput: (e) => silent(e.target.value),
  });
}

// ----- Parent scope -----

function scopeSection(step, describe) {
  const idx = state.plan.steps.indexOf(step);
  const earlier = state.plan.steps.slice(0, idx).filter((p) => p.enabled !== false);
  const candidates = [];
  for (const f of describe.fields) {
    if (!isLookup(f) || !f.filterable) continue;
    for (const p of earlier) {
      if (f.referenceTo.some((r) => r.toLowerCase() === p.object.toLowerCase())) candidates.push({ field: f, parent: p });
    }
  }
  const body = !candidates.length
    ? h('p', { class: 'muted small' }, earlier.length ? `No lookups from ${step.object} to earlier objects in the plan.` : 'This is the first step, so there are no parents to scope to.')
    : h('div', { class: 'check-list' }, candidates.map(({ field, parent }) => {
      const active = (step.parentScopes || []).some((sc) => sc.stepId === parent.id && sc.field.toLowerCase() === field.name.toLowerCase());
      return h('label', { class: 'check-row' },
        h('input', {
          type: 'checkbox', checked: active,
          onchange: (e) => {
            step.parentScopes = (step.parentScopes || []).filter((sc) => !(sc.stepId === parent.id && sc.field.toLowerCase() === field.name.toLowerCase()));
            if (e.target.checked) step.parentScopes.push({ field: field.name, stepId: parent.id });
            planChanged();
          },
        }),
        h('span', null, 'Only ', step.object, ' records whose ', h('strong', null, field.label), h('span', { class: 'mono muted small' }, ` (${field.name})`),
          ' is one of the extracted ', h('strong', null, parent.object), ' records (step ', String(state.plan.steps.indexOf(parent) + 1), ')',
          isRequiredOnCreate(field) ? badge('required', 'warning') : null));
    }));
  return h('div', null, ...section('Related records', 'Scope this step to children of records extracted by earlier steps, so you seed connected data instead of random rows. Multiple scopes are AND-ed.', body,
    h('div', { class: 'inline-actions related-cta' },
      h('button', { class: 'btn btn-small', onclick: () => openRelatedDialog() }, 'Find related records…'),
      h('span', { class: 'small muted' }, 'Checks the selected records for lookups to records that are not in the plan (parents, owners\' accounts, hierarchies…) and offers to add them.'))));
}

// ----- Fields -----

function fieldsSection(step, describe) {
  const all = seedableFields(describe).sort((a, b) => a.label.localeCompare(b.label));
  const mode = step.fieldMode === 'selected' ? 'selected' : 'all';
  const selected = new Set((step.fields || []).map((n) => n.toLowerCase()));
  const planObjects = new Set(state.plan.steps.map((s) => s.object.toLowerCase()));
  const preserve = new Set((state.plan.settings.preserveLookupsTo || []).map((s) => s.toLowerCase()));

  const modeRow = h('div', { class: 'radio-row' },
    h('label', { class: 'check-row' }, h('input', { type: 'radio', name: `fm-${step.id}`, checked: mode === 'all', onchange: () => { step.fieldMode = 'all'; planChanged(); } }),
      `All insertable fields (${all.length})`),
    h('label', { class: 'check-row' }, h('input', {
      type: 'radio', name: `fm-${step.id}`, checked: mode === 'selected',
      onchange: () => {
        step.fieldMode = 'selected';
        if (!step.fields.length) step.fields = all.map((f) => f.name);
        planChanged();
      },
    }), 'Choose fields'));

  const counter = h('span', { class: 'muted small' });
  const updateCounter = () => { counter.textContent = mode === 'selected' ? `${step.fields.length} of ${all.length} selected` : ''; };
  updateCounter();

  if (mode === 'all') {
    return h('div', null, ...section('Fields', 'Only fields that can be set on insert are listed. Formula, system and audit fields are never copied.', modeRow,
      h('p', { class: 'muted small' }, 'Every createable field is copied. Fields missing in the Target org are skipped automatically (shown during validation).')));
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter fields…', 'aria-label': 'Filter fields' });
  const items = all.map((f) => {
    const lookupNote = isLookup(f) ? (() => {
      const inPlan = f.referenceTo.some((r) => planObjects.has(r.toLowerCase()));
      const kept = f.referenceTo.some((r) => preserve.has(r.toLowerCase()));
      const users = f.referenceTo.includes('User') && state.plan.settings.matchUsersByUsername !== false;
      return badge(`→ ${f.referenceTo.join('/')}${users ? ' · by Username' : ''}`, inPlan || users ? 'info' : kept ? 'neutral' : 'warning',
        users ? 'Mapped to the Target user with the same Username' : inPlan ? 'Remapped to the newly inserted parent' : kept ? 'Id kept as-is (template setting)' : 'Not in plan: will be left blank (use Find related records)');
    })() : null;
    const cb = h('input', {
      type: 'checkbox', checked: selected.has(f.name.toLowerCase()),
      onchange: (e) => {
        const set = new Set(step.fields);
        if (e.target.checked) set.add(f.name);
        else set.delete(f.name);
        step.fields = all.map((x) => x.name).filter((n) => set.has(n));
        updateCounter();
        planChanged({ render: false });
      },
    });
    const row = h('label', { class: 'field-item', dataset: { q: `${f.label} ${f.name}`.toLowerCase() } },
      cb,
      h('span', { class: 'field-name' }, f.label, h('span', { class: 'mono muted small' }, ` ${f.name}`)),
      h('span', { class: 'field-badges' }, badge(f.type, 'neutral'), isRequiredOnCreate(f) ? badge('required', 'warning') : null, lookupNote));
    return { row, cb, f };
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const it of items) it.row.hidden = q && !it.row.dataset.q.includes(q);
  });
  const setVisible = (checked) => {
    const set = new Set(step.fields);
    for (const it of items) {
      if (it.row.hidden) continue;
      it.cb.checked = checked || isRequiredOnCreate(it.f);
      if (it.cb.checked) set.add(it.f.name);
      else set.delete(it.f.name);
    }
    step.fields = all.map((x) => x.name).filter((n) => set.has(n));
    updateCounter();
    planChanged({ render: false });
  };
  return h('div', null, ...section('Fields', 'Lookups to objects in the plan are remapped to the new Ids; other lookups are left blank.', modeRow,
    h('div', { class: 'field-toolbar' }, search,
      h('button', { class: 'btn btn-small', onclick: () => setVisible(true) }, 'Select shown'),
      h('button', { class: 'btn btn-small', onclick: () => setVisible(false), title: 'Required fields stay selected' }, 'Clear shown'),
      counter),
    h('div', { class: 'field-list' }, items.map((i) => i.row))));
}

// ----- SOQL preview -----

function previewSection(step, describe) {
  const code = h('pre', { class: 'soql' });
  const note = h('p', { class: 'small' });
  const countOut = h('span', { class: 'small muted' });
  const update = () => {
    note.textContent = '';
    note.className = 'small';
    try {
      const mode = effectiveRecordSource(step);
      const refText = (step.referencedBy || []).map((r) => {
        const from = state.plan.steps.find((x) => x.id === r.stepId);
        return from && from.id === step.id ? `parents via ${r.field}` : `${from ? from.object : '?'}.${r.field}`;
      }).join(', ');
      const bare = { ...step, filters: [], advancedWhere: '', orderBy: null, parentScopes: [] };
      const refQuery = compileQuery(bare, describe, { limit: 1 }).replace(/ LIMIT 1$/, ` WHERE Id IN (Ids referenced by ${refText})`);
      const soql = mode === 'referenced' ? refQuery : compileQuery(step, describe, { maxLimit: state.settings.maxRecordsPerObject });
      code.textContent = mode === 'both' ? `${soql}\n+ ${refQuery}` : soql;
      const scopes = (step.parentScopes || []).map((sc) => {
        const p = state.plan.steps.find((x) => x.id === sc.stepId);
        return `${sc.field} IN (Ids extracted by ${p ? p.object : '?'})`;
      });
      if (scopes.length) {
        note.textContent = `At run time this is also filtered by: ${scopes.join(' AND ')}.`;
        note.className = 'small muted';
      }
      if (soql.length > MAX_SOQL_GET_LENGTH) {
        note.textContent = `Query is ${fmtNum(soql.length)} characters, too long for the REST API. Choose fewer fields.`;
        note.className = 'small danger-text';
      }
    } catch (e) {
      code.textContent = '—';
      note.textContent = e.message;
      note.className = 'small danger-text';
    }
  };
  update();
  refs.preview = update;
  const countBtn = h('button', {
    class: 'btn btn-small',
    onclick: async () => {
      const s = src();
      if (!s) return;
      countOut.textContent = 'Counting…';
      try {
        const n = await s.client.count(compileCountQuery(step, describe));
        const lim = Math.min(parseInt(step.limit, 10) || 0, state.settings.maxRecordsPerObject);
        countOut.textContent = `${fmtNum(n)} matching in Source; ${fmtNum(Math.min(n, lim))} will be taken with LIMIT ${fmtNum(lim)}${(step.parentScopes || []).length ? ' (before parent scoping)' : ''}.`;
      } catch (e) {
        countOut.textContent = e.message;
      }
    },
  }, 'Preview count');
  return h('div', null, ...section('Generated SOQL', null, code, note, h('div', { class: 'inline-actions' }, countBtn, countOut)));
}
