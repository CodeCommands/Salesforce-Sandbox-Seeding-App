// Test fixtures: minimal describe results and an in-memory Salesforce mock.
import { RecordTypeIndex } from '../public/js/schema.js';

export function field(name, type, extra = {}) {
  return {
    name,
    label: extra.label || name,
    type,
    createable: true,
    updateable: true,
    nillable: true,
    defaultedOnCreate: false,
    filterable: true,
    sortable: true,
    referenceTo: [],
    picklistValues: [],
    ...extra,
  };
}

const sys = () => [
  field('Id', 'id', { createable: false, updateable: false, nillable: false }),
  field('CreatedDate', 'datetime', { createable: false, updateable: false }),
];

export function describes({ targetMissing = [] } = {}) {
  const account = {
    name: 'Account',
    label: 'Account',
    queryable: true,
    createable: true,
    fields: [
      ...sys(),
      field('Name', 'string', { nillable: false }),
      field('Industry', 'picklist', { picklistValues: [{ value: 'Tech', label: 'Tech', active: true }] }),
      field('AnnualRevenue', 'currency'),
      field('IsActive__c', 'boolean', { nillable: false, defaultedOnCreate: true }),
      field('ParentId', 'reference', { referenceTo: ['Account'] }),
      field('OwnerId', 'reference', { referenceTo: ['User'], nillable: false, defaultedOnCreate: true }),
      field('RecordTypeId', 'reference', { referenceTo: ['RecordType'] }),
      field('Formula__c', 'string', { createable: false, updateable: false }),
      field('Logo__c', 'base64'),
    ],
    recordTypeInfos: [],
  };
  const contact = {
    name: 'Contact',
    label: 'Contact',
    queryable: true,
    createable: true,
    fields: [
      ...sys(),
      field('LastName', 'string', { nillable: false }),
      field('Email', 'email'),
      field('AccountId', 'reference', { referenceTo: ['Account'] }),
      field('ReportsToId', 'reference', { referenceTo: ['Contact'] }),
      field('OwnerId', 'reference', { referenceTo: ['User'], nillable: false, defaultedOnCreate: true }),
    ],
    recordTypeInfos: [],
  };
  const child = {
    name: 'Child__c',
    label: 'Child',
    queryable: true,
    createable: true,
    fields: [
      ...sys(),
      field('Name', 'string', { nillable: false }),
      field('Parent__c', 'reference', { referenceTo: ['Account'], nillable: false, updateable: false }),
    ],
    recordTypeInfos: [],
  };
  const all = { Account: account, Contact: contact, Child__c: child };
  const strip = (d) => ({ ...d, fields: d.fields.filter((f) => !targetMissing.includes(`${d.name}.${f.name}`)) });
  return { source: all, target: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, strip(v)])) };
}

export const KEY_PREFIXES = new Map([['001', 'Account'], ['003', 'Contact'], ['005', 'User'], ['a00', 'Child__c'], ['012', 'RecordType']]);

export const id = (prefix, n) => `${prefix}${String(n).padStart(15, '0')}`;

/** Source mock: answers queries from fixture rows; understands "Field IN (...)" scope conditions. */
export class MockSource {
  constructor(describeMap, rows) {
    this.d = describeMap;
    this.rows = rows; // { Account: [...], Contact: [...] }
    this.queries = [];
  }
  describe(name) { return Promise.resolve(this.d[name]); }
  peekDescribe(name) { return this.d[name]; }
  async queryAll(soql, { max = Infinity } = {}) {
    this.queries.push(soql);
    const obj = soql.match(/ FROM (\w+)/)[1];
    let rows = (this.rows[obj] || []).slice();
    for (const m of soql.matchAll(/(\w+) IN \(([^)]*)\)/g)) {
      const ids = new Set(m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
      rows = rows.filter((r) => ids.has(r[m[1]]));
    }
    const lim = soql.match(/LIMIT (\d+)/);
    if (lim) rows = rows.slice(0, parseInt(lim[1], 10));
    return rows.slice(0, max);
  }
  async count() { return 0; }
  async limits() { return null; }
}

/** Target mock: assigns new Ids, can be told to fail certain records. */
export class MockTarget {
  constructor(describeMap, { failWhen = () => null } = {}) {
    this.d = describeMap;
    this.failWhen = failWhen;
    this.inserted = []; // payloads with assigned ids
    this.updates = [];
    this.deleted = [];
    this.seq = 0;
    this.batches = 0;
  }
  describe(name) { return Promise.resolve(this.d[name]); }
  peekDescribe(name) { return this.d[name]; }
  async insert(records) {
    this.batches++;
    return records.map((r) => {
      const reason = this.failWhen(r);
      if (reason) return { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: reason, fields: [] }] };
      const newId = `T${r.attributes.type.slice(0, 2)}${String(++this.seq).padStart(15, '0')}`;
      this.inserted.push({ ...r, Id: newId });
      return { id: newId, success: true, errors: [] };
    });
  }
  async update(records) {
    this.updates.push(...records);
    return records.map((r) => ({ id: r.Id, success: true, errors: [] }));
  }
  async del(ids) {
    this.deleted.push(...ids);
    return ids.map((i) => ({ id: i, success: true, errors: [] }));
  }
  async limits() {
    return { DataStorageMB: { Max: 200, Remaining: 150 }, DailyApiRequests: { Max: 15000, Remaining: 14000 } };
  }
  byName(name) {
    return this.inserted.find((r) => r.Name === name || r.LastName === name);
  }
}

export function rtIndex(rows) {
  return new RecordTypeIndex(rows);
}

export const APP_SETTINGS = { maxRecordsPerObject: 10000, warnTotalRecords: 5000, estimatedKbPerRecord: 2, allowProductionTarget: false };
