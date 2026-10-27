const $ = id => document.getElementById(id);
const active = status => ['preparing', 'submitting'].includes(status);
const label = (status, noun = 'receipt') => ({ preparing: `Preparing ${noun}`, submitting: 'Sending to Windows', submitted: 'Sent to Windows', failed: 'Not sent', unknown: 'Check the Windows print queue' }[status] || status);

export function initializeTraPrinting({ getReceipt, kind = 'receipt' }) {
  const noun = kind === 'waybill' ? 'waybill' : 'receipt';
  const namespace = kind === 'waybill' ? 'waybill' : 'tra';
  const apiBase = kind === 'waybill' ? '/api/waybills' : '/api/receipts';
  const PENDING_KEY = `labeldesk.${namespace}.print.pending.v1`;
  const PAPER_KEY = `labeldesk.${namespace}.paper.v1`;
  let ready = false, busy = false, connected = false, selected = '', pending = null, poll = null, token = '';
  let requestRunning = false;
  try {
    token = localStorage.getItem('labeldesk.token') || '';
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (saved?.requestId && /^[a-zA-Z0-9-]{16,64}$/.test(saved.requestId)) pending = saved;
    const paper = localStorage.getItem(PAPER_KEY);
    if (['Letter', 'A4', 'Long'].includes(paper)) $('receipt-paper').value = paper;
    if (pending?.body) {
      if (['Letter', 'A4', 'Long'].includes(pending.body.paper)) $('receipt-paper').value = pending.body.paper;
      if (Number.isInteger(pending.body.copies) && pending.body.copies >= 1 && pending.body.copies <= 10) $('receipt-copies').value = String(pending.body.copies);
    }
  } catch {}

  function message(text, error = false) { $('receipt-print-status').textContent = text; $('receipt-print-status').dataset.error = String(error); }
  function controls() {
    $('receipt-direct-print').disabled = !ready || !connected || !selected || busy || Boolean(pending);
    $('receipt-direct-print').textContent = busy ? `Sending ${noun}…` : /epson/i.test(selected) || !selected ? 'Print on Epson' : `Print ${noun}`;
    $('receipt-printer').disabled = !connected || busy || Boolean(pending);
    $('receipt-paper').disabled = busy || Boolean(pending);
    $('receipt-copies').disabled = busy || Boolean(pending);
    $('receipt-print-refresh').disabled = busy;
    $('receipt-print-recovery').hidden = !pending;
    $('receipt-print-check').disabled = busy;
    $('receipt-print-new').hidden = !pending?.resolved;
  }
  function savePending() {
    // Persist before sending so reloads and lost responses reuse the same ID.
    // If storage is blocked, do not send a request that cannot be recovered.
    if (pending) localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_KEY);
  }
  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000), cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'The printing PC could not complete the request.'), { status: response.status });
    return data;
  }
  function showHistory(jobs) {
    $('receipt-print-jobs').replaceChildren();
    for (const job of jobs) {
      const li = document.createElement('li');
      const number = Array.isArray(job.waybillNumbers) ? job.waybillNumbers.map(value => '#' + value).join(' / ') : job.receiptNumber ? `#${job.receiptNumber.replace(/^#/, '')}` : 'Receipt';
      li.textContent = `${number} · ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'} · ${job.paper} · ${label(job.status, noun)} · ${new Date(job.createdAt).toLocaleString()}`;
      $('receipt-print-jobs').append(li);
    }
    if (!jobs.length) { const li = document.createElement('li'); li.textContent = `No ${noun}s sent yet.`; $('receipt-print-jobs').append(li); }
  }
  async function refresh({ silent = false } = {}) {
    try {
      const status = await api(apiBase + '/status');
      connected = true; selected = status.selectedPrinter || '';
      $('receipt-printer').replaceChildren(new Option('Select document printer', ''));
      for (const printer of status.printers) $('receipt-printer').add(new Option(printer.name, printer.name));
      $('receipt-printer').value = selected;
      showHistory(status.recentJobs);
      if (!silent && !pending) message(status.printerError || (selected ? `Ready: ${selected}` : 'No document printer selected. Install or connect the Epson printer on the Windows PC, then refresh.'), !selected);
    } catch (error) {
      connected = false;
      if (!silent) message(error.status === 401 ? kind === 'waybill' ? 'Connect this phone using the pairing form above, then refresh the printer.' : 'Pair this phone with the PC using the catalog pairing form above, then refresh the printer.' : 'Cannot reach the printing PC. Check its connection and tap Refresh printer.', true);
    }
    controls();
  }
  function accept(job) {
    busy = false;
    if (active(job.status)) {
      message(`${label(job.status, noun)}… Keep this page open.`);
      poll = setTimeout(check, 1000);
    } else if (job.status === 'submitted') {
      pending = null;
      try { savePending(); } catch { /* Saved ID still deduplicates after reload. */ }
      message(`Sent to Windows: ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'} on ${job.printer}.`);
      void refresh({ silent: true });
    } else {
      pending.resolved = true;
      try { savePending(); } catch {}
      message(job.error || label(job.status, noun), true);
      void refresh({ silent: true });
    }
    controls();
  }
  async function check() {
    clearTimeout(poll);
    if (!pending || requestRunning) return;
    requestRunning = true; busy = true; controls();
    try {
      let result;
      try { result = await api(`${apiBase}/jobs/${pending.requestId}`); }
      catch (error) {
        if (error.status !== 404 || !pending.body) throw error;
        // A lost POST may not have reached the PC. Same ID and same snapshot
        // make resending safe even if the original arrives at the same time.
        result = await api(apiBase + '/print', pending.body);
      }
      accept(result.job);
    } catch (error) {
      busy = false;
      if ([400, 413, 415].includes(error.status)) {
        pending.resolved = true;
        try { savePending(); } catch {}
      }
      message(`${error.status ? error.message : 'The connection was interrupted.'} Tap Check print status to recover this request.`, true);
      controls();
    } finally { requestRunning = false; }
  }
  $('receipt-direct-print').addEventListener('click', async () => {
    if ($('receipt-direct-print').disabled) return;
    try {
      const copies = Number($('receipt-copies').value);
      if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new Error('Enter 1 to 10 copies.');
      const body = { ...getReceipt(), copies, paper: $('receipt-paper').value, requestId: requestId() };
      pending = { requestId: body.requestId, body };
      try { savePending(); } catch { pending = null; throw new Error('Allow browser storage before direct printing, so interrupted requests can be recovered safely.'); }
      await check();
    } catch (error) { message(error.message, true); controls(); }
  });
  $('receipt-print-check').addEventListener('click', check);
  $('receipt-print-new').addEventListener('click', () => {
    if (!pending?.resolved || !window.confirm('Check the Windows print queue and the Epson first. Start a new print request?')) return;
    pending = null;
    try { savePending(); } catch {}
    message(`Ready for a new print request. Check the ${noun} and tap Print on Epson.`); controls();
  });
  $('receipt-print-refresh').addEventListener('click', () => { void refresh(); if (pending) void check(); });
  $('receipt-printer').addEventListener('change', async () => {
    busy = true; controls();
    try { const result = await api(apiBase + '/printer', { printerName: $('receipt-printer').value }); selected = result.selectedPrinter; message(`Ready: ${selected}`); }
    catch (error) { $('receipt-printer').value = selected; message(error.message, true); }
    finally { busy = false; controls(); }
  });
  $('receipt-paper').addEventListener('change', () => { try { localStorage.setItem(PAPER_KEY, $('receipt-paper').value); } catch {} });
  window.addEventListener('labeldesk-paired', event => { token = event.detail.token || ''; void refresh(); if (pending) void check(); });
  window.addEventListener('pagehide', () => clearTimeout(poll));
  window.addEventListener('pageshow', () => { if (pending) void check(); });
  void refresh();
  if (pending) void check();
  return { setReady(value) { ready = value; controls(); }, isPending: () => Boolean(pending) || busy };
}

function requestId() {
  // getRandomValues works on the existing HTTP phone page as well as HTTPS.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
