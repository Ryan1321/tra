import { initializeDraftSync, draftValuesEqual } from '/draft-sync.js';
import { DEFAULT_LABEL_LAYOUT, LABEL_VARIATIONS, getLabelVariation } from '/label-layouts.js';
import { revealMobileSection } from '/mobile-workspace.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'labeldesk.token';
  const DRAFT_KEY = 'labeldesk.draft';
  const INTENT_KEY = 'labeldesk.pendingPrint';
  const BATCH_KEY = 'labeldesk.batchQueue';
  const BATCH_INTENT_KEY = 'labeldesk.pendingBatch';
  const MAX_COPIES = 100;
  let draftSync = null;
  const fieldInputs = {
    price: $('price'),
    productName: $('product-name'),
    sku: $('sku'),
    barcode: $('barcode'),
  };
  const state = {
    token: readStorage(TOKEN_KEY) || '',
    online: false,
    paired: false,
    selectedPrinter: '',
    printers: [],
    previewKey: '',
    previewUrl: '',
    previewLoading: false,
    previewController: null,
    previewTimer: null,
    previewVersion: 0,
    printing: false,
    savingPrinter: false,
    refreshing: false,
    booting: false,
    layoutVersion: '',
    pendingIntent: readJson(INTENT_KEY),
    catalogStarted: false,
    catalogLoading: false,
    catalogController: null,
    catalogTimer: null,
    catalogVersion: 0,
    catalogQuery: '',
    catalogPage: 1,
    catalogPages: 0,
    catalogProducts: [],
    selectionController: null,
    selectionVersion: 0,
    selectingProductId: '',
    selectedProductId: '',
    formProductId: '',
    batchQueue: [],
    batchIntent: null,
    batchResult: null,
    batchEditingId: '',
    batchRequesting: false,
    batchChecking: false,
    batchMissing: false,
    batchTimer: null,
  };

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  }

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch { return false; }
  }

  function readJson(key) {
    try { return JSON.parse(readStorage(key) || 'null'); } catch { return null; }
  }

  function setText(id, value) { $(id).textContent = value; }

  function setError(id, value) {
    setText(id, value || '');
    $(id).hidden = !value;
  }

  function showPanel(id) {
    ['loading-panel', 'pair-panel', 'fatal-panel', 'workspace'].forEach((panel) => {
      $(panel).hidden = panel !== id;
    });
  }

  function setConnection(online, text) {
    state.online = online;
    $('connection-status').dataset.state = online ? 'online' : 'offline';
    setText('connection-text', text || (online ? 'Station connected' : 'Station offline'));
    updatePrintControls();
  }

  function getFields() {
    return Object.fromEntries(Object.entries(fieldInputs).map(([key, input]) => [key, input.value.trim()]));
  }

  function getCopies() { return Number($('copies').value); }
  function validCopies() { const n = getCopies(); return Number.isInteger(n) && n >= 1 && n <= MAX_COPIES; }
  function fieldsComplete(fields = getFields()) { return Object.values(fields).every((value) => value.length > 0); }
  function selectedLayout() { return $('label-layout').value; }
  function fieldsKey(fields = getFields(), labelLayout = selectedLayout()) { return JSON.stringify({ fields, labelLayout }); }

  function saveDraft() {
    writeStorage(DRAFT_KEY, JSON.stringify({ fields: Object.fromEntries(Object.entries(fieldInputs).map(([key, input]) => [key, input.value])), copies: $('copies').value, formProductId: state.formProductId, batchEditingId: state.batchEditingId, labelLayout: selectedLayout() }));
    draftSync?.changed();
  }

  function restoreDraft() {
    const draft = readJson(DRAFT_KEY);
    if (!draft || typeof draft !== 'object') return;
    Object.entries(fieldInputs).forEach(([key, input]) => {
      if (typeof draft.fields?.[key] === 'string') {
        input.value = key === 'price' ? draft.fields[key].trim().replace(/^(?:₱|PHP\s*|P\s*)\s*/i, '') : draft.fields[key];
      }
    });
    const copies = Number(draft.copies);
    if (Number.isInteger(copies) && copies >= 1 && copies <= MAX_COPIES) $('copies').value = String(copies);
    if (typeof draft.formProductId === 'string') state.formProductId = draft.formProductId;
    if (typeof draft.batchEditingId === 'string') state.batchEditingId = draft.batchEditingId;
    if (LABEL_VARIATIONS.some(entry => entry.layout.version === draft.labelLayout)) $('label-layout').value = draft.labelLayout;
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 45000);
    const externalSignal = options.signal;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    const headers = { Accept: options.blob ? 'image/png, application/json' : 'application/json' };
    if (state.token && !options.public) headers.Authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (response.ok && options.blob && response.headers.get('content-type')?.includes('image/png')) return await response.blob();
      let data;
      try { data = await response.json(); } catch { throw new ApiError('The printing service returned an unreadable response.', response.status); }
      if (!response.ok) throw new ApiError(data.error || 'The printing service could not complete this request.', response.status, data);
      if (options.blob) throw new ApiError(data.error || 'The sticker preview could not be created.', response.status, data);
      return data;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  function requirePairing() {
    clearTimeout(state.batchTimer);
    state.paired = false;
    state.token = '';
    state.previewKey = '';
    writeStorage(TOKEN_KEY, null);
    cancelPreview();
    cancelCatalogRequest();
    cancelProductSelection();
    state.catalogStarted = false;
    state.catalogProducts = [];
    state.selectedProductId = '';
    $('catalog-products').replaceChildren();
    $('catalog-selection').hidden = true;
    showPanel('pair-panel');
    setConnection(true, 'Pairing needed');
  }

  function handleUnauthorized(error) {
    if (error.status === 401) {
      requirePairing();
      setError('pair-error', 'Connect this phone again using the code on your Windows PC.');
      return true;
    }
    return false;
  }

  function updateLabelSize() {
    const { label } = getLabelVariation(selectedLayout());
    state.layoutVersion = label.layoutVersion || '';
    const width = Number(label.widthInches);
    const height = Number(label.heightInches);
    if (width > 0 && height > 0) {
      setText('label-size', `2 stickers · ${width} × ${height} in row`);
      $('label-preview').style.aspectRatio = `${width} / ${height}`;
      setText('label-stock-note', `Load matching two-column stock: ${width} × ${height} in for the full row. This size applies to single prints and the entire batch.`);
    }
  }

  function renderSetup(setup) {
    $('setup-panel').hidden = false;
    // Keep pairing instructions available without expanding them on every refresh.
    setText('setup-code', String(setup.pairCode || ''));
    $('phone-urls').replaceChildren();
    for (const value of setup.phoneUrls || []) {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const link = document.createElement('a');
        link.href = url.href;
        link.textContent = url.href.replace(/\/$/, '');
        $('phone-urls').append(link);
      } catch { /* Ignore malformed service addresses. */ }
    }
    $('no-phone-url').hidden = $('phone-urls').childElementCount > 0;
    updateLabelSize(setup.label);
  }

  function renderStatus(data) {
    state.paired = true;
    state.printers = Array.isArray(data.printers) ? data.printers : [];
    if (!state.savingPrinter) state.selectedPrinter = data.selectedPrinter || '';
    updateLabelSize(data.label);
    const select = $('printer-select');
    select.replaceChildren(new Option('Choose a Windows printer', ''));
    state.printers.forEach((printer) => {
      if (typeof printer.name !== 'string') return;
      select.add(new Option(`${printer.name}${printer.isDefault ? ' (Windows default)' : ''}`, printer.name));
    });
    if (state.selectedPrinter && !state.printers.some((printer) => printer.name === state.selectedPrinter)) {
      select.add(new Option(`${state.selectedPrinter} (unavailable)`, state.selectedPrinter));
    }
    select.value = state.selectedPrinter;
    setError('printer-error', data.printerError || '');
    if (!state.printers.length) setText('printer-note', 'No Windows printers were found. Install the Citizen printer on this PC, then refresh.');
    else if (state.selectedPrinter) setText('printer-note', 'Keep the printer powered on and connected to the Windows PC by USB.');
    else setText('printer-note', 'Select the Citizen printer connected to your PC by USB.');
    if (Array.isArray(data.recentJobs)) renderJobs(data.recentJobs);
    setConnection(true);
    showPanel('workspace');
    if (!state.catalogStarted) loadCatalog(1);
    if (state.batchIntent && !batchTerminal() && !state.batchChecking && !state.batchRequesting) scheduleBatchCheck(0);
  }

  function cancelCatalogRequest() {
    clearTimeout(state.catalogTimer);
    state.catalogController?.abort();
    state.catalogController = null;
    state.catalogVersion += 1;
    state.catalogLoading = false;
  }

  function cancelProductSelection() {
    state.selectionController?.abort();
    state.selectionController = null;
    state.selectionVersion += 1;
    state.selectingProductId = '';
  }

  function clearCatalogSelection() {
    cancelProductSelection();
    state.selectedProductId = '';
    $('catalog-selection').hidden = true;
    updateCatalogControls();
  }

  function updateCatalogControls() {
    const busy = state.catalogLoading || !!state.selectingProductId;
    $('catalog-refresh').disabled = busy;
    $('catalog-retry').disabled = busy;
    $('catalog-previous').disabled = busy || state.catalogPage <= 1;
    $('catalog-next').disabled = busy || state.catalogPage >= state.catalogPages;
    $('catalog-products').setAttribute('aria-busy', String(state.catalogLoading));
    $('catalog-products').querySelectorAll('button[data-product-id]').forEach((button) => {
      const selected = button.dataset.productId === state.selectedProductId;
      const selecting = button.dataset.productId === state.selectingProductId;
      button.disabled = busy || state.printing || batchLocked() || !state.paired;
      button.textContent = selecting ? 'Loading...' : selected ? 'Selected' : 'Select for label';
      button.setAttribute('aria-pressed', String(selected));
      button.closest('li').classList.toggle('is-selected', selected);
    });
    $('catalog-products').querySelectorAll('button[data-batch-product-id]').forEach((button) => {
      const added = state.batchQueue.some((item) => item.productId === button.dataset.batchProductId);
      button.textContent = added ? 'Added to batch' : 'Add to batch';
      button.disabled = added || busy || !batchEditable() || !state.paired || state.batchQueue.length >= 50;
    });
  }

  function catalogPrice(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return raw ? `\u20b1 ${raw}` : 'Price unavailable';
    const [whole, decimal = ''] = raw.split('.');
    return `\u20b1 ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal.padEnd(2, '0')}`;
  }

  function missingProductDetails(product) {
    return [['productName', 'name'], ['price', 'price'], ['sku', 'SKU'], ['barcode', 'barcode']]
      .filter(([key]) => !String(product[key] ?? '').trim())
      .map(([, label]) => label);
  }

  function renderCatalogProducts() {
    const list = $('catalog-products');
    list.replaceChildren();
    state.catalogProducts.forEach((product) => {
      const item = document.createElement('li');
      item.className = 'catalog-product';
      const details = document.createElement('div');
      details.className = 'catalog-product-details';
      const name = document.createElement('h3');
      name.textContent = product.productName || 'Unnamed product';
      const identifiers = document.createElement('p');
      identifiers.textContent = `SKU: ${product.sku || '\u2014'} \u00b7 Barcode: ${product.barcode || '\u2014'}`;
      details.append(name, identifiers);
      const missing = missingProductDetails(product);
      if (missing.length) {
        const note = document.createElement('span');
        note.className = 'catalog-missing';
        note.textContent = `Needs ${missing.join(', ')}`;
        details.append(note);
      }
      const action = document.createElement('div');
      action.className = 'catalog-product-action';
      const price = document.createElement('span');
      price.className = 'catalog-price';
      price.textContent = catalogPrice(product.price);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button catalog-select';
      button.dataset.productId = String(product.id);
      button.setAttribute('aria-label', `Select ${product.productName || `product ${product.id}`}${product.sku ? `, SKU ${product.sku}` : ''} for label`);
      button.addEventListener('click', () => selectCatalogProduct(String(product.id)));
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'secondary-button catalog-add';
      add.dataset.batchProductId = String(product.id);
      add.setAttribute('aria-label', `Add ${product.productName || `product ${product.id}`} to batch`);
      add.addEventListener('click', () => addCatalogToBatch(String(product.id)));
      const buttons = document.createElement('div');
      buttons.className = 'catalog-product-buttons';
      buttons.append(button, add);
      action.append(price, buttons);
      item.append(details, action);
      list.append(item);
    });
    updateCatalogControls();
  }

  async function loadCatalog(page = 1) {
    if (!state.paired) return;
    cancelCatalogRequest();
    cancelProductSelection();
    const version = state.catalogVersion;
    const controller = new AbortController();
    state.catalogController = controller;
    state.catalogStarted = true;
    state.catalogLoading = true;
    state.catalogPage = page;
    $('catalog-problem').hidden = true;
    $('catalog-empty').hidden = true;
    setError('catalog-error', '');
    setText('catalog-summary', 'Loading products...');
    updatePrintControls();
    try {
      const params = new URLSearchParams({ q: state.catalogQuery, page: String(page), pageSize: matchMedia('(max-width: 640px)').matches ? '5' : '25' });
      const data = await api(`/api/products?${params}`, { signal: controller.signal });
      if (version !== state.catalogVersion || !state.paired) return;
      if (!Array.isArray(data.products)) throw new Error('Invalid catalog response');
      state.catalogProducts = data.products;
      state.catalogPage = data.page;
      state.catalogPages = data.totalPages;
      renderCatalogProducts();
      $('catalog-products').scrollTop = 0;
      const first = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
      const last = Math.min(data.total, first + data.products.length - 1);
      setText('catalog-summary', data.total ? `${first}\u2013${last} of ${data.total} products${state.catalogQuery ? ' found' : ''}` : '0 products');
      setText('catalog-page', `Page ${data.page} of ${Math.max(1, data.totalPages)}`);
      $('catalog-pagination').hidden = data.totalPages <= 1;
      $('catalog-empty').hidden = data.products.length > 0;
      setText('catalog-empty', state.catalogQuery ? 'No products found. Try a different name, SKU, or barcode.' : 'There are no products in the catalog yet.');
    } catch (error) {
      if (version !== state.catalogVersion || controller.signal.aborted) return;
      if (!handleUnauthorized(error)) {
        state.catalogProducts = [];
        renderCatalogProducts();
        setText('catalog-summary', 'Catalog unavailable');
        setError('catalog-error', error instanceof ApiError ? error.message : 'Could not load products. Check the connection and try again.');
        $('catalog-problem').hidden = false;
        $('catalog-pagination').hidden = true;
      }
    } finally {
      if (version === state.catalogVersion) {
        state.catalogLoading = false;
        state.catalogController = null;
        updateCatalogControls();
      }
    }
  }

  function searchCatalog(immediate = false) {
    if (!state.paired) return;
    cancelCatalogRequest();
    cancelProductSelection();
    state.catalogQuery = $('catalog-search').value.trim();
    state.catalogLoading = true;
    setText('catalog-summary', 'Searching products...');
    updatePrintControls();
    state.catalogTimer = setTimeout(() => loadCatalog(1), immediate ? 0 : 300);
  }

  async function selectCatalogProduct(id) {
    if (state.printing || batchLocked() || state.catalogLoading || state.selectingProductId || !state.paired) return;
    cancelProductSelection();
    const version = state.selectionVersion;
    const controller = new AbortController();
    state.selectionController = controller;
    state.selectingProductId = id;
    $('catalog-problem').hidden = true;
    setError('catalog-error', '');
    updatePrintControls();
    try {
      const { product } = await api(`/api/products/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (version !== state.selectionVersion || !state.paired || state.printing || batchLocked()) return;
      if (!product || String(product.id) !== id) throw new Error('Invalid product response');
      Object.entries(fieldInputs).forEach(([key, input]) => { input.value = String(product[key] ?? ''); });
      state.selectedProductId = id;
      state.formProductId = id;
      state.batchEditingId = '';
      state.catalogProducts = state.catalogProducts.map((row) => String(row.id) === id ? product : row);
      renderCatalogProducts();
      const missing = missingProductDetails(product);
      setText('catalog-selection-text', `Selected: ${product.productName || `product ${id}`}. ${missing.length ? `Add the missing ${missing.join(', ')} below before printing.` : 'Review the details and choose your copies.'}`);
      $('catalog-selection').hidden = false;
      if ($('print-message').dataset.type !== 'warning') showPrintMessage('');
      saveDraft();
      schedulePreview(true);
      revealMobileSection('label-editor');
      $('label-editor').focus({ preventScroll: true });
      $('label-editor').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (error) {
      if (version !== state.selectionVersion || controller.signal.aborted) return;
      if (!handleUnauthorized(error)) {
        setError('catalog-error', error instanceof ApiError ? error.message : 'Could not load this product. Try selecting it again.');
        $('catalog-problem').hidden = false;
      }
    } finally {
      if (version === state.selectionVersion) {
        state.selectingProductId = '';
        state.selectionController = null;
        updatePrintControls();
      }
    }
  }

  function batchTerminal() {
    return !!state.batchResult && ['submitted', 'failed', 'stopped', 'interrupted'].includes(state.batchResult.status);
  }

  function batchLocked() { return !!state.batchIntent && !batchTerminal(); }
  function batchEditable() { return !state.batchIntent && !state.printing; }
  function batchPairs() { return state.batchQueue.reduce((sum, item) => sum + (Number(item.copies) || 0), 0); }
  function batchCopiesValid() { return state.batchQueue.every((item) => Number.isInteger(Number(item.copies)) && Number(item.copies) >= 1 && Number(item.copies) <= MAX_COPIES); }

  function saveBatchQueue() { writeStorage(BATCH_KEY, JSON.stringify(state.batchQueue)); draftSync?.changed(); }
  function showBatchMessage(message, type = 'success') {
    setText('batch-message', message);
    $('batch-message').dataset.type = type;
    $('batch-message').hidden = !message;
    if (message && type === 'error') revealMobileSection('batch-panel');
  }

  function restoreBatch() {
    const queue = readJson(BATCH_KEY);
    if (Array.isArray(queue)) state.batchQueue = queue.slice(0, 50).filter((item) => item && typeof item.id === 'string' && item.fields && Object.keys(fieldInputs).every((key) => typeof item.fields[key] === 'string'));
    if (!state.batchQueue.some(item => item.id === state.batchEditingId)) state.batchEditingId = '';
    const intent = readJson(BATCH_INTENT_KEY);
    if (intent && typeof intent.requestId === 'string' && Array.isArray(intent.items) && intent.items.length) {
      state.batchIntent = intent;
      $('label-layout').value = getLabelVariation(intent.labelLayout).layout.version;
      updateLabelSize();
      state.batchResult = intent.result || null;
      // The saved submission is authoritative if the draft was changed in another tab.
      state.batchQueue = intent.items.map((item, index) => ({ id: `saved-${index}`, productId: '', fields: item.fields, copies: item.copies }));
    }
    renderBatch();
    if (batchTerminal()) renderBatchResult();
    else if (state.batchIntent) showBatchMessage('Checking the previous batch. The PC may still be printing; keep this request until its result is confirmed.', 'warning');
  }

  function updateBatchControls() {
    const editable = batchEditable();
    const missing = state.batchQueue.some((item) => !fieldsComplete(item.fields));
    const total = batchPairs();
    $('batch-clear').disabled = !editable || !state.batchQueue.length;
    $('batch-print').hidden = !!state.batchIntent;
    $('batch-print').disabled = !editable || !state.paired || !state.online || !printerAvailable() || state.savingPrinter || !!state.pendingIntent || !!state.selectingProductId || !!state.batchEditingId || !state.batchQueue.length || missing || !batchCopiesValid() || total > 500;
    $('batch-check').hidden = !batchLocked();
    $('batch-check').disabled = state.batchRequesting || state.batchChecking || !state.paired;
    $('batch-resend').hidden = !state.batchMissing || !batchLocked();
    $('batch-resend').disabled = state.batchRequesting || state.batchChecking || !state.paired || !state.online;
    $('batch-new').hidden = !batchTerminal();
    $('batch-new').disabled = state.printing;
    const canEditFailed = batchTerminal() && state.batchResult.items?.every((item) => ['pending', 'not_sent'].includes(item.status));
    $('batch-new').textContent = canEditFailed ? 'Edit batch and try again' : 'Start a new batch';
    $('batch-add-label').disabled = !editable || !state.paired || !!state.selectingProductId || !fieldsComplete() || !validCopies() || (!state.batchEditingId && state.batchQueue.length >= 50 && !state.batchQueue.some((item) => item.productId && item.productId === state.formProductId));
    setText('batch-add-label', state.batchEditingId ? 'Update batch item' : 'Add to batch');
    $('batch-cancel-edit').hidden = !state.batchEditingId;
    $('batch-cancel-edit').disabled = !editable;
    $('batch-items').querySelectorAll('button, input').forEach((input) => { input.disabled = !editable; });
    setText('batch-total', `${state.batchQueue.length} ${state.batchQueue.length === 1 ? 'product' : 'products'} · ${total} pairs · ${total * 2} stickers`);
    setText('batch-print', `Print batch · ${total} ${total === 1 ? 'pair' : 'pairs'}`);
    let help = 'Up to 50 products and 500 pairs per batch. Review the details before printing.';
    if (batchLocked()) help = 'The PC continues sending this batch if the phone disconnects. Sent means accepted by Windows; check the printer for the physical result.';
    else if (batchTerminal()) help = 'Review every item below before starting another batch. Uncertain items are never retried automatically.';
    else if (state.batchEditingId) help = 'Update the batch item below, or cancel the edit, before printing.';
    else if (state.pendingIntent) help = 'Resolve your previous single-label print request before starting a batch.';
    else if (missing) help = 'Some products need details. Tap Edit, complete the fields below, then Update batch item.';
    else if (!batchCopiesValid() || total > 500) help = 'Use 1–100 pairs per product, with a maximum of 500 pairs in this batch.';
    else if (state.batchQueue.length && !printerAvailable()) help = 'Choose an available printer below before printing the batch.';
    setText('batch-help', help);
  }

  function renderBatch() {
    const list = $('batch-items');
    list.replaceChildren();
    $('batch-empty').hidden = state.batchQueue.length > 0;
    state.batchQueue.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'batch-item';
      const details = document.createElement('div');
      details.className = 'batch-item-details';
      const title = document.createElement('h3');
      title.textContent = item.fields.productName || 'Unnamed product';
      const caption = document.createElement('p');
      caption.textContent = `${catalogPrice(item.fields.price)} · SKU: ${item.fields.sku || '—'} · Barcode: ${item.fields.barcode || '—'}`;
      details.append(title, caption);
      const missing = missingProductDetails(item.fields);
      if (missing.length) {
        const badge = document.createElement('span');
        badge.className = 'catalog-missing';
        badge.textContent = `Needs ${missing.join(', ')}`;
        details.append(badge);
      }
      const outcome = state.batchResult?.items?.[index];
      if (outcome) {
        const status = document.createElement('p');
        status.className = `batch-item-status status-${outcome.status}`;
        const labels = { pending: 'Waiting', submitting: 'Sending to Windows...', submitted: 'Sent to printer', unknown: 'Uncertain — check Windows print queue', not_sent: 'Not sent' };
        status.textContent = `${labels[outcome.status] || outcome.status}${outcome.error ? ` · ${outcome.error}` : ''}`;
        details.append(status);
      }
      const controls = document.createElement('div');
      controls.className = 'batch-item-controls';
      const label = document.createElement('label');
      label.textContent = 'Pairs';
      const copies = document.createElement('input');
      copies.type = 'number'; copies.min = '1'; copies.max = '100'; copies.step = '1'; copies.inputMode = 'numeric';
      copies.value = String(item.copies);
      copies.setAttribute('aria-label', `Pairs for ${item.fields.productName || `item ${index + 1}`}`);
      copies.addEventListener('input', () => {
        if (!batchEditable()) return;
        item.copies = copies.value;
        saveBatchQueue(); updatePrintControls();
      });
      label.append(copies);
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary-button'; edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${item.fields.productName || `item ${index + 1}`}`);
      edit.addEventListener('click', () => editBatchItem(item.id));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-button'; remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${item.fields.productName || `item ${index + 1}`}`);
      remove.addEventListener('click', () => {
        if (!batchEditable()) return;
        state.batchQueue = state.batchQueue.filter((queued) => queued.id !== item.id);
        if (state.batchEditingId === item.id) state.batchEditingId = '';
        saveBatchQueue(); renderBatch(); updatePrintControls();
      });
      controls.append(label, edit, remove);
      row.append(details, controls); list.append(row);
    });
    updateBatchControls(); updateCatalogControls();
  }

  async function addCatalogToBatch(id) {
    if (!batchEditable() || !state.paired || state.selectingProductId || state.batchQueue.length >= 50 || state.batchQueue.some((item) => item.productId === id)) return;
    cancelProductSelection();
    const version = state.selectionVersion;
    const controller = new AbortController();
    state.selectionController = controller; state.selectingProductId = id;
    updatePrintControls();
    try {
      const { product } = await api(`/api/products/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (version !== state.selectionVersion || !batchEditable() || !state.paired) return;
      if (!product || String(product.id) !== id) throw new Error('Invalid product response');
      state.batchQueue.push({ id: newRequestId(), productId: id, fields: Object.fromEntries(Object.keys(fieldInputs).map((key) => [key, String(product[key] ?? '')])), copies: 1 });
      saveBatchQueue(); renderBatch();
      showBatchMessage(`${product.productName || 'Product'} added. Choose its copies in Your batch.`);
    } catch (error) {
      if (version !== state.selectionVersion || controller.signal.aborted) return;
      if (!handleUnauthorized(error)) showBatchMessage(error instanceof ApiError ? error.message : 'Could not add this product. Try again.', 'error');
    } finally {
      if (version === state.selectionVersion) { state.selectingProductId = ''; state.selectionController = null; updatePrintControls(); }
    }
  }

  function editBatchItem(id) {
    if (!batchEditable()) return;
    const item = state.batchQueue.find((entry) => entry.id === id);
    if (!item) return;
    clearCatalogSelection();
    state.batchEditingId = id; state.formProductId = item.productId || '';
    Object.entries(fieldInputs).forEach(([key, input]) => { input.value = item.fields[key]; });
    $('copies').value = String(item.copies);
    setText('catalog-selection-text', 'Editing a batch item. Review the preview, then choose Update batch item.');
    $('catalog-selection').hidden = false;
    saveDraft(); schedulePreview(true);
    revealMobileSection('label-editor');
    $('label-editor').focus({ preventScroll: true });
    $('label-editor').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function addLabelToBatch() {
    if (!batchEditable() || $('batch-add-label').disabled) return;
    const existing = state.batchQueue.find((item) => item.id === state.batchEditingId || (!state.batchEditingId && state.formProductId && item.productId === state.formProductId));
    const entry = { id: existing?.id || newRequestId(), productId: existing?.productId || state.formProductId, fields: getFields(), copies: getCopies() };
    if (existing) state.batchQueue = state.batchQueue.map((item) => item.id === existing.id ? entry : item);
    else state.batchQueue.push(entry);
    state.batchEditingId = '';
    clearCatalogSelection(); saveBatchQueue(); renderBatch(); updatePrintControls();
    showBatchMessage(`${entry.fields.productName} ${existing ? 'updated in' : 'added to'} the batch.`);
    revealMobileSection('batch-panel');
    $('batch-panel').focus({ preventScroll: true });
    $('batch-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function renderBatchResult() {
    const batch = state.batchResult;
    if (!batch) return;
    const sent = (batch.items || []).filter((item) => item.status === 'submitted').length;
    const summaries = {
      validating: `Checking labels: ${batch.validatedItems || 0} of ${batch.items?.length || state.batchQueue.length} ready. Printing starts when all labels pass.`,
      printing: `Sending batch: ${sent} of ${batch.items?.length || state.batchQueue.length} products accepted by Windows.`,
      submitted: `Batch sent to printer: ${batch.totalPairs} pairs (${batch.totalPairs * 2} stickers). Check the printer for the physical result.`,
      failed: 'The batch could not be sent. Review the item results and correct the details before trying again.',
      stopped: 'The batch stopped. Check each item and the Windows print queue before sending anything again.',
      interrupted: 'The PC service restarted before the batch finished. Check each item and the Windows print queue before sending anything again.',
    };
    showBatchMessage(`${summaries[batch.status] || 'Checking batch status...'}${batch.error ? ` ${batch.error}` : ''}`, ['failed', 'stopped', 'interrupted'].includes(batch.status) ? 'warning' : 'success');
  }

  function acceptBatch(batch) {
    if (!batch || batch.id !== state.batchIntent?.requestId || !Array.isArray(batch.items)) throw new Error('Invalid batch response');
    state.batchResult = batch; state.batchMissing = false;
    state.batchIntent.result = batch;
    writeStorage(BATCH_INTENT_KEY, JSON.stringify(state.batchIntent));
    renderBatch(); renderBatchResult(); updatePrintControls();
    if (batchTerminal()) { clearTimeout(state.batchTimer); refreshStatus(); }
    else scheduleBatchCheck(1500);
  }

  function scheduleBatchCheck(delay = 3000) {
    clearTimeout(state.batchTimer);
    if (state.paired && state.batchIntent && !batchTerminal()) state.batchTimer = setTimeout(checkBatch, delay);
  }

  async function checkBatch() {
    if (!state.batchIntent || state.batchChecking || state.batchRequesting || !state.paired || batchTerminal()) return;
    state.batchChecking = true; updateBatchControls();
    try {
      const { batch } = await api(`/api/batches/${encodeURIComponent(state.batchIntent.requestId)}`, { timeout: 15000 });
      acceptBatch(batch);
    } catch (error) {
      if (error.status === 404) {
        state.batchMissing = true;
        showBatchMessage('The PC has no saved record of this batch. Use Send saved batch to submit the same request safely.', 'warning');
      } else if (!handleUnauthorized(error)) {
        showBatchMessage('Could not confirm the batch status. The PC may still be printing. Reconnect to check this same request; do not send a second batch.', 'warning');
        scheduleBatchCheck(5000);
      }
    } finally { state.batchChecking = false; updatePrintControls(); }
  }

  async function sendBatch() {
    if (state.batchRequesting || state.batchChecking || !state.batchIntent || !state.paired || batchTerminal()) return;
    state.batchRequesting = true; state.batchMissing = false;
    showBatchMessage('Sending your batch to the Windows PC...'); updatePrintControls();
    try {
      const { requestId, items, labelLayout = DEFAULT_LABEL_LAYOUT } = state.batchIntent;
      const { batch } = await api('/api/batches', { method: 'POST', body: { requestId, items, labelLayout }, timeout: 20000 });
      acceptBatch(batch);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 408, 409, 429].includes(error.status)) {
        acceptBatch({ id: state.batchIntent.requestId, status: 'failed', totalPairs: batchPairs(), error: error.message, items: state.batchIntent.items.map((item) => ({ ...item, status: 'not_sent' })) });
      } else if (!handleUnauthorized(error)) {
        showBatchMessage(error instanceof ApiError ? `${error.message} Checking whether the PC saved this batch...` : 'The connection ended before the batch was confirmed. Checking the saved request...', 'warning');
        scheduleBatchCheck(500);
      }
    } finally { state.batchRequesting = false; updatePrintControls(); }
  }

  function printBatch() {
    updatePrintControls();
    if ($('batch-print').disabled || state.batchIntent) return;
    const intent = { requestId: newRequestId(), labelLayout: selectedLayout(), items: state.batchQueue.map((item) => ({ fields: { ...item.fields }, copies: Number(item.copies) })) };
    if (!writeStorage(BATCH_INTENT_KEY, JSON.stringify(intent))) {
      showBatchMessage('Your browser could not save the batch request. Enable site storage before batch printing so it can recover safely after a reload.', 'error');
      return;
    }
    state.batchIntent = intent; state.batchResult = null;
    sendBatch();
  }

  function renderJobs(jobs) {
    const list = $('recent-jobs');
    list.replaceChildren();
    $('recent-empty').hidden = jobs.length > 0;
    jobs.slice(0, 8).forEach((job) => {
      const failed = job.status === 'failed';
      const uncertain = !['failed', 'submitted'].includes(job.status);
      const item = document.createElement('li');
      item.className = 'recent-job';
      const icon = document.createElement('span');
      icon.className = `job-icon${failed || uncertain ? ' failed' : ''}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = failed || uncertain ? '!' : '↗';
      const detail = document.createElement('div');
      detail.className = 'job-detail';
      const title = document.createElement('div');
      title.className = 'job-title';
      title.textContent = job.fields?.productName || 'Label';
      const caption = document.createElement('div');
      caption.className = 'job-caption';
      const units = job.labelsPerCopy === 2 ? (Number(job.copies) === 1 ? 'pair' : 'pairs') : (Number(job.copies) === 1 ? 'copy' : 'copies');
      const variant = LABEL_VARIATIONS.find(entry => entry.layout.version === job.layoutVersion);
      caption.textContent = `${job.fields?.sku || ''} · ${job.copies || 1} ${units}${variant ? ` · ${variant.label.title}` : ''}${(failed || uncertain) && job.error ? ` · ${job.error}` : ''}`;
      detail.append(title, caption);
      const status = document.createElement('div');
      status.className = `job-status${failed || uncertain ? ' failed' : ''}`;
      status.textContent = failed ? 'Not sent' : job.status === 'submitted' ? 'Sent to printer' : 'Check print queue';
      const date = new Date(job.createdAt);
      if (!Number.isNaN(date.getTime())) {
        const time = document.createElement('time');
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString();
        time.textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        status.append(time);
      }
      item.append(icon, detail, status);
      list.append(item);
    });
  }

  async function refreshStatus() {
    if (!state.token || state.refreshing || state.savingPrinter) return;
    state.refreshing = true;
    $('refresh-button').disabled = true;
    try {
      const data = await api('/api/status');
      if (!Array.isArray(data.printers)) { requirePairing(); return; }
      renderStatus(data);
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setConnection(false);
        setError('printer-error', error instanceof ApiError ? error.message : 'Cannot reach the Windows PC. Check the Wi-Fi connection and printing service.');
      }
    } finally {
      state.refreshing = false;
      $('refresh-button').disabled = false;
      updatePrintControls();
    }
  }

  function cancelPreview() {
    clearTimeout(state.previewTimer);
    state.previewController?.abort();
    state.previewController = null;
    state.previewVersion += 1;
    state.previewLoading = false;
    $('label-preview').dataset.loading = 'false';
  }

  function clearPreview() {
    state.previewKey = '';
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = '';
    $('preview-image').removeAttribute('src');
    $('preview-image').hidden = true;
    $('preview-full-size').hidden = true;
    $('preview-full-size').removeAttribute('href');
    $('preview-placeholder').hidden = false;
  }

  function schedulePreview(immediate = false) {
    cancelPreview();
    state.previewKey = '';
    setError('preview-error', '');
    const fields = getFields();
    if (!state.paired || !fieldsComplete(fields)) {
      clearPreview();
      setText('preview-status', 'Waiting for details');
      updatePrintControls();
      return;
    }
    state.previewLoading = true;
    $('label-preview').dataset.loading = 'true';
    setText('preview-status', 'Preparing preview…');
    updatePrintControls();
    const version = state.previewVersion;
    const labelLayout = selectedLayout();
    state.previewTimer = setTimeout(() => loadPreview(fields, version, labelLayout), immediate ? 0 : 450);
  }

  async function loadPreview(fields, version, labelLayout) {
    const controller = new AbortController();
    let pendingUrl = '';
    state.previewController = controller;
    try {
      const blob = await api('/api/preview', { method: 'POST', body: { fields, labelLayout }, blob: true, signal: controller.signal });
      if (version !== state.previewVersion || fieldsKey(fields, labelLayout) !== fieldsKey()) return;
      const url = URL.createObjectURL(blob);
      pendingUrl = url;
      // Decode before enabling Print so an unreadable preview cannot look ready.
      const probe = new Image();
      await new Promise((resolve, reject) => { probe.onload = resolve; probe.onerror = reject; probe.src = url; });
      if (version !== state.previewVersion || fieldsKey(fields, labelLayout) !== fieldsKey()) return;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = url;
      pendingUrl = '';
      $('preview-image').src = url;
      $('preview-image').hidden = false;
      $('preview-full-size').href = url;
      $('preview-full-size').hidden = false;
      $('preview-placeholder').hidden = true;
      state.previewKey = fieldsKey(fields, labelLayout);
      setText('preview-status', 'Ready to print');
      setConnection(true);
    } catch (error) {
      if (version !== state.previewVersion || controller.signal.aborted) return;
      if (!handleUnauthorized(error)) {
        clearPreview();
        setText('preview-status', 'Preview needs attention');
        setError('preview-error', error instanceof ApiError ? error.message : 'Could not prepare the preview. Check your connection and edit a field to try again.');
      }
    } finally {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      if (version === state.previewVersion) {
        state.previewLoading = false;
        state.previewController = null;
        $('label-preview').dataset.loading = 'false';
        updatePrintControls();
      }
    }
  }

  function printerAvailable() {
    return state.printers.some((printer) => printer.name === state.selectedPrinter);
  }

  function updatePrintControls() {
    const copies = getCopies();
    const locked = state.printing || batchLocked();
    const ready = state.paired && state.online && printerAvailable() && !state.savingPrinter &&
      !locked && !state.batchEditingId && !state.selectingProductId && validCopies() && state.previewKey === fieldsKey() && !state.previewLoading;
    $('print-button').disabled = !ready;
    $('printer-select').disabled = locked || state.savingPrinter;
    $('clear-button').disabled = locked;
    $('decrease-copies').disabled = locked || copies <= 1;
    $('increase-copies').disabled = locked || copies >= MAX_COPIES;
    $('copies').disabled = locked;
    $('label-layout').disabled = locked || Boolean(state.pendingIntent) || Boolean(state.batchIntent);
    $('new-request-control').hidden = !state.pendingIntent?.requestId || $('print-message').hidden || $('print-message').dataset.type !== 'warning';
    $('new-request-button').disabled = locked;
    Object.values(fieldInputs).forEach((input) => { input.disabled = locked; });
    setText('print-button-text', state.printing ? 'Sending to printer…' : `Print ${validCopies() && copies > 1 ? `${copies} pairs` : '1 pair'}`);
    let help = 'Complete all four details to prepare a label.';
    if (state.printing) help = 'Please wait while the label is sent to Windows.';
    else if (batchLocked()) help = 'Wait for the active batch result before sending a single label.';
    else if (state.batchEditingId) help = 'Choose Update batch item to save these details to your batch.';
    else if (!state.online) help = 'Reconnect to the print station to send labels.';
    else if (!printerAvailable()) help = 'Choose an available printer to continue.';
    else if (!validCopies()) help = `Enter a whole number from 1 to ${MAX_COPIES} copies.`;
    else if (state.selectingProductId) help = 'Loading the selected product details...';
    else if (state.previewLoading) help = 'Preparing your sticker preview…';
    else if (fieldsComplete() && !state.previewKey) help = 'Your preview needs to be ready before you can print.';
    else if (ready) help = `${copies} ${copies === 1 ? 'pair' : 'pairs'} = ${copies * 2} stickers. Each pair includes the logo and product label.`;
    setText('print-help', help);
    updateCatalogControls();
    updateBatchControls();
  }

  function showPrintMessage(text, type = 'success') {
    setText('print-message', text);
    $('print-message').dataset.type = type;
    $('print-message').hidden = !text;
    updatePrintControls();
  }

  function newRequestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function clearIntent() {
    state.pendingIntent = null;
    writeStorage(INTENT_KEY, null);
  }

  async function printLabel(event) {
    event.preventDefault();
    updatePrintControls();
    if ($('print-button').disabled) return;
    const fields = getFields();
    const copies = getCopies();
    const labelLayout = selectedLayout();
    const signature = JSON.stringify({ fields, copies, printer: state.selectedPrinter, layout: state.layoutVersion });
    if (state.pendingIntent?.signature !== signature || typeof state.pendingIntent?.requestId !== 'string') {
      state.pendingIntent = { signature, requestId: newRequestId() };
    }
    writeStorage(INTENT_KEY, JSON.stringify(state.pendingIntent));
    state.printing = true;
    showPrintMessage('');
    updatePrintControls();
    try {
      const response = await api('/api/print', { method: 'POST', body: { fields, copies, labelLayout, requestId: state.pendingIntent.requestId }, timeout: 90000 });
      if (response.job?.status === 'submitted') {
        clearIntent();
        showPrintMessage(`Sent to printer · ${copies} ${copies === 1 ? 'pair' : 'pairs'} (${copies * 2} stickers). Each pair has the logo on the left and product details on the right.`);
      } else if (response.job?.status === 'failed') {
        clearIntent();
        showPrintMessage(response.job.error || 'Windows could not accept this print job. Check your printer and try again.', 'error');
      } else {
        showPrintMessage(response.job?.error || 'The print result is still uncertain. Check the Windows print queue and printer before trying again.', 'warning');
      }
      await refreshStatus();
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409) {
        clearIntent();
        showPrintMessage(error.message, 'error');
        handleUnauthorized(error);
      } else {
        showPrintMessage(error instanceof ApiError && error.status === 409 ? error.message : 'The connection ended before the print result was confirmed. Check the Windows print queue and printer before trying again. Retrying these same details will reuse the original request.', 'warning');
        // Keep the request ID, including across reloads, to avoid duplicate jobs.
      }
    } finally {
      state.printing = false;
      updatePrintControls();
    }
  }

  async function changePrinter() {
    if (state.savingPrinter || state.printing || batchLocked()) return;
    const name = $('printer-select').value;
    if (!name) {
      $('printer-select').value = state.selectedPrinter;
      return;
    }
    const previous = state.selectedPrinter;
    state.savingPrinter = true;
    state.selectedPrinter = name;
    setError('printer-error', '');
    showPrintMessage('');
    updatePrintControls();
    try {
      await api('/api/printer', { method: 'POST', body: { printerName: name } });
      setText('printer-note', 'Keep the printer powered on and connected to the Windows PC by USB.');
    } catch (error) {
      state.selectedPrinter = previous;
      $('printer-select').value = previous;
      if (!handleUnauthorized(error)) setError('printer-error', error instanceof ApiError ? error.message : 'Could not save the printer. Check the connection and try again.');
    } finally {
      state.savingPrinter = false;
      updatePrintControls();
    }
  }

  async function pairPhone(event) {
    event.preventDefault();
    const code = $('pair-code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { setError('pair-error', 'Enter the six-digit code shown on your Windows PC.'); return; }
    $('pair-button').disabled = true;
    setError('pair-error', '');
    try {
      const data = await api('/api/pair', { method: 'POST', body: { code }, public: true });
      if (typeof data.token !== 'string' || !data.token) throw new Error('Missing token');
      state.token = data.token;
      writeStorage(TOKEN_KEY, state.token);
      await refreshStatus();
      if (state.paired) {
        $('pair-code').value = '';
        schedulePreview(true);
      } else if (!$('pair-panel').hidden) {
        setError('pair-error', 'The phone connected, but the station could not be loaded. Try again.');
      }
    } catch (error) {
      setError('pair-error', error instanceof ApiError ? error.message : 'Cannot reach the Windows PC. Check that both devices are on the same Wi-Fi.');
    } finally {
      $('pair-button').disabled = false;
    }
  }

  async function boot() {
    if (state.booting) return;
    state.booting = true;
    showPanel('loading-panel');
    try {
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
      if (loopback) {
        const setup = await api('/api/setup', { public: true });
        if (typeof setup.token === 'string') {
          state.token = setup.token;
          writeStorage(TOKEN_KEY, setup.token);
        }
        renderSetup(setup);
      }
      const data = await api('/api/status');
      if (!state.token || !Array.isArray(data.printers)) {
        requirePairing();
      } else {
        renderStatus(data);
        schedulePreview(true);
        if (state.pendingIntent?.requestId) showPrintMessage('A previous print request has no confirmed result. Check your printer and the Windows print queue before sending the same label again.', 'warning');
      }
    } catch (error) {
      if (!handleUnauthorized(error)) {
        showPanel('fatal-panel');
        setConnection(false);
        setText('fatal-message', error instanceof ApiError ? error.message : 'Cannot reach the Windows PC. Check that the printing service is running and your phone is on the same Wi-Fi.');
      }
    } finally {
      state.booting = false;
    }
  }

  Object.values(fieldInputs).forEach((input) => input.addEventListener('input', () => {
    clearCatalogSelection();
    saveDraft();
    if ($('print-message').dataset.type !== 'warning') showPrintMessage('');
    schedulePreview();
  }));
  $('copies').addEventListener('input', () => { saveDraft(); updatePrintControls(); });
  $('label-layout').addEventListener('change', () => {
    updateLabelSize(); clearPreview(); saveDraft(); schedulePreview(true);
  });
  $('decrease-copies').addEventListener('click', () => {
    $('copies').value = String(Math.max(1, (Number.isFinite(getCopies()) ? getCopies() : 1) - 1));
    saveDraft(); updatePrintControls();
  });
  $('increase-copies').addEventListener('click', () => {
    $('copies').value = String(Math.min(MAX_COPIES, Math.max(0, Number.isFinite(getCopies()) ? getCopies() : 0) + 1));
    saveDraft(); updatePrintControls();
  });
  $('clear-button').addEventListener('click', () => {
    if (state.printing || batchLocked()) return;
    clearCatalogSelection();
    state.formProductId = ''; state.batchEditingId = '';
    Object.values(fieldInputs).forEach((input) => { input.value = ''; });
    $('copies').value = '1';
    showPrintMessage('');
    saveDraft();
    schedulePreview();
    $('product-name').focus();
  });
  $('pair-form').addEventListener('submit', pairPhone);
  $('catalog-search').addEventListener('input', () => searchCatalog());
  $('catalog-search-form').addEventListener('submit', (event) => { event.preventDefault(); searchCatalog(true); });
  $('catalog-refresh').addEventListener('click', () => loadCatalog(state.catalogPage));
  $('catalog-retry').addEventListener('click', () => loadCatalog(state.catalogPage));
  $('catalog-previous').addEventListener('click', () => loadCatalog(Math.max(1, state.catalogPage - 1)));
  $('catalog-next').addEventListener('click', () => loadCatalog(Math.min(state.catalogPages, state.catalogPage + 1)));
  $('batch-add-label').addEventListener('click', addLabelToBatch);
  $('batch-cancel-edit').addEventListener('click', () => {
    if (!batchEditable()) return;
    state.batchEditingId = ''; clearCatalogSelection(); updatePrintControls();
    saveDraft();
  });
  $('batch-clear').addEventListener('click', () => {
    if (!batchEditable()) return;
    state.batchQueue = []; state.batchEditingId = '';
    saveBatchQueue(); renderBatch(); showBatchMessage(''); updatePrintControls();
  });
  $('batch-print').addEventListener('click', printBatch);
  $('batch-check').addEventListener('click', checkBatch);
  $('batch-resend').addEventListener('click', () => { if (state.batchMissing) sendBatch(); });
  $('batch-new').addEventListener('click', () => {
    if (!batchTerminal() || state.printing) return;
    const noneSent = state.batchResult.items?.every((item) => ['pending', 'not_sent'].includes(item.status));
    state.batchIntent = null; state.batchResult = null; state.batchMissing = false; state.batchEditingId = '';
    clearTimeout(state.batchTimer);
    writeStorage(BATCH_INTENT_KEY, null);
    if (!noneSent) state.batchQueue = [];
    saveBatchQueue(); renderBatch(); showBatchMessage(noneSent ? 'Correct the batch details below, then print when ready.' : 'Add products for your next batch.'); updatePrintControls();
  });
  $('new-request-button').addEventListener('click', () => {
    if (state.printing || batchLocked()) return;
    clearIntent();
    showPrintMessage('Ready for a new print request. Check the preview, then print.');
  });
  $('label-form').addEventListener('submit', printLabel);
  $('printer-select').addEventListener('change', changePrinter);
  $('refresh-button').addEventListener('click', async () => {
    await refreshStatus();
    if (state.paired && fieldsComplete() && !state.previewKey) schedulePreview(true);
  });
  $('reload-button').addEventListener('click', boot);
  window.addEventListener('focus', () => { if (state.paired && !state.booting) refreshStatus(); });
  window.addEventListener('online', () => { if (state.paired) refreshStatus(); });
  window.addEventListener('offline', () => setConnection(false));
  restoreDraft();
  restoreBatch();
  updateLabelSize();
  draftSync = initializeDraftSync({
    kind: 'stickers',
    getToken: () => state.paired ? state.token : '',
    getDraft: () => ({
      ...Object.fromEntries(Object.entries(fieldInputs).map(([key, input]) => [key, input.value])),
      copies: $('copies').value, formProductId: state.formProductId,
      labelLayout: selectedLayout(),
      batch: { queue: state.batchQueue.map(item => ({ ...item, productId: item.productId || '', copies: String(item.copies) })), editingId: state.batchEditingId },
    }),
    applyDraft: draft => {
      const layoutChanged = selectedLayout() !== draft.labelLayout;
      if (layoutChanged) { $('label-layout').value = getLabelVariation(draft.labelLayout).layout.version; updateLabelSize(); clearPreview(); }
      const fieldsChanged = Object.entries(fieldInputs).some(([key, input]) => input.value !== draft[key]);
      const batchChanged = !draftValuesEqual(state.batchQueue.map(item => ({ ...item, productId: item.productId || '', copies: String(item.copies) })), draft.batch.queue);
      if (fieldsChanged) clearCatalogSelection();
      for (const [key, input] of Object.entries(fieldInputs)) if (input.value !== draft[key]) input.value = draft[key];
      if ($('copies').value !== draft.copies) $('copies').value = draft.copies;
      state.formProductId = draft.formProductId;
      state.batchEditingId = draft.batch.editingId;
      if (batchChanged) { state.batchQueue = draft.batch.queue; renderBatch(); }
      saveDraft(); saveBatchQueue();
      if (fieldsChanged || layoutChanged) schedulePreview(); else updatePrintControls();
    },
    canSync: () => !state.printing && !state.pendingIntent && !state.batchIntent && !state.selectingProductId,
  });
  boot();
})();
