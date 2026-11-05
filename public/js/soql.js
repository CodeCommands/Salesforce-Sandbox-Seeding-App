// Converts plan steps (UI selections) into SOQL. Pure functions; no DOM or network.
import { fieldMap, getField, selectedSourceFields, hasRecordTypes, splitQualifiedRt } from './schema.js';

export const OPERATORS = {
  eq: { label: 'equals' },
  ne: { label: 'not equal to' },
  lt: { label: 'less than' },
  gt: { label: 'greater than' },
  le: { label: 'less or equal' },
  ge: { label: 'greater or equal' },
  contains: { label: 'contains' },
  notContains: { label: 'does not contain' },
  startsWith: { label: 'starts with' },
  endsWith: { label: 'ends with' },
  in: { label: 'is one of', list: true },
  notIn: { label: 'is not one of', list: true },
  includes: { label: 'includes', list: true },
  excludes: { label: 'excludes', list: true },
  isNull: { label: 'is blank', noValue: true },
  notNull: { label: 'is not blank', noValue: true },
};

const NUMERIC = new Set(['int', 'double', 'currency', 'percent', 'long']);
const TEMPORAL = new Set(['date', 'datetime', 'time']);
const COMPARE = { eq: '=', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=' };

const DATE_LITERAL = /^(YESTERDAY|TODAY|TOMORROW|LAST_WEEK|THIS_WEEK|NEXT_WEEK|LAST_MONTH|THIS_MONTH|NEXT_MONTH|LAST_90_DAYS|NEXT_90_DAYS|THIS_QUARTER|LAST_QUARTER|NEXT_QUARTER|THIS_YEAR|LAST_YEAR|NEXT_YEAR|THIS_FISCAL_QUARTER|LAST_FISCAL_QUARTER|NEXT_FISCAL_QUARTER|THIS_FISCAL_YEAR|LAST_FISCAL_YEAR|NEXT_FISCAL_YEAR|(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):\d+|N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS)_AGO:\d+)$/i;

export const RECORD_TYPE_FIELD = 'RecordTypeId';

export function operatorsFor(field) {
  if (!field) return ['eq', 'ne', 'isNull', 'notNull'];
  if (field.name === RECORD_TYPE_FIELD) return ['eq', 'ne', 'in', 'notIn', 'isNull', 'notNull'];
  const t = field.type;
  if (t === 'boolean') return ['eq', 'ne'];
  if (t === 'multipicklist') return ['includes', 'excludes', 'eq', 'ne', 'isNull', 'notNull'];
  if (NUMERIC.has(t) || TEMPORAL.has(t)) return ['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'in', 'notIn', 'isNull', 'notNull'];
  if (t === 'id' || t === 'reference' || t === 'picklist') return ['eq', 'ne', 'in', 'notIn', 'isNull', 'notNull'];
  return ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull', 'notNull'];
}

export function escapeSoqlString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function escapeLike(s) {
  return escapeSoqlString(s).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export const quote = (s) => `'${escapeSoqlString(s)}'`;

/** Splits "a, b, c" (or newline separated) into trimmed values. */
export function splitList(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter((v) => v !== '');
  return String(raw ?? '')
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Formats a single user value as a SOQL literal for the given field. Throws on invalid input. */
export function formatValue(field, raw) {
  const v = String(raw ?? '').trim();
  const t = field.type;
  const label = field.label || field.name;
  if (t === 'boolean') {
    if (!/^(true|false)$/i.test(v)) throw new Error(`${label}: enter true or false`);
    return v.toLowerCase();
  }
  if (NUMERIC.has(t)) {
    if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`${label}: "${v}" is not a number`);
    return v;
  }
  if (t === 'date') {
    if (DATE_LITERAL.test(v)) return v.toUpperCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    throw new Error(`${label}: use YYYY-MM-DD or a date literal such as LAST_N_DAYS:30`);
  }
  if (t === 'datetime') {
    if (DATE_LITERAL.test(v)) return v.toUpperCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/i);
    if (m) return `${m[1]}T${m[2]}${m[3] || ':00'}${(m[5] || 'Z').toUpperCase()}`;
    throw new Error(`${label}: use YYYY-MM-DD, YYYY-MM-DDThh:mm:ssZ or a date literal`);
  }
  if (t === 'time') {
    const m = v.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/i);
    if (!m) throw new Error(`${label}: use hh:mm or hh:mm:ss`);
    return `${m[1]}:${m[2]}:${m[3] || '00'}.${(m[4] || '0').padEnd(3, '0')}Z`;
  }
  if (t === 'id' || t === 'reference') {
    if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v)) throw new Error(`${label}: "${v}" is not a valid Salesforce Id`);
    return quote(v);
  }
  return quote(raw ?? ''); // strings keep inner whitespace
}

