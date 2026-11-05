// Tab 3: validate, dry run, run, monitor, download results, roll back.
import { h, clear, fmtNum, plural } from '../util.js';
import { state, on } from '../store.js';
import {
  validate, execute, stop, isBusy, rollbackRun, rollbackCandidates, downloadIdMap, downloadFailures, downloadLog, clearLog,
} from '../runController.js';
import { badge, confirmModal, emptyState } from './components.js';
import { openRelatedDialog } from './relatedDialog.js';

let refs = null;
let showDebug = false;
let levelFilter = 'all';

const LEVEL_ORDER = { error: 0, warning: 1, info: 2, ok: 3 };
const LEVEL_LABEL = { error: 'Error', warning: 'Warning', info: 'Note', ok: 'OK' };

// Live log and progress updates patch the DOM directly instead of re-rendering.
on('run:log', (line) => {
  if (refs && refs.log && refs.log.isConnected) appendLogLine(refs.log, line, true);
});
on('run:progress', () => {
  if (refs && refs.progress && refs.progress.isConnected) renderProgress(refs.progress);
});

export function renderRunView(container) {
  const run = state.run;
  const busy = isBusy();
  const s = state.conn.source;
  const t = state.conn.target;
  const ready = s.status === 'connected' && t.status === 'connected';
  const enabledSteps = state.plan.steps.filter((x) => x.enabled !== false).length;

  const progress = h('div', { class: 'progress-wrap' });
  const logEl = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
  refs = { progress, log: logEl };

  const view = h('section', { class: 'view run-view' },
    h('div', { class: 'card run-toolbar' },
      h('div', null,
        h('h1', null, 'Validate & run'),
        h('p', { class: 'muted small' },
          ready ? [h('strong', null, s.org ? s.org.Name : 'Source'), ' → ', h('strong', null, t.org ? t.org.Name : 'Target'), ' ', t.org && t.org.IsSandbox === false ? badge('PRODUCTION', 'danger') : badge('Sandbox', 'info'), ` · ${plural(enabledSteps, 'step')}`]
            : 'Connect both orgs on the Connect tab first.')),
      h('div', { class: 'toolbar-actions' },
        h('button', { class: 'btn', disabled: busy || !ready, onclick: validate, title: 'Schema checks, query validation and preview counts' }, 'Validate'),
        h('button', { class: 'btn', disabled: busy || !ready, onclick: () => execute({ dryRun: true }), title: 'Extract and run every pre-flight check without inserting anything' }, 'Dry run'),
        h('button', { class: 'btn btn-primary', disabled: busy || !ready || !enabledSteps, onclick: () => execute({ dryRun: false, confirm: confirmRun }) }, 'Run seeding'),
        busy ? h('button', { class: 'btn btn-danger', onclick: stop }, 'Stop') : null)),
    progress);

  renderProgress(progress);

  if (!run) {
    view.appendChild(h('div', { class: 'card' }, emptyState('Nothing run yet',
      'Validate checks the plan and shows preview counts. Dry run also extracts records and checks record types against the Target org. Run seeding asks for confirmation before inserting.')));
  } else {
    if (run.staticReport || run.dataReport) view.appendChild(reportCard(run));
    if (run.extraction || run.result) view.appendChild(resultsCard(run));
  }
  if (!busy && run && run.related && run.related.length && run.extraction) view.appendChild(relatedCard(run));
  const rb = !busy ? rollbackCandidates() : null;
  if (rb) view.appendChild(rollbackCard(rb));

  view.appendChild(logCard(logEl));
  container.appendChild(view);
  if (run) for (const line of run.logs) appendLogLine(logEl, line, false);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderProgress(el) {
  clear(el);
  const run = state.run;
  if (!run || run.status !== 'running') {
    if (run && run.status !== 'running') {
      const map = {
        done: ['success', run.mode === 'validate' ? 'Validation passed' : run.mode === 'dry' ? 'Dry run complete' : run.mode === 'rollback' ? 'Rollback complete' : 'Run complete'],
        blocked: ['danger', 'Blocked by pre-flight errors: nothing was inserted'],
        failed: ['danger', 'Failed (see log)'],
        stopped: ['warning', 'Stopped'],
        cancelled: ['neutral', 'Cancelled'],
      };
      const [kind, text] = map[run.status] || ['neutral', run.status];
      el.appendChild(h('div', { class: ['status-line', `status-${kind}`] }, text, run.finishedAt ? h('span', { class: 'muted small' }, ` · ${new Date(run.finishedAt).toLocaleTimeString()}`) : null));
    }
    return;
  }
  const p = run.progress;
  const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  const bar = h('div', { class: 'progress-bar' }, h('div', { class: ['progress-fill', pct === null && 'indeterminate'] }));
  if (pct !== null) bar.firstChild.style.width = `${pct}%`;
  el.appendChild(h('div', { class: 'progress' },
    h('div', { class: 'progress-label' }, h('span', { class: 'spinner' }), (p && p.label) || run.label || 'Working…',
      p && p.total ? h('span', { class: 'muted' }, ` ${fmtNum(p.done)} / ${fmtNum(p.total)}`) : null),
    bar));
}

function reportCard(run) {
  const items = [
    ...(run.staticReport ? run.staticReport.items.map((i) => ({ ...i, phase: 'Schema' })) : []),
    ...(run.dataReport ? run.dataReport.items.map((i) => ({ ...i, phase: 'Data' })) : []),
  ].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const errors = items.filter((i) => i.level === 'error').length;
  const warnings = items.filter((i) => i.level === 'warning').length;
  return h('div', { class: 'card' },
    h('div', { class: 'section-title' },
      h('h3', null, 'Pre-flight report'),
      h('div', { class: 'badges' },
        errors ? badge(plural(errors, 'error'), 'danger') : badge('No errors', 'success'),
        warnings ? badge(plural(warnings, 'warning'), 'warning') : null)),
    h('ul', { class: 'report' }, items.map((i) => h('li', { class: ['report-item', `report-${i.level}`] },
      h('span', { class: 'report-level' }, LEVEL_LABEL[i.level]),
      h('span', { class: 'report-msg' }, i.message),
      h('span', { class: 'muted small report-phase' }, i.phase)))));
}

function resultsCard(run) {
  const steps = run.extraction ? run.extraction.steps : state.plan.steps.filter((s) => s.enabled !== false);
  const r = run.result;
  const rows = steps.map((step, i) => {
    const ex = run.extraction ? run.extraction.stats.get(step.id) : null;
    const c = run.counts ? run.counts.get(step.id) : null;
    const st = r ? r.stepStats.get(step.id) : null;
    return h('tr', null,
      h('td', null, String(i + 1)),
      h('td', null, step.object),
      h('td', { class: 'num' }, c ? (c.count === null ? 'referenced' : `${fmtNum(c.expected)}${c.scoped ? ' (max)' : ''}${c.referenced ? ' + ref.' : ''}`) : '—'),
      h('td', { class: 'num' }, ex ? fmtNum(ex.extracted) : '—'),
      h('td', { class: 'num success-text' }, st ? fmtNum(st.inserted) : '—'),
      h('td', { class: ['num', st && st.failed + st.skipped ? 'danger-text' : ''] }, st ? fmtNum(st.failed + st.skipped) : '—'),
      h('td', { class: 'num' }, st ? `${fmtNum(st.updated)}${st.deferred ? ` / ${fmtNum(st.deferred)}` : ''}` : '—'));
  });
  return h('div', { class: 'card' },
    h('div', { class: 'section-title' }, h('h3', null, 'Results by step'),
      r ? h('div', { class: 'inline-actions' },
        h('button', { class: 'btn btn-small', onclick: downloadIdMap, disabled: !r.created.length }, 'Download Id map (CSV)'),
        h('button', { class: 'btn btn-small', onclick: downloadFailures, disabled: !r.failures.length }, `Download errors (${fmtNum(r.failures.length)})`)) : null),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', null, '#'), h('th', null, 'Object'), h('th', { class: 'num' }, 'Preview'), h('th', { class: 'num' }, 'Extracted'),
        h('th', { class: 'num' }, 'Inserted'), h('th', { class: 'num' }, 'Failed / skipped'), h('th', { class: 'num', title: 'Lookups set by update after insert / lookups deferred' }, 'Back-filled'))),
      h('tbody', null, rows))),
    r && r.failures.length ? h('details', { class: 'failures' },
      h('summary', null, `First ${Math.min(50, r.failures.length)} errors`),
      h('ul', { class: 'small' }, r.failures.slice(0, 50).map((f) => h('li', null, h('span', { class: 'mono' }, `${f.object} ${f.sourceId}`), ` [${f.stage}] ${f.message}`)))) : null);
}

