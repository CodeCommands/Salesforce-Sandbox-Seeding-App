// Application bootstrap: settings, sessions, routing between tabs, template import/export.
import { h, clear, readFileAsText, plural } from './util.js';
import { loadConfig } from './config.js';
import { state, on, emit, restoreDraft, flushDraft, setPlan, runsFromSnapshot } from './store.js';
import { restoreConnections } from './connections.js';
import { newPlan, parseTemplate } from './template.js';
import { isBusy } from './runController.js';
import { renderConnectView } from './ui/connectView.js';
import { renderPlanView, refreshPlanParts } from './ui/planView.js';
import { renderRunView } from './ui/runView.js';
import { openSetupGuide } from './ui/setupGuide.js';
import { loadSavedOrgs } from './savedOrgs.js';
import { openExportDialog } from './ui/exportDialog.js';
import { toast, confirmModal, badge, openModal } from './ui/components.js';

const VIEWS = {
  connect: { label: 'Connect', render: renderConnectView },
  plan: { label: 'Build plan', render: renderPlanView },
  run: { label: 'Validate & run', render: renderRunView },
};

const main = () => document.getElementById('view');

function render() {
  const container = clear(main());
  VIEWS[state.view].render(container);
  renderNav();
  renderOrgStrip();
}

function renderNav() {
  for (const btn of document.querySelectorAll('[data-view]')) {
    const active = btn.dataset.view === state.view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  }
  const planBtn = document.querySelector('[data-view="plan"] .tab-count');
  if (planBtn) planBtn.textContent = state.plan.steps.length ? String(state.plan.steps.length) : '';
  const nameEl = document.getElementById('plan-name');
  if (nameEl) nameEl.textContent = state.plan.name;
}

function renderOrgStrip() {
  const el = clear(document.getElementById('org-strip'));
  const part = (role, label) => {
    const c = state.conn[role];
    let status;
    if (c.status === 'connected') {
      status = [h('strong', null, c.org ? c.org.Name : 'Connected'), ' ',
        c.org && c.org.IsSandbox === false ? badge('Production', role === 'target' ? 'danger' : 'neutral') : badge('Sandbox', 'info')];
    } else if (c.status === 'expired') status = badge('Session expired', 'warning');
    else if (c.status === 'connecting' || c.status === 'authorizing') status = badge('Connecting…', 'info');
    else if (role === 'source' && runsFromSnapshot()) status = badge('captured data', 'info');
    else status = h('span', { class: 'muted' }, 'not connected');
    return h('button', { class: 'org-chip', onclick: () => go('connect'), title: `${label} org` }, h('span', { class: 'muted small' }, `${label}:`), ' ', status);
  };
  el.appendChild(part('source', 'Source'));
  el.appendChild(h('span', { class: 'muted', 'aria-hidden': 'true' }, '→'));
  el.appendChild(part('target', 'Target'));
}

