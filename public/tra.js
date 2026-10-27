import { MAX_TRA_ITEMS, calculateReceipt, formatTraMoney } from '/tra-model.js';
import { initializeTraCatalog } from '/tra-catalog.js';
import { renderTraPreview } from '/tra-render.js';
import { initializeTraPrinting } from '/tra-print.js';
import { initializeDraftSync } from '/draft-sync.js';
import { initializeSavedReceipts } from '/tra-saved.js';
import { initializeReceiptNumbering } from '/tra-numbering.js';
import { revealMobileSection, setMobileItemEntry } from '/mobile-workspace.js';

const DRAFT_KEY = 'labeldesk.tra.draft.v1';
const $ = (id) => document.getElementById(id);
const detailsInputs = {
  receiptNumber: $('receipt-number'),
  recipientName: $('recipient-name'), recipientAddress: $('recipient-address'),
  receiptDate: $('receipt-date'), agreementStart: $('agreement-start'), agreementEnd: $('agreement-end'),
};
const itemInputs = {
  description: $('item-description'), barcode: $('item-barcode'),
  quantity: $('item-quantity'), unitPrice: $('item-price'),
};
const state = { items: [], editingId: null, nextId: 1, templateReady: false, previewErrors: [], selectingProduct: false, selectedProduct: null };
let catalog = null;
let receiptPrinting = null;
let draftSync = null;
let savedReceipts = null;
let receiptNumbering = null;

function detailsFromForm() {
  return Object.fromEntries(Object.entries(detailsInputs).map(([key, input]) => [key, input.value]));
}

function itemFromForm() {
  return Object.fromEntries(Object.entries(itemInputs).map(([key, input]) => [key, input.value]));
}

function hasItemDraft() {
  return state.editingId !== null || itemInputs.description.value !== '' || itemInputs.barcode.value !== '' || itemInputs.unitPrice.value !== '' || itemInputs.quantity.value !== '1';
}

function setItemError(message = '') {
  $('item-error').textContent = message;
  $('item-error').hidden = !message;
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      version: 1, details: detailsFromForm(), items: state.items,
      itemDraft: itemFromForm(), editingId: state.editingId,
    }));
    $('draft-status').textContent = 'Draft saved on this browser.';
  } catch {
    $('draft-status').textContent = 'This browser cannot save your draft. Keep this page open until you finish.';
  }
  draftSync?.changed();
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || !draft.details || !Array.isArray(draft.items)) throw new Error('Invalid saved receipt.');
    const receipt = calculateReceipt(draft.items);
    const keepIds = draft.items.every(item => Number.isSafeInteger(item.id) && item.id > 0) && new Set(draft.items.map(item => item.id)).size === draft.items.length;
    state.items = receipt.items.map((item, index) => ({ ...item, id: keepIds ? draft.items[index].id : index + 1 }));
    state.nextId = Math.max(0, ...state.items.map(item => item.id)) + 1;
    for (const [key, input] of Object.entries(detailsInputs)) {
      if (typeof draft.details[key] === 'string') input.value = draft.details[key].slice(0, input.maxLength > 0 ? input.maxLength : 10);
    }
    if (draft.itemDraft && typeof draft.itemDraft === 'object') {
      for (const [key, input] of Object.entries(itemInputs)) {
        if (typeof draft.itemDraft[key] === 'string') input.value = draft.itemDraft[key].slice(0, input.maxLength > 0 ? input.maxLength : 5);
      }
      const editingIndex = draft.items.findIndex((item) => item.id === draft.editingId);
      if (draft.editingId !== null && editingIndex >= 0) state.editingId = state.items[editingIndex].id;
    }
    $('draft-status').textContent = 'Your saved draft is ready.';
  } catch {
    $('draft-status').textContent = 'The saved draft could not be opened. You can start a new receipt.';
  }
}

function updatePrintControls() {
  const editing = hasItemDraft();
  $('print-receipt').disabled = !state.templateReady || state.previewErrors.length > 0 || editing || state.selectingProduct;
  receiptPrinting?.setReady(!$('print-receipt').disabled);
  if (state.templateReady) $('template-status').textContent = state.selectingProduct ? 'Loading the selected product…' : editing ? 'Add or save the item above, or cancel it, before printing.' : 'The preview is ready to print.';
  $('item-cancel').hidden = !editing && !state.selectingProduct;
  $('item-save').disabled = state.selectingProduct || (state.items.length >= MAX_TRA_ITEMS && state.editingId === null);
  catalog?.setFull(state.items.length >= MAX_TRA_ITEMS);
}

