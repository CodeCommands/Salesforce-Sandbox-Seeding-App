import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLoop, wouldLoop, describeLink } from '../public/js/planner.js';
import {
  newPlan, newStep, toTemplate, parseTemplate, addLink, removeLink, linksOf, resolveContradictoryLinks, effectiveRecordSource,
} from '../public/js/template.js';
import { staticPreflight, dataPreflight } from '../public/js/preflight.js';
import { load, createLoadResult } from '../public/js/engine.js';
import { captureSnapshot, snapshotExtraction, SnapshotSource, snapshotKeyPrefixes, dataSignature } from '../public/js/snapshot.js';
import { describes, MockSource, MockTarget, KEY_PREFIXES, id, rtIndex, APP_SETTINGS } from './fixtures.mjs';

const A = (n) => id('001', n);
const C = (n) => id('003', n);
const U = (n) => id('005', n);
const T = (n) => id('005', 900 + n);
const noRt = { RecordTypeId: null, RecordType: null };

/** The plan from the bug report: Contact scoped to Account, and Account also takes the Accounts Contacts point to. */
function loopPlan(accountMode = 'both') {
  const plan = newPlan('loop');
  const acc = newStep('Account');
  const con = newStep('Contact');
  con.parentScopes = [{ field: 'AccountId', stepId: acc.id }];
  acc.referencedBy = [{ stepId: con.id, field: 'AccountId' }];
  acc.recordSource = accountMode;
  plan.steps = [acc, con];
  return { plan, acc, con };
}

test('findLoop names the two links of the Account/Contact loop in plain words', () => {
  const { plan, acc, con } = loopPlan();
  const loop = findLoop(plan.steps);
  assert.ok(loop);
  assert.deepEqual(new Set(loop.stepIds), new Set([acc.id, con.id]));
  const text = loop.links.map((l) => describeLink(l, plan.steps)).join(' | ');
  assert.match(text, /Contact \(step 2\) takes only the Contact records that belong to the Account records in step 1, via AccountId/);
  assert.match(text, /Account \(step 1\) takes the Account records that the Contact records in step 2 point to, via AccountId/);
  assert.equal(findLoop([acc]), null);
});

test('wouldLoop flags the opposite link; hierarchy links never loop', () => {
  const plan = newPlan('p');
  const acc = newStep('Account');
  const con = newStep('Contact');
  con.parentScopes = [{ field: 'AccountId', stepId: acc.id }];
  plan.steps = [acc, con];
  assert.equal(wouldLoop(plan.steps, { owner: acc.id, kind: 'reference', other: con.id, field: 'AccountId' }), true);
  assert.equal(wouldLoop(plan.steps, { owner: acc.id, kind: 'reference', other: acc.id, field: 'ParentId' }), false);
  assert.equal(wouldLoop(plan.steps, { owner: con.id, kind: 'reference', other: con.id, field: 'ReportsToId' }), false);
});

test('contradictory same-field links are repaired on import: redundant reference dropped when the parent also uses filters', () => {
  const { plan, acc, con } = loopPlan('both');
  const { plan: imported, warnings } = parseTemplate(JSON.stringify(toTemplate(plan)));
  const [a, c] = imported.steps;
  assert.equal(a.referencedBy.length, 0);
  assert.equal(effectiveRecordSource(a), 'query');
  assert.equal(c.parentScopes.length, 1, 'Contacts stay children of the selected Accounts');
  assert.ok(warnings.some((w) => /Fixed a loop between Account and Contact/.test(w)));
  assert.equal(findLoop(imported.steps), null);
  assert.ok(acc && con);
});

test('contradictory links: when the parent takes only referenced records, the child scope is dropped instead', () => {
  const { plan } = loopPlan('referenced');
  const messages = resolveContradictoryLinks(plan);
  const [a, c] = plan.steps;
  assert.equal(messages.length, 1);
  assert.equal(c.parentScopes.length, 0);
  assert.equal(a.referencedBy.length, 1);
  assert.equal(effectiveRecordSource(a), 'referenced');
});

test('addLink / removeLink keep recordSource consistent', () => {
  const plan = newPlan('p');
  const acc = newStep('Account');
  const con = newStep('Contact');
  plan.steps = [acc, con];
  addLink(plan, { owner: acc.id, kind: 'reference', other: con.id, field: 'AccountId' });
  assert.equal(acc.recordSource, 'referenced', 'no filters: only the referenced records');
  addLink(plan, { owner: acc.id, kind: 'reference', other: acc.id, field: 'ParentId' });
  assert.equal(linksOf(acc).length, 2);
  removeLink(plan, { owner: acc.id, kind: 'reference', other: con.id, field: 'accountid' });
  assert.equal(acc.recordSource, 'query', 'only the hierarchy link is left, so filters pick the records again');
  assert.equal(linksOf(acc).length, 1);

  const acc2 = newStep('Account');
  acc2.filters = [{ id: 'f', field: 'Industry', operator: 'eq', value: 'Tech' }];
  plan.steps.push(acc2);
  addLink(plan, { owner: acc2.id, kind: 'reference', other: con.id, field: 'AccountId' });
  assert.equal(acc2.recordSource, 'both', 'own filters are kept');
  addLink(plan, { owner: con.id, kind: 'scope', other: acc2.id, field: 'AccountId' });
  addLink(plan, { owner: con.id, kind: 'scope', other: acc2.id, field: 'AccountId' });
  assert.equal(con.parentScopes.length, 1, 'no duplicates');
});

