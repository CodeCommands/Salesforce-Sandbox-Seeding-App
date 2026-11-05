// Tab 1: connect Source and Target orgs.
import { h, fmtNum } from '../util.js';
import { state } from '../store.js';
import { ENVIRONMENTS } from '../auth.js';
import { connect, disconnect, cancelConnect, getLoginPrefs } from '../connections.js';
import { badge, toast, formRow, select } from './components.js';
import { openSettings, openSetupGuide } from './settingsModal.js';

const ROLE_INFO = {
  source: { title: 'Source org', text: 'Where records are copied from. Read-only: this tool only queries it.' },
  target: { title: 'Target org', text: 'The sandbox that receives the records.' },
};

export function renderConnectView(container) {
  const needsClientId = !state.settings.clientId && !getLoginPrefs('source').clientId && !getLoginPrefs('target').clientId;
  container.appendChild(h('section', { class: 'view connect-view' },
    h('div', { class: 'view-intro' },
      h('h1', null, 'Connect your orgs'),
      h('p', { class: 'muted' }, 'Sign in to both orgs with OAuth. Access tokens stay in this browser tab (sessionStorage) and are never written to disk.')),
    needsClientId ? h('div', { class: 'callout callout-warning' },
      h('strong', null, 'One-time setup needed. '),
      'Enter the Consumer Key of your External Client App before connecting. ',
      h('button', { class: 'link-btn', onclick: openSettings }, 'Open Settings'), ' · ',
      h('button', { class: 'link-btn', onclick: openSetupGuide }, 'External Client App setup guide')) : null,
    h('div', { class: 'org-grid' }, orgCard('source'), h('div', { class: 'org-arrow', 'aria-hidden': 'true' }, '→'), orgCard('target')),
    h('p', { class: 'muted small' },
      `Transport: ${state.settings.transport === 'proxy' ? 'Local proxy (via server.ps1)' : 'Direct (browser to Salesforce; requires CORS allowlist)'} · Sign-in: OAuth 2.0 + PKCE · API version: newest per org · `,
      h('button', { class: 'link-btn', onclick: openSettings }, 'Change'), ' · ',
      h('button', { class: 'link-btn', onclick: openSetupGuide }, 'Setup guide'))));
}