function renderPreview() {
  const receipt = calculateReceipt(state.items);
  state.previewErrors = renderTraPreview($('tra-document'), receipt, detailsFromForm());
  const errorBox = $('preview-errors');
  errorBox.replaceChildren();
  if (state.previewErrors.length) {
    const list = document.createElement('ul');
    for (const message of state.previewErrors) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    errorBox.append(list);
  }
  errorBox.hidden = state.previewErrors.length === 0;
  updatePrintControls();
}

function resetItemForm() {
  catalog?.cancelSelection();
  $('item-form').reset();
  state.editingId = null;
  clearProductSource();
  $('item-details').open = true;
  setItemError();
  $('item-heading').textContent = 'Add an item';
  $('item-save').textContent = 'Add item';
  $('item-cancel').hidden = true;
}

function clearProductSource() {
  state.selectedProduct = null;
  $('item-source').textContent = '';
  $('item-source').hidden = true;
}

function selectCatalogProduct(product) {
  const fields = {
    description: String(product.productName ?? ''), barcode: String(product.barcode ?? ''),
    unitPrice: String(product.price ?? ''), quantity: '1',
  };
  // Selecting a product always prepares a new receipt row, even after editing a row.
  state.editingId = null;
  state.selectedProduct = String(product.id);
  for (const [key, input] of Object.entries(itemInputs)) input.value = fields[key];
  $('item-heading').textContent = 'Add an item';
  $('item-save').textContent = 'Add item';
  let complete = true;
  try { calculateReceipt([fields]); } catch { complete = false; }
  let price = 'price needed';
  try { price = formatTraMoney(fields.unitPrice, { currency: true }); } catch { /* Show missing price below. */ }
  $('item-source').textContent = `${fields.description || 'Unnamed product'} · ${price}${complete ? ' — enter the quantity below.' : ' — complete the item details below.'}`;
  $('item-source').hidden = false;
  $('item-details').open = !complete;
  setItemError(complete ? '' : 'This catalog record needs item details. Complete them before adding it to the receipt.');
  renderItems();
  saveDraft();
  setMobileItemEntry(true);
  revealMobileSection('item-form');
  $('item-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  itemInputs.quantity.focus({ preventScroll: true });
  itemInputs.quantity.select();
}

function renderItems() {
  const receipt = calculateReceipt(state.items);
  const list = $('receipt-items');
  list.replaceChildren();
  receipt.items.forEach((item, index) => {
    const id = state.items[index].id;
    const row = document.createElement('li');
    row.className = 'receipt-item';
    row.dataset.editing = String(state.editingId === id);
    const heading = document.createElement('h3');
    heading.className = 'item-description';
    heading.textContent = `${index + 1}. ${item.description}`;
    const meta = document.createElement('p');
    meta.className = 'item-meta';
    meta.textContent = `${item.quantity} × ${formatTraMoney(item.unitPrice, { currency: true })} · Barcode ${item.barcode}`;
    const footer = document.createElement('div');
    footer.className = 'item-footer';
    const amount = document.createElement('strong');
    amount.className = 'item-amount';
    amount.textContent = formatTraMoney(item.amount, { currency: true });
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    for (const [action, text] of [['edit', 'Edit'], ['remove', 'Remove']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.dataset.action = action;
      button.dataset.itemId = String(id);
      button.textContent = text;
      button.setAttribute('aria-label', `${text} ${item.description}`);
      actions.append(button);
    }
    footer.append(amount, actions);
    row.append(heading, meta, footer);
    list.append(row);
  });
  $('items-empty').hidden = receipt.items.length > 0;
  $('item-count').textContent = `${receipt.items.length} / ${MAX_TRA_ITEMS}`;
  $('receipt-total').textContent = formatTraMoney(receipt.total, { currency: true });
  $('item-save').disabled = state.items.length >= MAX_TRA_ITEMS && state.editingId === null;
  $('item-limit').textContent = state.items.length >= MAX_TRA_ITEMS ? 'All 20 rows are filled. Edit or remove an item to make a change.' : 'Up to 20 items on one receipt.';
  renderPreview();
}

function saveItem(event) {
  event.preventDefault();
  if (state.selectingProduct) return;
  setItemError();
  try {
    const editingIndex = state.items.findIndex((item) => item.id === state.editingId);
    const candidate = state.items.map((item) => ({ ...item }));
    const item = { ...itemFromForm(), id: editingIndex >= 0 ? state.editingId : state.nextId };
    if (editingIndex >= 0) candidate[editingIndex] = item;
    else candidate.push(item);
    const receipt = calculateReceipt(candidate);
    // Check the actual cell widths before accepting an item; no clipping in print.
    const testSvg = $('tra-document').cloneNode(true);
    const fitErrors = renderTraPreview(testSvg, receipt);
    if (fitErrors.length) throw new Error(fitErrors[0]);
    state.items = receipt.items.map((entry, index) => ({ ...entry, id: candidate[index].id }));
    if (editingIndex < 0) state.nextId += 1;
    const fromCatalog = state.selectedProduct !== null;
    resetItemForm();
    renderItems();
    saveDraft();
    if (fromCatalog) { setMobileItemEntry(false); catalog?.focusSearch(); }
    else itemInputs.description.focus();
  } catch (error) {
    $('item-details').open = true;
    setItemError(error.message || 'Check the item details and try again.');
  }
}

function editItem(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  if (hasItemDraft() && !window.confirm('Discard the item changes you have not saved?')) return;
  catalog?.cancelSelection();
  clearProductSource();
  $('item-details').open = true;
  state.editingId = id;
  for (const [key, input] of Object.entries(itemInputs)) input.value = String(item[key]);
  setItemError();
  $('item-heading').textContent = 'Edit item';
  $('item-save').textContent = 'Save item';
  renderItems();
  saveDraft();
  setMobileItemEntry(true);
  revealMobileSection('item-form');
  $('item-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  itemInputs.description.focus({ preventScroll: true });
}

function removeItem(id) {
  state.items = state.items.filter((item) => item.id !== id);
  if (state.editingId === id) resetItemForm();
  renderItems();
  saveDraft();
}

$('item-form').addEventListener('submit', saveItem);
$('item-cancel').addEventListener('click', () => {
  resetItemForm();
  renderItems();
  saveDraft();
  setMobileItemEntry(false);
});
$('receipt-items').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-item-id]');
  if (!button) return;
  const id = Number(button.dataset.itemId);
  if (button.dataset.action === 'edit') editItem(id);
  if (button.dataset.action === 'remove') removeItem(id);
});
for (const input of Object.values(detailsInputs)) {
  input.addEventListener('input', () => { if (input === detailsInputs.receiptNumber) receiptNumbering?.clearStatus(); renderPreview(); saveDraft(); });
}
for (const input of Object.values(itemInputs)) {
  input.addEventListener('input', () => {
    catalog?.cancelSelection();
    if (input !== itemInputs.quantity) clearProductSource();
    setItemError(); updatePrintControls(); saveDraft();
  });
  input.addEventListener('invalid', () => { $('item-details').open = true; });
}
$('tra-catalog-manual').addEventListener('click', () => {
  catalog?.cancelSelection();
  $('item-details').open = true;
  setMobileItemEntry(true);
  itemInputs.description.focus();
});
$('clear-receipt').addEventListener('click', () => {
  if (savedReceipts?.isBusy() || receiptNumbering?.isBusy()) return;
  if ((state.items.length || hasItemDraft() || Object.values(detailsFromForm()).some(Boolean)) && !window.confirm('Start a new receipt with the next number? Current details and items will be cleared on your paired devices. Save the current receipt first if you need to keep it.')) return;
  void receiptNumbering.assign({ newReceipt: true }).catch(() => {});
});
$('receipt-next-number').addEventListener('click', () => {
  if (savedReceipts?.isBusy()) return;
  if (detailsInputs.receiptNumber.value.trim()) {
    $('receipt-number-status').textContent = 'This receipt already has a number. Use New receipt for a new document, or clear this number to replace it.';
    return;
  }
  void receiptNumbering.assign().catch(() => {});
});
$('print-receipt').addEventListener('click', () => {
  renderPreview();
  if (!$('print-receipt').disabled) window.print();
});
window.addEventListener('beforeprint', renderPreview);

