// Tab 2: build the seeding plan (objects, fields, filters, scopes, order).
import { h, clear, fmtNum, plural, uuid } from '../util.js';
import { state, emit, planChanged, selectedStep, snapshotState, runsFromSnapshot, setSnapshot } from '../store.js';
import { newFilter, DEFAULT_PLAN_SETTINGS, effectiveRecordSource, addLink, removeLink, linksOf } from '../template.js';
import {
  OPERATORS, operatorsFor, compileQuery, splitList, RECORD_TYPE_FIELD,
} from '../soql.js';
import { getField, isLookup, isRequiredOnCreate, seedableFields, qualifyRt, selectedSourceFields } from '../schema.js';
import { dependencyEdges, suggestOrder, checkOrder, findLoop, wouldLoop } from '../planner.js';
import { SnapshotSource, snapshotSummary, snapshotRecordCount, dataSignature } from '../snapshot.js';
import { countRecords, isBusy } from '../runController.js';
import { MAX_SOQL_GET_LENGTH } from '../sfapi.js';
import { badge, emptyState, formRow, select, spinner, toast, confirmModal } from './components.js';
import { openRelatedDialog } from './relatedDialog.js';
import { openAddObjectDialog, pluralLabel, reorderPlan } from './addObjectDialog.js';
import { captureWithProgress } from './exportDialog.js';

let refs = null; // { stepsPanel, editorPanel, preview }

const src = () => (state.conn.source.status === 'connected' ? state.conn.source : null);

let snapClient = null;
/** Describes come from the live Source when connected, else from captured data (read-only plan). */
function describeClient() {
  const s = src();
  if (s) return s.client;
  const snap = state.snapshot;
  if (!snap) return null;
  if (!snapClient || snapClient.snapshot !== snap) snapClient = new SnapshotSource(snap);
  return snapClient;
}

function objectLabel(name) {
  const s = src();
  const g = s && s.global ? s.global.find((x) => x.name === name) : null;
  if (g) return g.label;
  const c = describeClient();
  const d = c ? c.peekDescribe(name) : null;
  return d ? d.label : name;
}

const stepNo = (step) => state.plan.steps.indexOf(step) + 1;
const stepById = (id) => state.plan.steps.find((x) => x.id === id);
const plural2 = (object) => (src() ? pluralLabel(object) : `${objectLabel(object)} records`);

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
    snapshotBanner(),
    !src() && !state.snapshot ? h('div', { class: 'callout callout-info' }, 'Connect the Source org to add objects and edit fields and filters. You can still review an imported template.') : null,
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
    h('div', { class: 'template-id-row small' },
      h('span', { class: 'muted' }, 'Template ID '), h('code', null, state.plan.templateId || '—'),
      h('span', { class: 'muted' }, ' · stays the same when you edit, export or import this template, so its earlier runs in an org can be found and deleted. '),
      h('button', { class: 'link-btn', onclick: separateCopy }, 'Make a separate copy')),
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

/** Gives the plan a new template ID (and name), so its runs are tracked apart from the original's. */
async function separateCopy() {
  const ok = await confirmModal({
    title: 'Make a separate copy?',
    message: 'The plan gets a new template ID and "(copy)" is added to its name. Runs from now on are tracked under the copy; runs of the original stay with the original template. Use this when you turn an imported template into something different.',
    confirmLabel: 'Make a copy',
  });
  if (!ok) return;
  state.plan.templateId = uuid();
  state.plan.name = `${state.plan.name} (copy)`;
  state.plan.createdAt = new Date().toISOString();
  planChanged();
  toast('This plan is now a separate template.', 'success');
}

// ---------------------------------------------------------------------------
// Steps panel (execution order)
// ---------------------------------------------------------------------------

function orderAnalysis() {
  const c = describeClient();
  if (!c) return null;
  const steps = state.plan.steps.filter((st) => st.enabled !== false && !c.describeError(st.object));
  let missing = false;
  for (const st of steps) {
    if (!c.peekDescribe(st.object)) {
      describeOrLoad(st.object); // re-renders when loaded
      missing = true;
    }
  }
  if (missing) return null;
  const edges = dependencyEdges(steps, (n) => c.peekDescribe(n));
  return { edges, ...checkOrder(steps, edges) };
}

