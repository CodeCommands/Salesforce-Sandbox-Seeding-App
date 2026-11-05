# Sandbox Seeder

A local web app for seeding Salesforce sandboxes with realistic, connected data. It copies records from a Source org into a Target sandbox and keeps the relationships between them intact.

* **Zero installs:** a browser plus what the OS already has: PowerShell on Windows, Perl and curl on macOS. No Node.js, Python, npm, or admin rights.
* **Two orgs, one browser tab:** OAuth 2.0 + PKCE sign-in for Source and Target through an External Client App. No passwords or client secrets are stored.
* **Find related records:** scans the records you selected for lookups to records outside the plan, shows them, and adds them on request. Run it again to follow the chain (Opportunity → Account → parent Account…).
* **Users matched by Username:** `OwnerId` and other User lookups point to the same person in the Target, sandbox suffixes included (`ada@acme.com` ↔ `ada@acme.com.uat`).
* **Always the latest API:** each org's newest REST API version is detected on connect (for example v68.0).
* **Relationship-aware:** parents are inserted before children, lookups are remapped to the new Ids, hierarchies such as `Account.ParentId` are inserted level by level, and circular lookups are back-filled.
* **Portable Record Types:** templates store `DeveloperName`, never Ids. Every Record Type used by the data is checked against the Target **before** anything is inserted.
* **Reusable templates:** save a plan as JSON, share it, and load it again with Import (or drag and drop). Export it **with record data** and it runs with only the Target org connected.
* **Guard rails:** a required `LIMIT` per object, preview counts, storage and API headroom checks, a block on production targets, dry runs, and one-click rollback.

## Quick start

1. **One-time admin setup:** create the External Client App described in [docs/EXTERNAL_CLIENT_APP.md](docs/EXTERNAL_CLIENT_APP.md) and copy its Consumer Key.
2. Start the local server. A console window opens and your browser opens `http://localhost:5050/`. Keep the window open; press `Ctrl+C` to stop.
   * **Windows:** double-click **`start.bat`**.
   * **macOS:** double-click **`start.command`**.
3. On the **Connect** tab, paste the Consumer Key into the **Consumer Key** box on the org card. The first key you enter is used for the other org too, unless you enter a different one there. Each card has an **External Client App Setup Guide** button.
4. **Connect** the Source org and the Target sandbox.
5. **Build plan:** click **+ Add object**. The app asks how each new object's records are chosen (for example *"Contacts that belong to the Accounts in step 1"*). Then set filters and limits, and click **Find related records…** to pull in the records the lookups point to.
6. **Validate & run:** *Validate* → *Dry run* → *Run seeding*.

To use another port: `start.bat 5051` or `./start.command 5051` (the External Client App callback URL must match).

The scripts are not signed, so the first start shows a warning:

* **Windows:** SmartScreen may warn. Choose *More info → Run anyway*, or unblock the zip first (see Troubleshooting).
* **macOS:** if you see *"cannot be opened because Apple cannot check it"*, Control-click `start.command` → **Open** → **Open**, or allow it in *System Settings → Privacy & Security*. You only need to do this once.

### Which orgs do I need?

| Task | Source org | Target org |
| --- | --- | --- |
| Build or edit a plan, **Find related records** | yes | no |
| Run a plan-only template (`*.seed.json`) | yes (records are read fresh on every run) | yes |
| Export a template **with record data** | yes (to capture the records) | no |
| Run a template with record data (`*.seed-data.json`) | **no** | yes |

### Transport

| | Local proxy (default) | Direct |
| --- | --- | --- |
| Path | Browser → local server (`server.ps1` on Windows, `server.pl` on macOS) → Salesforce | Browser → Salesforce |
| Org setup | none | `http://localhost:5050` in **Setup → CORS** of every org, plus *Enable CORS for OAuth endpoints* |
| Notes | Windows: uses the system proxy and your Windows sign-in for proxy authentication. macOS: calls go through the built-in `curl`, which uses `https_proxy` if set, else the HTTPS proxy from *System Settings → Network* (proxy auto-config files and proxy sign-in are not supported; use Direct then). The start script must stay open. | Uses the browser's network stack. Choose it in Settings only if the relay is blocked. |

## Using the app

### 1. Connect

