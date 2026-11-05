// "Add object" dialog: a roomy, searchable object list (objects related to the plan first), then one
// plain question: how should this object's records be chosen? The answer becomes the step's link.
import { h, clear } from '../util.js';
import { state, planChanged } from '../store.js';
import { newStep, addLink } from '../template.js';
import { isLookup, isRequiredOnCreate, isSeedableField, isCopyableReference, selectedSourceFields } from '../schema.js';
import { dependencyEdges, suggestOrder } from '../planner.js';
import { openModal, badge, spinner, toast } from './components.js';

const COMMON = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem', 'Lead', 'Case', 'Campaign', 'CampaignMember', 'Product2', 'Asset', 'Contract', 'Order', 'Task', 'Event'];
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function pluralLabel(object) {
  const s = state.conn.source;
  const d = s.client ? s.client.peekDescribe(object) : null;
  if (d && d.labelPlural) return d.labelPlural;
  const g = s.global ? s.global.find((x) => eq(x.name, object)) : null;
  return g ? (g.labelPlural || g.label) : object;
}

function stepNo(step) {
  return state.plan.steps.indexOf(step) + 1;
}

/** Objects linked to the plan's steps: their parents (lookups) and children (child relationships). */
function relatedObjects(client, global) {
  const out = new Map(); // name -> hint
  const steps = state.plan.steps.filter((s) => s.enabled !== false);
  const inPlan = new Set(steps.map((s) => s.object.toLowerCase()));
  for (const st of steps) {
    const d = client.peekDescribe(st.object);
    if (!d) continue;
    for (const f of selectedSourceFields(st, d)) {
      if (!isLookup(f)) continue;
      for (const ref of f.referenceTo) {
        if (inPlan.has(ref.toLowerCase()) || !isCopyableReference(ref, global) || out.has(ref)) continue;
        out.set(ref, `${st.object} points to it via ${f.label}`);
      }
    }
    for (const cr of d.childRelationships || []) {
      const child = cr.childSObject;
      if (!child || !cr.field || inPlan.has(child.toLowerCase()) || out.has(child) || !isCopyableReference(child, global)) continue;
      out.set(child, `child of ${st.object} via ${cr.field}`);
    }
  }
  return out;
}

export function openAddObjectDialog() {
  const s = state.conn.source;
  if (s.status !== 'connected' || !s.seedable) {
    toast('Connect the Source org to browse its objects.', 'warning');
    return null;
  }
  return openModal({
    title: 'Add an object',
    wide: true,
    render: (close) => {
      const body = h('div', { class: 'add-object' });
      const showList = () => renderList(body, close, (name) => renderChoice(body, close, name, showList));
      showList();
      return body;
    },
  });
}

function renderList(body, close, onPick) {
  const s = state.conn.source;
  const used = new Map(state.plan.steps.map((st) => [st.object.toLowerCase(), st]));
  const related = relatedObjects(s.client, s.global);
  const byName = new Map(s.seedable.map((g) => [g.name, g]));
  const item = (g, hint) => ({ name: g.name, label: g.label, hint, q: `${g.label} ${g.name}`.toLowerCase() });
  const relatedItems = [...related].filter(([n]) => byName.has(n)).map(([n, hint]) => item(byName.get(n), hint))
    .sort((a, b) => a.label.localeCompare(b.label));
  const commonItems = COMMON.filter((n) => byName.has(n) && !related.has(n)).map((n) => item(byName.get(n), ''));
  const allItems = s.seedable.map((g) => item(g, ''));

  const search = h('input', { class: 'input input-search', type: 'search', placeholder: 'Search objects by label or API name, e.g. Contact or Invoice__c', 'aria-label': 'Search objects', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'object-picker', role: 'listbox', 'aria-label': 'Objects' });
  const count = h('p', { class: 'muted small' });
  let first = null;

  const row = (it) => {
    const st = used.get(it.name.toLowerCase());
    return h('button', { class: 'object-item', role: 'option', type: 'button', onclick: () => onPick(it.name) },
      h('span', { class: 'object-label' }, it.label),
      h('span', { class: 'mono muted small' }, it.name),
      h('span', { class: 'object-hint small' }, it.hint || '', st ? badge(`in plan · step ${stepNo(st)}`, 'neutral') : null));
  };
  const group = (title, items) => (items.length ? [h('div', { class: 'object-group' }, title), ...items.map(row)] : []);

  const render = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    if (!q) {
      list.append(...group('Related to your plan', relatedItems), ...group('Common objects', commonItems), ...group(`All objects (${allItems.length})`, allItems));
      first = relatedItems[0] || commonItems[0] || allItems[0] || null;
      count.textContent = 'Tip: start typing to filter. Objects that are linked to the steps in your plan are listed first.';
      return;
    }
    const score = (it) => (it.label.toLowerCase().startsWith(q) || it.name.toLowerCase().startsWith(q) ? 0 : 1) + (related.has(it.name) ? 0 : 0.5);
    const hits = allItems.filter((it) => it.q.includes(q)).sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label))
      .map((it) => ({ ...it, hint: related.get(it.name) || '' }));
    first = hits[0] || null;
    list.append(...hits.map(row));
    if (!hits.length) list.appendChild(h('p', { class: 'muted pad' }, 'No objects match. Only objects you can query and create records in are listed.'));
    count.textContent = `${hits.length} matching object${hits.length === 1 ? '' : 's'}`;
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && first) { e.preventDefault(); onPick(first.name); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const b = list.querySelector('.object-item'); if (b) b.focus(); }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll('.object-item')];
    const i = items.indexOf(document.activeElement);
    const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); search.focus(); }
  });
  render();
  clear(body).append(search, count, list,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel')));
  setTimeout(() => search.focus(), 0);
}

