// Helpers over Salesforce describe results and RecordType data.

const NON_SEEDABLE_TYPES = new Set(['base64', 'address', 'location', 'complexvalue', 'json']);
const EXCLUDED_OBJECT_SUFFIXES = ['__History', '__Share', '__Feed', '__Tag', '__ChangeEvent', 'ChangeEvent', '__e', '__mdt', '__b', '__x', '__hd', '__dlm'];

const fieldMapCache = new WeakMap();

/** Case-insensitive name -> field describe. */
export function fieldMap(describe) {
  if (!describe) return new Map();
  let m = fieldMapCache.get(describe);
  if (!m) {
    m = new Map(describe.fields.map((f) => [f.name.toLowerCase(), f]));
    fieldMapCache.set(describe, m);
  }
  return m;
}

export function getField(describe, name) {
  return fieldMap(describe).get(String(name || '').toLowerCase());
}

/** Objects worth offering as seeding sources (queryable + createable, not system/derived). */
export function isSeedableObject(g) {
  if (!g || !g.queryable || !g.createable || g.deprecatedAndHidden) return false;
  return !EXCLUDED_OBJECT_SUFFIXES.some((s) => g.name.endsWith(s));
}

/** Fields that can be copied: createable on insert and of a type the REST collections API accepts. */
export function isSeedableField(f) {
  return !!f && f.createable && f.name !== 'Id' && !NON_SEEDABLE_TYPES.has(f.type);
}

export function seedableFields(describe) {
  return describe ? describe.fields.filter(isSeedableField) : [];
}

/** Required on insert: not nillable and Salesforce will not default it. */
export function isRequiredOnCreate(f) {
  return !!f && f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean';
}

export function isLookup(f) {
  return !!f && f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0 && f.name !== 'RecordTypeId';
}

export function hasRecordTypes(describe) {
  return !!getField(describe, 'RecordTypeId');
}

/**
 * Setup / reference objects that are matched or defaulted in the target rather than copied.
 * (Users are matched by Username; the others are left to Salesforce defaults.)
 */
export const NON_COPYABLE_REFERENCES = new Set([
  'user', 'group', 'profile', 'userrole', 'recordtype', 'businesshours', 'organization', 'permissionset',
  'folder', 'emailtemplate', 'document', 'callcenter', 'territory', 'territory2', 'site', 'network',
  'queue', 'calendar', 'process', 'flow', 'apexclass', 'staticresource', 'brandtemplate',
]);

/**
 * A lookup that can only point to setup data each org keeps for itself (Business Hours, queues, email
 * templates…), never to User (users are matched by Username) or to records this tool copies. Such
 * fields are not sent on insert: the Target org fills them in (e.g. Case.BusinessHoursId gets the
 * default Business Hours), unless the template keeps those Ids as-is.
 */
export function isOrgSetupLookup(f) {
  return isLookup(f) && f.referenceTo.every((r) => NON_COPYABLE_REFERENCES.has(r.toLowerCase()))
    && !f.referenceTo.some((r) => r.toLowerCase() === 'user');
}

export function isCopyableReference(objectName, globalSobjects) {
  if (!objectName || NON_COPYABLE_REFERENCES.has(objectName.toLowerCase())) return false;
  const g = (globalSobjects || []).find((x) => x.name.toLowerCase() === objectName.toLowerCase());
  return g ? isSeedableObject(g) : false;
}

/** The field Salesforce marks as the record name (Name, CaseNumber, Subject…). */
export function nameFieldOf(describe) {
  if (!describe) return null;
  const f = describe.fields.find((x) => x.nameField) || describe.fields.find((x) => x.name === 'Name');
  return f ? f.name : null;
}

export function keyPrefixMap(globalSobjects) {
  const m = new Map();
  for (const g of globalSobjects || []) if (g.keyPrefix) m.set(g.keyPrefix, g.name);
  return m;
}

/** Fields the step will try to insert, from the source describe. */
export function selectedSourceFields(step, describe) {
  if (!describe) return [];
  const byName = fieldMap(describe);
  let fields;
  if (step.fieldMode === 'selected') {
    fields = (step.fields || []).map((n) => byName.get(String(n).toLowerCase())).filter(isSeedableField);
  } else {
    fields = seedableFields(describe);
  }
  // Parent-scope lookups are always carried so the relationship survives.
  const names = new Set(fields.map((f) => f.name));
  for (const sc of step.parentScopes || []) {
    const f = byName.get(String(sc.field).toLowerCase());
    if (isSeedableField(f) && !names.has(f.name)) {
      fields.push(f);
      names.add(f.name);
    }
  }
  return fields.filter((f) => f.name !== 'RecordTypeId');
}

// ---------- Record types ----------

export const RT_SOQL = 'SELECT Id, DeveloperName, NamespacePrefix, SobjectType, Name, IsActive FROM RecordType';

/** "ns__DeveloperName" when namespaced; API names cannot contain "__" so this is unambiguous. */
export function qualifyRt(namespace, developerName) {
  return namespace ? `${namespace}__${developerName}` : developerName;
}

export function splitQualifiedRt(qualified) {
  const s = String(qualified || '');
  const idx = s.indexOf('__');
  if (idx > 0) return { namespace: s.slice(0, idx), developerName: s.slice(idx + 2) };
  return { namespace: null, developerName: s };
}

export class RecordTypeIndex {
  constructor(rows = []) {
    this.rows = rows;
    this.byKey = new Map(); // `${object}::${qualified}` lowercased -> row
    this.byDev = new Map(); // `${object}::${developerName}` lowercased -> rows[]
    this.byObject = new Map(); // object lowercased -> rows[]
    for (const r of rows) {
      const obj = String(r.SobjectType).toLowerCase();
      this.byKey.set(`${obj}::${qualifyRt(r.NamespacePrefix, r.DeveloperName).toLowerCase()}`, r);
      const dk = `${obj}::${String(r.DeveloperName).toLowerCase()}`;
      if (!this.byDev.has(dk)) this.byDev.set(dk, []);
      this.byDev.get(dk).push(r);
      if (!this.byObject.has(obj)) this.byObject.set(obj, []);
      this.byObject.get(obj).push(r);
    }
  }

  forObject(object) {
    return (this.byObject.get(String(object).toLowerCase()) || []).slice().sort((a, b) => a.DeveloperName.localeCompare(b.DeveloperName));
  }

  get(object, qualified) {
    return this.byKey.get(`${String(object).toLowerCase()}::${String(qualified).toLowerCase()}`) || null;
  }

  /**
   * Resolve a source record type into this (target) org.
   * Exact match on namespace + DeveloperName first; then DeveloperName ignoring namespace
   * (managed package installed with different state), flagged as `namespaceMismatch`.
   */
  resolve(object, qualified) {
    const exact = this.get(object, qualified);
    if (exact) return { row: exact, namespaceMismatch: false };
    const { developerName } = splitQualifiedRt(qualified);
    const candidates = this.byDev.get(`${String(object).toLowerCase()}::${developerName.toLowerCase()}`) || [];
    if (candidates.length === 1) return { row: candidates[0], namespaceMismatch: true };
    if (candidates.length > 1) return { row: null, ambiguous: candidates };
    return { row: null };
  }
}
