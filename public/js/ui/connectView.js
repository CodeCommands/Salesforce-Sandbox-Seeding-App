// Tab 1: connect Source and Target orgs. Orgs connected before are saved (My Domain + Consumer Key),
// so later sessions only need "pick the org, sign in".
import { h, fmtNum } from '../util.js';
import { state, snapshotState, emit } from '../store.js';
import { snapshotSummary } from '../snapshot.js';
import { ENVIRONMENTS } from '../auth.js';
import { connect, disconnect, cancelConnect } from '../connections.js';
import { listSavedOrgs, getSavedOrg, lastUsed, forgetOrg, legacyPrefill, savedOrgsLocation } from '../savedOrgs.js';
import { badge, toast, formRow, select, confirmModal } from './components.js';
import { openSetupGuide } from './setupGuide.js';

const ROLE_INFO = {
  source: { title: 'Source org', text: 'Where records are copied from. Read-only: this tool only queries it. Needed to build a plan and to read records.' },
  target: { title: 'Target org', text: 'The sandbox that receives the records.' },
};

const NEW = 'new';
/** What each card's sign-in form shows; kept across re-renders so typed values are not lost. */
const drafts = { source: null, target: null };

function draftFor(role) {
  if (drafts[role]) return drafts[role];
  const saved = lastUsed(role) ? getSavedOrg(lastUsed(role)) : null;
  if (saved) {
    drafts[role] = { choice: saved.id, key: saved.clientId || '', env: 'custom', domain: saved.host };
  } else {
    const legacy = legacyPrefill(role);
    drafts[role] = { choice: NEW, key: legacy.clientId, env: legacy.env || (role === 'source' ? 'production' : 'sandbox'), domain: legacy.customDomain };
  }
  return drafts[role];
}

