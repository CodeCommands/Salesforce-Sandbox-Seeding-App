import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, load, rollback, createLoadResult } from '../public/js/engine.js';
import { dataPreflight, staticPreflight } from '../public/js/preflight.js';
import { newPlan, newStep } from '../public/js/template.js';
import { describes, MockSource, MockTarget, KEY_PREFIXES, id, rtIndex, APP_SETTINGS } from './fixtures.mjs';

const RT_SRC = [{ Id: '012S00000000001AAA', SobjectType: 'Account', DeveloperName: 'Partner', NamespacePrefix: null, IsActive: true }];
const RT_TGT = [{ Id: '012T00000000001AAA', SobjectType: 'Account', DeveloperName: 'Partner', NamespacePrefix: null, IsActive: true }];

const A = (n) => id('001', n);
const C = (n) => id('003', n);
const U1 = id('005', 1);
const rt = (dev) => ({ RecordTypeId: '012S00000000001AAA', RecordType: { DeveloperName: dev, NamespacePrefix: null } });
const noRt = { RecordTypeId: null, RecordType: null };

function setup({ rows, steps, targetRt = RT_TGT, targetOpts = {}, targetMissing = [], preserve = [] }) {
  const d = describes({ targetMissing });
  const source = new MockSource(d.source, rows);
  const target = new MockTarget(d.target, targetOpts);
  const plan = newPlan('test');
  plan.settings.preserveLookupsTo = preserve;
  plan.steps = steps;
  const logs = [];
  const ctx = {
    source,
    target,
    plan,
    appSettings: APP_SETTINGS,
    orgs: { source: { Id: '00DS', Name: 'Src', IsSandbox: false }, target: { Id: '00DT', Name: 'Tgt', IsSandbox: true } },
    sourceRt: rtIndex(RT_SRC),
    targetRt: rtIndex(targetRt),
    sourceKeyPrefixes: KEY_PREFIXES,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    progress: () => {},
  };
  return { ctx, source, target, plan, logs };
}

async function runAll(ctx) {
  const extraction = await extract(ctx);
  const pf = await dataPreflight(ctx, extraction);
  assert.equal(pf.report.hasErrors, false, pf.report.errors.map((e) => e.message).join('\n'));
  const result = await load(ctx, extraction, pf, createLoadResult());
  return { extraction, pf, result };
}

test('account hierarchy is inserted level by level with remapped ParentId', async () => {
  const s = newStep('Account');
  const rows = {
    Account: [
      { Id: A(3), Name: 'Grandchild', ParentId: A(2), OwnerId: U1, ...noRt },
      { Id: A(2), Name: 'Child', ParentId: A(1), OwnerId: U1, ...noRt },
      { Id: A(1), Name: 'Root', ParentId: null, OwnerId: U1, ...rt('Partner') },
      { Id: A(4), Name: 'Orphan', ParentId: A(99), OwnerId: U1, ...noRt },
    ],
  };
  const { ctx, target } = setup({ rows, steps: [s] });
  const { result } = await runAll(ctx);
  assert.equal(result.created.length, 4);
  const root = target.byName('Root');
  const child = target.byName('Child');
  const grand = target.byName('Grandchild');
  const orphan = target.byName('Orphan');
  assert.equal(child.ParentId, root.Id);
  assert.equal(grand.ParentId, child.Id);
  assert.equal(orphan.ParentId, undefined, 'parent outside the seed is left blank');
  assert.equal(root.OwnerId, undefined, 'lookups to objects outside the plan are cleared');
  assert.equal(root.RecordTypeId, '012T00000000001AAA', 'record type resolved by DeveloperName');
  assert.equal(root.Formula__c, undefined);
  // Root+Orphan in pass 1, Child pass 2, Grandchild pass 3
  assert.equal(result.stepStats.get(s.id).passes, 3);
  assert.equal(target.updates.length, 0);
});

