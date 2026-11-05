// Central app state with a tiny topic-based event bus.
import { storage } from './util.js';
import { newPlan, toTemplate, draftFromStorage } from './template.js';
import { dataSignature } from './snapshot.js';

const DRAFT_KEY = 'sfseed.draft';
const LAST_RUN_KEY = 'sfseed.lastRun';
const SNAPSHOT_KEY = 'sfseed.snapshot';

function emptyConnection() {
  return { status: 'disconnected', session: null, client: null, org: null, user: null, error: null, rt: null, global: null, limits: null };
}

export const state = {
  settings: null,
  view: 'connect',
  plan: newPlan(),
  selectedStepId: null,
  conn: { source: emptyConnection(), target: emptyConnection() },
  run: null, // see runController.js
  snapshot: null, // captured record data (see snapshot.js); kept in memory and in this tab's sessionStorage
  useSnapshot: true, // when both captured data and a Source connection exist, which one runs use
};

export { emptyConnection };

const listeners = new Map();

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

export function emit(topic, payload) {
  for (const fn of listeners.get(topic) || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`listener for ${topic} failed`, e);
    }
  }
  if (topic !== '*') for (const fn of listeners.get('*') || []) fn(topic, payload);
}

// ---------- Plan draft persistence (no secrets, so localStorage is fine) ----------

let draftTimer = null;
export function planChanged({ render = true } = {}) {
  state.plan.updatedAt = new Date().toISOString();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => storage.set('localStorage', DRAFT_KEY, toTemplate(state.plan)), 300);
  emit(render ? 'plan' : 'plan:silent');
}

export function flushDraft() {
  clearTimeout(draftTimer);
  storage.set('localStorage', DRAFT_KEY, toTemplate(state.plan));
}

/** Restores the saved draft (and captured data from this tab). Returns messages about repaired links. */
export function restoreDraft() {
  const res = draftFromStorage(storage.get('localStorage', DRAFT_KEY));
  if (res) state.plan = res.plan;
  state.selectedStepId = state.plan.steps[0] ? state.plan.steps[0].id : null;
  const snap = storage.get('sessionStorage', SNAPSHOT_KEY);
  if (snap && snap.signature === dataSignature(state.plan)) state.snapshot = snap;
  else storage.remove('sessionStorage', SNAPSHOT_KEY);
  if (res && res.warnings.length) planChanged({ render: false });
  return res ? res.warnings : [];
}

export function setPlan(plan, { snapshot = null } = {}) {
  state.plan = plan;
  state.selectedStepId = plan.steps[0] ? plan.steps[0].id : null;
  setSnapshot(snapshot, { silent: true });
  planChanged();
}

// ---------- Captured record data ----------

/** Stores (or clears) captured data. Large captures may not fit sessionStorage; then they live in memory only. */
export function setSnapshot(snap, { silent = false } = {}) {
  if (snap && !snap.signature) snap.signature = dataSignature(state.plan);
  state.snapshot = snap || null;
  state.useSnapshot = true;
  if (!snap || !storage.set('sessionStorage', SNAPSHOT_KEY, snap)) storage.remove('sessionStorage', SNAPSHOT_KEY);
  if (!silent) emit('plan');
}

/**
 * { snap, stale, usable }: stale when the plan's objects, fields, filters or links changed since capture.
 */
export function snapshotState() {
  const snap = state.snapshot;
  if (!snap) return { snap: null, stale: false, usable: false };
  const stale = snap.signature !== dataSignature(state.plan);
  return { snap, stale, usable: !stale };
}

/** Whether runs (and the plan view) work from captured data rather than the live Source org. */
export function runsFromSnapshot() {
  const { usable } = snapshotState();
  if (!usable) return false;
  return state.conn.source.status !== 'connected' || state.useSnapshot;
}

export function selectedStep() {
  return state.plan.steps.find((s) => s.id === state.selectedStepId) || null;
}

// ---------- Last run (Ids only) so a run can be rolled back after a page reload ----------

export function getLastRun() {
  return storage.get('localStorage', LAST_RUN_KEY);
}

export function saveLastRun(run) {
  if (!storage.set('localStorage', LAST_RUN_KEY, run)) {
    console.warn('Could not persist last run (storage full?)');
  }
}

export function clearLastRun() {
  storage.remove('localStorage', LAST_RUN_KEY);
}
