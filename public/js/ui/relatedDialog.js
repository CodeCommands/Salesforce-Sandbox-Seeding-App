// "Find related records" dialog: scan → review findings → add → scan again (follows chains of lookups).
import { h, clear, fmtNum, plural } from '../util.js';
import { state, planChanged } from '../store.js';
import { scanRelatedRecords } from '../runController.js';
import { applyChoices, previewRecords, findMissingReferences } from '../discovery.js';
import { dependencyEdges, suggestOrder } from '../planner.js';
import { openModal, badge, spinner, toast } from './components.js';

/**
 * @param initial optional { findings } from a dry run, shown without rescanning first.
 */
export function openRelatedDialog({ initial = null } = {}) {
  let round = 0;
  let addedTotal = 0;
  return openModal({
    title: 'Find related records',
    wide: true,
    render: (close) => {
      const body = h('div', { class: 'related' });
      let abort = null;

      const scan = async (note) => {
        round++;
        abort = new AbortController();
        const label = h('span', null, 'Extracting the records your plan selects (read-only)…');
        clear(body).appendChild(h('div', null, note ? h('p', { class: 'callout callout-info small' }, note) : null, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), label)));
        try {
          const { extraction, findings } = await scanRelatedRecords({
            signal: abort.signal,
            onProgress: (p) => { if (p && p.label) label.textContent = `${p.label}…`; },
          });
          renderFindings(findings, extraction.total, extraction.steps.length);
        } catch (e) {
          if (e.name === 'AbortError') return;
          clear(body).appendChild(h('div', { class: 'callout callout-danger' }, e.message));
          body.appendChild(h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Close')));
        }
      };

      const renderFindings = (findings, scannedRecords, scannedSteps) => {
        clear(body);
        body.appendChild(h('p', { class: 'muted small' },
          round > 1 ? `Scan ${round}: ` : '',
          scannedRecords !== null ? `checked ${plural(scannedRecords, 'record')} in ${plural(scannedSteps, 'step')}. ` : '',
          'Lookups to users are matched by Username, and setup objects (profiles, queues, record types…) are never copied, so they are not listed.'));
        if (!findings.length) {
          body.appendChild(h('div', { class: 'callout callout-info' },
            h('strong', null, 'All related records are covered. '),
            addedTotal ? `Every lookup now points to a record in the plan (${plural(addedTotal, 'link')} added in this session).` : 'Every lookup in the selected records points to a record that is already in the plan, or is blank.'));
          body.appendChild(h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => close(addedTotal) }, 'Done')));
          return;
        }
        const totalMissing = findings.reduce((n, f) => n + f.missingIds.length, 0);
        body.appendChild(h('p', null,
          h('strong', null, `${plural(findings.length, 'lookup')} point${findings.length === 1 ? 's' : ''} to ${plural(totalMissing, 'record')} that ${totalMissing === 1 ? 'is' : 'are'} not in your plan. `),
          'Without them those lookups are left blank in the Target (or the record is skipped when the lookup is required). Tick the ones to add; this is optional.'));

        const rows = findings.map((f) => findingRow(f));
        body.appendChild(h('div', { class: 'finding-list' }, rows.map((r) => r.el)));
        const addBtn = h('button', { class: 'btn btn-primary' }, 'Add selected & scan again');
        const updateBtn = () => {
          const n = rows.filter((r) => r.checked()).length;
          addBtn.disabled = n === 0;
          addBtn.textContent = n ? `Add ${n} selected & scan again` : 'Add selected & scan again';
        };
        rows.forEach((r) => r.onChange(updateBtn));
        updateBtn();
        addBtn.addEventListener('click', async () => {
          const choices = rows.filter((r) => r.checked()).map((r) => ({ finding: r.finding, action: r.action() }));
          const { created, updated } = applyChoices(state.plan, choices);
          addedTotal += choices.length;
          await reorder();
          planChanged();
          if (created.length) state.selectedStepId = created[0].id;
          toast(`${created.length ? `Added ${plural(created.length, 'step')} (${created.map((s) => s.object).join(', ')})` : 'Plan updated'}${updated.length ? `; updated ${updated.map((s) => s.object).join(', ')}` : ''}.`, 'success');
          scan('Added. Scanning again to find records that the newly added records point to…');
        });
        body.appendChild(h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close(addedTotal) }, addedTotal ? 'Done' : 'Close'),
          addBtn));
      };

      const findingRow = (f) => {
        const cb = h('input', { type: 'checkbox', checked: f.required });
        const sel = h('select', { class: 'input' }, f.options.list.map((o) => h('option', { value: o.value, disabled: !!o.disabled, selected: o.value === f.options.defaultValue, title: o.hint || '' }, o.label + (o.disabled ? ' (not possible: would create a loop)' : ''))));
        sel.value = f.options.defaultValue;
        const previewBox = h('div', { class: 'finding-preview', hidden: true });
        let loaded = false;
        const toggle = h('button', { class: 'link-btn small' }, `Show the ${plural(f.missingIds.length, 'referenced record')}`);
        toggle.addEventListener('click', async () => {
          previewBox.hidden = !previewBox.hidden;
          toggle.textContent = previewBox.hidden ? `Show the ${plural(f.missingIds.length, 'referenced record')}` : 'Hide records';
          if (loaded || previewBox.hidden) return;
          loaded = true;
          previewBox.appendChild(spinner('Loading…'));
          try {
            const p = await previewRecords(state.conn.source.client, f.refObject, f.missingIds);
            clear(previewBox).appendChild(h('div', { class: 'table-wrap preview-table' }, h('table', { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, p.nameLabel), h('th', null, 'Record Id'))),
              h('tbody', null, p.rows.map((r) => h('tr', null, h('td', null, r.name || '—'), h('td', { class: 'mono small' }, r.Id)))))));
            if (p.notVisible) previewBox.appendChild(h('p', { class: 'small warning-text' }, `${plural(p.notVisible, 'record')} could not be read (deleted, or not shared with your user) and will be skipped.`));
            if (p.truncated) previewBox.appendChild(h('p', { class: 'small muted' }, `Showing the first ${fmtNum(p.requested)} of ${fmtNum(f.missingIds.length)}.`));
          } catch (e) {
            clear(previewBox).appendChild(h('p', { class: 'small danger-text' }, e.message));
          }
        });
        const pct = Math.round((f.populated / f.total) * 100);
        const el = h('div', { class: ['finding', f.required && 'finding-required'] },
          h('label', { class: 'finding-head' }, cb,
            h('span', null,
              h('strong', null, f.object), ' → ', h('strong', null, f.refObject), ' via ', f.fieldLabel, h('span', { class: 'mono muted small' }, ` (${f.field})`),
              f.required ? badge('required', 'warning', 'Records without this parent are skipped') : null,
              f.selfRef ? badge('hierarchy', 'info') : null)),
          h('p', { class: 'small muted finding-stats' },
            `${fmtNum(f.populated)} of ${plural(f.total, `${f.object} record`)} (${pct}%) have a value · ${plural(f.distinct, `distinct ${f.refObject} record`)} · `,
            h('strong', null, `${fmtNum(f.missingIds.length)} not in the plan`),
            f.inSeed ? ` · ${fmtNum(f.inSeed)} already included` : ''),
          h('div', { class: 'finding-action' }, sel),
          toggle,
          previewBox);
        return {
          el,
          finding: f,
          checked: () => cb.checked,
          action: () => sel.value,
          onChange: (fn) => cb.addEventListener('change', fn),
        };
      };

      if (initial && initial.findings) {
        round = 1;
        // Recompute options against the current plan (it may have changed since the dry run).
        const s = state.conn.source;
        const refreshed = initial.extraction && s.client
          ? findMissingReferences(initial.extraction, { describeFor: (n) => s.client.peekDescribe(n), globalSobjects: s.global, keyPrefixes: s.keyPrefixes, plan: state.plan })
          : initial.findings;
        renderFindings(refreshed, initial.extraction ? initial.extraction.total : null, initial.extraction ? initial.extraction.steps.length : 0);
      } else {
        scan();
      }
      return body;
    },
  });
}

/** Parents before children after adding steps (stable: keeps the user's order where possible). */
async function reorder() {
  const s = state.conn.source;
  try {
    await Promise.all(state.plan.steps.map((st) => s.client.describe(st.object)));
  } catch {
    return;
  }
  const steps = state.plan.steps;
  const edges = dependencyEdges(steps.filter((st) => st.enabled !== false), (n) => s.client.peekDescribe(n));
  const { order } = suggestOrder(steps, edges);
  const pos = new Map(order.map((id, i) => [id, i]));
  steps.sort((a, b) => pos.get(a.id) - pos.get(b.id));
}