/** The ways a new step of `object` can relate to the plan. Best choice first. */
function choicesFor(object, d) {
  const client = state.conn.source.client;
  const steps = state.plan.steps.filter((x) => x.enabled !== false);
  const label = pluralLabel(object);
  const out = [];
  for (const f of d.fields) {
    if (!isLookup(f) || !f.filterable || !isSeedableField(f)) continue;
    for (const p of steps) {
      if (eq(p.object, object) || !f.referenceTo.some((r) => eq(r, p.object))) continue;
      const required = isRequiredOnCreate(f);
      out.push({
        rank: required ? 0 : 1,
        link: { kind: 'scope', other: p.id, field: f.name },
        title: `${label} that belong to the ${pluralLabel(p.object)} in step ${stepNo(p)} (via ${f.label})`,
        detail: `Uses the lookup ${f.name}. You can still add filters and a LIMIT.`,
        badges: required ? [badge('required lookup', 'warning', 'Without its parent this record cannot be inserted')] : [],
      });
    }
  }
  for (const c of steps) {
    const cd = client.peekDescribe(c.object);
    if (!cd) continue;
    for (const f of selectedSourceFields(c, cd)) {
      if (!isLookup(f) || !f.referenceTo.some((r) => eq(r, object))) continue;
      if (eq(c.object, object)) continue; // same object: use the parent hierarchy option on that step instead
      out.push({
        rank: 2,
        link: { kind: 'reference', other: c.id, field: f.name },
        title: `Only the ${label} that the ${pluralLabel(c.object)} in step ${stepNo(c)} point to (via ${f.label})`,
        detail: `Uses the lookup ${c.object}.${f.name}. Keeps every ${c.object} connected to its ${d.label}; no LIMIT needed.`,
        badges: [],
      });
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  out.push({
    rank: 9,
    link: null,
    title: `${label} matching filters I choose`,
    detail: steps.length ? 'Not linked to the other steps. You set filters and a LIMIT next.' : 'You set filters and a LIMIT next.',
    badges: [],
  });
  return out;
}

async function renderChoice(body, close, object, back) {
  const s = state.conn.source;
  clear(body).appendChild(spinner(`Loading ${object}…`));
  let d;
  try {
    [d] = await Promise.all([s.client.describe(object), ...state.plan.steps.map((st) => s.client.describe(st.object).catch(() => null))]);
  } catch (e) {
    clear(body).append(h('div', { class: 'callout callout-danger' }, `Could not load ${object}: ${e.message}`),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: back }, 'Back')));
    return;
  }
  const choices = choicesFor(object, d);
  const existing = state.plan.steps.find((st) => eq(st.object, object));
  if (choices.length === 1) {
    // Nothing in the plan links to this object: no question to ask.
    add(object, null);
    close();
    return;
  }
  let picked = 0;
  const radios = choices.map((c, i) => h('label', { class: ['choice', i === 0 && 'choice-recommended'] },
    h('input', { type: 'radio', name: 'add-choice', checked: i === 0, onchange: () => { picked = i; } }),
    h('span', { class: 'choice-text' },
      h('span', { class: 'choice-title' }, c.title, i === 0 ? badge('recommended', 'success') : null, ...c.badges),
      h('span', { class: 'choice-detail small muted' }, c.detail))));
  clear(body).append(...[
    h('h3', { class: 'choice-question' }, `Which ${pluralLabel(object)} should be copied?`),
    existing ? h('p', { class: 'callout callout-info small' }, `${d.label} is already step ${stepNo(existing)}. Adding it again creates a second ${d.label} step, for example for a different set of records.`) : null,
    h('div', { class: 'choice-list', role: 'radiogroup' }, radios),
    h('p', { class: 'muted small' }, 'You can change this later in the step\'s "Which records" section.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: back }, 'Back'),
      h('button', { class: 'btn btn-primary', onclick: () => { add(object, choices[picked].link); close(); } }, `Add ${d.label}`)),
  ].filter(Boolean)); // Element.append would print "null"
  const firstRadio = body.querySelector('input[type=radio]');
  if (firstRadio) firstRadio.focus();
}

function add(object, link) {
  const step = newStep(object);
  state.plan.steps.push(step);
  if (link) addLink(state.plan, { ...link, owner: step.id });
  const moved = reorderPlan();
  state.selectedStepId = step.id;
  planChanged();
  toast(`${object} added as step ${stepNo(step)}${moved ? ' (the order was updated so parents are inserted first)' : ''}.`, 'success');
}

/** Parents before children (stable). Returns true when the order changed. */
export function reorderPlan() {
  const client = state.conn.source.client;
  if (!client) return false;
  const steps = state.plan.steps;
  const edges = dependencyEdges(steps.filter((st) => st.enabled !== false), (n) => client.peekDescribe(n));
  const { order } = suggestOrder(steps, edges);
  const before = steps.map((st) => st.id).join();
  const pos = new Map(order.map((id, i) => [id, i]));
  steps.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  return before !== steps.map((st) => st.id).join();
}
