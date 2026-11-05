// Reusable UI pieces: modal dialogs, confirm, toasts, small widgets.
import { h, clear } from '../util.js';

let modalStack = 0;

/**
 * Opens a modal. `render(close)` returns the body node. Resolves with the value passed to close().
 */
export function openModal({ title, render, wide = false, footer = null, dismissable = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const previouslyFocused = document.activeElement;
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      modalStack--;
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) close(undefined);
    };
    const body = render(close);
    const dialog = h('div', { class: ['modal', wide && 'modal-wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-header' },
        h('h2', null, title),
        dismissable ? h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(undefined) }, '×') : null),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-footer' }, footer(close)) : null);
    const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay && dismissable) close(undefined); } }, dialog);
    root.appendChild(overlay);
    modalStack++;
    document.addEventListener('keydown', onKey);
    const focusable = dialog.querySelector('input, select, textarea, button.btn-primary, button');
    if (focusable) setTimeout(() => focusable.focus(), 0);
  });
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null }) {
  return openModal({
    title,
    render: (close) => {
      const input = requireText ? h('input', { type: 'text', class: 'input', placeholder: requireText, 'aria-label': `Type ${requireText} to confirm` }) : null;
      const btn = h('button', {
        class: ['btn', danger ? 'btn-danger' : 'btn-primary'],
        disabled: !!requireText,
        onclick: () => close(true),
      }, confirmLabel);
      if (input) {
        input.addEventListener('input', () => { btn.disabled = input.value.trim() !== requireText; });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) close(true); });
      }
      return h('div', null,
        typeof message === 'string' ? h('p', null, message) : message,
        input ? h('label', { class: 'field-label' }, `Type `, h('code', null, requireText), ' to confirm', input) : null,
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
          btn));
    },
  }).then((v) => v === true);
}

export function toast(text, kind = 'info', ms = 4500) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' }, text);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? ms * 2 : ms);
}

export function badge(text, kind = 'neutral', title) {
  return h('span', { class: ['badge', `badge-${kind}`], title }, text);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, action || null);
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
}

/** Labeled form row. */
export function formRow(label, control, hint) {
  return h('label', { class: 'form-row' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

export function select(options, value, onChange, attrs = {}) {
  const el = h('select', { class: 'input', ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map((o) => {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      return h('option', { value: opt.value, selected: String(opt.value) === String(value), disabled: opt.disabled }, opt.label);
    }));
  el.value = value ?? '';
  return el;
}

/**
 * Searchable combobox for long lists (objects, fields). Calls onPick(value).
 * items: [{ value, label, sub }]
 */
export function combobox({ items, placeholder = 'Search…', onPick, value = '', autofocus = false }) {
  const input = h('input', { type: 'text', class: 'input', placeholder, value, autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'false' });
  const list = h('ul', { class: 'combo-list', role: 'listbox', hidden: true });
  let active = -1;
  let shown = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = (q ? items.filter((i) => i.label.toLowerCase().includes(q) || String(i.value).toLowerCase().includes(q)) : items).slice(0, 200);
    clear(list);
    shown.forEach((it, idx) => {
      list.appendChild(h('li', {
        class: ['combo-item', idx === active && 'active'],
        role: 'option',
        onmousedown: (e) => { e.preventDefault(); pick(it); },
      }, h('span', null, it.label), h('span', { class: 'combo-sub' }, it.sub || it.value)));
    });
    if (!shown.length) list.appendChild(h('li', { class: 'combo-empty' }, 'No matches'));
  };
  const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); };
  const closeList = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const pick = (it) => { closeList(); onPick(it.value); };
  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    open(); // recompute matches first, then highlight the best one
    active = shown.length ? 0 : -1;
    render();
  });
  input.addEventListener('blur', () => setTimeout(closeList, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const it = shown[active] || (input.value.trim() ? shown[0] : null);
      if (it) pick(it);
      e.preventDefault();
    }
    else if (e.key === 'Escape') { closeList(); }
  });
  if (autofocus) setTimeout(() => input.focus(), 0);
  return h('div', { class: 'combo' }, input, list);
}