test('children scoped to extracted parents; lookups remapped; preserve list keeps Ids', async () => {
  const acc = newStep('Account');
  acc.limit = 2;
  const con = newStep('Contact');
  con.parentScopes = [{ field: 'AccountId', stepId: acc.id }];
  const rows = {
    Account: [{ Id: A(1), Name: 'A1', OwnerId: U1, ...noRt }, { Id: A(2), Name: 'A2', OwnerId: U1, ...noRt }, { Id: A(3), Name: 'A3', OwnerId: U1, ...noRt }],
    Contact: [
      { Id: C(1), LastName: 'c1', AccountId: A(1), OwnerId: U1 },
      { Id: C(2), LastName: 'c2', AccountId: A(2), OwnerId: U1 },
      { Id: C(3), LastName: 'c3', AccountId: A(3), OwnerId: U1 },
    ],
  };
  const { ctx, target, source } = setup({ rows, steps: [acc, con], preserve: ['User'] });
  const { extraction } = await runAll(ctx);
  assert.equal(extraction.byStep.get(con.id).length, 2, 'only children of the 2 extracted accounts');
  assert.match(source.queries[1], /AccountId IN \('001000000000000001','001000000000000002'\)/);
  const c1 = target.byName('c1');
  assert.equal(c1.AccountId, target.byName('A1').Id);
  assert.equal(c1.OwnerId, U1, 'User Ids preserved via template setting');
});

test('circular references are inserted then back-filled with an update', async () => {
  const con = newStep('Contact');
  const rows = {
    Contact: [
      { Id: C(1), LastName: 'boss', ReportsToId: C(2), OwnerId: U1 },
      { Id: C(2), LastName: 'peer', ReportsToId: C(1), OwnerId: U1 },
    ],
  };
  const { ctx, target, logs } = setup({ rows, steps: [con] });
  const { result } = await runAll(ctx);
  assert.equal(result.created.length, 2);
  assert.equal(target.updates.length, 2);
  const boss = target.byName('boss');
  const peer = target.byName('peer');
  assert.equal(boss.ReportsToId, undefined);
  const upd = Object.fromEntries(target.updates.map((u) => [u.Id, u.ReportsToId]));
  assert.equal(upd[boss.Id], peer.Id);
  assert.equal(upd[peer.Id], boss.Id);
  assert.ok(logs.some((l) => l.includes('circular')));
});

test('child step before its optional parent step is back-filled', async () => {
  const con = newStep('Contact');
  const acc = newStep('Account');
  const rows = {
    Contact: [{ Id: C(1), LastName: 'c1', AccountId: A(1), OwnerId: U1 }],
    Account: [{ Id: A(1), Name: 'A1', OwnerId: U1, ...noRt }],
  };
  const { ctx, target } = setup({ rows, steps: [con, acc] });
  const { result } = await runAll(ctx);
  assert.equal(result.updated, 1);
  assert.equal(target.updates[0].AccountId, target.byName('A1').Id);
});

test('required lookup to a record outside the seed is skipped, and pre-flight warns', async () => {
  const ch = newStep('Child__c');
  const rows = { Child__c: [{ Id: id('a00', 1), Name: 'x', Parent__c: A(7) }] };
  const { ctx, target } = setup({ rows, steps: [ch] });
  const extraction = await extract(ctx);
  const pf = await dataPreflight(ctx, extraction);
  assert.ok(pf.report.warnings.some((w) => /will be skipped because required lookup Parent__c/.test(w.message)));
  const result = await load(ctx, extraction, pf);
  assert.equal(result.created.length, 0);
  assert.equal(result.failures[0].stage, 'skipped');
  assert.equal(target.batches, 0);
});

test('failed parent: required children skipped, optional children cleared', async () => {
  const acc = newStep('Account');
  const con = newStep('Contact');
  const ch = newStep('Child__c');
  const rows = {
    Account: [{ Id: A(1), Name: 'BAD', OwnerId: U1, ...noRt }, { Id: A(2), Name: 'ok', OwnerId: U1, ...noRt }],
    Contact: [{ Id: C(1), LastName: 'c1', AccountId: A(1), OwnerId: U1 }],
    Child__c: [{ Id: id('a00', 1), Name: 'k1', Parent__c: A(1) }, { Id: id('a00', 2), Name: 'k2', Parent__c: A(2) }],
  };
  const { ctx, target } = setup({ rows, steps: [acc, con, ch], targetOpts: { failWhen: (r) => (r.Name === 'BAD' ? 'Validation failed' : null) } });
  const { result } = await runAll(ctx);
  assert.equal(target.byName('c1').AccountId, undefined);
  assert.ok(target.byName('k2'));
  assert.equal(target.byName('k1'), undefined);
  const stages = result.failures.map((f) => `${f.object}:${f.stage}`).sort();
  assert.deepEqual(stages, ['Account:insert', 'Child__c:skipped']);
  assert.match(result.failures.find((f) => f.stage === 'skipped').message, /parent failed to insert/);
});