/** Captured data status, shown above the plan. */
function snapshotBanner() {
  const { snap, stale } = snapshotState();
  if (!snap) return null;
  const discard = h('button', {
    class: 'btn btn-small btn-ghost',
    onclick: async () => {
      const ok = await confirmModal({ title: 'Discard captured data?', message: 'The plan stays. Runs will query the Source org again, so it must be connected.', confirmLabel: 'Discard' });
      if (ok) setSnapshot(null);
    },
  }, 'Discard captured data');
  const recapture = src() ? h('button', { class: 'btn btn-small', onclick: () => captureWithProgress() }, stale ? 'Capture again' : 'Re-capture') : null;
  if (stale) {
    return h('div', { class: 'callout callout-warning snapshot-banner' },
      h('div', null, h('strong', null, 'Captured data is out of date. '),
        `The plan's objects, fields, filters or links changed after ${snapshotSummary(snap)}. Runs now query the Source org.`),
      h('div', { class: 'inline-actions' }, recapture, discard));
  }
  if (!src()) {
    return h('div', { class: 'callout callout-info snapshot-banner' },
      h('div', null, h('strong', null, 'This plan includes record data. '),
        `${snapshotSummary(snap)}. Runs insert these records, so only the Target org needs to be connected. Steps are read-only until you connect the Source org; you can still reorder, enable or disable them.`),
      h('div', { class: 'inline-actions' }, discard));
  }
  const pick = (value, label) => h('label', { class: 'check-row' },
    h('input', { type: 'radio', name: 'data-source', checked: state.useSnapshot === value, onchange: () => { state.useSnapshot = value; emit('plan'); } }), label);
  return h('div', { class: 'callout callout-info snapshot-banner' },
    h('div', null, h('strong', null, 'Captured data available. '), `${snapshotSummary(snap)}. Changing objects, fields, filters or links makes it out of date.`,
      h('div', { class: 'radio-row' }, h('span', { class: 'small' }, 'Runs use:'), pick(true, 'the captured records'), pick(false, 'fresh records from the Source org'))),
    h('div', { class: 'inline-actions' }, recapture, discard));
}

function renderStepsPanel() {
  const panel = clear(refs.stepsPanel);
  const plan = state.plan;
  const s = src();
  const canOrder = !!describeClient();

  panel.appendChild(h('div', { class: 'panel-title' },
    h('h2', null, 'Execution order'),
    h('div', { class: 'inline-actions' },
      plan.steps.length > 1 ? h('button', { class: 'btn btn-small', onclick: autoOrder, disabled: !canOrder, title: 'Sort so parents are inserted before children' }, 'Auto-order') : null)));
  panel.appendChild(h('button', {
    class: 'btn btn-primary btn-block', disabled: !s, onclick: () => openAddObjectDialog(),
    title: s ? 'Choose an object to copy and how its records are picked' : 'Connect the Source org to add objects',
  }, '+ Add object'));
  if (plan.steps.length) {
    panel.appendChild(h('button', {
      class: 'btn btn-small btn-block', disabled: !s, onclick: () => openRelatedDialog(),
      title: 'Scan the records this plan selects for lookups to records that are not in the plan',
    }, 'Find related records…'));
  }

  if (!plan.steps.length) {
    panel.appendChild(h('p', { class: 'muted small pad' }, 'Start with the top-level object (for example Account), then add the objects that belong to it (Contact, Opportunity…). The app asks how each one is linked and keeps parents before children.'));
    return;
  }

  const analysis = orderAnalysis();
  const loop = findLoop(plan.steps.filter((st) => st.enabled !== false));
  const issuesByStep = new Map();
  if (analysis) {
    for (const e of analysis.errors) issuesByStep.set(e.child, 'error');
    for (const e of analysis.backfills) if (!issuesByStep.has(e.child)) issuesByStep.set(e.child, 'backfill');
  }
  if (loop) for (const id of loop.stepIds) issuesByStep.set(id, 'loop');
  const { usable } = snapshotState();
  const fromSnap = runsFromSnapshot();

  const list = h('ol', { class: 'step-list' });
  plan.steps.forEach((step, idx) => {
    const issue = issuesByStep.get(step.id);
    const mode = effectiveRecordSource(step);
    const meta = [];
    const live = liveCount(step);
    if (fromSnap && usable) meta.push(plural(snapshotRecordCount(state.snapshot, step), 'captured record'));
    else if (live) meta.push(plural(live.extracted, 'record'));
    else if (mode !== 'referenced') meta.push(`LIMIT ${fmtNum(parseInt(step.limit, 10) || 0)}`);
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
          stepLinkBadges(step),
          step.enabled === false ? badge('off', 'neutral') : null,
          issue === 'loop' ? badge('loop', 'danger', 'This step and another one wait for each other') : null,
          issue === 'error' ? badge('order', 'danger', 'A required parent runs after this step') : null,
          issue === 'backfill' ? badge('back-fill', 'warning', 'A lookup parent runs later; it will be set by an update') : null)),
      h('div', { class: 'step-actions', onclick: (e) => e.stopPropagation() },
        h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
        h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: idx === plan.steps.length - 1, onclick: () => move(idx, 1) }, '↓'))));
  });
  panel.appendChild(list);

  if (loop) panel.appendChild(loopCallout(loop));
  if (analysis && analysis.errors.length) {
    panel.appendChild(h('div', { class: 'callout callout-danger small' }, analysis.errors.map((e) => h('div', null, e.message))));
  }
}

