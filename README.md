# Sandbox Seeder

A local web app for seeding Salesforce sandboxes with realistic, connected data. It copies records from a Source org into a Target sandbox and keeps the relationships between them intact.

* **Zero installs:** Windows PowerShell plus a browser. No Node.js, Python, npm, or admin rights.
* **Two orgs, one browser tab:** OAuth 2.0 + PKCE sign-in for Source and Target through an External Client App. No passwords or client secrets are stored.
* **Find related records:** scans the records you selected for lookups to records outside the plan, shows them, and adds them on request. Run it again to follow the chain (Opportunity → Account → parent Account…).
* **Users matched by Username:** `OwnerId` and other User lookups point to the same person in the Target, sandbox suffixes included (`ada@acme.com` ↔ `ada@acme.com.uat`).
* **Always the latest API:** each org's newest REST API version is detected on connect (for example v68.0).
* **Relationship-aware:** parents are inserted before children, lookups are remapped to the new Ids, hierarchies such as `Account.ParentId` are inserted level by level, and circular lookups are back-filled.
* **Portable Record Types:** templates store `DeveloperName`, never Ids. Every Record Type used by the data is checked against the Target **before** anything is inserted.
* **Reusable templates:** save a plan as JSON, share it, and load it again with Import (or drag and drop).
* **Guard rails:** a required `LIMIT` per object, preview counts, storage and API headroom checks, a block on production targets, dry runs, and one-click rollback.

## Quick start

1. **One-time admin setup:** create the External Client App described in [docs/EXTERNAL_CLIENT_APP.md](docs/EXTERNAL_CLIENT_APP.md) and copy its Consumer Key.
2. Double-click **`start.bat`**. A console window starts the local server and your browser opens `http://localhost:5050/`. Keep the window open; press `Ctrl+C` to stop.
3. In the app, open **Settings** (⚙) and paste the Consumer Key.
4. **Connect** the Source org and the Target sandbox.
5. **Build plan:** add objects, choose fields, filters and limits, then click **Find related records…** to pull in the records those lookups point to.
6. **Validate & run:** *Validate* → *Dry run* → *Run seeding*.

To use another port: `start.bat 5051` (the External Client App callback URL must match).

Windows shows a warning the first time because the scripts are not signed. That is expected.

### Transport

| | Local proxy (default) | Direct |
| --- | --- | --- |
| Path | Browser → `server.ps1` → Salesforce | Browser → Salesforce |
| Org setup | none | `http://localhost:5050` in **Setup → CORS** of every org, plus *Enable CORS for OAuth endpoints* |
| Notes | Uses Windows' system proxy and your Windows sign-in for proxy authentication. `start.bat` must stay open. | Uses the browser's network stack. Choose it in Settings only if the relay is blocked. |

## Using the app

### 1. Connect

Pick *Production*, *Sandbox* or a *Custom domain* (My Domain, required for SSO orgs) for each side. Sign-in happens in a pop-up. If pop-ups are blocked, the app falls back to a full-page redirect, and your plan draft is kept. If an org has its own External Client App with a different key, enter that key under **Advanced** on the org's card. Each card shows the API version in use.

### 2. Build the plan

