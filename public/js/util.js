// Shared, framework-free helpers (DOM building, async, CSV, downloads).

/**
 * Minimal hyperscript helper.
 * h('div', { class: 'x', onclick: fn, style: { width: '10px' } }, 'text', childNode, [more])
 * Properties such as value/checked/disabled/selected are set as DOM properties.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : val;
      } else if (key === 'style' && typeof val === 'object') {
        Object.assign(el.style, val); // CSSOM writes are CSP-safe
      } else if (key === 'dataset') {
        Object.assign(el.dataset, val);
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (['value', 'checked', 'disabled', 'selected', 'readOnly', 'multiple', 'hidden', 'indeterminate'].includes(key)) {
        el[key] = val;
      } else if (val === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function uid(prefix = 'id') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}

/** Random RFC 4122 version 4 UUID. */
export function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class AbortedError extends Error {
  constructor() {
    super('Operation stopped by user');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortedError();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new AbortedError());
      }, { once: true });
    }
  });
}

export function fmtNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : String(n ?? '');
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function slugify(s) {
  return String(s || 'template').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((hd) => csvEscape(row[hd])).join(','));
  return lines.join('\r\n');
}

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsText(file);
  });
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export const storage = {
  get(area, key, fallback = null) {
    try {
      const raw = window[area].getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(area, key) {
    try {
      window[area].removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function plural(n, word, pluralWord) {
  return `${fmtNum(n)} ${n === 1 ? word : pluralWord || `${word}s`}`;
}
