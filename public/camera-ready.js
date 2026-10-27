import { calculateReceipt } from '/tra-model.js';

const DRAFT_KEY = 'labeldesk.tra.draft.v1';
const TOKEN_KEY = 'labeldesk.token';
const MAX_DRAFT_BYTES = 50 * 1024;
const $ = id => document.getElementById(id);
const nonce = new URLSearchParams(location.hash.slice(1)).get('nonce') || '';
const sourceWindow = window.opener;
history.replaceState(null, '', location.pathname);
let sourceOrigin = null;
let pendingTransfer = null;
let receiving = true;
let readyTimer = null;
let timeout = null;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textFields(value, fields) {
  if (!isObject(value)) throw new Error('The saved receipt has invalid fields.');
  const normalized = {};
  for (const [key, maximum] of Object.entries(fields)) {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > maximum || /[\x00-\x1f\x7f]/.test(text)) throw new Error('The saved receipt has invalid text.');
    normalized[key] = text;
  }
  return normalized;
}

function validateDraft(raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES) throw new Error('The saved receipt is too large to copy.');
  const draft = JSON.parse(raw);
  if (!isObject(draft) || draft.version !== 1 || !isObject(draft.details) || !Array.isArray(draft.items)) throw new Error('The saved receipt has an unsupported format.');
  const receipt = calculateReceipt(draft.items);
  const details = textFields(draft.details, { receiptNumber: 21, recipientName: 100, recipientAddress: 180, receiptDate: 10, agreementStart: 10, agreementEnd: 10 });
  const itemDraft = draft.itemDraft === undefined ? { description: '', barcode: '', unitPrice: '', quantity: '1' } : textFields(draft.itemDraft, { description: 100, barcode: 32, unitPrice: 24, quantity: 5 });
  const ids = draft.items.map(item => item.id);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) throw new Error('The saved receipt has invalid item identifiers.');
  const editingId = draft.editingId ?? null;
  if (editingId !== null && (!Number.isSafeInteger(editingId) || !ids.includes(editingId))) throw new Error('The saved receipt has an invalid edited item.');
  const normalized = { version: 1, details, items: receipt.items.map((item, index) => ({ ...item, id: ids[index] })), itemDraft, editingId };
  return { raw: JSON.stringify(normalized), draft: normalized };
}

function hasContent(validated) {
  if (!validated) return false;
  const draft = validated.draft;
  return draft.items.length > 0 || Object.values(draft.details).some(Boolean) || draft.editingId !== null ||
    Object.entries(draft.itemDraft).some(([key, value]) => key === 'quantity' ? value !== '1' && value !== '' : Boolean(value));
}

function summary(label, validated) {
  if (!validated) return `${label}: saved receipt could not be read.`;
  const { details, items } = validated.draft;
  const name = details.recipientName || (details.receiptNumber ? `#${details.receiptNumber.replace(/^#/, '')}` : 'Unnamed receipt');
  return `${label}: ${name} · ${items.length} ${items.length === 1 ? 'item' : 'items'}`;
}

function stopWaiting() {
  clearInterval(readyTimer);
  clearTimeout(timeout);
  receiving = false;
}

function tellSource(type) {
  if (sourceWindow && sourceOrigin) sourceWindow.postMessage({ type, nonce }, sourceOrigin);
}

function fail(message) {
  stopWaiting();
  pendingTransfer = null;
  $('ready-status').textContent = 'Your original receipt is still saved at the old address.';
  $('ready-error').textContent = message;
  $('ready-error').hidden = false;
  $('ready-fallback').hidden = false;
  $('draft-choice').hidden = true;
  tellSource('labeldesk-camera-transfer-error');
}

function complete(copyDraft) {
  if (!pendingTransfer) return;
  try {
    if (copyDraft && pendingTransfer.incoming) localStorage.setItem(DRAFT_KEY, pendingTransfer.incoming.raw);
    if (pendingTransfer.token) localStorage.setItem(TOKEN_KEY, pendingTransfer.token);
    tellSource('labeldesk-camera-transferred');
    pendingTransfer = null;
    window.opener = null;
    location.replace('/tra');
  } catch {
    fail('This browser could not save the copied receipt. Keep the old page open and allow browser storage before trying again.');
  }
}

window.addEventListener('message', event => {
  if (!receiving || !sourceOrigin || event.origin !== sourceOrigin || event.source !== sourceWindow ||
      !isObject(event.data) || event.data.type !== 'labeldesk-camera-transfer' || event.data.nonce !== nonce) return;
  stopWaiting();
  try {
    const { token = '', draft } = event.data;
    if (typeof token !== 'string' || (token && !/^[a-f0-9]{64}$/.test(token))) throw new Error('The old page sent invalid pairing details. Pair this secure page using the code on your Windows PC.');
    const incoming = validateDraft(draft);
    const existingRaw = localStorage.getItem(DRAFT_KEY);
    let existing = null;
    let existingInvalid = false;
    try { existing = validateDraft(existingRaw); } catch { existingInvalid = Boolean(existingRaw); }
    pendingTransfer = { token, incoming };
    if (incoming && (existingInvalid || hasContent(existing)) && incoming.raw !== existing?.raw) {
      $('incoming-summary').textContent = summary('From old address', incoming);
      $('existing-summary').textContent = summary('Saved here', existing);
      $('ready-status').textContent = 'Your connection is ready. Choose the receipt to continue.';
      $('draft-choice').hidden = false;
      return;
    }
    complete(Boolean(incoming));
  } catch (problem) {
    fail(problem.message || 'The receipt could not be copied. Return to the old receipt page to continue it.');
  }
});

$('copy-draft').addEventListener('click', () => complete(true));
$('keep-draft').addEventListener('click', () => complete(false));

async function initialize() {
  try {
    if (location.protocol !== 'https:' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('This page needs a trusted secure connection for live camera access. Return to camera setup and check the certificate installation.');
    }
    if (!sourceWindow || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Open this page from Open live scanning on the camera setup page to copy your saved receipt.');
    const response = await fetch('/api/camera-setup', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The printing PC could not confirm the secure connection.');
    const data = await response.json();
    const original = new URL(data.httpUrl);
    const secure = new URL(data.httpsUrl);
    if (!data.enabled || original.protocol !== 'http:' || original.hostname !== location.hostname || original.username || original.password ||
        secure.protocol !== 'https:' || secure.origin !== location.origin || secure.username || secure.password) {
      throw new Error('Open camera setup using the address shown on your printing PC.');
    }
    sourceOrigin = original.origin;
    const announce = () => tellSource('labeldesk-camera-ready');
    readyTimer = setInterval(announce, 700);
    timeout = setTimeout(() => fail('The original setup tab did not respond. Return to that tab and tap Open live scanning again.'), 15000);
    announce();
  } catch (problem) {
    fail(problem.name === 'TimeoutError' ? 'The printing PC took too long to respond. Return to camera setup and try again.' : problem.message);
  }
}

initialize();