/** Record type filter: values are (optionally namespaced) DeveloperNames, never Ids. */
function recordTypeExpression(values) {
  const parts = values.map(splitQualifiedRt);
  if (parts.every((p) => !p.namespace)) {
    if (parts.length === 1) return `RecordType.DeveloperName = ${quote(parts[0].developerName)}`;
    return `RecordType.DeveloperName IN (${parts.map((p) => quote(p.developerName)).join(', ')})`;
  }
  const ors = parts.map((p) =>
    p.namespace
      ? `(RecordType.NamespacePrefix = ${quote(p.namespace)} AND RecordType.DeveloperName = ${quote(p.developerName)})`
      : `(RecordType.NamespacePrefix = null AND RecordType.DeveloperName = ${quote(p.developerName)})`);
  return ors.length === 1 ? ors[0] : `(${ors.join(' OR ')})`;
}

export function compileCondition(cond, describe) {
  const field = getField(describe, cond.field);
  if (!field) throw new Error(`Unknown field "${cond.field}" on ${describe.name}`);
  const op = cond.operator;
  if (!OPERATORS[op]) throw new Error(`Unknown operator "${op}"`);
  if (!operatorsFor(field).includes(op)) throw new Error(`Operator "${OPERATORS[op].label}" is not valid for ${field.label}`);
  if (field.name !== RECORD_TYPE_FIELD && !field.filterable) throw new Error(`${field.label} cannot be used in a filter`);
  const name = field.name;

  if (op === 'isNull') return `${name} = null`;
  if (op === 'notNull') return `${name} != null`;

  if (field.name === RECORD_TYPE_FIELD) {
    const values = OPERATORS[op].list ? splitList(cond.value) : [String(cond.value ?? '').trim()].filter(Boolean);
    if (!values.length) throw new Error('Record Type: choose at least one record type');
    const expr = recordTypeExpression(values);
    return op === 'ne' || op === 'notIn' ? `(NOT ${expr})` : expr;
  }

  if (OPERATORS[op].list) {
    const values = splitList(cond.value);
    if (!values.length) throw new Error(`${field.label}: enter at least one value`);
    if (op === 'includes' || op === 'excludes') {
      return `${name} ${op === 'includes' ? 'INCLUDES' : 'EXCLUDES'} (${values.map(quote).join(', ')})`;
    }
    return `${name} ${op === 'in' ? 'IN' : 'NOT IN'} (${values.map((v) => formatValue(field, v)).join(', ')})`;
  }

  if (op in COMPARE) {
    if (String(cond.value ?? '').trim() === '' && field.type !== 'string' && field.type !== 'textarea') {
      throw new Error(`${field.label}: enter a value (or use "is blank")`);
    }
    return `${name} ${COMPARE[op]} ${formatValue(field, cond.value)}`;
  }

  const v = String(cond.value ?? '');
  if (!v) throw new Error(`${field.label}: enter a value`);
  switch (op) {
    case 'contains': return `${name} LIKE '%${escapeLike(v)}%'`;
    case 'notContains': return `(NOT ${name} LIKE '%${escapeLike(v)}%')`;
    case 'startsWith': return `${name} LIKE '${escapeLike(v)}%'`;
    case 'endsWith': return `${name} LIKE '%${escapeLike(v)}'`;
    default: throw new Error(`Unsupported operator ${op}`);
  }
}

/**
 * Parses custom filter logic such as "1 AND (2 OR 3)" and substitutes compiled conditions.
 * Mixing AND/OR at the same level without parentheses is rejected (SOQL rejects it too).
 */
