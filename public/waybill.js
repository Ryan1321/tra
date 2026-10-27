import { WAYBILL_FIELDS, blankWaybills, normalizeWaybills, nextWaybillNumber } from '/waybill-model.js';
import { renderWaybillPreview } from '/waybill-render.js';
import { initializeTraPrinting } from '/tra-print.js';
import { initializeDraftSync } from '/draft-sync.js';
import { revealMobileSection } from '/mobile-workspace.js';

const $ = id => document.getElementById(id);
const DRAFT_KEY = 'labeldesk.waybill.draft.v1';
let values = blankWaybills(), printing = null, valid = false;
let draftSync = null;

function formValues() {
  return [0, 1].map(index => Object.fromEntries(WAYBILL_FIELDS.map(field => [field.key, $(`waybill-${index}-${field.key}`).value])));
}
function fill(values) {
  for (let index = 0; index < 2; index++) for (const field of WAYBILL_FIELDS) {
    const input = $(`waybill-${index}-${field.key}`);
    if (input.value !== values[index][field.key]) input.value = values[index][field.key];
  }
}
function hasChanges() { return formValues().some(entry => Object.values(entry).some(Boolean)); }
function save() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, waybills: formValues() })); $('waybill-draft-status').textContent = 'Draft saved on this browser.'; }
  catch { $('waybill-draft-status').textContent = 'This browser cannot save drafts. Keep this page open until you finish.'; }
  draftSync?.changed();
}
function preview() {
  let errors = [], incomplete = '';
  try {
    values = normalizeWaybills(formValues());
    errors = renderWaybillPreview($('waybill-document'), values);
    try { normalizeWaybills(values, { forPrint: true }); } catch (error) { incomplete = error.message; }
  } catch (error) { errors = [error.message]; }
  valid = !errors.length && !incomplete;
  const box = $('waybill-errors'); box.replaceChildren();
  for (const error of errors) { const p = document.createElement('p'); p.textContent = error; box.append(p); }
  box.hidden = !errors.length;
  $('waybill-browser-print').disabled = !valid;
  printing?.setReady(valid);
  $('waybill-ready').textContent = errors.length ? 'Shorten the text listed above the preview before printing.' : incomplete || 'Both waybills are ready to print.';
}

for (let index = 0; index < 2; index++) {
  const container = $(index ? 'waybill-two-fields' : 'waybill-one-fields');
  for (const field of WAYBILL_FIELDS) {
    const div = document.createElement('div'); div.className = 'field';
    const label = document.createElement('label'); label.htmlFor = `waybill-${index}-${field.key}`; label.textContent = field.label;
    const input = document.createElement('input'); input.id = label.htmlFor; input.maxLength = field.maximum; input.autocomplete = 'off';
    input.placeholder = ({ number: index ? '331' : '330', destination: 'SM BATAAN', transport: 'NORTHERN BUS,', location: 'SAMPALOC', recipient: 'Recipient name', phone: '09XXXXXXXXX' })[field.key];
    if (field.key === 'phone') { input.type = 'tel'; input.inputMode = 'tel'; }
    input.addEventListener('input', () => { preview(); save(); });
    div.append(label, input); container.append(div);
  }
}
try {
  const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  if (saved) {
    if (saved.version !== 1) throw new Error('Unsupported draft.');
    values = normalizeWaybills(saved.waybills);
    $('waybill-draft-status').textContent = 'Your saved waybills are ready.';
  }
} catch { $('waybill-draft-status').textContent = 'The saved waybill draft could not be opened. Start a new sheet.'; }
fill(values);
$('copy-waybill').addEventListener('click', () => {
  const current = formValues();
  if (Object.values(current[1]).some(Boolean) && !confirm('Replace the details in waybill 2 with waybill 1?')) return;
  current[1] = { ...current[0], number: nextWaybillNumber(current[0].number) };
  fill(current); preview(); save(); revealMobileSection('waybill-1-number'); $('waybill-1-number').focus();
});
$('waybill-clear').addEventListener('click', () => {
  if (hasChanges() && !confirm('Clear both waybills?')) return;
  fill(blankWaybills()); preview(); save(); revealMobileSection('waybill-0-number'); $('waybill-0-number').focus();
});
$('waybill-sample').addEventListener('click', () => {
  if (hasChanges() && !confirm('Replace your current sheet with the reference example?')) return;
  fill(['330', '331'].map(number => ({ number, destination: 'SM BATAAN', transport: 'NORTHERN BUS,', location: 'SAMPALOC', recipient: 'JOSEPHIA O. AZORES', phone: '09338102488' })));
  preview(); save();
});
$('waybill-browser-print').addEventListener('click', () => { preview(); if (valid) window.print(); });
window.addEventListener('beforeprint', preview);
printing = initializeTraPrinting({ kind: 'waybill', getReceipt: () => {
  preview();
  if (!valid) throw new Error('Complete both waybills and fix any preview errors before printing.');
  return { waybills: normalizeWaybills(formValues(), { forPrint: true }) };
} });
preview();
document.fonts.ready.then(preview);

function rememberPairing(token) {
  try { localStorage.setItem('labeldesk.token', token); } catch {}
  window.dispatchEvent(new CustomEvent('labeldesk-paired', { detail: { token } }));
  $('waybill-pair-form').hidden = true; $('waybill-pair-status').textContent = 'Connected to the printing PC.';
}
async function connect() {
  try {
    let token = ''; try { token = localStorage.getItem('labeldesk.token') || ''; } catch {}
    const response = await fetch('/api/status', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error();
    const status = await response.json();
    if (!status.pairedRequired) { rememberPairing(token); return; }
    if (status.localSetup) {
      const setup = await fetch('/api/setup?includePrinters=false', { signal: AbortSignal.timeout(10000) });
      if (!setup.ok) throw new Error();
      rememberPairing((await setup.json()).token); return;
    }
    $('waybill-pair-form').hidden = false;
  } catch { $('waybill-pair-form').hidden = false; $('waybill-pair-status').textContent = 'Start the printing service on the PC, then refresh to connect. You can still edit and save a PDF.'; }
}
$('waybill-pair-form').addEventListener('submit', async event => {
  event.preventDefault(); $('waybill-pair-button').disabled = true;
  try {
    const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('waybill-pair-code').value }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    rememberPairing(data.token); $('waybill-pair-code').value = '';
  } catch (error) { $('waybill-pair-status').textContent = error.message || 'Could not connect. Try again.'; }
  finally { $('waybill-pair-button').disabled = false; }
});
draftSync = initializeDraftSync({
  kind: 'waybill',
  getDraft: () => Object.fromEntries(formValues().flatMap((entry, index) => Object.entries(entry).map(([key, value]) => [`${index}.${key}`, value]))),
  applyDraft: draft => {
    fill([0, 1].map(index => Object.fromEntries(WAYBILL_FIELDS.map(field => [field.key, draft[`${index}.${field.key}`]]))));
    preview(); save();
  },
  canSync: () => !printing?.isPending(),
});
void connect();