export function renderConnectView(container) {
  const firstTime = !listSavedOrgs().length && (state.conn.source.status !== 'connected' || state.conn.target.status !== 'connected');
  container.appendChild(h('section', { class: 'view connect-view' },
    h('div', { class: 'view-intro' },
      h('h1', null, 'Connect your orgs'),
      h('p', { class: 'muted' }, 'Sign in to both orgs with OAuth. Access tokens stay in this browser tab (sessionStorage) and are never written to disk.')),
    firstTime ? h('div', { class: 'callout callout-warning' },
      h('strong', null, 'First time here? '),
      'Each org needs the Consumer Key of its External Client App: paste it on the org card and connect. The org is then saved in the app folder, so next time you only pick it and sign in. Use the setup guide button on the card if the app does not exist yet.') : null,
    whichOrgsNote(),
    h('div', { class: 'org-grid' }, orgCard('source'), h('div', { class: 'org-arrow', 'aria-hidden': 'true' }, '→'), orgCard('target')),
    h('p', { class: 'muted small' },
      'Sign-in: OAuth 2.0 + PKCE · API version: newest per org · ',
      savedOrgsLocation() === 'file'
        ? ['Saved orgs are kept in ', h('code', null, 'data/saved-orgs.json'), ' in the app folder (My Domain and Consumer Key only, never passwords or tokens).']
        : h('span', { class: 'warning-text' }, 'Saved orgs are kept in this browser only, because the running start script cannot save files. Restart the app with the latest start.bat / start.command to keep them in the app folder.'))));
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
      h('dt', null, 'My Domain'), h('dd', { class: 'mono small' }, conn.session.instanceUrl),
      h('dt', null, 'Org Id'), h('dd', { class: 'mono small' }, o.Id || conn.session.orgId),
      h('dt', null, 'API version'), h('dd', null, `v${conn.client.apiVersion}`),
      lim.DailyApiRequests ? [h('dt', null, 'API requests'), h('dd', null, `${fmtNum(lim.DailyApiRequests.Remaining)} of ${fmtNum(lim.DailyApiRequests.Max)} left today`)] : null,
      lim.DataStorageMB ? [h('dt', null, 'Data storage'), h('dd', null, `${fmtNum(lim.DataStorageMB.Remaining)} MB free of ${fmtNum(lim.DataStorageMB.Max)} MB`)] : null,
      h('dt', null, 'Record types'), h('dd', null, fmtNum(conn.rt ? conn.rt.rows.length : 0))));
    if (role === 'target' && o.IsSandbox === false && !state.settings.allowProductionTarget) {
      card.appendChild(h('div', { class: 'callout callout-danger small' }, 'This is a production org. This tool only seeds sandboxes, so runs against it are blocked.'));
    }
    card.appendChild(h('div', { class: 'card-actions' },
      // A plain link: the browser normally still has the Salesforce session from signing in (and with SSO,
      // the identity provider signs you in again if needed), so no Salesforce-only MFA step is involved.
      h('a', { class: 'btn btn-primary', href: `${conn.session.instanceUrl}/`, target: '_blank', rel: 'noopener noreferrer', title: 'Opens this org in a new browser tab' }, 'Open org ↗'),
      h('button', { class: 'btn', onclick: () => { drafts[role] = null; disconnect(role); } }, 'Disconnect')));
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

  // Disconnected / error / expired: pick a saved org or enter a new one
  const d = draftFor(role);
  const saved = listSavedOrgs();
  if (d.choice !== NEW && !saved.some((o) => o.id === d.choice)) d.choice = NEW;
  const pick = d.choice === NEW ? null : saved.find((o) => o.id === d.choice);
  const rerender = () => emit('connections');
  const go = () => startConnect(role, pick
    ? { env: 'custom', customDomain: pick.host, clientId: d.key, savedOrgId: pick.id }
    : { env: d.env, customDomain: d.domain, clientId: d.key });

  const rows = [];
  if (saved.length) {
    rows.push(formRow('Org', select([
      ...saved.map((o) => ({ value: o.id, label: `${o.name} · ${o.host}${o.isSandbox ? '' : ' (production)'}` })),
      { value: NEW, label: '+ Another org…' },
    ], d.choice, (v) => {
      d.choice = v;
      const o = v === NEW ? null : getSavedOrg(v);
      d.key = o ? o.clientId || '' : '';
      if (!o) { d.env = role === 'source' ? 'production' : 'sandbox'; d.domain = ''; }
      rerender();
    }), pick ? null : 'Orgs you connected before are listed here.'));
  }
  if (pick) {
    rows.push(h('div', { class: 'saved-org small' },
      h('div', null, h('span', { class: 'muted' }, 'My Domain '), h('span', { class: 'mono' }, pick.host)),
      pick.username ? h('div', null, h('span', { class: 'muted' }, 'Last signed in as '), pick.username) : null,
      h('button', {
        class: 'link-btn',
        onclick: async () => {
          const ok = await confirmModal({ title: `Forget ${pick.name}?`, message: 'Its My Domain and Consumer Key are removed from this browser. You can add it again any time.', confirmLabel: 'Forget org' });
          if (!ok) return;
          forgetOrg(pick.id);
          drafts.source = drafts.source && drafts.source.choice === pick.id ? null : drafts.source;
          drafts.target = drafts.target && drafts.target.choice === pick.id ? null : drafts.target;
          rerender();
        },
      }, 'Forget this org')));
  } else {
    const domainInput = h('input', {
      type: 'text', class: 'input', value: d.domain, placeholder: 'acme--uat.sandbox.my.salesforce.com', spellcheck: 'false',
      oninput: (e) => { d.domain = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') go(); },
    });
    const domainRow = formRow('My Domain URL', domainInput, 'Use this for SSO orgs and orgs that require My Domain login.');
    domainRow.hidden = d.env !== 'custom';
    rows.push(formRow('Login environment', select(Object.entries(ENVIRONMENTS).map(([value, e]) => ({ value, label: e.label })), d.env, (v) => {
      d.env = v;
      domainRow.hidden = v !== 'custom';
    })), domainRow);
  }

  const connectBtn = h('button', { class: 'btn btn-primary', onclick: go }, conn.status === 'expired' ? 'Reconnect' : `Connect ${role}`);
  const syncBtn = () => {
    connectBtn.disabled = !d.key.trim();
    connectBtn.title = d.key.trim() ? '' : 'Paste the Consumer Key first';
  };
  const keyInput = h('input', {
    type: 'text', class: 'input mono', value: d.key, spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Paste the Consumer Key (starts with 3MVG9…)',
    'aria-label': `Consumer Key for the ${info.title}`,
    oninput: (e) => { d.key = e.target.value; syncBtn(); },
    onkeydown: (e) => { if (e.key === 'Enter' && d.key.trim()) go(); },
  });
  syncBtn();
  const keyHint = pick
    ? 'Saved for this org. After a sandbox refresh the key can change: if sign-in fails, paste the new key from the org\'s External Client App. It is saved once you are connected.'
    : 'From the org\'s External Client App: Settings > OAuth Settings > Consumer Key and Secret. No secret is needed. Saved with the org (in the app folder) once you are connected.';
  if (conn.error) card.appendChild(h('div', { class: 'callout callout-danger small', role: 'alert' }, conn.error));
  card.appendChild(h('div', { class: 'form-stack' }, ...rows,
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

async function startConnect(role, { env, customDomain, clientId, savedOrgId = null }) {
  try {
    const conn = await connect(role, { env, customDomain, clientId, savedOrgId });
    if (conn.status === 'connected') drafts[role] = null; // next time: start from the saved org
    if (conn.status === 'connected') toast(`${ROLE_INFO[role].title} connected: ${conn.org ? conn.org.Name : ''}`, 'success');
    else if (conn.error) toast(conn.error, 'error');
  } catch (e) {
    if (e.message !== 'Login cancelled') toast(e.message, 'error');
  }
}
