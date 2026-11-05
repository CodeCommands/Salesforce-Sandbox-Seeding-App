# Seeding template format (schemaVersion 1)

A template is a JSON file (`*.seed.json`) describing a seeding plan. It holds no data and no org-specific Ids: objects and fields are referenced by API name, and Record Types by **DeveloperName**. That way the same template works against any pair of orgs.

```json
{
  "format": "sf-sandbox-seeding-template",
  "schemaVersion": 1,
  "name": "Partner accounts with contacts",
  "description": "",
  "createdAt": "2026-11-04T10:00:00.000Z",
  "updatedAt": "2026-11-04T10:00:00.000Z",
  "settings": {
    "matchUsersByUsername": true,
    "preserveLookupsTo": [],
    "allowDuplicateSave": true,
    "disableAssignmentRules": true,
    "batchSize": 200
  },
  "steps": [
    {
      "id": "accounts",
      "order": 1,
      "object": "Account",
      "enabled": true,
      "fieldMode": "all",
      "fields": [],
      "filters": [
        { "field": "RecordTypeId", "operator": "in", "value": "Partner, Reseller" },
        { "field": "CreatedDate", "operator": "ge", "value": "LAST_N_DAYS:365" }
      ],
      "filterLogic": { "mode": "all", "expression": "" },
      "advancedWhere": "",
      "orderBy": { "field": "CreatedDate", "direction": "DESC" },
      "limit": 100,
      "parentScopes": []
    },
    {
      "id": "contacts",
      "order": 2,
      "object": "Contact",
      "fieldMode": "selected",
      "fields": ["FirstName", "LastName", "Email", "AccountId", "ReportsToId"],
      "filters": [],
      "limit": 500,
      "parentScopes": [{ "field": "AccountId", "stepId": "accounts" }]
    },
    {
      "id": "parent-accounts",
      "order": 0,
      "object": "Account",
      "recordSource": "referenced",
      "referencedBy": [
        { "stepId": "contacts", "field": "AccountId" },
        { "stepId": "parent-accounts", "field": "ParentId" }
      ],
      "limit": 100
    }
  ]
}
```

## Top level

| Key | Type | Notes |
| --- | --- | --- |
| `format` | string | Always `sf-sandbox-seeding-template`. Optional on import. |
| `schemaVersion` | number | `1`. Templates from a newer version are rejected. |
| `name`, `description` | string | Shown in the app. |
| `settings` | object | See below. Missing keys fall back to defaults. |
| `steps` | array | **Execution order** is the `order` value, or the array order if `order` is missing. |

## `settings`

| Key | Default | Meaning |
| --- | --- | --- |
| `matchUsersByUsername` | `true` | User lookups (`OwnerId`, custom User lookups) are mapped to the **active** Target user with the same Username. Sandbox suffixes are handled: `ada@acme.com` in production is `ada@acme.com.uat` in the `uat` sandbox. Unmatched users are left blank, so the running user becomes the owner. |
| `preserveLookupsTo` | `[]` | Objects whose Ids are copied **as-is** into lookups, for objects with identical Ids in both orgs. Lookups to other objects outside the plan are left blank. |
| `allowDuplicateSave` | `true` | Sends `Sforce-Duplicate-Rule-Header: allowSave=true`. This bypasses duplicate rules set to *Alert*, not ones set to *Block*. |
| `disableAssignmentRules` | `true` | Sends `Sforce-Auto-Assign: FALSE`, so lead and case assignment rules do not reassign owners. |
| `batchSize` | `200` | Records per sObject Collections request (1–200). |

