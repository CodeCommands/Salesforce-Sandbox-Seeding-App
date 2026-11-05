// Settings dialog and External Client App setup guide.
import { h } from '../util.js';
import { state, emit } from '../store.js';
import { saveSettings, resetSettings, redirectUri } from '../config.js';
import { openModal, formRow, toast } from './components.js';

export function openSettings() {
  const s = { ...state.settings };
  openModal({
    title: 'Settings',
    wide: true,
    render: (close) => {
      const text = (key, attrs = {}) => h('input', { class: 'input', type: 'text', value: s[key] ?? '', spellcheck: 'false', ...attrs, oninput: (e) => { s[key] = e.target.value.trim(); } });
      const num = (key, attrs = {}) => h('input', { class: 'input', type: 'number', value: s[key], ...attrs, oninput: (e) => { s[key] = e.target.value; } });
      return h('div', { class: 'settings-grid' },
        h('p', { class: 'muted span-all settings-intro' }, 'These settings apply to both the Source and the Target org. They are saved in this browser only.'),
        h('fieldset', null,
          h('legend', null, 'External Client App (OAuth 2.0 + PKCE)'),
          formRow('Consumer Key', text('clientId', { placeholder: '3MVG9…', class: 'input mono' }), 'The shared key for both orgs. A key typed on an org card on the Connect page overrides it for that org. No secret is needed.'),
          formRow('Callback URL to register', h('input', { class: 'input mono', type: 'text', readOnly: true, value: redirectUri(), onfocus: (e) => e.target.select() }), 'Must match the External Client App exactly, including the port.'),
          formRow('OAuth scopes', text('scopes'), 'Space separated. "api" is required. Add "web" so "Open org" signs you in without the login page; the External Client App must allow "web" too, or sign-in fails. Reconnect after changing this.'),
          h('p', { class: 'hint' }, 'API version: the newest version each org supports is detected automatically when you connect.')),
        h('fieldset', null,
          h('legend', null, 'Safety limits'),
          formRow('Max records per object (hard cap on LIMIT)', num('maxRecordsPerObject', { min: 1, max: 50000 })),
          formRow('Warn when a run exceeds (records)', num('warnTotalRecords', { min: 1 })),
          formRow('Storage estimate per record (KB)', num('estimatedKbPerRecord', { min: 1, max: 100 }), 'Salesforce counts most records as 2 KB.'),
          h('label', { class: 'check-row danger-text' },
            h('input', { type: 'checkbox', checked: !!s.allowProductionTarget, onchange: (e) => { s.allowProductionTarget = e.target.checked; } }),
            'Allow a production org as Target (not recommended)')),
        h('div', { class: 'modal-actions span-all' },
          h('button', { class: 'btn btn-ghost', onclick: () => { state.settings = resetSettings(); afterSave(); close(); } }, 'Reset to defaults'),
          h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary',
            onclick: () => {
              s.estimatedKbPerRecord = Math.max(1, parseFloat(s.estimatedKbPerRecord) || 2);
              state.settings = saveSettings(s);
              afterSave();
              close();
            },
          }, 'Save')));
    },
  });
}

function afterSave() {
  toast('Settings saved', 'success');
  emit('settings');
}

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
        h('li', null, 'OAuth Scopes: ', h('strong', null, 'Manage user data via APIs (api)'), '. Optional: also ', h('strong', null, 'Manage user data via Web browsers (web)'), ', so the Open org button signs you in to Salesforce without the login page (then enter "api web" in Settings > OAuth scopes).'),
        h('li', null, 'Security: tick ', h('strong', null, 'Require Proof Key for Code Exchange (PKCE)'), ' and untick ', h('strong', null, 'Require secret for Web Server Flow'), '.'),
        h('li', null, 'Policies: Permitted Users "All users can self-authorize" (or admin-approved users plus the right profiles / permission sets). Relax IP restrictions only if needed.'),
        h('li', null, 'Settings > OAuth Settings > ', h('strong', null, 'Consumer Key and Secret'), ': copy the Consumer Key and paste it into the Consumer Key box on the org card.')),
      h('h3', null, 'Using it for both orgs'),
      h('p', null, 'A Local External Client App only signs users in to the org where it exists. A sandbox created or refreshed after the app was made has its own copy. If that copy shows a different Consumer Key, paste it into the Consumer Key box on that org\'s card; otherwise the same key works for both. For orgs without a copy, create the app there too.'),
      h('p', { class: 'muted small' }, 'Full details: docs/EXTERNAL_CLIENT_APP.md in the app folder.')),
  });
}
