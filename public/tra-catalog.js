import { formatTraMoney } from '/tra-model.js';
import { initializeTraScanner } from '/tra-scanner.js';

const TOKEN_KEY = 'labeldesk.token';
const PAGE_SIZE = matchMedia('(max-width: 640px)').matches ? 5 : 10;
const $ = (id) => document.getElementById(id);

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function initializeTraCatalog({ beforeSelect, onSelect, onBusy }) {
  const state = {
    token: readToken(), query: '', page: 1, pages: 0, loading: false, connecting: false,
    selecting: null, full: false, products: [], timer: null,
    searchVersion: 0, selectionVersion: 0, searchController: null, selectionController: null,
    lookup: false, exactBarcode: '',
  };
  let scanner = null;

  function rememberToken(token) {
    state.token = token;
    window.dispatchEvent(new CustomEvent('labeldesk-paired', { detail: { token } }));
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* Pairing remains usable when browser storage is unavailable. */ }
  }

  async function request(path, { body, signal, publicRequest = false, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    const headers = { Accept: 'application/json' };
    if (!publicRequest && state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('The catalog returned an unreadable response. Try again.'); }
      if (!response.ok) {
        const error = new Error(data.error || 'The catalog could not complete this request.');
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function showError(message = '') {
    $('tra-catalog-error').textContent = message;
    $('tra-catalog-problem').hidden = !message;
  }

  function errorMessage(error) {
    if (error.name === 'AbortError') return 'The catalog took too long to respond. Try again, or enter the item manually.';
    if (error instanceof TypeError) return 'Cannot reach the Windows PC. Check the connection or enter the item manually.';
    return error.message;
  }

  function controls() {
    $('tra-catalog').setAttribute('aria-busy', String(state.loading || state.connecting));
    $('tra-catalog-previous').disabled = state.loading || state.connecting || state.page <= 1;
    $('tra-catalog-next').disabled = state.loading || state.connecting || state.page >= state.pages;
    $('tra-catalog-connect').disabled = state.connecting;
    $('tra-catalog-retry').disabled = state.loading || state.connecting;
    scanner?.setDisabled(state.loading || state.connecting || state.selecting !== null || state.full || !state.token);
    for (const button of $('tra-catalog-products').querySelectorAll('button[data-product-id]')) {
      button.disabled = state.loading || state.selecting !== null || state.full || !state.token;
      button.textContent = state.selecting === button.dataset.productId ? 'Loading…' : 'Choose item';
    }
  }

  function cancelSelection() {
    scanner?.stop();
    if (state.lookup) {
      state.searchVersion += 1;
      state.searchController?.abort();
      state.searchController = null;
      state.lookup = false;
      state.loading = false;
    }
    state.selectionVersion += 1;
    state.selectionController?.abort();
    state.selectionController = null;
    state.selecting = null;
    onBusy(false);
    controls();
  }

  function requirePairing() {
    state.searchVersion += 1;
    state.searchController?.abort();
    state.searchController = null;
    state.loading = false;
    clearTimeout(state.timer);
    rememberToken('');
    state.products = [];
    $('tra-catalog-products').replaceChildren();
    $('tra-catalog-pagination').hidden = true;
    $('tra-catalog-pair').hidden = false;
    $('tra-catalog-status').textContent = 'Connect to browse products. You can also enter an item manually.';
    cancelSelection();
  }

  function renderProducts() {
    const list = $('tra-catalog-products');
    list.replaceChildren();
    for (const product of state.products) {
      const row = document.createElement('li');
      row.className = 'catalog-product';
      const name = document.createElement('strong');
      name.textContent = product.productName || 'Unnamed product';
      const meta = document.createElement('p');
      meta.className = 'item-meta';
      meta.textContent = `SKU ${product.sku || '—'} · Barcode ${product.barcode || '—'}`;
      const footer = document.createElement('div');
      footer.className = 'catalog-product-footer';
      const price = document.createElement('span');
      price.className = 'item-amount';
      try { price.textContent = formatTraMoney(String(product.price ?? ''), { currency: true }); }
      catch { price.textContent = 'Price missing'; }
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'secondary-button';
      choose.dataset.productId = String(product.id);
      choose.setAttribute('aria-label', `Choose ${product.productName || `product ${product.id}`}`);
      footer.append(price, choose);
      row.append(name, meta);
      const missing = [!product.productName && 'name', !product.barcode && 'barcode',
        (product.price === null || product.price === undefined || product.price === '') && 'price'].filter(Boolean);
      if (missing.length) {
        const warning = document.createElement('p');
        warning.className = 'catalog-missing';
        warning.textContent = `Complete ${missing.join(', ')} after choosing.`;
        row.append(warning);
      }
      row.append(footer);
      list.append(row);
    }
    controls();
  }

  async function load(page = 1) {
    clearTimeout(state.timer);
    cancelSelection();
    state.exactBarcode = '';
    const version = ++state.searchVersion;
    state.searchController?.abort();
    if (!state.token) {
      requirePairing();
      return;
    }
    const controller = new AbortController();
    state.searchController = controller;
    state.loading = true;
    showError();
    $('tra-catalog-status').textContent = 'Loading products…';
    controls();
    try {
      const query = new URLSearchParams({ q: state.query, page: String(page), pageSize: String(PAGE_SIZE) });
      const data = await request(`/api/products?${query}`, { signal: controller.signal });
      if (version !== state.searchVersion) return;
      state.products = data.products;
      state.page = data.page;
      state.pages = data.totalPages;
      $('tra-catalog-pair').hidden = true;
      const first = (data.page - 1) * data.pageSize + 1;
      const last = first + data.products.length - 1;
      $('tra-catalog-status').textContent = data.total
        ? `${first}–${last} of ${data.total} products${state.query ? ` matching “${state.query}”` : ''}.`
        : 'No products found. Try another search or enter the item manually.';
      $('tra-catalog-pagination').hidden = data.totalPages <= 1;
      $('tra-catalog-page').textContent = `${data.page} / ${data.totalPages}`;
      renderProducts();
    } catch (error) {
      if (version !== state.searchVersion) return;
      state.products = [];
      $('tra-catalog-products').replaceChildren();
      $('tra-catalog-pagination').hidden = true;
      if (error.status === 401) requirePairing();
      else {
        $('tra-catalog-status').textContent = 'Catalog unavailable. Manual entry and your receipt remain available.';
        showError(errorMessage(error));
      }
    } finally {
      if (version === state.searchVersion) {
        state.loading = false;
        state.searchController = null;
        controls();
      }
    }
  }

  async function selectProduct(id, expectedBarcode = state.exactBarcode) {
    if (state.loading || state.selecting !== null || state.full || !state.token || !beforeSelect()) return false;
    const version = ++state.selectionVersion;
    const controller = new AbortController();
    state.selectionController = controller;
    state.selecting = id;
    onBusy(true);
    showError();
    controls();
    try {
      const { product } = await request(`/api/products/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (version !== state.selectionVersion) return false;
      if (!product || String(product.id) !== id) throw new Error('The selected product could not be verified. Choose it again.');
      if (expectedBarcode && String(product.barcode) !== expectedBarcode) throw new Error('This product barcode has changed. Scan again or search for the item by name.');
      onSelect(product);
      return true;
    } catch (error) {
      if (version !== state.selectionVersion) return false;
      if (error.status === 401) requirePairing();
      showError(errorMessage(error));
      return false;
    } finally {
      if (version === state.selectionVersion) {
        state.selecting = null;
        state.selectionController = null;
        onBusy(false);
        controls();
      }
    }
  }

  async function scanBarcode(value) {
    if (state.full || !state.token) return false;
    const barcode = String(value ?? '');
    if (!barcode || barcode.length > 100 || barcode !== barcode.trim() || /[\x00-\x1F\x7F]/.test(barcode)) {
      showError('This barcode is not a valid catalog code. Try another photo or search by product name.');
      return false;
    }
    clearTimeout(state.timer);
    cancelSelection();
    const version = ++state.searchVersion;
    state.searchController?.abort();
    const controller = new AbortController();
    state.searchController = controller;
    state.lookup = true;
    state.loading = true;
    state.exactBarcode = barcode;
    state.query = barcode;
    $('tra-catalog-search').value = barcode;
    state.products = [];
    $('tra-catalog-products').replaceChildren();
    $('tra-catalog-pagination').hidden = true;
    $('tra-catalog-status').textContent = `Finding barcode ${barcode}...`;
    showError();
    onBusy(true);
    controls();
    let selectedId = null;
    try {
      const data = await request(`/api/products/barcode?${new URLSearchParams({ value: barcode })}`, { signal: controller.signal });
      if (version !== state.searchVersion) return false;
      if (!Array.isArray(data.products) || !Number.isInteger(data.total) || data.total < data.products.length || data.products.some(product => String(product.barcode) !== barcode)) {
        throw new Error('The barcode match could not be verified. Try scanning again.');
      }
      state.products = data.products;
      state.page = 1;
      state.pages = 1;
      if (data.total === 1 && data.products.length === 1) {
        selectedId = String(data.products[0].id);
        $('tra-catalog-status').textContent = `Barcode ${barcode} found. Choose the item below to load its details.`;
      } else if (data.total > 1) {
        $('tra-catalog-status').textContent = `${data.total} products share barcode ${barcode}. Choose the correct item below.${data.total > data.products.length ? ` Showing the first ${data.products.length}; search by name or SKU for other matches.` : ''}`;
      } else {
        $('tra-catalog-status').textContent = `No product has barcode ${barcode}. Scan again, search by name, or enter the item manually.`;
      }
      renderProducts();
    } catch (error) {
      if (version !== state.searchVersion) return false;
      if (error.status === 401) requirePairing();
      else $('tra-catalog-status').textContent = 'The barcode lookup could not finish. Your receipt and item details are saved.';
      showError(errorMessage(error));
    } finally {
      if (version === state.searchVersion) {
        state.lookup = false;
        state.loading = false;
        state.searchController = null;
        onBusy(false);
        controls();
      }
    }
    if (version !== state.searchVersion) return false;
    if (selectedId) {
      const selected = await selectProduct(selectedId, barcode);
      if (selected && version === state.searchVersion) $('tra-catalog-status').textContent = `Barcode ${barcode} found. Enter the quantity and tap Add item.`;
    }
    return state.products.length > 0;
  }

  async function connect() {
    if (state.connecting) return;
    if (state.token) { await load(1); return; }
    state.connecting = true;
    showError();
    $('tra-catalog-status').textContent = 'Connecting to the catalog…';
    controls();
    try {
      // The public status response does not enumerate printers when unauthenticated.
      const status = await request('/api/status', { publicRequest: true });
      if (status.localSetup) {
        const setup = await request('/api/setup?includePrinters=false', { publicRequest: true });
        rememberToken(setup.token);
        await load(1);
      } else requirePairing();
    } catch (error) {
      $('tra-catalog-status').textContent = 'Catalog unavailable. You can enter an item manually.';
      showError(errorMessage(error));
    } finally {
      state.connecting = false;
      controls();
    }
  }

  $('tra-catalog-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = $('tra-catalog-search').value.trim();
    load(1);
  });
  $('tra-catalog-search').addEventListener('input', () => {
    clearTimeout(state.timer);
    cancelSelection();
    state.searchVersion += 1;
    state.searchController?.abort();
    state.query = $('tra-catalog-search').value.trim();
    // Disable the old results during the debounce so they cannot be mistaken for the new search.
    state.loading = Boolean(state.token);
    controls();
    state.timer = setTimeout(() => load(1), 300);
  });
  $('tra-catalog-products').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-product-id]');
    if (button && !button.disabled) selectProduct(button.dataset.productId);
  });
  $('tra-catalog-previous').addEventListener('click', () => load(state.page - 1));
  $('tra-catalog-next').addEventListener('click', () => load(state.page + 1));
  $('tra-catalog-retry').addEventListener('click', () => connect());
  $('tra-catalog-pair').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.connecting) return;
    state.connecting = true;
    showError();
    controls();
    try {
      const data = await request('/api/pair', { publicRequest: true, body: { code: $('tra-catalog-code').value.trim() } });
      rememberToken(data.token);
      $('tra-catalog-code').value = '';
      await load(1);
    } catch (error) { showError(errorMessage(error)); }
    finally { state.connecting = false; controls(); }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_KEY) return;
    cancelSelection();
    state.token = readToken();
    load(1);
  });
  scanner = initializeTraScanner({ onScan: scanBarcode });
  connect();
  return {
    cancelSelection,
    setFull(full) { state.full = full; controls(); },
    focusSearch() { $(state.exactBarcode ? 'tra-scanner-photo' : 'tra-catalog-search').focus({ preventScroll: true }); },
  };
}