export function go(view) {
  if (!VIEWS[view] || state.view === view) return;
  state.view = view;
  try { sessionStorage.setItem('sfseed.view', view); } catch { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}

// Throttle re-renders triggered by rapid events (run progress, describes).
let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function wireEvents() {
  on('connections', () => {
    renderOrgStrip();
    if (state.view === 'connect' || state.view === 'plan' || state.view === 'run') scheduleRender();
  });
  on('plan', () => { renderOrgStrip(); scheduleRender(); });
  on('plan:silent', () => { if (state.view === 'plan') refreshPlanParts('silent'); renderNav(); });
  on('plan:describe', () => { if (state.view === 'plan' && !refreshPlanParts('describe')) scheduleRender(); });
  on('plan:name', renderNav);
  on('run', () => { if (state.view === 'run') scheduleRender(); });
  on('toast', ({ kind, text }) => toast(text, kind));

  for (const btn of document.querySelectorAll('[data-view]')) btn.addEventListener('click', () => go(btn.dataset.view));
  document.getElementById('btn-help').addEventListener('click', openHelp);
  document.getElementById('btn-new').addEventListener('click', newTemplate);
  document.getElementById('btn-export').addEventListener('click', openExportDialog);
  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) await importFile(file);
  });
  // Drag & drop a template anywhere on the page
  document.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    await importFile(file);
  });
  window.addEventListener('beforeunload', (e) => {
    flushDraft();
    if (isBusy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function newTemplate() {
  if (isBusy()) return toast('Wait for the current run to finish.', 'warning');
  if (state.plan.steps.length) {
    const ok = await confirmModal({ title: 'Start a new plan?', message: 'The current plan will be replaced. Export it first if you want to keep it.', confirmLabel: 'New plan' });
    if (!ok) return;
  }
  setPlan(newPlan());
  go('plan');
  render();
}

async function importFile(file) {
  if (isBusy()) return toast('Wait for the current run to finish.', 'warning');
  if (file.size > 200 * 1024 * 1024) return toast('That file is too large to be a seeding template (over 200 MB).', 'error');
  let parsed;
  try {
    parsed = parseTemplate(await readFileAsText(file));
  } catch (e) {
    return toast(`Could not import ${file.name}: ${e.message}`, 'error');
  }
  if (state.plan.steps.length) {
    const ok = await confirmModal({ title: `Import "${parsed.plan.name}"?`, message: 'This replaces the current plan.', confirmLabel: 'Import' });
    if (!ok) return;
  }
  setPlan(parsed.plan, { snapshot: parsed.snapshot });
  for (const w of parsed.warnings) toast(w, 'warning', 8000);
  if (parsed.snapshot) {
    const targetOk = state.conn.target.status === 'connected';
    toast(`Imported "${parsed.plan.name}" with ${plural(parsed.snapshot.total, 'record')} of captured data. Only the Target org is needed: ${targetOk ? 'open Validate & run.' : 'connect it on the Connect tab, then Validate & run.'}`, 'success', 8000);
  } else {
    toast(`Imported "${parsed.plan.name}" with ${parsed.plan.steps.length} steps. It reads records from the Source org, so connect both orgs, then Validate & run.`, 'success', 8000);
  }
  state.view = 'plan';
  render();
}

function openHelp() {
  openModal({
    title: 'How it works',
    wide: true,
    render: () => h('div', { class: 'guide' },
      h('ol', null,
        h('li', null, h('strong', null, 'Connect'), ' a Source org (read only) and a Target sandbox.'),
        h('li', null, h('strong', null, 'Build a plan'), ': add objects, choose fields, filters (including Record Type by DeveloperName) and a LIMIT. Scope child objects to the extracted parents to keep data connected.'),
        h('li', null, h('strong', null, 'Find related records'), ' (any time, from the plan or after a dry run): the app checks the selected records for lookups to records that are not in the plan, shows them, and adds them on request, as a new step or into an existing one. Scan again to follow the chain further.'),
        h('li', null, h('strong', null, 'Validate'), ' to check schema compatibility and preview counts; ', h('strong', null, 'Dry run'), ' to also extract records and verify every Record Type exists in the Target.'),
        h('li', null, h('strong', null, 'Run'), ': records are inserted parent-first. Lookups are rewritten to the new Target Ids, hierarchies (e.g. Account.ParentId) are inserted level by level, and circular lookups are filled in by a final update pass.'),
        h('li', null, h('strong', null, 'Export'), ' the plan as a JSON template to reuse or share; ', h('strong', null, 'Import'), ' (or drag a file onto the page) to load one. Choose ', h('strong', null, 'Plan + record data'), ' to include a copy of the records: that file runs with only the Target org connected.')),
      h('p', { class: 'muted small' }, 'User lookups such as OwnerId are matched to the Target user with the same Username (sandbox suffixes like ".uat" are handled); unmatched users are left blank so you become the owner. Other lookups to records outside the plan are left blank.'),
      h('p', null, h('button', { class: 'link-btn', onclick: openSetupGuide }, 'External Client App setup guide'))),
  });
}

/** Every Salesforce call goes through the local server (server.ps1 or server.pl); warn early if the page was opened some other way. */
async function checkProxy() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (data && data.proxy) return;
  } catch { /* fall through */ }
  toast('The app cannot reach Salesforce because it was not opened by the start script. Close this tab and start the app with start.bat (Windows) or start.command (macOS).', 'error', 10000);
}

async function boot() {
  state.settings = await loadConfig();
  await loadSavedOrgs(); // from data/saved-orgs.json in the app folder
  const repaired = restoreDraft();
  try {
    const v = sessionStorage.getItem('sfseed.view');
    if (v && VIEWS[v]) state.view = v;
  } catch { /* ignore */ }
  wireEvents();
  render();
  for (const w of repaired) toast(w, 'info', 10000);
  await checkProxy();
  await restoreConnections();
  if (state.view === 'connect' && state.conn.source.status === 'connected' && state.conn.target.status === 'connected' && !sessionStorage.getItem('sfseed.view')) {
    go('plan');
  }
  emit('connections');
}

boot().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${e.message}`, 'error');
});