function relatedCard(run) {
  const total = run.related.reduce((n, f) => n + f.missingIds.length, 0);
  return h('div', { class: 'card related-card' },
    h('div', { class: 'section-title' },
      h('h3', null, 'Related records not in this seed'),
      h('button', { class: 'btn btn-small btn-primary', onclick: () => openRelatedDialog({ initial: { findings: run.related, extraction: run.extraction } }) }, 'Review & add…')),
    h('p', { class: 'small muted' }, `The extracted records point to ${plural(total, 'record')} that the plan does not include. Their lookups will be left blank unless you add them.`),
    h('ul', { class: 'small' }, run.related.slice(0, 6).map((f) => h('li', null,
      h('strong', null, `${f.object}.${f.field}`), ` → ${plural(f.missingIds.length, `${f.refObject} record`)} missing (${fmtNum(f.populated)} of ${fmtNum(f.total)} ${f.object} records have a value)`,
      f.required ? badge('required', 'warning') : null))),
    run.related.length > 6 ? h('p', { class: 'small muted' }, `…and ${run.related.length - 6} more.`) : null);
}

function rollbackCard(rb) {
  return h('div', { class: 'card rollback-card' },
    h('div', { class: 'section-title' },
      h('h3', null, 'Undo'),
      h('p', { class: 'muted small' }, rb.source === 'stored'
        ? `A previous run in this browser created ${plural(rb.created.length, 'record')} in this Target org: ${rb.label}.`
        : `This run created ${plural(rb.created.length, 'record')} in the Target org.`)),
    h('button', {
      class: 'btn btn-danger-ghost',
      onclick: async () => {
        const t = state.conn.target.org;
        const ok = await confirmModal({
          title: 'Delete the records created by this run?',
          message: `${plural(rb.created.length, 'record')} will be deleted from ${t ? t.Name : 'the Target org'} (newest first). They go to the Recycle Bin. Records created by triggers or flows are not tracked and will not be removed.`,
          confirmLabel: 'Delete records',
          danger: true,
          requireText: 'DELETE',
        });
        if (ok) rollbackRun();
      },
    }, `Delete ${plural(rb.created.length, 'created record')}`));
}

