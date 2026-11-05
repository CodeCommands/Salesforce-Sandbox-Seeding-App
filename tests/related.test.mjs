import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, load, createLoadResult } from '../public/js/engine.js';
import { dataPreflight, staticPreflight } from '../public/js/preflight.js';
import { extractionOrder } from '../public/js/planner.js';
import { findMissingReferences, applyChoices, actionOptions } from '../public/js/discovery.js';
import { newPlan, newStep, toTemplate, parseTemplate } from '../public/js/template.js';
import { sandboxSuffixFromUrl, orgUsernameSuffix, candidateUsernames, buildUserMap } from '../public/js/users.js';
import { latestApiVersion, FALLBACK_API_VERSION } from '../public/js/config.js';
import { describes, MockSource, MockTarget, KEY_PREFIXES, id, rtIndex, APP_SETTINGS } from './fixtures.mjs';

const A = (n) => id('001', n);
const C = (n) => id('003', n);
const U = (n) => id('005', n);
const T = (n) => `005T${String(n).padStart(14, '0')}`;
const noRt = { RecordTypeId: null, RecordType: null };
const GLOBAL = [
  { name: 'Account', queryable: true, createable: true },
  { name: 'Contact', queryable: true, createable: true },
  { name: 'Child__c', queryable: true, createable: true },
  { name: 'User', queryable: true, createable: true },
];

function setup({ rows, steps, users = null }) {
  const d = describes();
  const source = new MockSource(d.source, rows);
  const target = new MockTarget(d.target);
  if (users) {
    target.queryAll = async (soql) => {
      const names = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return users.target.filter((u) => names.includes(u.Username.toLowerCase()));
    };
  }
  const plan = newPlan('t');
  plan.steps = steps;
  const ctx = {
    source, target, plan, appSettings: APP_SETTINGS,
    orgs: { source: { Id: 'S', IsSandbox: false }, target: { Id: 'T', IsSandbox: true } },
    sourceRt: rtIndex([]), targetRt: rtIndex([]), sourceKeyPrefixes: KEY_PREFIXES, sourceGlobal: GLOBAL,
    userInfo: users ? users.info : null,
    log: () => {}, progress: () => {},
  };
  return { ctx, source, target, plan };
}

const env = (ctx) => ({ describeFor: (n) => ctx.source.peekDescribe(n), globalSobjects: GLOBAL, keyPrefixes: KEY_PREFIXES, plan: ctx.plan });

// ---------------------------------------------------------------------------

test('discovery reports lookups to records outside the plan, with counts', async () => {
  const con = newStep('Contact');
  const rows = {
    Contact: [
      ...Array.from({ length: 30 }, (_, i) => ({ Id: C(i + 1), LastName: `c${i}`, AccountId: A((i % 3) + 1), OwnerId: U(1) })),
      ...Array.from({ length: 20 }, (_, i) => ({ Id: C(i + 31), LastName: `n${i}`, AccountId: null, OwnerId: U(1) })),
    ],
  };
  con.limit = 50;
  const { ctx } = setup({ rows, steps: [con] });
  const extraction = await extract(ctx);
  const findings = findMissingReferences(extraction, env(ctx));
  assert.equal(findings.length, 1, 'User lookups are not reported (matched by Username)');
  const f = findings[0];
  assert.equal(f.field, 'AccountId');
  assert.equal(f.refObject, 'Account');
  assert.equal(f.total, 50);
  assert.equal(f.populated, 30);
  assert.equal(f.distinct, 3);
  assert.equal(f.missingIds.length, 3);
  assert.equal(f.options.defaultValue, 'new');
});

test('adding a referenced step pulls exactly those parents, extracted after and inserted before the child', async () => {
  const con = newStep('Contact');
  const rows = {
    Account: [{ Id: A(1), Name: 'A1', OwnerId: U(1), ...noRt }, { Id: A(2), Name: 'A2', OwnerId: U(1), ...noRt }, { Id: A(3), Name: 'unrelated', OwnerId: U(1), ...noRt }],
    Contact: [{ Id: C(1), LastName: 'c1', AccountId: A(1), OwnerId: U(1) }, { Id: C(2), LastName: 'c2', AccountId: A(2), OwnerId: U(1) }],
  };
  const { ctx, target, plan } = setup({ rows, steps: [con] });
  const findings = findMissingReferences(await extract(ctx), env(ctx));
  const { created } = applyChoices(plan, [{ finding: findings[0], action: 'new' }]);
  assert.equal(created.length, 1);
  assert.deepEqual(plan.steps.map((s) => s.object), ['Account', 'Contact'], 'new parent step is placed before the child');
  assert.equal(plan.steps[0].recordSource, 'referenced');
  assert.deepEqual(extractionOrder(plan.steps).order.map((s) => s.object), ['Contact', 'Account']);

  const extraction = await extract(ctx);
  assert.deepEqual(extraction.byStep.get(plan.steps[0].id).map((r) => r.Name).sort(), ['A1', 'A2']);
  assert.equal(findMissingReferences(extraction, env(ctx)).length, 0, 'second scan finds nothing missing');
  const pf = await dataPreflight(ctx, extraction);
  await load(ctx, extraction, pf, createLoadResult());
  assert.equal(target.byName('c1').AccountId, target.byName('A1').Id);
  assert.ok(target.inserted.findIndex((r) => r.Name === 'A1') < target.inserted.findIndex((r) => r.LastName === 'c1'));
});