restoreDraft();
if (state.editingId !== null) {
  $('item-heading').textContent = 'Edit item';
  $('item-save').textContent = 'Save item';
}
renderItems();
catalog = initializeTraCatalog({
  beforeSelect: () => !hasItemDraft() || window.confirm(state.editingId !== null
    ? 'Discard unsaved edits and choose this product as a new receipt item? The saved row will stay on the receipt.'
    : 'Replace the item details you have not added to the receipt?'),
  onSelect: selectCatalogProduct,
  onBusy: (busy) => { state.selectingProduct = busy; updatePrintControls(); },
});
catalog.setFull(state.items.length >= MAX_TRA_ITEMS);
const template = new Image();
template.addEventListener('load', () => {
  state.templateReady = true;
  renderPreview();
});
template.addEventListener('error', () => {
  $('template-status').textContent = 'The template could not load. Refresh this page before printing.';
});
template.src = '/tra-template.svg';
document.fonts.ready.then(renderPreview);
receiptPrinting = initializeTraPrinting({
  getReceipt: () => {
    renderPreview();
    if ($('print-receipt').disabled) throw new Error('Finish the item and fix the preview errors before printing.');
    return { details: detailsFromForm(), items: calculateReceipt(state.items).items };
  },
});
updatePrintControls();
receiptNumbering = initializeReceiptNumbering({
  getDraft: () => ({ details: detailsFromForm(), items: state.items, editor: itemFromForm(), editingId: state.editingId }),
  canChange: () => !state.selectingProduct && !$('tra-scanner-dialog').open && !receiptPrinting?.isPending(),
  applyNumber: (number, newReceipt) => {
    if (newReceipt) {
      state.items = []; state.nextId = 1;
      for (const input of Object.values(detailsInputs)) input.value = '';
      resetItemForm();
      setMobileItemEntry(false);
      $('receipt-save-status').textContent = 'New receipt. Add the recipient and items, then save it to the database.';
      $('receipt-save-status').dataset.error = 'false';
    }
    detailsInputs.receiptNumber.value = number;
    renderItems(); saveDraft();
    if (newReceipt) revealMobileSection('receipt-number');
  },
});

