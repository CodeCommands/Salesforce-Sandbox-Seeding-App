import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newPlan, newStep, toTemplate, parseTemplate, TEMPLATE_ID_RE } from '../public/js/template.js';
import { listRuns, saveRun, forgetRecords, runsInOrg } from '../public/js/runHistory.js';

/** Minimal localStorage; `limit` makes setItem throw like a full browser storage. */
function memoryStorage(limit = Infinity) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const size = [...m].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0) + String(v).length;
      if (size > limit) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
  };
}

beforeEach(() => {
  globalThis.window = { localStorage: memoryStorage() };
});

const run = (id, { templateId = 'tpl-a', org = '00DT00000000001AAA', n = 2, startedAt = `2026-11-0${id.slice(-1)}T10:00:00.000Z` } = {}) => ({
  id, templateId, templateName: `Plan ${templateId}`, startedAt, status: 'done', targetOrgId: org, targetOrgName: 'UAT',
  created: Array.from({ length: n }, (_, i) => ({ o: 'Account', s: `001S${id}${i}`, t: `001T${id}${i}` })),
});

test('every plan has a permanent template ID that survives export, import and draft restore', () => {
  const plan = newPlan('p');
  assert.match(plan.templateId, TEMPLATE_ID_RE);
  plan.steps = [newStep('Account')];
  const doc = toTemplate(plan);
  assert.equal(doc.templateId, plan.templateId);
  const { plan: again } = parseTemplate(JSON.stringify(doc));
  assert.equal(again.templateId, plan.templateId, 'same ID after import');
  again.steps.push(newStep('Contact'));
  const { plan: edited } = parseTemplate(JSON.stringify(toTemplate(again)));
  assert.equal(edited.templateId, plan.templateId, 'editing does not change it');

  const old = toTemplate(plan);
  delete old.templateId;
  const { plan: legacy } = parseTemplate(JSON.stringify(old));
  assert.match(legacy.templateId, TEMPLATE_ID_RE, 'templates from earlier versions get one');
  assert.notEqual(legacy.templateId, plan.templateId);
  old.templateId = 'not-a-uuid';
  assert.match(parseTemplate(JSON.stringify(old)).plan.templateId, TEMPLATE_ID_RE);
});

test('runs are split into this template and others, per Target org', () => {
  saveRun(run('r1'));
  saveRun(run('r2', { templateId: 'tpl-b' }));
  saveRun(run('r3', { org: '00DX00000000009AAA' }));
  const { mine, others } = runsInOrg('00DT00000000001', 'tpl-a'); // 15-character org Id matches too
  assert.deepEqual(mine.map((r) => r.id), ['r1']);
  assert.deepEqual(others.map((r) => r.id), ['r2']);
  assert.equal(listRuns()[0].id, 'r3', 'newest first');
});

test('deleted records are forgotten; a run with nothing left disappears', () => {
  saveRun(run('r1', { n: 3 }));
  forgetRecords(['r1'], ['001Tr10', '001Tr11']);
  assert.deepEqual(listRuns()[0].created.map((c) => c.t), ['001Tr12'], 'failed deletes stay listed');
  forgetRecords(['r1'], ['001Tr12']);
  assert.equal(listRuns().length, 0);
});

test('the single "last run" of earlier versions is moved into the history', () => {
  window.localStorage.setItem('sfseed.lastRun', JSON.stringify({ planName: 'Old', startedAt: '2026-10-01T00:00:00Z', targetOrgId: '00DT00000000001AAA', targetOrgName: 'UAT', created: [{ o: 'Account', s: 'a', t: 'b' }] }));
  const runs = listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].templateName, 'Old');
  assert.equal(runs[0].templateId, null);
  assert.equal(window.localStorage.getItem('sfseed.lastRun'), null);
  assert.equal(runsInOrg('00DT00000000001AAA', 'tpl-a').others.length, 1, 'shown under other templates');
});

test('when storage is full the oldest other runs are dropped, never the current one', () => {
  saveRun(run('r1', { n: 40 }));
  saveRun(run('r2', { n: 40 }));
  const size = window.localStorage.getItem('sfseed.runs').length;
  const data = new Map([['sfseed.runs', window.localStorage.getItem('sfseed.runs')]]);
  globalThis.window = { localStorage: memoryStorage(size + 200) };
  window.localStorage.setItem('sfseed.runs', data.get('sfseed.runs'));
  const res = saveRun(run('r3', { n: 40 }));
  assert.equal(res.saved, true);
  assert.deepEqual(res.dropped.map((r) => r.id), ['r1']);
  assert.deepEqual(listRuns().map((r) => r.id), ['r3', 'r2']);

  globalThis.window = { localStorage: memoryStorage(10) };
  assert.equal(saveRun(run('r4')).saved, false);
});
