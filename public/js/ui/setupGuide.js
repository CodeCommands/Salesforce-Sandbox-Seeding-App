// External Client App setup guide (opened from each org card on the Connect page).
import { h } from '../util.js';
import { redirectUri } from '../config.js';
import { openModal, toast } from './components.js';

export function openSetupGuide() {
  const code = (t) => h('code', { class: 'copyable', title: 'Click to copy', onclick: () => navigator.clipboard && navigator.clipboard.writeText(t).then(() => toast('Copied', 'success', 1500)) }, t);
  openModal({
    title: 'External Client App setup',
    wide: true,
    render: () => h('div', { class: 'guide' },
      h('p', null, 'An admin creates an External Client App once. The app signs in with OAuth 2.0 Authorization Code + PKCE, so no client secret is involved.'),
      h('ol', null,
        h('li', null, 'Setup > ', h('strong', null, 'External Client App Manager'), ' > New External Client App. Distribution State: ', h('strong', null, 'Local'), '.'),
        h('li', null, 'API (Enable OAuth Settings) > Callback URL: ', code(redirectUri())),
        h('li', null, 'OAuth Scopes: ', h('strong', null, 'Manage user data via APIs (api)'), '. Nothing else is needed.'),
        h('li', null, 'Security: tick ', h('strong', null, 'Require Proof Key for Code Exchange (PKCE)'), ' and untick ', h('strong', null, 'Require secret for Web Server Flow'), '.'),
        h('li', null, 'Policies: Permitted Users "All users can self-authorize" (or admin-approved users plus the right profiles / permission sets). Relax IP restrictions only if needed.'),
        h('li', null, 'Settings > OAuth Settings > ', h('strong', null, 'Consumer Key and Secret'), ': copy the Consumer Key and paste it into the Consumer Key box on the org card.')),
      h('h3', null, 'One key per org'),
      h('p', null, 'A Local External Client App only signs users in to the org where it exists, so each org has its own Consumer Key. A sandbox created or refreshed from production gets a copy of the app, often with a new Consumer Key. The app saves each org\'s key after you connect; after a refresh, pick the org, paste its new key and connect again. For orgs without a copy, create the app there too.'),
      h('p', { class: 'muted small' }, 'Full details: docs/EXTERNAL_CLIENT_APP.md in the app folder.')),
  });
}