/** Short badges describing how a step picks its records. */
function stepLinkBadges(step) {
  const out = [];
  for (const l of linksOf(step)) {
    const other = stepById(l.other);
    if (!other) continue;
    if (l.kind === 'scope') out.push(badge(`of step ${stepNo(other)}`, 'info', `Only ${step.object} records that belong to the ${other.object} records in step ${stepNo(other)} (${l.field})`));
    else if (l.other === step.id) out.push(badge('+ parents', 'info', `Also the parent records up the hierarchy (${l.field})`));
    else out.push(badge(`used by step ${stepNo(other)}`, 'info', `The ${step.object} records that step ${stepNo(other)} (${other.object}) points to via ${l.field}`));
  }
  if (effectiveRecordSource(step) === 'both' && (step.referencedBy || []).some((r) => r.stepId !== step.id)) out.push(badge('+ filters', 'neutral', 'Also takes the records matching its own filters'));
  return out;
}

/** Explains a loop of links in plain words, with a button to remove each link. */
function loopCallout(loop) {
  const names = [...new Set(loop.stepIds.map((id) => (stepById(id) || {}).object))];
  return h('div', { class: 'callout callout-danger small loop-callout', role: 'alert' },
    h('strong', null, `${names.join(' and ')} wait for each other.`),
    h('p', null, 'Each of these links needs the other step to be read first, so the plan cannot run. Remove one:'),
    h('ul', { class: 'loop-links' }, loop.links.map((l) => h('li', null,
      h('span', null, linkSentence(l)),
      h('button', { class: 'btn btn-small', onclick: () => { removeLink(state.plan, l); planChanged(); toast('Link removed.', 'success'); } }, 'Remove this link')))));
}

function move(idx, delta) {
  const steps = state.plan.steps;
  const j = idx + delta;
  if (j < 0 || j >= steps.length) return;
  [steps[idx], steps[j]] = [steps[j], steps[idx]];
  planChanged();
}