test('"include in existing step" adds references to a query step (both)', async () => {
  const acc = newStep('Account');
  acc.limit = 1;
  const con = newStep('Contact');
  const rows = {
    Account: [{ Id: A(1), Name: 'A1', OwnerId: U(1), ...noRt }, { Id: A(2), Name: 'A2', OwnerId: U(1), ...noRt }],
    Contact: [{ Id: C(1), LastName: 'c1', AccountId: A(2), OwnerId: U(1) }],
  };
  const { ctx, plan } = setup({ rows, steps: [acc, con] });
  const findings = findMissingReferences(await extract(ctx), env(ctx));
  assert.equal(findings[0].options.defaultValue, `existing:${acc.id}`);
  applyChoices(plan, [{ finding: findings[0], action: findings[0].options.defaultValue }]);
  assert.equal(acc.recordSource, 'both');
  const ex = await extract(ctx);
  assert.deepEqual(ex.byStep.get(acc.id).map((r) => r.Name).sort(), ['A1', 'A2']);
});

test('self-lookup finding pulls the parent hierarchy into the same step', async () => {
  const acc = newStep('Account');
  acc.limit = 1;
  const rows = {
    Account: [
      { Id: A(3), Name: 'leaf', ParentId: A(2), OwnerId: U(1), ...noRt },
      { Id: A(2), Name: 'mid', ParentId: A(1), OwnerId: U(1), ...noRt },
      { Id: A(1), Name: 'root', ParentId: null, OwnerId: U(1), ...noRt },
    ],
  };
  const { ctx, plan, target } = setup({ rows, steps: [acc] });
  const f = findMissingReferences(await extract(ctx), env(ctx))[0];
  assert.equal(f.selfRef, true);
  assert.equal(f.options.defaultValue, 'hierarchy');
  applyChoices(plan, [{ finding: f, action: 'hierarchy' }]);
  const ex = await extract(ctx);
  assert.equal(ex.total, 3);
  assert.equal(ex.stats.get(acc.id).byHierarchy, 2);
  await load(ctx, ex, await dataPreflight(ctx, ex), createLoadResult());
  assert.equal(target.byName('leaf').ParentId, target.byName('mid').Id);
  assert.equal(target.byName('mid').ParentId, target.byName('root').Id);
});

test('existing-step option is disabled when it would create a loop; static pre-flight reports loops', async () => {
  const acc = newStep('Account');
  const con = newStep('Contact');
  con.parentScopes = [{ field: 'AccountId', stepId: acc.id }];
  const plan = newPlan('t');
  plan.steps = [acc, con];
  const opts = actionOptions(plan, con, 'AccountId', 'Account', false);
  assert.equal(opts.list.find((o) => o.value === `existing:${acc.id}`).disabled, true);
  assert.equal(opts.defaultValue, 'new');

  acc.referencedBy = [{ stepId: con.id, field: 'AccountId' }];
  const { ctx } = setup({ rows: {}, steps: [acc, con] });
  const sp = await staticPreflight(ctx, { withCounts: false });
  assert.ok(sp.report.errors.some((e) => /loop/.test(e.message)));
  await assert.rejects(extract(ctx), /loop/);
});

test('referenced-by field must be selected in the referencing step', async () => {
  const acc = newStep('Account');
  const con = newStep('Contact');
  con.fieldMode = 'selected';
  con.fields = ['LastName'];
  acc.recordSource = 'referenced';
  acc.referencedBy = [{ stepId: con.id, field: 'AccountId' }];
  const { ctx } = setup({ rows: {}, steps: [acc, con] });
  const sp = await staticPreflight(ctx, { withCounts: false });
  assert.ok(sp.report.errors.some((e) => /not selected in the Contact step/.test(e.message)));
});