* **Execution order** (left panel) is the insert order. Put parents above children, or click **Auto-order**. A red *order* badge means a *required* parent (such as a master-detail) runs too late. A *back-fill* badge means an optional lookup will be set by an update after insert.
* **Filters** build the `WHERE` clause. Choosing *Record Type* shows a dropdown of DeveloperNames and compiles to `RecordType.DeveloperName = '…'`. Use custom logic such as `1 AND (2 OR 3)` for mixed conditions, or add raw SOQL under *Advanced*.
* **Scoping children:** tick e.g. *"Only Contact records whose Account ID is one of the extracted Account records"* to seed the children of what you picked. This is suggested automatically when the choice is clear.
* **Find related records…** (steps panel, each step's *Related records* section, or the run screen after a dry run) works the other way round, from children to what they point at. It extracts your selection (read-only) and lists every lookup that points to records not in the plan, for example *"Opportunity → Account via AccountId: 30 of 50 records have a value · 18 distinct Accounts · 6 not in the plan"*. You can preview those records by name and tick the ones to add:
  * **new step** that takes exactly the referenced records (placed before the step that references them);
  * **existing step** of that object (it then takes its filtered records *and* the referenced ones);
  * **parent hierarchy** for self-lookups such as `Account.ParentId` (follows parents up to 10 levels).

  After adding, the app scans again automatically, so chains are followed until every lookup is covered. Adding is always optional, and lookups to users and setup objects (profiles, queues, record types) are not listed.
* **Records to take** (on steps with references): *matching filters*, *only referenced records*, or *both*. References can also be added or removed by hand here.
* **Fields:** *All insertable fields* (portable across orgs) or a hand-picked list. Formula, system and audit fields are never copied.
* **LIMIT** is required for every object and capped by *Settings → Max records per object*.
* **Template settings:** *Match users by Username* (on by default), *Keep Ids as-is for lookups to* (for objects whose Ids are identical in both orgs), and the duplicate-rule and assignment-rule headers.

The plan auto-saves in this browser. **Export** downloads it as `<name>.seed.json`; **Import** loads one. A sample is in [public/templates/](public/templates/).

### 3. Validate & run

| Button | Does |
| --- | --- |
| **Validate** | Schema checks in both orgs, query validation, ordering, parent scopes, `COUNT()` preview, Target storage and API headroom. Read-only. |
| **Dry run** | Validate, then extract the records and run the data checks: every Record Type must exist and be active in the Target, users are matched by Username, and required lookups are checked. Lookups pointing outside the seed are listed with a **Review & add…** button. Nothing is written. |
| **Run seeding** | Dry run, then a confirmation, then insert, then back-fill. |

During a run you can **Stop** at any time. Afterwards you can download the **Id map** (Source Id → Target Id) and the **errors** as CSV. **Delete created records** rolls the run back, newest first. The created Ids are also kept in this browser, so rollback still works after a page reload.

## How relationships are resolved

1. Records are **extracted** in dependency order: a step that takes referenced records is read after the steps that point to it. They are **inserted** in plan order (parents first). Each new record's Id is stored in an in-memory map `sourceId → targetId`.
2. Before a record is inserted, every lookup is checked:
   * parent already inserted → replaced with the Target Id;
   * parent in this seed but inserted later → left blank now, set by a **back-fill update** at the end;
   * a User → the active Target user with the same Username (base username plus the Target sandbox suffix, then exact). If none exists, it's left blank;
   * parent not in the seed → left blank. If the lookup is **required**, the record is skipped and reported. Objects listed in *Keep Ids as-is* keep the original Id.
3. `RecordTypeId` is replaced with the Target Record Type that has the same namespace + `DeveloperName`.
4. Self-references (Account hierarchies, Contact `ReportsTo`) are inserted top-level first, then one level per pass.

When an owner can't be matched, the lookup is left blank and the running user becomes the owner. The pre-flight report lists which usernames were not found or are inactive.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Console says *Group Policy sets the PowerShell execution policy* | IT enforces an execution policy that overrides `-ExecutionPolicy Bypass`. Answer **Y** to load the server in memory (check your IT policy first), or ask IT to sign/allow `server.ps1`. |
| *PowerShell is running in ConstrainedLanguage mode* | AppLocker/WDAC blocks .NET in scripts. Ask IT to allow `server.ps1`, or serve the `public/` folder from any internal web server (Direct transport only). |
| *Could not listen on http://localhost:5050/* | The port is in use (maybe the Seeder is already running). Use `start.bat 5051` and register that callback URL. |
| Windows SmartScreen warns about `start.bat` | Right-click the zip → Properties → **Unblock** before extracting, or choose *More info → Run anyway*. |
| `redirect_uri_mismatch` | The External Client App callback URL must be exactly `http://localhost:<port>/oauth/callback.html`. |
| `invalid_client_id` on one org | A Local External Client App only works in its own org. Enter that org's Consumer Key under *Advanced* on its Connect card. See [docs/EXTERNAL_CLIENT_APP.md](docs/EXTERNAL_CLIENT_APP.md). |
| *The local proxy is not available* | The page was not opened through `start.bat`. Start it, or switch Transport to Direct in Settings. |
| *Network error … CORS* (Direct transport) | Add `http://localhost:5050` to Setup → CORS in that org, or switch back to **Local proxy**. |
| Users not matched | The person has no active user with the same Username in the Target. Create or activate them, or accept that you become the owner. |
| Pre-flight: *record type "X" is missing in the Target org* | Create, or activate, the Record Type with the same DeveloperName in the Target, or filter those records out. |
| Inserts fail with `DUPLICATES_DETECTED` | A duplicate rule is set to *Block*. Deactivate it in the sandbox or exclude those records. |
| Inserts fail with `FIELD_CUSTOM_VALIDATION_EXCEPTION` | A Target validation rule rejects the data. Fix the data or temporarily deactivate the rule in the sandbox. |
| Unique external Id errors on a second run | The records already exist in the Target. Roll back the earlier run first, or filter them out. |

## Project layout

```
start.bat                 Entry point: launches server.ps1 (execution-policy aware)
server.ps1                HttpListener static server + optional Salesforce relay (/api/proxy)
public/
  index.html              Single-page app shell
  config.json             Defaults for every user of this copy (clientId, transport, limits)
  oauth/callback.html     OAuth redirect target
  css/app.css
  js/
    app.js                Bootstrap, routing, import/export
    auth.js               OAuth 2.0 Authorization Code + PKCE, session storage
    sfapi.js              REST client (query, describe, limits, sObject Collections)
    soql.js               Filter builder → SOQL compiler
    schema.js             Describe helpers, Record Type index
    planner.js            Dependency graph, auto-order, order checks
    preflight.js          Static and data pre-flight validation
    engine.js             Extraction (incl. referenced records & hierarchies), Id mapping, multi-pass insert, back-fill, rollback
    discovery.js          Find related records: scan, preview, add to plan
    users.js              User matching by Username (sandbox suffix aware)
    template.js           Template schema, import/export
    runController.js      Run orchestration, logs, downloads
    ui/                   Views (connect, plan, run), dialogs, components
  templates/              Sample templates
docs/
  EXTERNAL_CLIENT_APP.md  External Client App (PKCE) and org settings
  TEMPLATE_SCHEMA.md      Template JSON reference
tests/                    Unit tests: engine, related records, user matching, SOQL compiler, planner, templates
```

## Development

The app is plain ES modules and needs no build step. To run the unit tests on a machine with Node.js 20+ (not needed to use the app):

```
node --test tests/*.test.mjs
```

On macOS or Linux you can serve the UI with any static server (for example `python3 -m http.server 5050 -d public`), but then switch Transport to Direct: the `/api/proxy` relay exists only in `server.ps1`.

## Limits and known gaps

* Binary fields (Attachment/ContentVersion bodies, `base64`) are not copied.
* Records owned by queues (`OwnerId` → Group) get the running user as owner; queues are not matched.
* Lookups to setup objects other than User (profiles, roles, record types, business hours…) are not copied or matched; Salesforce defaults apply.
* Referenced records are always included to keep relationships, but are capped by *Max records per object*.
* Records created by Target automation (triggers, flows) during a run are not tracked for rollback.
* Very wide objects can exceed the REST URL length for one query (the app warns). Choose fewer fields in that case.
* One request at a time: the local server is single-threaded, which suits this workload.