test('static pre-flight explains a loop with both links', async () => {
  const { plan } = loopPlan('both');
  const d = describes();
  const ctx = {
    source: new MockSource(d.source, {}), target: new MockTarget(d.target), plan, appSettings: APP_SETTINGS,
    orgs: { source: { Id: 'S', IsSandbox: false }, target: { Id: 'T', IsSandbox: true } },
    sourceRt: rtIndex([]), targetRt: rtIndex([]), sourceKeyPrefixes: KEY_PREFIXES,
  };
  const { report } = await staticPreflight(ctx, { withCounts: false });
  const e = report.errors.find((x) => /loop/.test(x.message));
  assert.ok(e);
  assert.match(e.message, /Account and Contact wait for each other/);
  assert.match(e.message, /Fix button/);
});

// ---------------------------------------------------------------------------
// Captured data: capture with the Source, export, import, run with only the Target
// ---------------------------------------------------------------------------

test('a template with captured data runs with only the Target org', async () => {
  const d = describes();
  const rows = {
    Account: [{ Id: A(1), Name: 'Acme', OwnerId: U(1), ...noRt }, { Id: A(2), Name: 'Globex', OwnerId: U(2), ...noRt }],
    Contact: [
      { Id: C(1), LastName: 'Ada', AccountId: A(1), OwnerId: U(1) },
      { Id: C(2), LastName: 'Bob', AccountId: A(2), OwnerId: U(2) },
      { Id: C(3), LastName: 'Elsewhere', AccountId: A(9), OwnerId: U(1) },
    ],
    User: [{ Id: U(1), Username: 'ada@acme.com', Name: 'Ada', IsActive: true }, { Id: U(2), Username: 'bob@acme.com', Name: 'Bob', IsActive: true }],
  };
  const plan = newPlan('with data');
  const acc = newStep('Account');
  const con = newStep('Contact');
  con.parentScopes = [{ field: 'AccountId', stepId: acc.id }];
  plan.steps = [acc, con];

  // 1. Capture from the Source (read-only).
  const source = new MockSource(d.source, rows);
  const snap = await captureSnapshot({
    source, plan, appSettings: APP_SETTINGS, sourceKeyPrefixes: KEY_PREFIXES, log: () => {}, progress: () => {},
    sourceInfo: { orgId: '00DS', orgName: 'Acme Prod', isSandbox: false, instanceUrl: 'https://acme.my.salesforce.com', username: 'ada@acme.com' },
  });
  assert.equal(snap.total, 4, '2 accounts + 2 scoped contacts');
  assert.equal(snap.users[U(1)].Username, 'ada@acme.com');
  assert.ok(!('attributes' in snap.steps[acc.id].records[0]));
  assert.equal(snap.signature, dataSignature(plan));

  // 2. Export and import (step ids are regenerated on import).
  const text = JSON.stringify(toTemplate(plan, { snapshot: snap }));
  const doc = JSON.parse(text);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.data.total, 4);
  const { plan: imported, snapshot, warnings } = parseTemplate(text);
  assert.deepEqual(warnings, []);
  assert.ok(snapshot);
  const [iAcc, iCon] = imported.steps;
  assert.notEqual(iAcc.id, acc.id);
  assert.equal(snapshot.steps[iAcc.id].records.length, 2);
  assert.equal(snapshot.steps[iCon.id].records.length, 2);

  // 3. Run against the Target only: the Source is replaced by the captured data.
  const target = new MockTarget(d.target);
  target.queryAll = async (soql) => {
    const names = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return [{ Id: T(1), Username: 'ada@acme.com.uat', IsActive: true }].filter((u) => names.includes(u.Username));
  };
  const snapSource = new SnapshotSource(snapshot);
  const ctx = {
    source: snapSource, target, plan: imported, appSettings: APP_SETTINGS,
    orgs: { source: { Id: snapshot.source.orgId, Name: snapshot.source.orgName, IsSandbox: false }, target: { Id: '00DT', Name: 'UAT', IsSandbox: true } },
    sourceRt: null, targetRt: rtIndex([]), sourceKeyPrefixes: snapshotKeyPrefixes(snapshot),
    userInfo: {
      source: { isSandbox: false, instanceUrl: snapshot.source.instanceUrl, username: snapshot.source.username },
      target: { isSandbox: true, instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com', username: 'ada@acme.com.uat' },
    },
    log: () => {}, progress: () => {},
  };
  const sp = await staticPreflight(ctx, { withCounts: true });
  assert.equal(sp.report.hasErrors, false, sp.report.errors.map((e) => e.message).join('\n'));
  assert.ok(sp.report.items.some((i) => /Captured data: 4 records/.test(i.message)));

  const extraction = snapshotExtraction(imported, snapshot);
  assert.equal(extraction.total, 4);
  const pf = await dataPreflight(ctx, extraction);
  assert.equal(pf.report.hasErrors, false, pf.report.errors.map((e) => e.message).join('\n'));
  const result = await load(ctx, extraction, pf, createLoadResult());
  assert.equal(result.created.length, 4);
  const acme = target.byName('Acme');
  assert.equal(target.byName('Ada').AccountId, acme.Id, 'lookup remapped to the new Account');
  assert.equal(acme.OwnerId, T(1), 'owner matched by Username from captured user data');
  assert.equal(target.byName('Globex').OwnerId, undefined, 'unmatched owner left blank');
  await assert.rejects(() => snapSource.queryAll('SELECT Id FROM Account'), /captured data/);
});

test('captured data with an unknown format is dropped with a warning, the plan still imports', () => {
  const plan = newPlan('p');
  plan.steps = [newStep('Account')];
  const doc = toTemplate(plan);
  doc.data = { format: 'something-else', objects: {}, steps: {} };
  const { plan: imported, snapshot, warnings } = parseTemplate(JSON.stringify(doc));
  assert.equal(imported.steps.length, 1);
  assert.equal(snapshot, null);
  assert.ok(warnings.some((w) => /could not be used/.test(w)));
});
