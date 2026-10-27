import { DEFAULT_LABEL_LAYOUT } from '/label-layouts.js';

const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const draftValuesEqual = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const equal = draftValuesEqual;
const changedKeys = (a, b) => Object.keys(a).filter(key => !equal(a[key], b[key]));

// Polls use the existing authenticated HTTP/HTTPS connection. Only draft data
// travels here: never print actions, print request IDs, scanner state, or tokens.
export function initializeDraftSync({ kind, getDraft, applyDraft, canSync = () => true, getToken }) {
  const storageKey = `labeldesk.sync.${kind}.v1`;
  const box = document.getElementById('draft-sync');
  const heading = document.createElement('strong'); heading.textContent = 'Live sync';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.id = 'draft-sync-status';
  const actions = document.createElement('div'); actions.className = 'draft-sync-actions'; actions.hidden = true;
  const other = document.createElement('button'); other.type = 'button'; other.id = 'draft-sync-other'; other.textContent = 'Use shared changes';
  const mine = document.createElement('button'); mine.type = 'button'; mine.id = 'draft-sync-mine'; mine.textContent = 'Keep my changes';
  for (const button of [other, mine]) button.className = 'secondary-button';
  const comparison = document.createElement('details'); comparison.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = 'Compare changes';
  const list = document.createElement('ul'); comparison.append(summary, list);
  actions.append(other, mine); box.append(heading, status, actions, comparison);
  let base = null, conflict = null, applying = false, running = false, timer = null, stopped = false, token = '', composing = false, editTime = 0;
  try {
    token = localStorage.getItem('labeldesk.token') || '';
    const cached = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (kind === 'stickers' && cached?.data && !Object.hasOwn(cached.data, 'labelLayout')) cached.data.labelLayout = DEFAULT_LABEL_LAYOUT;
    if (cached && Number.isSafeInteger(cached.revision) && cached.data && equal(Object.keys(cached.data).sort(), Object.keys(getDraft()).sort())) base = cached;
  } catch {}
  function message(text, state = 'ready') { if (status.textContent !== text) status.textContent = text; box.dataset.state = state; }
  function saveBase() { try { localStorage.setItem(storageKey, JSON.stringify(base)); } catch {} }
  function apply(data) {
    if (equal(data, getDraft())) return;
    applying = true;
    try { applyDraft(clone(data)); } finally { applying = false; }
  }
  function describe(value) {
    if (Array.isArray(value)) return `${value.length} items: ${value.map(item => item.description || item.fields?.productName || '').join(', ').slice(0, 200)}`;
    if (value && typeof value === 'object') return Object.entries(value).map(([key, val]) => `${key}: ${describe(val)}`).join('; ').slice(0, 300);
    return String(value ?? '') || '(empty)';
  }
  function showConflict(remote, keys, initial = false) {
    conflict = { remote, keys, initial }; actions.hidden = comparison.hidden = false;
    message(initial ? 'This browser has a different saved draft. Choose which draft to share with your other devices.' : 'The same content changed on another device. Choose which changes to keep; your other edits are retained.', 'conflict');
    list.replaceChildren();
    const local = getDraft();
    for (const key of keys) { const row = document.createElement('li'); row.textContent = `${key}: This device: ${describe(local[key])} · Shared: ${describe(remote.data[key])}`; list.append(row); }
  }
  function receive(remote, reference = base?.data) {
    const local = getDraft();
    if (!reference) {
      // Empty forms can immediately join an existing draft. An older saved
      // browser draft must never silently replace the PC's current document.
      const populated = Object.entries(local).some(([key, value]) => {
        if (kind === 'stickers' && key === 'copies') return value !== '1';
        if (kind === 'stickers' && key === 'labelLayout') return value !== DEFAULT_LABEL_LAYOUT;
        if (key === 'editor') return Object.entries(value).some(([name, entry]) => name === 'quantity' ? entry !== '1' : name === 'editingId' ? entry !== null : Boolean(entry));
        if (key === 'batch') return value.queue.length || value.editingId;
        return Array.isArray(value) ? value.length : Boolean(value);
      });
      if (remote.revision && populated && !equal(local, remote.data)) { showConflict(remote, changedKeys(local, remote.data), true); return false; }
      if (remote.revision) apply(remote.data);
      base = remote; saveBase(); return true;
    }
    const dirty = changedKeys(local, reference);
    const clashes = dirty.filter(key => !equal(remote.data[key], reference[key]) && !equal(remote.data[key], local[key]));
    if (clashes.length) { showConflict(remote, clashes); return false; }
    const merged = clone(remote.data);
    for (const key of dirty) merged[key] = local[key];
    apply(merged); base = remote; saveBase(); return true;
  }
  async function request(body) {
    const credential = getToken ? getToken() : token;
    if (!credential) throw Object.assign(new Error('Pair this device with the printing PC to sync.'), { status: 401 });
    const response = await fetch(`/api/drafts/${kind}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok && response.status !== 409) throw Object.assign(new Error(data.error || 'Could not sync the draft.'), { status: response.status });
    return data;
  }
  function schedule(ms = 1000) { clearTimeout(timer); if (!stopped) timer = setTimeout(cycle, ms); }
  async function cycle() {
    if (running || stopped) return;
    if (!canSync() || composing) { message('Sync paused while this device finishes its current action.', 'waiting'); schedule(); return; }
    running = true;
    try {
      const { draft } = await request();
      if (!canSync() || composing || stopped) return;
      if (conflict) { showConflict(draft, conflict.initial ? changedKeys(getDraft(), draft.data) : conflict.keys, conflict.initial); return; }
      if (!receive(draft)) return;
      const local = getDraft();
      const changes = changedKeys(local, base.data).map(key => ({ key, before: base.data[key], value: local[key] }));
      if (changes.length && Date.now() - editTime >= 250) {
        message('Syncing changes…', 'waiting');
        const sent = clone(local);
        const result = await request({ revision: base.revision, changes });
        if (stopped) return;
        // Edits made while POST is in flight remain dirty against what was
        // actually sent. A successful ACK cannot undo the next keystroke.
        if (!canSync() || composing) return;
        if (!receive(result.draft, result.conflict ? base.data : sent)) return;
      }
      message(changedKeys(getDraft(), base.data).length ? 'Changes saved here. Syncing shortly…' : 'Synced with the printing PC. Open this page on your other paired device.', changedKeys(getDraft(), base.data).length ? 'waiting' : 'ready');
    } catch (error) {
      message(error.status === 401 ? 'Pair this device with the printing PC to sync.' : error.status && error.status !== 503 ? `Sync paused: ${error.message}` : 'Offline — changes stay on this device and will sync when the PC reconnects.', 'offline');
    } finally { running = false; schedule(); }
  }
  function resolveConflict(useMine) {
    if (!conflict || !canSync() || composing) return;
    const local = getDraft(), { remote, keys, initial } = conflict;
    try { localStorage.setItem(`${storageKey}.recovery`, JSON.stringify({ local, shared: remote, savedAt: new Date().toISOString() })); } catch {}
    let merged = clone(remote.data);
    if (initial) { if (useMine) merged = local; }
    else {
      for (const key of changedKeys(local, base.data)) if (useMine || !keys.includes(key)) merged[key] = local[key];
    }
    apply(merged); base = remote; saveBase(); conflict = null; actions.hidden = comparison.hidden = true;
    message('Syncing your chosen changes…', 'waiting'); schedule(0);
  }
  other.addEventListener('click', () => resolveConflict(false)); mine.addEventListener('click', () => resolveConflict(true));
  function changed() { if (applying) return; editTime = Date.now(); if (!conflict) message('Changes saved here. Syncing shortly…', 'waiting'); schedule(300); }
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; changed(); });
  window.addEventListener('labeldesk-paired', event => { token = event.detail.token || ''; schedule(0); });
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('focus', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', () => { stopped = false; schedule(0); });
  message('Connecting live sync…', 'waiting'); schedule(0);
  return { changed, refresh: () => schedule(0) };
}