function orgCard(role) {
  const conn = state.conn[role];
  const info = ROLE_INFO[role];
  const prefs = getLoginPrefs(role);
  const card = h('article', { class: ['card', 'org-card', `org-${conn.status}`] });

  const header = h('div', { class: 'card-header' },
    h('div', null, h('h2', null, info.title), h('p', { class: 'muted small' }, info.text)),
    statusBadge(conn));
  card.appendChild(header);

  if (conn.status === 'connected') {
    const o = conn.org || {};
    const u = conn.user || {};
    const lim = conn.limits || {};
    card.appendChild(h('dl', { class: 'kv' },
      h('dt', null, 'Org'), h('dd', null, o.Name || '—', ' ', o.IsSandbox ? badge('Sandbox', 'info') : badge('Production', role === 'target' ? 'danger' : 'neutral')),
      h('dt', null, 'User'), h('dd', null, u.Username || u.Name || '—'),
      h('dt', null, 'Instance'), h('dd', { class: 'mono small' }, conn.session.instanceUrl),
      h('dt', null, 'Org Id'), h('dd', { class: 'mono small' }, o.Id || conn.session.orgId),
      h('dt', null, 'API version'), h('dd', null, `v${conn.client.apiVersion}`),
      lim.DailyApiRequests ? [h('dt', null, 'API requests'), h('dd', null, `${fmtNum(lim.DailyApiRequests.Remaining)} of ${fmtNum(lim.DailyApiRequests.Max)} left today`)] : null,
      lim.DataStorageMB ? [h('dt', null, 'Data storage'), h('dd', null, `${fmtNum(lim.DataStorageMB.Remaining)} MB free of ${fmtNum(lim.DataStorageMB.Max)} MB`)] : null,
      h('dt', null, 'Record types'), h('dd', null, fmtNum(conn.rt ? conn.rt.rows.length : 0))));
    if (role === 'target' && o.IsSandbox === false) {
      card.appendChild(h('div', { class: 'callout callout-danger small' },
        'This is a production org. Runs against it are blocked unless "Allow production target" is enabled in Settings.'));
    }
    card.appendChild(h('div', { class: 'card-actions' },
      h('button', { class: 'btn', onclick: () => disconnect(role) }, 'Disconnect'),
      h('button', { class: 'btn btn-ghost', onclick: () => startConnect(role, prefs) }, 'Switch org')));
    return card;
  }

  if (conn.status === 'connecting') {
    card.appendChild(h('p', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading org details…'));
    return card;
  }

  if (conn.status === 'authorizing') {
    card.appendChild(h('p', { class: 'loading' }, h('span', { class: 'spinner' }), 'Waiting for you to finish signing in in the pop-up window…'));
    card.appendChild(h('div', { class: 'card-actions' }, h('button', { class: 'btn', onclick: () => cancelConnect(role) }, 'Cancel')));
    return card;
  }

  // Disconnected / error / expired: login form
  let env = prefs.env;
  let domain = prefs.customDomain || '';
  const domainInput = h('input', {
    type: 'text', class: 'input', value: domain, placeholder: 'acme--uat.sandbox.my.salesforce.com', spellcheck: 'false',
    oninput: (e) => { domain = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') startConnect(role, { env, customDomain: domain, clientId: orgKey }); }, // eslint-disable-line no-use-before-define
  });
  const domainRow = formRow('My Domain URL', domainInput, 'Required when the org enforces My Domain login or SSO.');
  domainRow.hidden = env !== 'custom';
  const envSelect = select(Object.entries(ENVIRONMENTS).map(([value, e]) => ({ value, label: e.label })), env, (v) => {
    env = v;
    domainRow.hidden = v !== 'custom';
  });
  let orgKey = prefs.clientId || '';
  const connectBtn = h('button', {
    class: 'btn btn-primary',
    onclick: () => startConnect(role, { env, customDomain: domain, clientId: orgKey }),
  }, conn.status === 'expired' ? 'Reconnect' : `Connect ${role}`);
  const syncBtn = () => {
    const has = !!(orgKey.trim() || state.settings.clientId);
    connectBtn.disabled = !has;
    connectBtn.title = has ? '' : 'Set the Consumer Key in Settings (or under Advanced) first';
  };
  const keyInput = h('input', {
    type: 'text', class: 'input mono', value: orgKey, spellcheck: 'false',
    placeholder: state.settings.clientId ? 'Leave blank to use the key from Settings' : '3MVG9…',
    oninput: (e) => { orgKey = e.target.value; syncBtn(); },
  });
  syncBtn();
  if (conn.error) card.appendChild(h('div', { class: 'callout callout-danger small', role: 'alert' }, conn.error));
  card.appendChild(h('div', { class: 'form-stack' }, formRow('Login environment', envSelect), domainRow,
    h('details', { class: 'advanced', open: !!orgKey },
      h('summary', null, 'Advanced'),
      formRow('Consumer Key for this org (optional)', keyInput, 'Only needed when this org has its own External Client App with a different key.'))));
  card.appendChild(h('div', { class: 'card-actions' }, connectBtn));
  return card;
}

function statusBadge(conn) {
  switch (conn.status) {
    case 'connected': return badge('Connected', 'success');
    case 'connecting': return badge('Loading', 'info');
    case 'authorizing': return badge('Signing in', 'info');
    case 'expired': return badge('Session expired', 'warning');
    case 'error': return badge('Error', 'danger');
    default: return badge('Not connected', 'neutral');
  }
}

async function startConnect(role, { env, customDomain, clientId }) {
  try {
    const conn = await connect(role, { env, customDomain, clientId });
    if (conn.status === 'connected') toast(`${ROLE_INFO[role].title} connected: ${conn.org ? conn.org.Name : ''}`, 'success');
    else if (conn.error) toast(conn.error, 'error');
  } catch (e) {
    if (e.message !== 'Login cancelled') toast(e.message, 'error');
  }
}
