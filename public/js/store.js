// Central app state with a tiny topic-based event bus.
import { storage } from './util.js';
import { newPlan, toTemplate, planFromDraft } from './template.js';

const DRAFT_KEY = 'sfseed.draft';
const LAST_RUN_KEY = 'sfseed.lastRun';

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

export function restoreDraft() {
  const plan = planFromDraft(storage.get('localStorage', DRAFT_KEY));
  if (plan) state.plan = plan;
  state.selectedStepId = state.plan.steps[0] ? state.plan.steps[0].id : null;
}

export function setPlan(plan) {
  state.plan = plan;
  state.selectedStepId = plan.steps[0] ? plan.steps[0].id : null;
  planChanged();
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
