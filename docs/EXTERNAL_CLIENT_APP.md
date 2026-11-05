# External Client App setup (OAuth 2.0 + PKCE)

Sandbox Seeder signs in with the **OAuth 2.0 Authorization Code flow with PKCE** (S256). No client secret is created, stored, or sent, and the older User-Agent (implicit) flow is not used.

> **Port:** everything below assumes the default port `5050`. If you start the app with `start.bat 5051` (Windows) or `./start.command 5051` (macOS), use `5051` instead, or register both callback URLs.

## 1. Create the External Client App

Setup → **External Client App Manager** → **New External Client App**.

| Section | Setting | Value |
| --- | --- | --- |
| Basic Information | Name / API Name | `Sandbox Seeder` (any) |
| | Contact Email | your admin mailbox |
| | Distribution State | **Local** |
| API (Enable OAuth Settings) | Callback URL | `http://localhost:5050/oauth/callback.html` |
| | OAuth Scopes | **Manage user data via APIs (api)**. Nothing else is needed. |
| | Flow Enablement | none of the optional flows (client credentials, device, JWT, token exchange) are needed |
| | Security | ✅ **Require Proof Key for Code Exchange (PKCE) extension for Supported Authorization Flows** |
| | | ☐ **Require secret for Web Server Flow** (must be off: the app has no secret) |
| | | ☐ Require secret for Refresh Token Flow (not used) |

Create the app, then open **Policies** → Edit:

| Policy | Recommended value |
| --- | --- |
| Permitted Users | *All users can self-authorize*, or *Admin-approved users are pre-authorized* plus the profiles or permission sets of the people who seed data |
| IP Relaxation | *Enforce IP restrictions* unless your users are blocked by it |
| Refresh token policy | not used. Sessions last as long as the org's session timeout. |

Finally, open **Settings** → **OAuth Settings** → **Consumer Key and Secret** (you'll be asked for a verification code) and copy the **Consumer Key**. The secret is not needed.

## 2. One app, two orgs

A **Local** External Client App signs users in only to the org where it exists.

* A **sandbox created or refreshed after** you created the app in production contains a copy of it. If that copy shows the same Consumer Key, one key in Settings covers both orgs.
* If the sandbox copy has a **different** key, or the sandbox was created earlier, create the app there too (or refresh the sandbox). Enter that org's key in the **Consumer Key** box on its card in the Connect tab.

The app remembers a per-org key in this browser, keyed by Source/Target.

## 3. Transport and CORS

| Transport | What to configure in each org |
| --- | --- |
| **Local proxy** (default) | Nothing. The browser talks only to the local server (`server.ps1` on Windows, `server.pl` on macOS), which relays calls (including the token exchange) to Salesforce. The start script window must stay open. |
| Direct | Setup → CORS → Allowed Origins List → New: `http://localhost:5050`, and tick **Enable CORS for OAuth endpoints**. Sandboxes copy this list from production on refresh. |

## 4. Configure the app

Paste the Consumer Key into the **Consumer Key** box on the org's card on the **Connect** tab (the first key you enter is also used for the other org), or into **Settings** (⚙). Both are stored in this browser only. To set it for everyone who uses this copy, put it in `public/config.json`:

```json
{ "clientId": "3MVG9...your consumer key..." }
```

## How sign-in works

1. **Connect** opens `https://<login host>/services/oauth2/authorize?response_type=code&code_challenge=<S256>&prompt=login…` in a pop-up. The login host is `login.salesforce.com`, `test.salesforce.com`, or your My Domain.
2. After sign-in, Salesforce redirects to `/oauth/callback.html?code=…&state=…`. The page removes the code from the address bar immediately and hands it to the main window. If pop-ups are blocked, the same happens through a full-page redirect.
3. The main window checks `state`, then exchanges the code plus the PKCE verifier at `/services/oauth2/token`.
4. The access token is kept in `sessionStorage` for this tab only. On connect, the app reads `/services/data/` and uses the **newest API version** the org offers (for example v68.0).

`prompt=login` always shows the login screen, so you can sign in to two different orgs in one browser.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `redirect_uri_mismatch` | The Callback URL must be exactly `http://localhost:<port>/oauth/callback.html`. |
| `invalid_client_id` / `invalid_client` | Wrong key for this org: a Local app only works in its own org. Enter the org's key in the **Consumer Key** box on its Connect card. New apps can take a few minutes to activate. |
| `invalid_grant` | Untick *Require secret for Web Server Flow*. Also check that the code wasn't reused (start the login again). |
| `invalid_request` mentioning code challenge | Enable *Require Proof Key for Code Exchange (PKCE)*. |
| `OAUTH_APPROVAL_ERROR_GENERIC` / user not approved | Check *Permitted Users* and the assigned profiles / permission sets. |
| "Token exchange failed" | Proxy: make sure `start.bat` / `start.command` is running. Direct: enable *Enable CORS for OAuth endpoints*. |
