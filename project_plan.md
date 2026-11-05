# Project Plan: Salesforce Sandbox Seeding Application

## 1. Executive Summary & Objectives
This project delivers a lightweight, zero-dependency, locally hosted web application enabling Salesforce administrators and developers to efficiently seed sandboxes with data. Designed for locked-down Windows environments, the solution relies entirely on native Windows scripting (Batch/PowerShell) and client-side web technologies (Vanilla HTML, CSS, JavaScript). It bypasses the need for administrative installations, external runtime dependencies (like Node.js or Python), or third-party packages.

**Core Objectives:**
*   Establish seamless cross-org authentication (Source and Target) within a single browser session without password management.
*   Provide a modern, intuitive UI for querying objects, filtering records, and building reusable JSON seeding templates.
*   Execute intelligent data insertion that maintains complex parent-child relationships via in-memory ID resolution.
*   Ensure environment-agnostic data portability by resolving Record Types dynamically via `DeveloperName` rather than hardcoded IDs.
*   Operate offline-first for hosting, relying strictly on Salesforce REST APIs for data transmission.

---

## 2. Technical Stack & Architecture
*   **Execution Environment:** Windows Command Prompt (`.bat`) and PowerShell (`.ps1`) for local HTTP server hosting (utilizing native `System.Net.HttpListener`).
*   **Frontend Framework:** Pure Vanilla JavaScript (ES6+), HTML5, and CSS3. No external frameworks (e.g., React, Vue) or package managers (e.g., NPM) are required.
*   **Authentication:** Salesforce OAuth 2.0 User-Agent Flow (Client-side token management).
*   **Data Integration:** Salesforce REST API (Describe, Query, and Composite/SObject Tree endpoints).
*   **State & Storage:** Browser `sessionStorage` for active tokens; local file system (`.json`) for template sharing and storage.

---

## 3. Project Phases & Timeline

| Phase | Milestone Name | Key Deliverables |
| :--- | :--- | :--- |
| **Phase 1** | Local Environment & Scaffolding | `start.bat` and `server.ps1` scripts; Basic HTTP serving capabilities. |
| **Phase 2** | Authentication & Core UI | OAuth 2.0 integration; Single Page Application (SPA) layout and CSS styling. |
| **Phase 3** | Metadata & Query Engine | Dynamic object/field dropdowns; Filter builder UI; Record Type introspection; SOQL generation logic. |
| **Phase 4** | Relationship & Insertion Engine | In-memory ID mapping dictionary; Multi-pass record insertion logic; Record Type `DeveloperName` pre-flight validation. |
| **Phase 5** | Template Management | JSON export/import handlers utilizing browser File APIs. |
| **Phase 6** | QA, Hardening & UAT | Limit testing (API and storage); Edge-case testing on locked-down Windows VMs; Cross-org Record Type mismatch testing. |

---

## 4. Work Breakdown Structure (WBS)

### 4.1. Module A: Local Launch System
*   **Develop `start.bat`:** Create the entry point script that bypasses local execution policies for the current session to launch the PowerShell server.
*   **Develop `server.ps1`:** Implement a lightweight local HTTP listener (e.g., `http://localhost:5050`) to serve the `public/` directory, avoiding browser CORS blocks associated with `file:///` protocols.
*   **Browser Automation:** Script the automatic launch of the user's default browser pointing to the local port once the server confirms initialization.

### 4.2. Module B: Connection & Authentication
*   **Salesforce Connected App Configuration:** Define the exact specifications required for the Connected App in the production/hub org (Callback URLs, Scopes, CORS allowlisting).
*   **OAuth User-Agent Implementation:** Build the login redirect mechanism for both Source and Target orgs.
*   **Token Management:** Develop JavaScript utilities to extract the access token from the URL hash, store it securely in `sessionStorage`, and strip it from the visible browser address bar for security.

### 4.3. Module C: Query Builder & UI
*   **Schema & Record Type Introspection:** Implement REST `/describe` API calls to fetch global objects, object-specific fields, and an initialization query to fetch the `RecordType` object data (`SELECT Id, DeveloperName, SobjectType FROM RecordType`) from the Source Org.
*   **Filter Builder UI:** Build dynamic DOM manipulation allowing users to add/remove `WHERE` clause conditions (e.g., Field, Operator, Value).
*   **Record Type UI Translation:** When a user selects `RecordTypeId` in the filter builder, dynamically replace the standard text input with a dropdown populated with the `DeveloperName`s available for that specific object.
*   **Query Compilation:** Write the parser that converts UI selections into valid SOQL strings. Implement relationship notation logic for Record Types (e.g., `WHERE RecordType.DeveloperName = 'Selected_Name'`) and strictly enforce `LIMIT` clauses to respect sandbox capacities.

### 4.4. Module D: Data Migration & ID Resolution Engine (Critical Path)
*   **Data Extraction:** Implement pagination logic to pull selected Source records via the REST API.
*   **Pre-Flight Target Validation:** Query the Target Org's `RecordType` table to build a validation map. Cross-reference the extracted Source records against this map to ensure all required `DeveloperName`s exist in the Target Org before execution.
*   **Dependency Sequencing:** Develop logic to identify parent vs. child objects from the selection to dictate the correct insertion order.
*   **ID Mapping Dictionary:** Build the in-memory key-value store that temporarily maps old Source IDs to newly generated Target IDs during the migration session.
*   **Payload Mutation (Relationships & Record Types):** Write the logic that intercepts records before insertion to:
    1.  Scan lookup fields and replace Source IDs with the resolved Target IDs.
    2.  Evaluate `RecordType.DeveloperName`, retrieve the corresponding Target `RecordTypeId` from the pre-flight map, and overwrite the `RecordTypeId` field.

### 4.5. Module E: Template Engine
*   **Schema Definition:** Standardize the JSON structure representing a seeding template (storing selected objects, field criteria, Record Type filters, and execution order).
*   **Export Functionality:** Utilize the JavaScript `Blob` API to generate a downloadable `.json` file from the current UI state.
*   **Import Functionality:** Utilize the `FileReader` API to parse an uploaded template, automatically map the UI state, and prepare the tool for immediate validation and execution against the Target org.

---

## 5. Risk Management & Mitigations

| Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Missing Target Record Types** | Inserts fail with "Invalid Record Type ID". | Execute a pre-flight schema validation query. Halt the job and display exactly which `DeveloperName` is missing in the target environment before any inserts are attempted. |
| **Managed Package Record Types** | Namespace prefixes cause Developer Name mismatches. | Ensure the pre-flight check accounts for namespace prefixes in the `DeveloperName` if moving data between orgs with different managed package states. |
| **Sandbox Storage Limits** | Sandbox hits 100% capacity, failing inserts. | Hardcode a global limit warning. Use SOQL `COUNT()` to display a "Preview Count" before execution. |
| **Salesforce API Limits** | Hitting 24-hour API call limits. | Utilize the Composite API or SObject Collections API to batch inserts and minimize individual HTTP requests. |
| **Locked-Down PCs** | Local server script blocked by OS. | Test `.bat`/`.ps1` on environments with strict GPOs to ensure `-ExecutionPolicy Bypass` works for local user sessions. |
| **Self-Referential Objects** | Inserts fail due to parent missing. | ID mapping engine must insert top-level parent nodes before child nodes of the same object type (e.g., Account hierarchies). |