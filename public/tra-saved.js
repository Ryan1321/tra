import { formatTraMoney } from '/tra-model.js';
import { RECEIPT_STATUSES } from '/tra-status-model.js';
import { revealMobileSection } from '/mobile-workspace.js';

const $ = id => document.getElementById(id);
export function initializeSavedReceipts({ getReceipt, getDraft, applyReceipt, canOpen, ensureNumber = async () => {} }) {
  let busy = false, page = 1, pages = 0, query = '', filter = '', searchSequence = 0, searching = 0, listSnapshot = '', poll = null;
  const message = (id, text, error = false) => { $(id).textContent = text; $(id).dataset.error = String(error); };
  function controls() {
    $('receipt-save').disabled = busy;
    $('receipt-save').textContent = busy ? 'Please wait…' : 'Save receipt to database';
    for (const button of $('saved-receipts-list').querySelectorAll('button')) button.disabled = busy;
    for (const row of $('saved-receipts-list').children) {
      const select = row.querySelector('select');
      select.disabled = busy;
      row.querySelector('[data-action="status"]').disabled = busy || select.value === row.dataset.status;
    }
  }
  async function api(path, body) {
    const token = localStorage.getItem('labeldesk.token') || '';
    const response = await fetch('/api/receipts/saved' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Pair this device using the catalog pairing form below, then try again.' : data.conflict ? 'The status changed on another device. The latest status is shown; choose again if you still want to change it.' : data.error || 'Cannot reach saved receipts.'), { status: response.status, saved: data.saved });
    return data;
  }
  function statusEditsPending() {
    return [...$('saved-receipts-list').children].some(row => row.querySelector('select').value !== row.dataset.status);
  }
  function pauseRefresh() {
    return busy || statusEditsPending() || $('saved-receipts-list').contains(document.activeElement);
  }
  function applyStatus(saved) {
    listSnapshot = '';
    for (const row of $('saved-receipts-list').children) {
      if (row.dataset.statusGroup !== saved.statusGroup) continue;
      row.dataset.status = saved.status; row.dataset.statusRevision = String(saved.statusRevision);
      const badge = row.querySelector('.receipt-status-badge');
      badge.dataset.status = saved.status; badge.textContent = RECEIPT_STATUSES[saved.status];
      row.querySelector('select').value = saved.status;
      row.querySelector('.receipt-status-updated').textContent = saved.statusUpdatedAt ? `Status updated ${new Date(saved.statusUpdatedAt).toLocaleString()}` : '';
    }
    controls();
  }
  async function updateStatus(row, receipt) {
    if (busy) return;
    const select = row.querySelector('select');
    if (select.value === row.dataset.status) return;
    const body = { status: select.value, revision: Number(row.dataset.statusRevision) };
    busy = true; searchSequence++; controls();
    message('saved-status-feedback', 'Updating receipt status…');
    try {
      const result = await api('/' + receipt.id + '/status', body);
      applyStatus(result.saved);
      message('saved-status-feedback', `${receipt.receiptNumber ? '#' + receipt.receiptNumber : 'Receipt'}: ${RECEIPT_STATUSES[result.saved.status]}. Status saved for all copies with this number.`);
      await search(page);
    } catch (error) {
      if (error.status === 409 && error.saved) applyStatus(error.saved);
      message('saved-status-feedback', error.status === 409 ? error.message : `${error.message || 'The connection was interrupted.'} Status was not confirmed. Search again to check it, or retry Update status.`, true);
    } finally { busy = false; controls(); }
  }
  async function search(nextPage = 1, { quiet = false } = {}) {
    if (quiet && (searching || pauseRefresh())) return;
    const sequence = ++searchSequence;
    searching++;
    if (!quiet) message('saved-receipts-status', 'Loading saved receipts…');
    try {
      const result = await api('?' + new URLSearchParams({ q: query, status: filter, page: String(nextPage), pageSize: matchMedia('(max-width: 640px)').matches ? '5' : '10' }));
      if (sequence !== searchSequence || (quiet && pauseRefresh())) return;
      page = result.page; pages = result.totalPages;
      const snapshot = JSON.stringify(result.receipts);
      if (snapshot !== listSnapshot) {
      const scrollTop = $('saved-receipts-list').scrollTop;
      $('saved-receipts-list').replaceChildren();
      for (const receipt of result.receipts) {
        const row = document.createElement('li'), heading = document.createElement('strong'), meta = document.createElement('p'), button = document.createElement('button');
        row.dataset.receiptId = receipt.id; row.dataset.statusGroup = receipt.statusGroup;
        row.dataset.status = receipt.status; row.dataset.statusRevision = String(receipt.statusRevision);
        heading.textContent = `${receipt.receiptNumber ? '#' + receipt.receiptNumber : 'Unnumbered receipt'} · ${receipt.recipientName}`;
        meta.className = 'hint';
        meta.textContent = `${receipt.receiptDate || 'No receipt date'} · ${receipt.itemCount} item${receipt.itemCount === 1 ? '' : 's'} · ${formatTraMoney(receipt.total, { currency: true })} · Saved ${new Date(receipt.createdAt).toLocaleString()}`;
        button.type = 'button'; button.className = 'secondary-button'; button.textContent = 'Open receipt';
        button.dataset.action = 'open';
        button.addEventListener('click', () => open(receipt.id));
        const badge = document.createElement('span'); badge.className = 'receipt-status-badge';
        badge.dataset.status = receipt.status; badge.textContent = RECEIPT_STATUSES[receipt.status];
        const editor = document.createElement('div'); editor.className = 'receipt-status-editor';
        const label = document.createElement('label'), select = document.createElement('select');
        select.id = `receipt-status-${receipt.id}`; label.htmlFor = select.id; label.textContent = 'Change status';
        for (const [value, text] of Object.entries(RECEIPT_STATUSES)) select.add(new Option(text, value));
        select.value = receipt.status;
        select.addEventListener('change', controls);
        const update = document.createElement('button'); update.type = 'button'; update.className = 'secondary-button'; update.textContent = 'Update status'; update.dataset.action = 'status';
        update.addEventListener('click', () => updateStatus(row, receipt));
        const actions = document.createElement('div'); actions.className = 'button-row'; actions.append(button, update);
        const updated = document.createElement('p'); updated.className = 'hint receipt-status-updated'; updated.textContent = receipt.statusUpdatedAt ? `Status updated ${new Date(receipt.statusUpdatedAt).toLocaleString()}` : '';
        editor.append(label, select, actions, updated);
        row.append(heading, document.createElement('br'), badge, meta, editor); $('saved-receipts-list').append(row);
      }
      $('saved-receipts-list').scrollTop = scrollTop;
      listSnapshot = snapshot;
      }
      message('saved-receipts-status', result.total ? `${result.total} saved ${result.total === 1 ? 'copy' : 'copies'}.` : 'No saved receipts found.');
      $('saved-receipts-pagination').hidden = pages < 2;
      $('saved-receipts-page').textContent = `Page ${page} of ${pages}`;
      $('saved-receipts-previous').disabled = page <= 1;
      $('saved-receipts-next').disabled = page >= pages;
      controls();
    } catch (error) {
      if (sequence !== searchSequence) return;
      if (!quiet) { $('saved-receipts-list').replaceChildren(); $('saved-receipts-pagination').hidden = true; listSnapshot = ''; }
      message('saved-receipts-status', error.message || 'Cannot reach the PC. Check the connection and search again.', true);
    } finally { searching--; }
  }
  async function open(id) {
    if (busy) return;
    busy = true; controls();
    try {
      if (!canOpen()) throw new Error('Finish the current print or product selection before opening a receipt.');
      const before = JSON.stringify(getDraft());
      const result = await api('/' + id);
      if (!canOpen() || JSON.stringify(getDraft()) !== before) throw new Error('Your draft changed while loading. Tap Open receipt again when you are ready.');
      if (!window.confirm('Open this saved receipt in the shared draft on your phone and PC? Your current draft will be replaced; a backup will be kept in this browser.')) return;
      // Persist before replacing; blocked storage must never discard the current draft.
      localStorage.setItem('labeldesk.tra.before-open.v1', before);
      applyReceipt(result.receipt);
      message('receipt-save-status', `Opened ${result.saved.receiptNumber ? '#' + result.saved.receiptNumber : 'saved receipt'}. You can edit or print it. Save changes as a new copy.`);
      revealMobileSection('recipient-name');
      $('recipient-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) { message('receipt-save-status', error.message || 'The saved receipt could not be opened. Your current draft is kept.', true); }
    finally { busy = false; controls(); }
  }
  $('receipt-save').addEventListener('click', async () => {
    if (busy) return;
    busy = true; controls();
    try {
      let receipt = getReceipt();
      if (!receipt.details.recipientName.trim()) throw new Error('Enter the recipient’s name before saving the receipt.');
      if (!receipt.items.length) throw new Error('Add at least one item before saving the receipt.');
      await ensureNumber();
      receipt = getReceipt();
      const snapshot = JSON.stringify(getDraft());
      message('receipt-save-status', 'Saving to the database…');
      const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await api('', { ...receipt, requestId });
      const changed = snapshot !== JSON.stringify(getDraft());
      message('receipt-save-status', `${result.duplicate ? 'This copy is already saved' : 'Receipt saved to the database'}.${changed ? ' You made further changes while saving; save again to keep those changes.' : ' You can find it in the saved receipts list.'}`);
      if ($('saved-receipts-panel').open) void search();
    } catch (error) { message('receipt-save-status', `${error.message || 'The connection was interrupted.'} Your draft is kept. You can retry saving; identical copies are stored once.`, true); }
    finally { busy = false; controls(); }
  });
  $('saved-receipts-panel').addEventListener('toggle', () => { if ($('saved-receipts-panel').open) void search(); });
  $('saved-receipts-search-form').addEventListener('submit', event => { event.preventDefault(); query = $('saved-receipts-search').value.trim(); void search(); });
  $('saved-receipts-filter').addEventListener('change', () => { filter = $('saved-receipts-filter').value; void search(); });
  $('saved-receipts-previous').addEventListener('click', () => { if (page > 1) void search(page - 1); });
  $('saved-receipts-next').addEventListener('click', () => { if (page < pages) void search(page + 1); });
  window.addEventListener('labeldesk-paired', () => { if ($('saved-receipts-panel').open) void search(); });
  function scheduleRefresh() {
    clearTimeout(poll);
    poll = setTimeout(() => {
      if ($('saved-receipts-panel').open && !document.hidden) void search(page, { quiet: true });
      scheduleRefresh();
    }, 5000);
  }
  window.addEventListener('pagehide', () => clearTimeout(poll));
  window.addEventListener('pageshow', scheduleRefresh);
  window.addEventListener('focus', () => { if ($('saved-receipts-panel').open) void search(page, { quiet: true }); });
  scheduleRefresh();
  return { isBusy: () => busy };
}
