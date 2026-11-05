// Export dialog (plan only, or plan + captured record data) and the "capture data" progress dialog.
import { h, clear, plural, fmtNum, slugify } from '../util.js';
import { state, setSnapshot, snapshotState } from '../store.js';
import { exportTemplate } from '../template.js';
import { captureData, isBusy } from '../runController.js';
import { snapshotSummary } from '../snapshot.js';
import { openModal, toast } from './components.js';

const LARGE_BYTES = 25 * 1024 * 1024;

/**
 * Extracts the plan from the Source (read-only) in a small progress dialog and stores the result.
 * Resolves with the snapshot, or null when cancelled or failed.
 */
export function captureWithProgress() {
  if (isBusy()) {
    toast('Wait for the current run to finish.', 'warning');
    return Promise.resolve(null);
  }
  let result = null;
  return openModal({
    title: 'Capturing record data',
    dismissable: false,
    render: (close) => {
      const abort = new AbortController();
      const label = h('span', null, 'Extracting the records your plan selects (read-only)…');
      const body = h('div', null,
        h('div', { class: 'loading' }, h('span', { class: 'spinner' }), label),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => { abort.abort(); close(); } }, 'Cancel')));
      captureData({ signal: abort.signal, onProgress: (p) => { if (p && p.label) label.textContent = `${p.label}…`; } })
        .then((snap) => {
          if (abort.signal.aborted) return;
          setSnapshot(snap);
          result = snap;
          toast(`Captured ${plural(snap.total, 'record')}.`, 'success');
          close();
        })
        .catch((e) => {
          if (abort.signal.aborted || e.name === 'AbortError') return;
          clear(body).append(h('div', { class: 'callout callout-danger' }, `Could not capture the records: ${e.message}`),
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Close')));
        });
      return body;
    },
  }).then(() => result);
}

export function openExportDialog() {
  if (!state.plan.steps.length) {
    toast('Add at least one object before exporting.', 'warning');
    return;
  }
  openModal({
    title: 'Export template',
    wide: true,
    render: (close) => {
      const { snap, usable, stale } = snapshotState();
      const sourceOk = state.conn.source.status === 'connected';
      const canData = usable || sourceOk;
      let choice = usable ? 'data' : 'plan';

      const dataNote = usable
        ? h('span', null, `Uses the data already captured: ${snapshotSummary(snap)}. `, sourceOk ? h('button', { class: 'link-btn', onclick: async () => { close(); await captureWithProgress(); openExportDialog(); } }, 'Capture again') : null)
        : sourceOk
          ? `The records are extracted from ${state.conn.source.org ? state.conn.source.org.Name : 'the Source org'} now (read-only).${stale ? ' The earlier capture is out of date because the plan changed.' : ''}`
          : 'Connect the Source org to capture records.';

      const warning = h('p', { class: 'callout callout-warning small', hidden: choice !== 'data' },
        h('strong', null, 'Record data is a copy of real data. '),
        'It can include names, emails and other personal information from the Source org. Store and share the file the way your company handles data exports, and delete it when you no longer need it.');
      const option = (value, title, file, lines, disabled) => h('label', { class: ['choice', disabled && 'choice-disabled'] },
        h('input', { type: 'radio', name: 'export-kind', checked: choice === value, disabled, onchange: () => { choice = value; warning.hidden = value !== 'data'; } }),
        h('span', { class: 'choice-text' },
          h('span', { class: 'choice-title' }, title, ' ', h('span', { class: 'mono muted small' }, file)),
          ...lines.map((l) => h('span', { class: 'choice-detail small muted' }, l))));

      const base = slugify(state.plan.name);
      const exportBtn = h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (choice === 'plan') {
            exportTemplate(state.plan);
            toast('Template downloaded.', 'success');
            close();
            return;
          }
          close();
          let data = snapshotState().usable ? state.snapshot : null;
          if (!data) data = await captureWithProgress();
          if (!data) return;
          const doc = exportTemplate(state.plan, { snapshot: data });
          const size = JSON.stringify(doc).length;
          toast(`Template with ${plural(doc.data.total, 'record')} downloaded (${fmtNum(Math.round(size / 1024))} KB).`, 'success');
          if (size > LARGE_BYTES) toast('That file is large. Importing it may take a moment, and some browsers limit how much can be kept between page reloads.', 'warning', 8000);
        },
      }, 'Export');

      return h('div', { class: 'export-dialog' },
        h('div', { class: 'choice-list', role: 'radiogroup' },
          option('plan', 'Plan only', `${base}.seed.json`, [
            'Objects, fields, filters, links and settings. No records.',
            'Running it needs both orgs: records are read fresh from the Source org every run.',
          ], false),
          option('data', 'Plan + record data', `${base}.seed-data.json`, [
            'Also contains a copy of every record the plan selects.',
            'Running it needs only the Target org: import it, connect the Target, then Validate & run.',
            dataNote,
          ], !canData)),
        warning,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), exportBtn));
    },
  });
}
