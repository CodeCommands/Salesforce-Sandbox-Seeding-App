import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOrgSetupLookup } from '../public/js/schema.js';
import { buildFieldPlan } from '../public/js/preflight.js';
import { transformRecord } from '../public/js/engine.js';
import { newStep } from '../public/js/template.js';
import { field } from './fixtures.mjs';

// Case as Salesforce describes it: BusinessHoursId may be marked required, but Salesforce fills in the default.
const caseDescribe = () => ({
  name: 'Case',
  fields: [
    field('Id', 'id', { createable: false, nillable: false }),
    field('Subject', 'string'),
    field('AccountId', 'reference', { referenceTo: ['Account'] }),
    field('BusinessHoursId', 'reference', { referenceTo: ['BusinessHours'], nillable: false }),
    field('OwnerId', 'reference', { referenceTo: ['Group', 'User'], nillable: false, defaultedOnCreate: true }),
  ],
});

test('lookups that only point to org setup data are recognized; User and copyable objects are not', () => {
  const [, , acc, bh, owner] = caseDescribe().fields;
  assert.equal(isOrgSetupLookup(bh), true);
  assert.equal(isOrgSetupLookup(owner), false, 'can point to a User, which is matched by Username');
  assert.equal(isOrgSetupLookup(acc), false);
});

test('Case.BusinessHoursId is left to the Target org, so the Case is inserted instead of skipped', () => {
  const step = newStep('Case');
  const fp = buildFieldPlan(step, caseDescribe(), caseDescribe());
  assert.deepEqual(fp.orgDefaulted.map((f) => f.name), ['BusinessHoursId']);
  assert.ok(!fp.insertFields.some((f) => f.name === 'BusinessHoursId'));
  const st = { idMap: new Map(), userMap: new Map(), keyPrefixes: new Map([['01m', 'BusinessHours']]), extracted: new Map(), failed: new Set(), preserve: new Set(), planObjects: new Set(['case']), rtResolution: new Map() };
  const out = transformRecord({ Id: '500000000000001AAA', Subject: 'Broken', BusinessHoursId: '01m000000000001AAA' }, 'Case', fp, st);
  assert.equal(out.skip, undefined);
  assert.equal(out.payload.Subject, 'Broken');
  assert.ok(!('BusinessHoursId' in out.payload));
});

test('"Keep Ids as-is" for BusinessHours copies the field again', () => {
  const fp = buildFieldPlan(newStep('Case'), caseDescribe(), caseDescribe(), { preserve: new Set(['businesshours']) });
  assert.equal(fp.orgDefaulted.length, 0);
  assert.ok(fp.insertFields.some((f) => f.name === 'BusinessHoursId'));
});
