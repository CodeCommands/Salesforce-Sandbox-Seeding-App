// Dependency sequencing: which steps are parents of which, suggested insert order, order checks.
import { isLookup, isRequiredOnCreate, selectedSourceFields } from './schema.js';

/**
 * Builds lookup edges between enabled steps.
 * @param steps plan steps
 * @param describeFor (objectName) => describe | undefined
 * @returns edges [{ child, parent, field, required, sameObject }]
 */
export function dependencyEdges(steps, describeFor) {
  const active = steps.filter((s) => s.enabled !== false);
  const byObject = new Map();
  for (const s of active) {
    const k = s.object.toLowerCase();
    if (!byObject.has(k)) byObject.set(k, []);
    byObject.get(k).push(s);
  }
  const edges = [];
  for (const s of active) {
    const d = describeFor(s.object);
    if (!d) continue;
    for (const f of selectedSourceFields(s, d)) {
      if (!isLookup(f)) continue;
      for (const ref of f.referenceTo) {
        for (const p of byObject.get(ref.toLowerCase()) || []) {
          if (p.id === s.id) continue; // self-reference inside one step is handled by multi-pass insert
          edges.push({
            child: s.id,
            parent: p.id,
            field: f.name,
            required: isRequiredOnCreate(f),
            sameObject: p.object.toLowerCase() === s.object.toLowerCase(),
          });
        }
      }
    }
  }
  return edges;
}

/** Self-referencing lookups within a step (e.g. Account.ParentId). */
export function selfReferenceFields(step, describe) {
  return selectedSourceFields(step, describe).filter((f) => isLookup(f) && f.referenceTo.some((r) => r.toLowerCase() === step.object.toLowerCase()));
}

/**
 * Stable topological order: parents before children, preserving the user's order where possible.
 * Optional edges are dropped only when needed to break a cycle; required cycles are reported.
 */
export function suggestOrder(steps, edges) {
  const ids = steps.map((s) => s.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const e of edges) if (index.has(e.child) && index.has(e.parent)) incoming.get(e.child).push(e);
  const placed = new Set();
  const order = [];
  const brokenEdges = [];
  const requiredCycle = [];
  while (order.length < ids.length) {
    const remaining = ids.filter((id) => !placed.has(id));
    let pick = remaining.find((id) => incoming.get(id).every((e) => placed.has(e.parent)));
    if (!pick) {
      pick = remaining.find((id) => incoming.get(id).every((e) => placed.has(e.parent) || !e.required));
      if (pick) {
        brokenEdges.push(...incoming.get(pick).filter((e) => !placed.has(e.parent)));
      } else {
        pick = remaining[0];
        requiredCycle.push(pick);
      }
    }
    placed.add(pick);
    order.push(pick);
  }
  return { order, brokenEdges, requiredCycle };
}

/** Checks the user's current order. Required parents after children are errors; optional ones get back-filled. */
export function checkOrder(steps, edges) {
  const pos = new Map(steps.map((s, i) => [s.id, i]));
  const name = new Map(steps.map((s) => [s.id, s.object]));
  const errors = [];
  const backfills = [];
  for (const e of edges) {
    if (!pos.has(e.parent) || !pos.has(e.child)) continue;
    if (pos.get(e.parent) > pos.get(e.child)) {
      const msg = `${name.get(e.child)}.${e.field} points to ${name.get(e.parent)}, which runs later`;
      if (e.required) errors.push({ ...e, message: `${msg}. The lookup is required, so move ${name.get(e.parent)} above ${name.get(e.child)} (or use Auto-order).` });
      else backfills.push({ ...e, message: `${msg}; it will be filled in by an update after both are inserted.` });
    }
  }
  return { errors, backfills };
}

/**
 * Extraction order. A step is extracted after the steps it is scoped to (parentScopes) and the steps
 * that reference it (referencedBy), so a parent added because children point to it is pulled after
 * those children. Insert order is still the plan order. Returns { order } or { cycle } on a loop.
 */
export function extractionOrder(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const deps = new Map(steps.map((s) => [s.id, new Set(
    [...(s.parentScopes || []).map((p) => p.stepId), ...(s.referencedBy || []).map((r) => r.stepId)]
      .filter((id) => id !== s.id && byId.has(id)),
  )]));
  const order = [];
  const placed = new Set();
  while (order.length < steps.length) {
    const next = steps.find((s) => !placed.has(s.id) && [...deps.get(s.id)].every((d) => placed.has(d)));
    if (!next) return { order: null, cycle: steps.filter((s) => !placed.has(s.id)).map((s) => s.object) };
    placed.add(next.id);
    order.push(next);
  }
  return { order, cycle: null };
}

/**
 * Links that make a step wait for another step during extraction.
 * kind "scope": the step takes only children of the other step's records (step.field IN other's Ids).
 * kind "reference": the step takes the records that the other step's records point to (other.field).
 */
export function extractionLinks(step) {
  return [
    ...(step.parentScopes || []).map((p) => ({ owner: step.id, kind: 'scope', other: p.stepId, field: p.field })),
    ...(step.referencedBy || []).filter((r) => r.stepId !== step.id).map((r) => ({ owner: step.id, kind: 'reference', other: r.stepId, field: r.field })),
  ];
}

/**
 * Finds one loop of extraction links (e.g. Contact scoped to Account while Account takes the Accounts
 * those Contacts point to). Returns null, or { stepIds, links } with the links that form the loop.
 */
export function findLoop(steps) {
  const ids = new Set(steps.map((s) => s.id));
  const out = new Map(steps.map((s) => [s.id, extractionLinks(s).filter((l) => ids.has(l.other))]));
  const color = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    for (const link of out.get(id) || []) {
      if (color.get(link.other) === 1) {
        const start = stack.findIndex((l) => l.owner === link.other);
        const links = [...(start >= 0 ? stack.slice(start) : []), link];
        return { stepIds: links.map((l) => l.owner), links };
      }
      if (!color.has(link.other)) {
        stack.push(link);
        const found = visit(link.other);
        if (found) return found;
        stack.pop();
      }
    }
    color.set(id, 2);
    return null;
  };
  for (const s of steps) {
    if (color.has(s.id)) continue;
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}

/** Plain-language sentence for one link, for the UI and validation messages. */
export function describeLink(link, steps) {
  const owner = steps.find((s) => s.id === link.owner);
  const other = steps.find((s) => s.id === link.other);
  const n = (s) => (s ? `step ${steps.indexOf(s) + 1}` : 'a missing step');
  const o = owner ? owner.object : '?';
  const p = other ? other.object : '?';
  if (link.kind === 'scope') return `${o} (${n(owner)}) takes only the ${o} records that belong to the ${p} records in ${n(other)}, via ${link.field}`;
  return `${o} (${n(owner)}) takes the ${o} records that the ${p} records in ${n(other)} point to, via ${link.field}`;
}

/** True when adding `link` ({ owner, kind, other, field }) would make extraction loop. */
export function wouldLoop(steps, link) {
  if (link.kind === 'reference' && link.owner === link.other) return false; // hierarchy is handled inside a step
  const next = steps.map((s) => {
    if (s.id !== link.owner) return s;
    return link.kind === 'scope'
      ? { ...s, parentScopes: [...(s.parentScopes || []), { field: link.field, stepId: link.other }] }
      : { ...s, referencedBy: [...(s.referencedBy || []), { field: link.field, stepId: link.other }] };
  });
  return !!findLoop(next.filter((s) => s.enabled !== false));
}
