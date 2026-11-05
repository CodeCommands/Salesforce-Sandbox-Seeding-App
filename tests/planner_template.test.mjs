import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencyEdges, suggestOrder, checkOrder } from '../public/js/planner.js';
import { parseTemplate, toTemplate, newPlan, newStep, planFromDraft } from '../public/js/template.js';
import { RecordTypeIndex, qualifyRt, splitQualifiedRt } from '../public/js/schema.js';
import { describes } from './fixtures.mjs';

const { source } = describes();
const describeFor = (n) => source[n];

function plan(...objects) {
  const p = newPlan('t');
  p.steps = objects.map((o) => newStep(o));
  return p;
}

test('suggestOrder puts required and optional parents first, keeps user order otherwise', () => {
  const p = plan('Contact', 'Child__c', 'Account');
  const edges = dependencyEdges(p.steps, describeFor);
  const { order, brokenEdges, requiredCycle } = suggestOrder(p.steps, edges);
  const names = order.map((id) => p.steps.find((s) => s.id === id).object);
  assert.deepEqual(names, ['Account', 'Contact', 'Child__c']);
  assert.equal(brokenEdges.length, 0);
  assert.equal(requiredCycle.length, 0);
});

test('checkOrder: required parent after child is an error, optional one is a back-fill', () => {
  const p = plan('Child__c', 'Contact', 'Account');
  const edges = dependencyEdges(p.steps, describeFor);
  const { errors, backfills } = checkOrder(p.steps, edges);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Child__c\.Parent__c .*required/);
  assert.equal(backfills.length, 1);
  assert.match(backfills[0].message, /Contact\.AccountId/);
});

test('self references do not create edges within a step', () => {
  const p = plan('Account');
  assert.equal(dependencyEdges(p.steps, describeFor).length, 0);
});

test('disabled steps are ignored for dependencies', () => {
  const p = plan('Account', 'Contact');
  p.steps[0].enabled = false;
  assert.equal(dependencyEdges(p.steps, describeFor).length, 0);
});

test('template round trip keeps order, filters, scopes (remapped ids)', () => {
  const p = plan('Account', 'Contact');
  p.steps[0].filters = [{ id: 'f', field: 'RecordTypeId', operator: 'eq', value: 'Partner' }];
  p.steps[1].parentScopes = [{ field: 'AccountId', stepId: p.steps[0].id }];
  p.steps[1].fieldMode = 'selected';
  p.steps[1].fields = ['LastName', 'AccountId'];
  p.settings.preserveLookupsTo = ['User'];
  const doc = toTemplate(p);
  assert.equal(doc.format, 'sf-sandbox-seeding-template');
  assert.equal(doc.steps[1].order, 2);
  const { plan: back, warnings } = parseTemplate(JSON.stringify(doc));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back.steps.map((s) => s.object), ['Account', 'Contact']);
  assert.equal(back.steps[0].filters[0].value, 'Partner');
  assert.equal(back.steps[1].parentScopes[0].stepId, back.steps[0].id);
  assert.notEqual(back.steps[0].id, p.steps[0].id, 'imported templates get fresh ids');
  assert.deepEqual(back.settings.preserveLookupsTo, ['User']);
  const draft = planFromDraft(doc);
  assert.equal(draft.steps[0].id, p.steps[0].id, 'drafts keep ids');
});

test('template import validation', () => {
  assert.throws(() => parseTemplate('nope'), /Not valid JSON/);
  assert.throws(() => parseTemplate('{"format":"other","steps":[]}'), /Unknown template format/);
  assert.throws(() => parseTemplate('{"schemaVersion":99,"steps":[]}'), /newer/);
  const { plan: p, warnings } = parseTemplate({
    steps: [
      { order: 2, object: 'Contact', parentScopes: [{ field: 'AccountId', stepId: 'gone' }], filters: [{ field: 'Name', operator: 'weird', value: 'x' }] },
      { order: 1, object: 'Account', limit: -5 },
      { object: 'Bad Object!' },
    ],
  });
  assert.deepEqual(p.steps.map((s) => s.object), ['Account', 'Contact']);
  assert.equal(p.steps[0].limit, 100);
  assert.equal(p.steps[1].parentScopes.length, 0);
  assert.equal(p.steps[1].filters[0].operator, 'eq');
  assert.equal(warnings.length, 3);
});

test('record type index resolves exact, namespace-mismatch and ambiguous', () => {
  const idx = new RecordTypeIndex([
    { Id: '012A', SobjectType: 'Account', DeveloperName: 'Partner', NamespacePrefix: null, IsActive: true },
    { Id: '012B', SobjectType: 'Account', DeveloperName: 'Pkg_Type', NamespacePrefix: 'abc', IsActive: true },
    { Id: '012C', SobjectType: 'Case', DeveloperName: 'Dup', NamespacePrefix: 'x', IsActive: true },
    { Id: '012D', SobjectType: 'Case', DeveloperName: 'Dup', NamespacePrefix: 'y', IsActive: true },
  ]);
  assert.equal(idx.resolve('account', 'partner').row.Id, '012A');
  assert.equal(idx.resolve('Account', 'abc__Pkg_Type').row.Id, '012B');
  const mm = idx.resolve('Account', 'zzz__Pkg_Type');
  assert.equal(mm.row.Id, '012B');
  assert.equal(mm.namespaceMismatch, true);
  assert.equal(idx.resolve('Case', 'Dup').ambiguous.length, 2);
  assert.equal(idx.resolve('Account', 'Missing').row, null);
  assert.equal(qualifyRt('ns', 'Dev'), 'ns__Dev');
  assert.deepEqual(splitQualifiedRt('Dev'), { namespace: null, developerName: 'Dev' });
});