## Step

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | Referenced by other steps' `parentScopes`. Imported ids are replaced internally, and references are re-pointed. |
| `order` | number | 1-based position in the execution order. |
| `object` | string | sObject API name. |
| `enabled` | boolean | Disabled steps are kept in the template but skipped. |
| `fieldMode` | `all` \| `selected` | `all` = every field that can be set on insert in the Source org. Fields missing in the Target are skipped automatically. |
| `fields` | string[] | Used when `fieldMode` is `selected`. Read-only fields are ignored. |
| `filters` | Filter[] | Become the SOQL `WHERE` clause. |
| `filterLogic` | object | `mode`: `all` (AND), `any` (OR) or `custom` with `expression` such as `"1 AND (2 OR 3)"`. Filters are numbered from 1. Use parentheses when mixing AND and OR. |
| `advancedWhere` | string | Raw SOQL condition AND-ed with the filters. |
| `orderBy` | object \| null | `{ "field": "CreatedDate", "direction": "ASC" \| "DESC" }` |
| `limit` | number | **Required.** Capped by the app's *Max records per object* setting (default 10,000). |
| `parentScopes` | Scope[] | `{ "field": "AccountId", "stepId": "accounts" }` keeps only records whose lookup points at a record extracted by that step (children of what you picked). Several scopes are AND-ed. |
| `recordSource` | `query` \| `referenced` \| `both` | `query` = filters + LIMIT (default). `referenced` = exactly the records listed by `referencedBy`; filters and LIMIT are ignored, and the per-object cap still applies. `both` = the union. |
| `referencedBy` | Ref[] | `{ "stepId": "opps", "field": "AccountId" }` adds the records that step's lookup points to (parents of what you picked). These are usually created by **Find related records**. With `stepId` equal to the step's own id, it follows a self-lookup such as `ParentId` up to 10 levels. |

Extraction runs in dependency order: a step is read after the steps it is scoped to and the steps that reference it. Loops are rejected. Insertion runs in `order`, parents first.

## Filter

`{ "field": "<API name>", "operator": "<op>", "value": "<text>" }`

| Operator | SOQL |
| --- | --- |
| `eq`, `ne`, `lt`, `gt`, `le`, `ge` | `=`, `!=`, `<`, `>`, `<=`, `>=` |
| `contains`, `notContains`, `startsWith`, `endsWith` | `LIKE '%v%'` and variants (`%` and `_` in values are escaped) |
| `in`, `notIn` | `IN (...)`. `value` is comma-separated. |
| `includes`, `excludes` | Multi-select picklists |
| `isNull`, `notNull` | `= null`, `!= null` (no value) |

Values are validated per field type. Dates accept `YYYY-MM-DD` or SOQL date literals (`TODAY`, `LAST_N_DAYS:30`, `THIS_FISCAL_YEAR`, …). Datetimes also accept ISO 8601.

### Record Type filters

Use `"field": "RecordTypeId"` with the **DeveloperName** as the value, never an Id:

| Template | Generated SOQL |
| --- | --- |
| `{"field":"RecordTypeId","operator":"eq","value":"Partner"}` | `RecordType.DeveloperName = 'Partner'` |
| `{"field":"RecordTypeId","operator":"in","value":"Partner, Reseller"}` | `RecordType.DeveloperName IN ('Partner', 'Reseller')` |
| `{"field":"RecordTypeId","operator":"eq","value":"pkg__Partner"}` | `(RecordType.NamespacePrefix = 'pkg' AND RecordType.DeveloperName = 'Partner')` |

Managed-package record types are written `namespace__DeveloperName`.

## What happens at run time

1. **Extract**: each enabled step is queried in dependency order (`Id`, the chosen fields, `RecordType.DeveloperName`, `RecordType.NamespacePrefix`). Scoped steps query in chunks of parent Ids; referenced steps query `Id IN (…)`. A record matched by two steps is inserted once.
2. **Pre-flight**: every Record Type used by an extracted record must exist and be active in the Target, matched by namespace + DeveloperName, or by DeveloperName alone with a warning. Missing ones halt the run before any insert. Users are matched by Username, lookups pointing outside the seed are listed, and storage and API headroom are checked.
3. **Insert**: parents first, 200 records per call. `RecordTypeId` is replaced with the Target Id. Lookups to records inserted earlier are rewritten using the in-memory Source→Target Id map. Self-lookups such as `Account.ParentId` are inserted level by level.
4. **Back-fill**: lookups whose parent was inserted later (cycles, or a child step placed before its optional parent) are set by a final update.
5. **Unresolved lookups**: if the parent is not in the seed (or a user has no match), the lookup is left blank. If that lookup is required, the record is skipped and reported.
