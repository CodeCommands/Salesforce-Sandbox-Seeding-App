// Tab 1: connect Source and Target orgs.
import { h, fmtNum } from '../util.js';
import { state, snapshotState } from '../store.js';
import { snapshotSummary } from '../snapshot.js';
import { ENVIRONMENTS } from '../auth.js';
import { connect, disconnect, cancelConnect, getLoginPrefs } from '../connections.js';
import { badge, toast, formRow, select } from './components.js';
import { openSettings, openSetupGuide } from './settingsModal.js';

const ROLE_INFO = {
  source: { title: 'Source org', text: 'Where records are copied from. Read-only: this tool only queries it. Needed to build a plan and to read records.' },
  target: { title: 'Target org', text: 'The sandbox that receives the records.' },
};

const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);

export function renderConnectView(container) {
  const needsClientId = !state.settings.clientId && !getLoginPrefs('source').clientId && !getLoginPrefs('target').clientId;
  container.appendChild(h('section', { class: 'view connect-view' },
    h('div', { class: 'view-intro' },
      h('h1', null, 'Connect your orgs'),
      h('p', { class: 'muted' }, 'Sign in to both orgs with OAuth. Access tokens stay in this browser tab (sessionStorage) and are never written to disk.')),
    needsClientId ? h('div', { class: 'callout callout-warning' },
      h('strong', null, 'One-time setup needed. '),
      'Paste the Consumer Key of your External Client App into the Consumer Key box on the org card below. The first key you enter is also used for the other org unless you enter a different one there. Each card has a setup guide button if the app does not exist yet.') : null,
    whichOrgsNote(),
    h('div', { class: 'org-grid' }, orgCard('source'), h('div', { class: 'org-arrow', 'aria-hidden': 'true' }, '→'), orgCard('target')),
    h('p', { class: 'muted small' },
      'Sign-in: OAuth 2.0 + PKCE · API version: newest per org · Shared Consumer Key and safety limits: ',
      h('button', { class: 'link-btn', onclick: openSettings }, 'Settings'))));
}

/** Which connections the current plan needs. */
function whichOrgsNote() {
  const { snap, usable } = snapshotState();
  if (usable) {
    return h('div', { class: 'callout callout-info' },
      h('strong', null, 'Only the Target org is needed for this plan. '),
      `It includes captured record data (${snapshotSummary(snap)}). Connect the Source org only if you want to change the plan or read fresh records.`);
  }
  return h('p', { class: 'muted small' },
    'Building a plan and reading records needs the Source org. Running a template exported with ', h('strong', null, 'record data'), ' needs only the Target org.');
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
    connectBtn.title = has ? '' : 'Paste the Consumer Key first';
  };
  const shared = state.settings.clientId;
  const keyInput = h('input', {
    type: 'text', class: 'input mono', value: orgKey, spellcheck: 'false', autocomplete: 'off',
    placeholder: shared ? `Leave blank to use ${maskKey(shared)}` : 'Paste the Consumer Key (starts with 3MVG9…)',
    'aria-label': `Consumer Key for the ${info.title}`,
    oninput: (e) => { orgKey = e.target.value; syncBtn(); },
  });
  syncBtn();
  const keyHint = shared
    ? `Blank uses the shared key ${maskKey(shared)} (from Settings or the first org you connected). Enter a different key only if this org has its own External Client App.`
    : 'From your External Client App: Settings > OAuth Settings > Consumer Key and Secret. No secret is needed.';
  if (conn.error) card.appendChild(h('div', { class: 'callout callout-danger small', role: 'alert' }, conn.error));
  card.appendChild(h('div', { class: 'form-stack' }, formRow('Login environment', envSelect), domainRow,
    h('div', { class: 'key-block' },
      formRow('Consumer Key', keyInput, keyHint),
      h('button', { class: 'btn btn-small guide-btn', type: 'button', onclick: openSetupGuide }, 'External Client App Setup Guide'))));
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