function logCard(logEl) {
  const levelSel = h('select', { class: 'input input-small', 'aria-label': 'Log level', onchange: (e) => { levelFilter = e.target.value; applyLogFilter(logEl); } },
    [['all', 'All messages'], ['warn', 'Warnings & errors'], ['error', 'Errors only']].map(([v, l]) => h('option', { value: v, selected: levelFilter === v }, l)));
  return h('div', { class: 'card' },
    h('div', { class: 'section-title' },
      h('h3', null, 'Log'),
      h('div', { class: 'inline-actions' },
        levelSel,
        h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: showDebug, onchange: (e) => { showDebug = e.target.checked; applyLogFilter(logEl); } }), 'Show SOQL'),
        h('button', { class: 'btn btn-small', onclick: downloadLog }, 'Download log'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: clearLog, disabled: isBusy() }, 'Clear'))),
    logEl);
}

function lineVisible(level) {
  if (level === 'debug') return showDebug;
  if (levelFilter === 'error') return level === 'error';
  if (levelFilter === 'warn') return level === 'error' || level === 'warn';
  return true;
}

function appendLogLine(logEl, line, scroll) {
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const el = h('div', { class: ['log-line', `log-${line.level}`], dataset: { level: line.level } },
    h('span', { class: 'log-time' }, line.t), h('span', { class: 'log-msg' }, line.message));
  el.hidden = !lineVisible(line.level);
  logEl.appendChild(el);
  while (logEl.childNodes.length > 2000) logEl.removeChild(logEl.firstChild);
  if (scroll && nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function applyLogFilter(logEl) {
  for (const el of logEl.children) el.hidden = !lineVisible(el.dataset.level);
}

/** Final confirmation before any insert. Production targets require typing the org name. */
function confirmRun(summary) {
  const list = h('ul', { class: 'small' }, summary.steps.map((s) => h('li', null, `${s.object}: ${fmtNum(s.count)}`)));
  const prod = summary.targetIsSandbox === false;
  return confirmModal({
    title: `Insert ${plural(summary.total, 'record')}?`,
    message: h('div', null,
      h('p', null, 'Into ', h('strong', null, summary.targetName), prod ? h('strong', { class: 'danger-text' }, ' (PRODUCTION)') : ' (sandbox)', ':'),
      list,
      summary.warnings ? h('p', { class: 'warning-text small' }, `${plural(summary.warnings, 'pre-flight warning')}: review the report before continuing.`) : null,
      h('p', { class: 'muted small' }, 'Records are inserted in batches with partial success allowed. You can stop at any time and roll back what was created.')),
    confirmLabel: 'Insert records',
    danger: prod,
    requireText: prod ? summary.targetName : null,
  });
}
