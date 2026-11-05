import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCondition, compileWhere, compileQuery, compileCountQuery, applyFilterLogic, formatValue, escapeSoqlString, operatorsFor,
} from '../public/js/soql.js';
import { describes, field } from './fixtures.mjs';

const { source } = describes();
const acc = source.Account;
const step = (over = {}) => ({ id: 's1', object: 'Account', fieldMode: 'all', fields: [], filters: [], filterLogic: { mode: 'all', expression: '' }, advancedWhere: '', orderBy: null, limit: 50, parentScopes: [], ...over });

test('escapes quotes, backslashes and newlines', () => {
  assert.equal(escapeSoqlString("O'Brien \\ \"x\"\n"), "O\\'Brien \\\\ \\\"x\\\"\\n");
});

test('string operators and LIKE escaping', () => {
  assert.equal(compileCondition({ field: 'Name', operator: 'eq', value: "Acme's" }, acc), "Name = 'Acme\\'s'");
  assert.equal(compileCondition({ field: 'Name', operator: 'contains', value: '50%_off' }, acc), "Name LIKE '%50\\%\\_off%'");
  assert.equal(compileCondition({ field: 'Name', operator: 'startsWith', value: 'Ac' }, acc), "Name LIKE 'Ac%'");
  assert.equal(compileCondition({ field: 'Name', operator: 'notContains', value: 'x' }, acc), "(NOT Name LIKE '%x%')");
  assert.equal(compileCondition({ field: 'Name', operator: 'in', value: 'A, B ,C' }, acc), "Name IN ('A', 'B', 'C')");
  assert.equal(compileCondition({ field: 'Name', operator: 'isNull' }, acc), 'Name = null');
});

test('numbers, booleans, dates validated', () => {
  assert.equal(compileCondition({ field: 'AnnualRevenue', operator: 'gt', value: '1000.5' }, acc), 'AnnualRevenue > 1000.5');
  assert.throws(() => compileCondition({ field: 'AnnualRevenue', operator: 'gt', value: '1e5; DELETE' }, acc), /not a number/);
  assert.equal(compileCondition({ field: 'IsActive__c', operator: 'eq', value: 'TRUE' }, acc), 'IsActive__c = true');
  const dt = field('CreatedDate', 'datetime');
  const d = field('CloseDate', 'date');
  assert.equal(formatValue(dt, '2024-01-31'), '2024-01-31T00:00:00Z');
  assert.equal(formatValue(dt, '2024-01-31T10:20'), '2024-01-31T10:20:00Z');
  assert.equal(formatValue(dt, 'last_n_days:30'), 'LAST_N_DAYS:30');
  assert.equal(formatValue(d, 'THIS_FISCAL_YEAR'), 'THIS_FISCAL_YEAR');
  assert.throws(() => formatValue(d, '31/01/2024'), /YYYY-MM-DD/);
});

test('ids are validated before quoting', () => {
  assert.equal(compileCondition({ field: 'ParentId', operator: 'eq', value: '001000000000001AAA' }, acc), "ParentId = '001000000000001AAA'");
  assert.throws(() => compileCondition({ field: 'ParentId', operator: 'eq', value: "x' OR Name != '" }, acc), /valid Salesforce Id/);
});

test('record type filters compile to DeveloperName relationship notation', () => {
  assert.deepEqual(operatorsFor(acc.fields.find((f) => f.name === 'RecordTypeId')), ['eq', 'ne', 'in', 'notIn', 'isNull', 'notNull']);
  assert.equal(compileCondition({ field: 'RecordTypeId', operator: 'eq', value: 'Partner' }, acc), "RecordType.DeveloperName = 'Partner'");
  assert.equal(compileCondition({ field: 'RecordTypeId', operator: 'in', value: 'Partner, Customer' }, acc), "RecordType.DeveloperName IN ('Partner', 'Customer')");
  assert.equal(compileCondition({ field: 'RecordTypeId', operator: 'ne', value: 'Partner' }, acc), "(NOT RecordType.DeveloperName = 'Partner')");
  assert.equal(
    compileCondition({ field: 'RecordTypeId', operator: 'eq', value: 'pkg__Partner' }, acc),
    "(RecordType.NamespacePrefix = 'pkg' AND RecordType.DeveloperName = 'Partner')",
  );
  assert.equal(compileCondition({ field: 'RecordTypeId', operator: 'isNull' }, acc), 'RecordTypeId = null');
});

test('custom filter logic', () => {
  const c = ['A', 'B', 'C'];
  assert.equal(applyFilterLogic('1 AND (2 OR 3)', c), '(A) AND ((B) OR (C))');
  assert.equal(applyFilterLogic('not 1 and 2 and 3', c), 'NOT (A) AND (B) AND (C)');
  assert.throws(() => applyFilterLogic('1 AND 2 OR 3', c), /parentheses/);
  assert.throws(() => applyFilterLogic('1 AND 4', ['A', 'B', 'C', 'D'].slice(0, 3)), /only 3 exist/);
  assert.throws(() => applyFilterLogic('1 AND 2', c), /does not use filter 3/);
  assert.throws(() => applyFilterLogic('(1 AND 2', ['A', 'B']), /closing parenthesis/);
  assert.throws(() => applyFilterLogic('1; DROP', ['A']), /unexpected/);
});

test('where clause combines filters, advanced SOQL and extra conditions', () => {
  const s = step({
    filters: [{ field: 'Name', operator: 'startsWith', value: 'A' }, { field: 'Industry', operator: 'eq', value: 'Tech' }],
    filterLogic: { mode: 'any' },
    advancedWhere: 'CreatedDate = LAST_N_DAYS:30',
  });
  assert.equal(compileWhere(s, acc, ["ParentId IN ('x')"]),
    "((Name LIKE 'A%') OR (Industry = 'Tech')) AND (CreatedDate = LAST_N_DAYS:30) AND (ParentId IN ('x'))");
});

test('query selects createable fields, record type relationship and enforces LIMIT', () => {
  const q = compileQuery(step({ limit: 999999 }), acc, { maxLimit: 2000 });
  assert.match(q, /^SELECT Id, Name, Industry, AnnualRevenue, IsActive__c, ParentId, OwnerId, RecordTypeId, RecordType.DeveloperName, RecordType.NamespacePrefix FROM Account LIMIT 2000$/);
  assert.doesNotMatch(q, /Formula__c|Logo__c|CreatedDate/);
  const sel = compileQuery(step({ fieldMode: 'selected', fields: ['Name', 'Formula__c', 'Nope'], limit: 5, orderBy: { field: 'Name', direction: 'DESC' } }), acc);
  assert.equal(sel, 'SELECT Id, Name, RecordTypeId, RecordType.DeveloperName, RecordType.NamespacePrefix FROM Account ORDER BY Name DESC NULLS LAST LIMIT 5');
  assert.equal(compileCountQuery(step({ filters: [{ field: 'Name', operator: 'eq', value: 'x' }] }), acc), "SELECT COUNT() FROM Account WHERE Name = 'x'");
});

test('filter errors name the filter number', () => {
  assert.throws(() => compileWhere(step({ filters: [{ field: 'Name', operator: 'eq', value: 'a' }, { field: 'Bogus', operator: 'eq', value: 'x' }] }), acc), /Filter 2: Unknown field/);
});