test('template round trip keeps referencedBy and remaps step ids', () => {
  const con = newStep('Contact');
  const acc = newStep('Account');
  acc.recordSource = 'referenced';
  acc.referencedBy = [{ stepId: con.id, field: 'AccountId' }, { stepId: acc.id, field: 'ParentId' }];
  const p = newPlan('t');
  p.steps = [acc, con];
  const { plan, warnings } = parseTemplate(JSON.stringify(toTemplate(p)));
  assert.deepEqual(warnings, []);
  assert.equal(plan.steps[0].recordSource, 'referenced');
  assert.deepEqual(plan.steps[0].referencedBy, [{ field: 'AccountId', stepId: plan.steps[1].id }, { field: 'ParentId', stepId: plan.steps[0].id }]);
  assert.equal(plan.settings.matchUsersByUsername, true);
});

// ---------------------------------------------------------------------------
// Users

test('sandbox suffix detection', () => {
  assert.equal(sandboxSuffixFromUrl('https://acme--uat.sandbox.my.salesforce.com'), 'uat');
  assert.equal(sandboxSuffixFromUrl('https://my-co--dev2.sandbox.my.salesforce.com'), 'dev2');
  assert.equal(sandboxSuffixFromUrl('https://acme--qa.my.salesforce.com'), 'qa');
  assert.equal(sandboxSuffixFromUrl('https://acme.my.salesforce.com'), null);
  const prod = { isSandbox: false, instanceUrl: 'https://acme.my.salesforce.com', username: 'ada@acme.com' };
  assert.equal(orgUsernameSuffix(prod, null), null);
  const legacy = { isSandbox: true, instanceUrl: 'https://cs42.salesforce.com', username: 'ada@acme.com.full' };
  assert.equal(orgUsernameSuffix(legacy, prod), 'full', 'falls back to comparing running users');
  assert.deepEqual(candidateUsernames('Bob@Acme.com.dev', 'dev', 'uat'), ['bob@acme.com.uat', 'bob@acme.com.dev', 'bob@acme.com']);
  assert.deepEqual(candidateUsernames('bob@acme.com', null, null), ['bob@acme.com']);
});

test('users are matched by Username across sandbox suffixes; inactive or missing users are reported', async () => {
  const source = { queryAll: async () => [
    { Id: U(1), Username: 'ada@acme.com', IsActive: true },
    { Id: U(2), Username: 'bob@acme.com', IsActive: true },
    { Id: U(3), Username: 'gone@acme.com', IsActive: false },
  ] };
  const targetUsers = [
    { Id: T(1), Username: 'ada@acme.com.uat', IsActive: true },
    { Id: T(2), Username: 'bob@acme.com.uat', IsActive: false },
  ];
  const target = { queryAll: async (soql) => targetUsers.filter((u) => soql.includes(`'${u.Username}'`)) };
  const res = await buildUserMap({
    source, target,
    sourceInfo: { isSandbox: false, suffix: null },
    targetInfo: { isSandbox: true, suffix: 'uat' },
  }, new Set([U(1), U(2), U(3), U(4)]));
  assert.equal(res.map.get(U(1)), T(1));
  assert.equal(res.map.has(U(2)), false);
  assert.deepEqual(res.unmatched.map((u) => u.reason).sort(), [
    'inactive in the Target org', 'no user with this Username in the Target org', 'not visible in the Source org',
  ]);
});

test('OwnerId is mapped to the matching Target user during insert', async () => {
  const acc = newStep('Account');
  const rows = {
    Account: [{ Id: A(1), Name: 'mine', OwnerId: U(1), ...noRt }, { Id: A(2), Name: 'nobody', OwnerId: U(9), ...noRt }],
    User: [{ Id: U(1), Username: 'ada@acme.com', IsActive: true }, { Id: U(9), Username: 'left@acme.com', IsActive: true }],
  };
  const users = {
    target: [{ Id: T(1), Username: 'ada@acme.com.uat', IsActive: true }],
    info: {
      source: { isSandbox: false, instanceUrl: 'https://acme.my.salesforce.com', username: 'ada@acme.com' },
      target: { isSandbox: true, instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com', username: 'ada@acme.com.uat' },
    },
  };
  const { ctx, target } = setup({ rows, steps: [acc], users });
  const ex = await extract(ctx);
  const pf = await dataPreflight(ctx, ex);
  assert.ok(pf.report.items.some((i) => /1 of 2 referenced users matched by Username/.test(i.message)));
  assert.ok(pf.report.warnings.some((w) => /left@acme\.com/.test(w.message)));
  await load(ctx, ex, pf, createLoadResult());
  assert.equal(target.byName('mine').OwnerId, T(1));
  assert.equal(target.byName('nobody').OwnerId, undefined, 'unmatched owner is left blank (running user becomes owner)');
});

test('latest API version is picked from the versions list', () => {
  assert.equal(latestApiVersion([{ version: '66.0' }, { version: '68.0' }, { version: '67.0' }]), '68.0');
  assert.equal(latestApiVersion(null), FALLBACK_API_VERSION);
});