savedReceipts = initializeSavedReceipts({
  ensureNumber: () => receiptNumbering.assign(),
  getReceipt: () => {
    if (hasItemDraft() || state.selectingProduct) throw new Error('Add or save the item above, or cancel it, before saving the receipt.');
    return { details: detailsFromForm(), items: calculateReceipt(state.items).items };
  },
  getDraft: () => ({ version: 1, details: detailsFromForm(), items: state.items, itemDraft: itemFromForm(), editingId: state.editingId }),
  canOpen: () => !state.selectingProduct && !$('tra-scanner-dialog').open && !receiptPrinting?.isPending() && !receiptNumbering?.isBusy(),
  applyReceipt: receipt => {
    const normalized = calculateReceipt(receipt.items);
    receiptNumbering?.clearStatus();
    for (const [key, input] of Object.entries(detailsInputs)) input.value = receipt.details[key] || '';
    state.items = normalized.items.map((item, index) => ({ ...item, id: index + 1 }));
    state.nextId = state.items.length + 1;
    resetItemForm(); setMobileItemEntry(false); renderItems(); saveDraft();
  },
});

draftSync = initializeDraftSync({
  kind: 'tra',
  getDraft: () => ({ ...detailsFromForm(), items: state.items, editor: { ...itemFromForm(), editingId: state.editingId } }),
  applyDraft: draft => {
    if (detailsInputs.receiptNumber.value !== draft.receiptNumber) receiptNumbering?.clearStatus();
    for (const [key, input] of Object.entries(detailsInputs)) if (input.value !== draft[key]) input.value = draft[key];
    const editorChanged = JSON.stringify({ ...itemFromForm(), editingId: state.editingId }) !== JSON.stringify(draft.editor);
    if (editorChanged) {
      catalog?.cancelSelection(); clearProductSource(); setItemError();
      for (const [key, input] of Object.entries(itemInputs)) if (input.value !== draft.editor[key]) input.value = draft.editor[key];
      state.editingId = draft.editor.editingId;
      $('item-details').open = true;
      $('item-heading').textContent = state.editingId === null ? 'Add an item' : 'Edit item';
      $('item-save').textContent = state.editingId === null ? 'Add item' : 'Save item';
      setMobileItemEntry(hasItemDraft());
    }
    state.items = draft.items;
    state.nextId = Math.max(0, ...state.items.map(item => item.id)) + 1;
    renderItems(); saveDraft();
  },
  canSync: () => !state.selectingProduct && !$('tra-scanner-dialog').open && !receiptPrinting?.isPending() && !savedReceipts?.isBusy() && !receiptNumbering?.isBusy(),
});
setMobileItemEntry(hasItemDraft());