async function autoOrder() {
  const c = describeClient();
  if (!c) return;
  try {
    await Promise.all(state.plan.steps.map((st) => c.describe(st.object)));
  } catch (e) {
    toast(`Could not load object details: ${e.message}`, 'error');
    return;
  }
  const steps = state.plan.steps;
  const enabled = steps.filter((st) => st.enabled !== false);
  const edges = dependencyEdges(enabled, (n) => c.peekDescribe(n));
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
    panel.appendChild(h('div', { class: 'card' }, emptyState('No object selected',
      state.plan.steps.length ? 'Select a step on the left to edit it.' : 'Click "+ Add object" to start building your plan.',
      !state.plan.steps.length && src() ? h('button', { class: 'btn btn-primary', onclick: () => openAddObjectDialog() }, '+ Add object') : null)));
    return;
  }

  panel.appendChild(h('div', { class: 'card editor-header' },
    h('div', null,
      h('h2', null, objectLabel(step.object), objectLabel(step.object) !== step.object ? [' ', h('span', { class: 'mono muted' }, step.object)] : null),
      h('p', { class: 'muted small' }, 'Step ', String(stepNo(step)), ' of ', String(state.plan.steps.length))),
    h('div', { class: 'editor-header-actions' },
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: step.enabled !== false, onchange: (e) => { step.enabled = e.target.checked; planChanged(); } }),
        'Enabled'),
      h('button', { class: 'btn btn-danger-ghost', onclick: () => removeStep(step) }, 'Remove'))));

  panel.appendChild(h('div', { class: 'card' }, recordCountSection(step)));
  if (!src() && state.snapshot) {
    panel.appendChild(h('div', { class: 'card' }, capturedStepSection(step)));
    return;
  }
  const d = describeOrLoad(step.object);
  if (d.missing) {
    panel.appendChild(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Connect the Source org to edit fields and filters.'), linksReadOnly(step)));
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
  panel.appendChild(h('div', { class: 'card' }, recordsSection(step, describe)));
  if (effectiveRecordSource(step) !== 'referenced') panel.appendChild(h('div', { class: 'card' }, filtersSection(step, describe)));
  panel.appendChild(h('div', { class: 'card' }, fieldsSection(step, describe)));
  panel.appendChild(h('div', { class: 'card' }, previewSection(step, describe)));
}

async function removeStep(step) {
  const dependents = state.plan.steps.filter((s) => s.id !== step.id
    && ((s.parentScopes || []).some((p) => p.stepId === step.id) || (s.referencedBy || []).some((r) => r.stepId === step.id)));
  const ok = await confirmModal({
    title: `Remove ${step.object}?`,
    message: dependents.length ? `${dependents.map((s) => s.object).join(', ')} ${dependents.length === 1 ? 'is' : 'are'} linked to this step; those links will be removed too.` : 'The step and its filters will be removed from the plan.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  for (const s of dependents) {
    for (const l of linksOf(s)) if (l.other === step.id) removeLink(state.plan, l);
  }
  const idx = state.plan.steps.indexOf(step);
  state.plan.steps.splice(idx, 1);
  const next = state.plan.steps[idx] || state.plan.steps[idx - 1];
  state.selectedStepId = next ? next.id : null;
  planChanged();
}

function section(title, hint, ...body) {
  return [h('div', { class: 'section-title' }, h('h3', null, title), hint ? h('p', { class: 'muted small' }, hint) : null), ...body];
}

// ----- Which records (links to other steps, mode, LIMIT, order) -----

/** Plain-language description of one link, from the owning step's point of view. */
function linkSentence(link) {
  const owner = stepById(link.owner);
  const other = stepById(link.other);
  if (!owner) return '(missing step)';
  const o = plural2(owner.object);
  if (!other) return `${o}: link to a step that no longer exists (${link.field})`;
  const d = describeClient();
  const fieldOf = (obj) => { const desc = d ? d.peekDescribe(obj) : null; const f = desc ? getField(desc, link.field) : null; return f ? f.label : link.field; };
  if (link.kind === 'scope') return `Only ${o} that belong to the ${plural2(other.object)} in step ${stepNo(other)} (via ${fieldOf(owner.object)})`;
  if (other.id === owner.id) return `Plus their parent ${o}, up the hierarchy via ${fieldOf(owner.object)} (up to 10 levels)`;
  return `The ${o} that the ${plural2(other.object)} in step ${stepNo(other)} point to (via ${fieldOf(other.object)})`;
}

/** Every link this step could add, both directions. Options that would loop are flagged. */
function linkCandidates(step, describe) {
  const s = src();
  const steps = state.plan.steps;
  const out = [];
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (const f of describe.fields) {
    if (!isLookup(f) || !f.filterable) continue;
    for (const p of steps) {
      if (p.id === step.id || p.enabled === false || !f.referenceTo.some((r) => eq(r, p.object))) continue;
      out.push({ owner: step.id, kind: 'scope', other: p.id, field: f.name });
    }
  }
  for (const other of steps) {
    if (other.enabled === false) continue;
    const d = s.client.peekDescribe(other.object);
    if (!d) { describeOrLoad(other.object); continue; }
    for (const f of selectedSourceFields(other, d)) {
      if (!isLookup(f) || !f.referenceTo.some((r) => eq(r, step.object))) continue;
      out.push({ owner: step.id, kind: 'reference', other: other.id, field: f.name });
    }
  }
  const have = linksOf(step);
  return out
    .filter((l) => !have.some((x) => x.kind === l.kind && x.other === l.other && x.field.toLowerCase() === l.field.toLowerCase()))
    .map((l) => ({ link: l, loop: wouldLoop(steps, l) }));
}

function recordsSection(step, describe) {
  const links = linksOf(step);
  const candidates = linkCandidates(step, describe);
  const hasRefs = (step.referencedBy || []).some((r) => r.stepId !== step.id);
  const mode = effectiveRecordSource(step);
  const label = plural2(step.object);

  const linkList = links.length
    ? h('ul', { class: 'link-list' }, links.map((l) => h('li', { class: ['link-item', `link-${l.kind}`] },
      h('span', { class: 'link-icon', 'aria-hidden': 'true' }, l.kind === 'scope' ? '↳' : l.other === step.id ? '⤒' : '↑'),
      h('span', { class: 'link-text' }, linkSentence(l)),
      h('button', { class: 'icon-btn', title: 'Remove link', 'aria-label': 'Remove link', onclick: () => { removeLink(state.plan, l); planChanged(); } }, '×'))))
    : h('p', { class: 'muted small' }, state.plan.steps.length > 1
      ? `Not linked to other steps: ${label} are picked only by the filters and LIMIT below.`
      : `${label} are picked by the filters and LIMIT below.`);

  const loops = candidates.filter((c) => c.loop);
  const addSel = candidates.length ? select(
    [{ value: '', label: '+ Link to another step…' }, ...candidates.map((c, i) => ({
      value: String(i),
      label: `${linkSentence(c.link)}${c.loop ? ' (not possible: would create a loop)' : ''}`,
      disabled: c.loop,
    }))],
    '',
    (v) => {
      if (v === '') return;
      const c = candidates[parseInt(v, 10)];
      addLink(state.plan, c.link);
      const moved = reorderPlan();
      planChanged();
      if (moved) toast('Order updated so parents are inserted before children.', 'info');
    },
    { 'aria-label': 'Link to another step', class: 'input link-add' },
  ) : null;

  const radio = (value, text) => h('label', { class: 'check-row' },
    h('input', { type: 'radio', name: `rs-${step.id}`, checked: mode === value, onchange: () => { step.recordSource = value; planChanged(); } }), text);

  const max = state.settings.maxRecordsPerObject;
  const sortable = describe.fields.filter((f) => f.sortable).sort((a, b) => a.label.localeCompare(b.label));
  const ob = step.orderBy || { field: '', direction: 'ASC' };
  const limitRow = mode === 'referenced' ? null : h('div', { class: 'inline-fields' },
    formRow('LIMIT (required)', h('input', {
      class: 'input input-narrow', type: 'number', min: 1, max, value: step.limit,
      oninput: (e) => { step.limit = parseInt(e.target.value, 10) || 0; planChanged({ render: false }); },
    }), `${links.some((l) => l.kind === 'scope') ? 'Applies after the link above. ' : ''}Max ${fmtNum(max)} per object (Settings).`),
    formRow('Order by', select([{ value: '', label: '— none —' }, ...sortable.map((f) => ({ value: f.name, label: `${f.label} (${f.name})` }))], ob.field, (v) => {
      step.orderBy = { field: v, direction: ob.direction || 'ASC' };
      planChanged();
    })),
    ob.field ? formRow('Direction', select([{ value: 'ASC', label: 'Ascending' }, { value: 'DESC', label: 'Descending' }], ob.direction, (v) => {
      step.orderBy = { ...ob, direction: v };
      planChanged({ render: false });
    })) : null);

  return h('div', null, ...section(`Which ${label}`, 'Link this step to other steps so the copied records stay connected, or pick records with filters.',
    linkList,
    addSel ? h('div', { class: 'ref-add' }, addSel) : null,
    loops.length ? h('p', { class: 'hint' }, 'Greyed-out links would make two steps wait for each other. Remove the opposite link first if you need one of them.') : null,
    hasRefs ? h('div', { class: 'radio-row' },
      h('span', { class: 'small' }, 'Take:'),
      radio('referenced', `only the linked ${label}`),
      radio('both', `linked ${label} plus ${label} matching filters`)) : null,
    mode === 'referenced' ? h('p', { class: 'muted small' }, `Takes exactly the ${label} the linked steps point to, so filters and LIMIT are not needed (the per-object cap in Settings still applies).`) : null,
    limitRow,
    h('div', { class: 'inline-actions related-cta' },
      h('button', { class: 'btn btn-small', onclick: () => openRelatedDialog() }, 'Find related records…'),
      h('span', { class: 'small muted' }, 'Checks the selected records for lookups to records that are not in the plan and offers to add them.'))));
}

function linksReadOnly(step) {
  const links = linksOf(step);
  if (!links.length) return null;
  return h('ul', { class: 'link-list' }, links.map((l) => h('li', { class: 'link-item' }, h('span', { class: 'link-text' }, linkSentence(l)))));
}

// ----- Record count -----

/** Counts from the last "Count records", when the plan has not changed since. */
function liveCount(step) {
  const rc = state.recordCounts;
  if (!rc || rc.signature !== dataSignature(state.plan)) return null;
  return rc.stats.get(step.id) || null;
}

function breakdown(st) {
  const parts = [];
  if (st.byQuery) parts.push(`${fmtNum(st.byQuery)} matching the filters`);
  if (st.byReference) parts.push(`${fmtNum(st.byReference)} linked from other steps`);
  if (st.byHierarchy) parts.push(`${fmtNum(st.byHierarchy)} parent record${st.byHierarchy === 1 ? '' : 's'}`);
  if (st.duplicates) parts.push(`${fmtNum(st.duplicates)} already taken by an earlier step (inserted once)`);
  return parts.length > 1 || st.duplicates ? parts.join(', ') : '';
}

let counting = null; // AbortController while "Count records" runs

/** How many records this step copies: captured count and/or a fresh count from the Source org. */
function recordCountSection(step) {
  const { snap, usable, stale } = snapshotState();
  const s = src();
  const rows = [];
  if (snap && usable) {
    const n = snapshotRecordCount(snap, step);
    rows.push(h('dt', null, 'Captured'), h('dd', null, h('span', { class: 'count-big' }, plural(n, 'record')),
      h('div', { class: 'small muted' }, snap.steps[step.id] ? snapshotSummary(snap) : 'Nothing was captured for this step (it was disabled or added after the capture).')));
  } else if (snap && stale) {
    rows.push(h('dt', null, 'Captured'), h('dd', { class: 'small muted' }, 'Out of date: the plan changed after the capture.'));
  }
  const rc = state.recordCounts;
  const live = liveCount(step);
  const out = h('div', { class: 'small muted' });
  if (s) {
    let value;
    if (step.enabled === false) value = h('span', { class: 'muted' }, 'Disabled steps are not counted.');
    else if (live) {
      const lim = Math.min(parseInt(step.limit, 10) || 0, state.settings.maxRecordsPerObject);
      const capped = effectiveRecordSource(step) !== 'referenced' && live.byQuery >= lim;
      value = [h('span', { class: 'count-big' }, plural(live.extracted, 'record')),
        h('div', { class: 'small muted' }, [breakdown(live), capped ? `LIMIT ${fmtNum(lim)} reached: more records match the filters` : '', `counted ${new Date(rc.at).toLocaleTimeString()}`].filter(Boolean).join(' · '))];
    } else {
      value = h('span', { class: 'muted small' }, rc ? 'The plan changed since the last count.' : 'Not counted yet.');
    }
    rows.push(h('dt', null, 'In the Source org now'), h('dd', null, value));
  }
  const btn = s ? h('button', {
    class: 'btn btn-small',
    disabled: !!counting || isBusy(),
    onclick: async () => {
      counting = new AbortController();
      btn.disabled = true;
      out.textContent = 'Counting: reading the records the plan selects (read-only)…';
      try {
        await countRecords({ signal: counting.signal });
        counting = null;
      } catch (e) {
        counting = null;
        btn.disabled = false;
        out.textContent = `Could not count: ${e.message}`;
      }
    },
  }, live ? 'Count again' : 'Count records') : null;
  return h('div', null, ...section('Record count', s ? 'Counts every step of the plan the way a run would select records, including links between steps. Nothing is written.' : null,
    rows.length ? h('dl', { class: 'count-rows' }, rows) : h('p', { class: 'muted small' }, 'Connect the Source org to count records.'),
    btn ? h('div', { class: 'inline-actions' }, btn, out) : null));
}

/** Read-only view of a step when the plan runs from captured data without a Source connection. */
function capturedStepSection(step) {
  const snap = state.snapshot;
  const c = describeClient();
  const d = c.peekDescribe(step.object);
  const fields = d ? selectedSourceFields(step, d) : [];
  return h('div', null, ...section('Which records', null,
    !snap.steps[step.id] ? h('p', { class: 'callout callout-warning small' }, 'No records were captured for this step (it was disabled or added after capture), so it inserts nothing.') : null,
    linksReadOnly(step),
    d ? h('details', { class: 'advanced' }, h('summary', null, `${plural(fields.length, 'field')} copied`),
      h('p', { class: 'small mono' }, fields.map((f) => f.name).join(', '))) : null,
    h('p', { class: 'muted small' }, 'To change filters, fields or links, connect the Source org; then capture the data again when you export.')));
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
  return h('div', null, ...section('Generated SOQL', null, code, note));
}