export function applyFilterLogic(expression, compiled) {
  const tokens = [];
  const re = /\s*(\d+|AND\b|OR\b|NOT\b|\(|\))\s*/giy;
  const src = String(expression || '').trim();
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) throw new Error(`Filter logic: unexpected text near "${src.slice(pos, pos + 10)}"`);
    tokens.push(m[1].toUpperCase());
    pos = re.lastIndex;
  }
  if (!tokens.length) throw new Error('Filter logic is empty');
  const used = new Set();
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseExpr() {
    let left = parseTerm();
    let joiner = null;
    while (peek() === 'AND' || peek() === 'OR') {
      const op = next();
      if (joiner && joiner !== op) throw new Error('Filter logic: use parentheses when mixing AND and OR, e.g. 1 AND (2 OR 3)');
      joiner = op;
      left = `${left} ${op} ${parseTerm()}`;
    }
    return left;
  }
  function parseTerm() {
    const t = next();
    if (t === undefined) throw new Error('Filter logic ends unexpectedly');
    if (t === 'NOT') return `NOT ${parseTerm()}`;
    if (t === '(') {
      const inner = parseExpr();
      if (next() !== ')') throw new Error('Filter logic: missing closing parenthesis');
      return `(${inner})`;
    }
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      if (n < 1 || n > compiled.length) throw new Error(`Filter logic references filter ${n}, but only ${compiled.length} exist`);
      used.add(n);
      return `(${compiled[n - 1]})`;
    }
    throw new Error(`Filter logic: unexpected "${t}"`);
  }

  const out = parseExpr();
  if (i < tokens.length) throw new Error(`Filter logic: unexpected "${tokens[i]}"`);
  const unused = compiled.map((_, idx) => idx + 1).filter((n) => !used.has(n));
  if (unused.length) throw new Error(`Filter logic does not use filter ${unused.join(', ')}`);
  return out;
}

export function compileWhere(step, describe, extraConditions = []) {
  const parts = [];
  const filters = step.filters || [];
  if (filters.length) {
    const compiled = filters.map((c, idx) => {
      try {
        return compileCondition(c, describe);
      } catch (e) {
        throw new Error(`Filter ${idx + 1}: ${e.message}`);
      }
    });
    const mode = (step.filterLogic && step.filterLogic.mode) || 'all';
    let main;
    if (mode === 'custom') main = applyFilterLogic(step.filterLogic.expression, compiled);
    else main = compiled.length === 1 ? compiled[0] : compiled.map((c) => `(${c})`).join(mode === 'any' ? ' OR ' : ' AND ');
    parts.push(main);
  }
  const adv = String(step.advancedWhere || '').trim();
  if (adv) parts.push(adv);
  parts.push(...extraConditions.filter(Boolean));
  if (parts.length <= 1) return parts[0] || '';
  return parts.map((p) => `(${p})`).join(' AND ');
}

/** Field list to SELECT: Id, chosen fields, record type relationship fields, and scope lookups. */
export function queryFieldNames(step, describe) {
  const names = ['Id'];
  const seen = new Set(['id']);
  const add = (n) => {
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      names.push(n);
    }
  };
  for (const f of selectedSourceFields(step, describe)) add(f.name);
  if (hasRecordTypes(describe)) {
    add('RecordTypeId');
    add('RecordType.DeveloperName');
    add('RecordType.NamespacePrefix');
  }
  return names;
}

export function compileOrderBy(step, describe) {
  const ob = step.orderBy;
  if (!ob || !ob.field) return '';
  const f = getField(describe, ob.field);
  if (!f) throw new Error(`Order by: unknown field "${ob.field}"`);
  if (!f.sortable) throw new Error(`Order by: ${f.label} is not sortable`);
  const dir = String(ob.direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return ` ORDER BY ${f.name} ${dir}${dir === 'DESC' ? ' NULLS LAST' : ''}`;
}

export function clampLimit(limit, max) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(100, max);
  return Math.min(n, max);
}

export function compileQuery(step, describe, { limit, extraConditions = [], maxLimit = 10000 } = {}) {
  const fields = queryFieldNames(step, describe);
  const where = compileWhere(step, describe, extraConditions);
  const lim = clampLimit(limit ?? step.limit, maxLimit);
  return `SELECT ${fields.join(', ')} FROM ${describe.name}${where ? ` WHERE ${where}` : ''}${compileOrderBy(step, describe)} LIMIT ${lim}`;
}

export function compileCountQuery(step, describe, extraConditions = []) {
  const where = compileWhere(step, describe, extraConditions);
  return `SELECT COUNT() FROM ${describe.name}${where ? ` WHERE ${where}` : ''}`;
}

/** `Field IN ('id1','id2',...)` */
export function inCondition(fieldName, ids) {
  return `${fieldName} IN (${ids.map(quote).join(',')})`;
}

export { fieldMap };