Pick *Production*, *Sandbox* or a *Custom domain* (My Domain, required for SSO orgs) for each side. Sign-in happens in a pop-up. If pop-ups are blocked, the app falls back to a full-page redirect, and your plan draft is kept. The **Consumer Key** box is always on the card. Leave it blank to use the shared key (from Settings, or the first key you entered). Enter a key only if that org has its own External Client App with a different key. **External Client App Setup Guide** under the box explains how to create the app. Each connected card shows the API version in use.

### 2. Build the plan

* **+ Add object** opens a large, searchable list. Objects linked to the steps already in the plan are listed first (for example Contact, Opportunity and Case once Account is in), then common objects, then all objects. After you pick one, the app asks **which records to copy**, in plain words:
  * *"Contacts that belong to the Accounts in step 1 (via Account ID)"*: children of records you already picked (recommended when it applies);
  * *"Only the Accounts that the Contacts in step 2 point to (via Account ID)"*: parents of records you already picked;
  * *"Contacts matching filters I choose"*: not linked.

  The step is then placed so parents are inserted before children.
* **Which records** (top of each step) lists the step's links to other steps as sentences, with **×** to remove one and **+ Link to another step…** to add one. Links that would make two steps wait for each other are greyed out with the reason. When a step takes the records other steps point to, choose *only the linked records* or *linked records plus records matching filters*. LIMIT and Order by are here too.
* **Execution order** (left panel) is the insert order. Parents run above children automatically when you add objects or links; you can still move steps or click **Auto-order**. Badges show how each step is linked (*of step 1*, *used by step 2*, *+ parents*). A red *order* badge means a *required* parent (such as a master-detail) runs too late. A *back-fill* badge means an optional lookup will be set by an update after insert. A red *loop* badge comes with a box that names the two conflicting links and a **Remove this link** button for each.
* **Filters** build the `WHERE` clause. Choosing *Record Type* shows a dropdown of DeveloperNames and compiles to `RecordType.DeveloperName = '…'`. Use custom logic such as `1 AND (2 OR 3)` for mixed conditions, or add raw SOQL under *Advanced*.
* **Find related records…** (steps panel, each step's *Which records* section, or the run screen after a dry run) works the other way round, from children to what they point at. It extracts your selection (read-only) and lists every lookup that points to records not in the plan, for example *"Opportunity → Account via AccountId: 30 of 50 records have a value · 18 distinct Accounts · 6 not in the plan"*. You can preview those records by name and tick the ones to add:
  * **new step** that takes exactly the referenced records (placed before the step that references them);
  * **existing step** of that object (it then takes its filtered records *and* the referenced ones);
  * **parent hierarchy** for self-lookups such as `Account.ParentId` (follows parents up to 10 levels).

  After adding, the app scans again automatically, so chains are followed until every lookup is covered. Adding is always optional, and lookups to users and setup objects (profiles, queues, record types) are not listed.
* **Fields:** *All insertable fields* (portable across orgs) or a hand-picked list. Formula, system and audit fields are never copied.
* **LIMIT** is required for every object and capped by *Settings → Max records per object*.
* **Template settings:** *Match users by Username* (on by default), *Keep Ids as-is for lookups to* (for objects whose Ids are identical in both orgs), and the duplicate-rule and assignment-rule headers.

The plan auto-saves in this browser. **Import** loads a template (or drop the file on the page). A sample is in [public/templates/](public/templates/).

Older plans (or templates from earlier versions) that contain the Account ↔ Contact loop are repaired when they load, and a note explains what changed. Example: Contacts limited to the selected Accounts, while Account also took "the Accounts those Contacts point to". The extra link added no records, so it is removed.

### Export: plan only, or plan + record data

**Export** asks which you want:

| | Plan only (`<name>.seed.json`) | Plan + record data (`<name>.seed-data.json`) |
| --- | --- | --- |
| Contains | Objects, fields, filters, links, settings | The same, plus a copy of every record the plan selects, the field details the insert needs, and the usernames of referenced users |
| Records | Read fresh from the Source org on every run | Captured once, when you export (read-only extraction) |
| Needed to run | Source **and** Target | **Target only** |

To use a data template: start the app, **Import** the file, connect the **Target** org, then **Validate & run**. The plan shows a banner with how many records were captured, from which org, and when. Its steps are read-only, but you can still reorder, enable or disable them. If you also connect the Source org, you choose whether runs use the captured records or fresh ones. Changing objects, fields, filters or links makes the captured data out of date; the app then reads fresh records and offers **Capture again**.

Record data is a copy of real data and can include personal information. Store and share the file the way your company handles data exports. Within one browser tab the captured data survives a page reload (if it fits in session storage); otherwise import the file again.

### 3. Validate & run

| Button | Does |
| --- | --- |
| **Validate** | Schema checks in both orgs (Target only for a data template), query validation, ordering, parent scopes, `COUNT()` preview, Target storage and API headroom. Read-only. |
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
| macOS: *"start.command cannot be opened"* | Control-click it → **Open** → **Open** (once), or *System Settings → Privacy & Security → Open Anyway*. |
| macOS: *"You do not have permission to open start.command"* | The zip was made on Windows and lost the executable flag. In Terminal, in the app folder, run `chmod +x start.command` once (or start it with `bash start.command`). |
| macOS: *Could not listen on http://localhost:5050/* | The port is in use (maybe the Seeder is already running). Use `./start.command 5051` and register that callback URL. |
| macOS: proxy errors from the relay (*Could not resolve host*, timeouts) | Your network needs a proxy that `curl` cannot use (auto-config file or sign-in). Set `https_proxy` before starting, or switch Transport to **Direct** in Settings. |
| *… wait for each other in a loop …* | Two steps are linked both ways (for example Contacts limited to the selected Accounts, and Accounts taken from those Contacts). Open **Build plan**: the red box names both links; click **Remove this link** on the one you do not need. |
| *Connect the Source org, or import a template that includes captured record data* | The plan reads records from the Source org. Connect it, or export the plan **with record data** (from a session where the Source is connected) and use that file. |
| `redirect_uri_mismatch` | The External Client App callback URL must be exactly `http://localhost:<port>/oauth/callback.html`. |
| `invalid_client_id` on one org | A Local External Client App only works in its own org. Enter that org's key in the **Consumer Key** box on its Connect card. See [docs/EXTERNAL_CLIENT_APP.md](docs/EXTERNAL_CLIENT_APP.md). |
| *The local proxy is not available* | The page was not opened through `start.bat` / `start.command`. Start it, or switch Transport to Direct in Settings. |
| *Network error … CORS* (Direct transport) | Add `http://localhost:5050` to Setup → CORS in that org, or switch back to **Local proxy**. |
| Users not matched | The person has no active user with the same Username in the Target. Create or activate them, or accept that you become the owner. |
| Pre-flight: *record type "X" is missing in the Target org* | Create, or activate, the Record Type with the same DeveloperName in the Target, or filter those records out. |
| Inserts fail with `DUPLICATES_DETECTED` | A duplicate rule is set to *Block*. Deactivate it in the sandbox or exclude those records. |
| Inserts fail with `FIELD_CUSTOM_VALIDATION_EXCEPTION` | A Target validation rule rejects the data. Fix the data or temporarily deactivate the rule in the sandbox. |
| Unique external Id errors on a second run | The records already exist in the Target. Roll back the earlier run first, or filter them out. |

## Project layout

```
start.bat                 Windows entry point: launches server.ps1 (execution-policy aware)
server.ps1                Windows: HttpListener static server + optional Salesforce relay (/api/proxy)
start.command             macOS entry point (double-click): launches server.pl
server.pl                 macOS: static server + Salesforce relay via the built-in curl (Perl core modules only)
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
    snapshot.js           Captured record data: capture, replay without the Source org
    users.js              User matching by Username (sandbox suffix aware)
    template.js           Template schema, import/export
    runController.js      Run orchestration, logs, downloads
    ui/                   Views (connect, plan, run), dialogs (add object, export, related records), components
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

On macOS use `start.command` (or `perl server.pl --port 5050`); `server.pl` provides the same static files, `/api/health` and `/api/proxy` relay as `server.ps1`. It also runs on Linux (`perl server.pl`; it opens the browser with `xdg-open`).

## Limits and known gaps

* Binary fields (Attachment/ContentVersion bodies, `base64`) are not copied, also not in templates with record data.
* A template with record data holds the records as they were when it was exported. Find related records needs the Source org.
* Records owned by queues (`OwnerId` → Group) get the running user as owner; queues are not matched.
* Lookups to setup objects other than User (profiles, roles, record types, business hours…) are not copied or matched; Salesforce defaults apply.
* Referenced records are always included to keep relationships, but are capped by *Max records per object*.
* Records created by Target automation (triggers, flows) during a run are not tracked for rollback.
* Very wide objects can exceed the REST URL length for one query (the app warns). Choose fewer fields in that case.
* One request at a time: the local server is single-threaded, which suits this workload.