test('missing target record type halts in pre-flight with the DeveloperName', async () => {
  const acc = newStep('Account');
  const rows = { Account: [{ Id: A(1), Name: 'x', OwnerId: U1, ...rt('Partner') }] };
  const { ctx } = setup({ rows, steps: [acc], targetRt: [] });
  const extraction = await extract(ctx);
  const pf = await dataPreflight(ctx, extraction);
  assert.equal(pf.report.hasErrors, true);
  assert.match(pf.report.errors[0].message, /record type "Partner" .* missing in the Target org/);
});

test('inactive target record type is an error', async () => {
  const acc = newStep('Account');
  const rows = { Account: [{ Id: A(1), Name: 'x', OwnerId: U1, ...rt('Partner') }] };
  const { ctx } = setup({ rows, steps: [acc], targetRt: [{ ...RT_TGT[0], IsActive: false }] });
  const pf = await dataPreflight(ctx, await extract(ctx));
  assert.match(pf.report.errors[0].message, /inactive/);
});

test('fields missing in target are dropped and reported by static pre-flight', async () => {
  const acc = newStep('Account');
  const rows = { Account: [{ Id: A(1), Name: 'x', Industry: 'Tech', OwnerId: U1, ...noRt }] };
  const { ctx, target } = setup({ rows, steps: [acc], targetMissing: ['Account.Industry'] });
  const sp = await staticPreflight(ctx, { withCounts: false });
  assert.ok(sp.report.warnings.some((w) => /Industry \(does not exist in target/.test(w.message)));
  await runAll(ctx);
  assert.equal(target.byName('x').Industry, undefined);
});

test('static pre-flight blocks production targets and bad ordering', async () => {
  const ch = newStep('Child__c');
  const acc = newStep('Account');
  const { ctx } = setup({ rows: {}, steps: [ch, acc] });
  ctx.orgs.target.IsSandbox = false;
  const sp = await staticPreflight(ctx, { withCounts: false });
  const msgs = sp.report.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /production org/);
  assert.match(msgs, /required, so move Account above Child__c/);
});

test('records matched by two steps are inserted once', async () => {
  const a1 = newStep('Account');
  const a2 = newStep('Account');
  const rows = { Account: [{ Id: A(1), Name: 'same', OwnerId: U1, ...noRt }] };
  const { ctx, target } = setup({ rows, steps: [a1, a2] });
  const { extraction } = await runAll(ctx);
  assert.equal(extraction.total, 1);
  assert.equal(extraction.stats.get(a2.id).duplicates, 1);
  assert.equal(target.inserted.length, 1);
});

test('batches respect the batch size', async () => {
  const acc = newStep('Account');
  acc.limit = 450;
  const rows = { Account: Array.from({ length: 450 }, (_, i) => ({ Id: A(i + 1), Name: `n${i}`, OwnerId: U1, ...noRt })) };
  const { ctx, target } = setup({ rows, steps: [acc] });
  await runAll(ctx);
  assert.equal(target.batches, 3);
  assert.equal(target.inserted.length, 450);
});

test('fatal errors stop the run but keep partial results', async () => {
  const acc = newStep('Account');
  acc.limit = 300;
  const rows = { Account: Array.from({ length: 300 }, (_, i) => ({ Id: A(i + 1), Name: `n${i}`, OwnerId: U1, ...noRt })) };
  const { ctx, target } = setup({ rows, steps: [acc] });
  let calls = 0;
  const orig = target.insert.bind(target);
  target.insert = async (recs) => {
    if (++calls === 2) throw Object.assign(new Error('Session expired'), { status: 401 });
    return orig(recs);
  };
  const extraction = await extract(ctx);
  const pf = await dataPreflight(ctx, extraction);
  const result = createLoadResult();
  await assert.rejects(load(ctx, extraction, pf, result), /Session expired/);
  assert.equal(result.created.length, 200, 'first batch is kept for rollback');
});

test('rollback deletes newest first', async () => {
  const target = new MockTarget({});
  const created = [{ targetId: 'p' }, { targetId: 'c1' }, { targetId: 'c2' }];
  const res = await rollback(target, created);
  assert.deepEqual(target.deleted, ['c2', 'c1', 'p']);
  assert.equal(res.deleted, 3);
});
