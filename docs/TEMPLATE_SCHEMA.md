# Seeding template format (schemaVersion 1 and 2)

A template is a JSON file (`*.seed.json`) describing a seeding plan. A **plan-only** template (`schemaVersion` 1) holds no data and no org-specific Ids: objects and fields are referenced by API name, and Record Types by **DeveloperName**. That way the same template works against any pair of orgs.

A template exported **with record data** (`*.seed-data.json`, `schemaVersion` 2) adds a `data` block with the captured records, so it can run with only a Target org connected. See [Record data](#record-data-data).

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
| `schemaVersion` | number | `1` (plan only) or `2` (has `data`). Templates from a newer version are rejected. |
| `data` | object | Optional. Captured records; see below. |
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

Extraction runs in dependency order: a step is read after the steps it is scoped to and the steps that reference it. Loops are rejected. Exception: when a step is scoped to a parent step through a lookup (`parentScopes`), and the parent also lists that same child and lookup in `referencedBy`, the pair is repaired on import. If the parent's `recordSource` is `referenced`, the child's scope is removed; otherwise the parent's redundant `referencedBy` entry is removed. Insertion runs in `order`, parents first.

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

## Record data (`data`)

Present only in templates exported with **Plan + record data**. The insert uses these records instead of querying the Source org.

```json
"data": {
  "format": "records-v1",
  "capturedAt": "2026-11-05T10:00:00.000Z",
  "source": { "orgId": "00D…", "orgName": "Acme Production", "isSandbox": false, "instanceUrl": "https://acme.my.salesforce.com", "username": "ada@acme.com" },
  "total": 7,
  "keyPrefixes": { "001": "Account", "003": "Contact", "005": "User" },
  "objects": { "Account": { "name": "Account", "label": "Account", "labelPlural": "Accounts", "keyPrefix": "001", "fields": [ { "name": "Name", "type": "string", "createable": true, "nillable": false } ] } },
  "users": { "005…": { "Username": "ada@acme.com", "Name": "Ada", "IsActive": true } },
  "steps": { "accounts": { "records": [ { "Id": "001…", "Name": "Acme", "OwnerId": "005…", "RecordTypeId": null, "RecordType": null } ], "stats": {} } }
}
```

| Key | Notes |
| --- | --- |
| `format` | Always `records-v1`. Unknown formats are dropped with a warning; the plan still imports. |
| `source` | The org the records came from. Used for messages, the same-org check and sandbox-suffix detection when matching users. |
| `keyPrefixes` | Id prefix → object for every lookup value in the records, so the app can tell a User Id from an Account Id. |
| `objects` | Trimmed Source describes (field name, type, `referenceTo`, `createable`, `nillable`…) for each step's object. These decide which fields are inserted and how lookups are handled. |
| `users` | Username of every User referenced by a lookup, for *Match users by Username*. |
| `steps` | Keyed by step `id`. `records` are the Source records exactly as queried (minus the REST `attributes` blocks), including `RecordType.DeveloperName` and `NamespacePrefix`. Records whose `Id` is not a valid 15/18-character Id are ignored. |

Steps without an entry insert nothing. The step fields (`filters`, `limit`, links…) are kept for reference and for capturing again. They are not re-applied to the captured records.
