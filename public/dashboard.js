const $ = id => document.getElementById(id);
let token = '', authenticated = false, connecting = false, refreshing = false, loadingCounts = false, epoch = 0, countsAt = 0;
try { token = localStorage.getItem('labeldesk.token') || ''; } catch {}
const number = new Intl.NumberFormat();
const mobile = matchMedia('(max-width: 640px)');
function disclosureLayout() { for (const id of ['dashboard-activity', 'dashboard-station']) $(id).open = !mobile.matches; }
disclosureLayout();
mobile.addEventListener('change', disclosureLayout);

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Could not load the dashboard.'), { status: response.status });
  return data;
}
function connection(text, state) { $('connection-text').textContent = text; $('connection-status').dataset.state = state; }
function message(text = '') { $('dashboard-message').textContent = text; $('dashboard-message').hidden = !text; }
function remember(value) { token = value; try { localStorage.setItem('labeldesk.token', value); } catch {} }
function requirePairing() {
  authenticated = false; epoch++; countsAt = 0;
  $('dashboard-data').hidden = true; $('dashboard-details').hidden = true; $('dashboard-pair').hidden = false;
  $('dashboard-phone').hidden = true; $('dashboard-pair-code').textContent = '';
  $('dashboard-updated').textContent = 'Connect to see your activity and catalog.';
  connection('Pair device', 'waiting'); message();
}
function printer(prefix, value) {
  $(`${prefix}-printer-name`).textContent = value.name || 'Choose a printer in the printing tool.';
  const state = $(`${prefix}-printer-state`);
  state.textContent = value.busy ? 'Sending' : value.name ? 'Configured' : 'Not selected';
  state.dataset.state = value.busy || !value.name ? 'warning' : 'ready';
}
function activityRow(job) {
  const li = document.createElement('li');
  const icon = document.createElement('span'); icon.className = 'activity-kind'; icon.setAttribute('aria-hidden', 'true');
  icon.textContent = { sticker: 'S', receipt: 'R', waybill: 'W' }[job.kind];
  const info = document.createElement('div'); info.className = 'activity-info';
  const link = document.createElement('a'); link.href = job.href; link.textContent = job.title;
  const caption = document.createElement('small');
  const date = new Date(job.createdAt);
  const unit = job.kind === 'sticker' ? (job.labelsPerCopy === 2 ? 'pair' : 'sticker') : 'sheet';
  caption.textContent = `${job.copies} ${unit}${job.copies === 1 ? '' : 's'} · ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  info.append(link, caption);
  const badge = document.createElement('span'); badge.className = 'dashboard-state';
  badge.textContent = { submitted: 'Sent', preparing: 'Preparing', submitting: 'Sending', unknown: 'Check queue', failed: 'Failed' }[job.status] || 'Check queue';
  badge.dataset.state = job.status === 'submitted' ? 'ready' : ['preparing', 'submitting'].includes(job.status) ? 'warning' : 'error';
  li.append(icon, info, badge); return li;
}
function render(data) {
  $('dashboard-data').hidden = false; $('dashboard-details').hidden = false; $('dashboard-pair').hidden = true;
  $('metric-stickers').textContent = number.format(data.today.stickerPairs);
  $('metric-documents').textContent = number.format(data.today.documentSheets);
  const list = $('activity-list');
  // Keep keyboard focus in the activity list when a quiet refresh changes counts.
  const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('li')?.dataset.id : null;
  list.replaceChildren(...data.activity.map(job => { const row = activityRow(job); row.dataset.id = job.id; return row; }));
  if (focusedId) [...list.children].find(row => row.dataset.id === focusedId)?.querySelector('a')?.focus({ preventScroll: true });
  $('activity-empty').hidden = data.activity.length > 0;
  $('activity-summary').textContent = `${data.today.submissions} sent today`;
  printer('sticker', data.printers.stickers); printer('document', data.printers.documents);
  $('station-summary').textContent = data.printers.stickers.busy || data.printers.documents.busy ? 'Sending jobs' : 'Printer settings';
  const now = new Date(data.updatedAt);
  $('dashboard-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: data.timeZone });
  $('dashboard-date').dateTime = data.date;
  $('dashboard-updated').textContent = `Updated ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · Today follows the PC’s clock`;
  message(data.attentionToday ? `${data.attentionToday} job${data.attentionToday === 1 ? '' : 's'} to check today. Review the Windows print queue before retrying.` : data.activeJobs || data.activeBatches ? 'Your print jobs are being prepared or sent. You can follow their status in the printing tool.' : '');
  connection('PC connected', 'online');
}
async function refreshCounts() {
  if (!authenticated || loadingCounts) return;
  loadingCounts = true;
  const version = epoch;
  try {
    await Promise.allSettled([
      ['/api/products?pageSize=1', 'products', 'In your catalog'],
      ['/api/receipts/saved?pageSize=1', 'receipts', 'Including saved versions'],
    ].map(async ([path, key, note]) => {
      try {
        const data = await api(path);
        if (version !== epoch) return;
        if (!Number.isInteger(data.total) || data.total < 0) throw new Error('Count unavailable');
        $(`metric-${key}`).textContent = number.format(data.total); $(`${key}-note`).textContent = note;
      } catch (error) {
        if (version !== epoch) return;
        if (error.status === 401) { requirePairing(); return; }
        $(`metric-${key}`).textContent = '—'; $(`${key}-note`).textContent = 'Unavailable · tap refresh';
      }
    }));
    if (version === epoch) countsAt = Date.now();
  } finally { loadingCounts = false; }
}
async function refresh(forceCounts = false) {
  if (!authenticated || refreshing) return;
  refreshing = true; $('dashboard-refresh').disabled = true;
  const version = epoch;
  try {
    const data = await api('/api/dashboard');
    if (version !== epoch) return;
    render(data);
    if (forceCounts || Date.now() - countsAt > 60000) void refreshCounts();
  } catch (error) {
    if (version !== epoch) return;
    if (error.status === 401) { requirePairing(); return; }
    connection('Offline', 'offline');
    message('Cannot reach the Windows PC. Showing the last loaded information. Check your connection and tap refresh.');
  } finally { refreshing = false; $('dashboard-refresh').disabled = false; }
}
async function connect() {
  if (connecting) return;
  connecting = true; $('dashboard-refresh').disabled = true; connection('Connecting', 'waiting');
  try {
    const status = await api('/api/status?includePrinters=false');
    if (status.localSetup) {
      const setup = await api('/api/setup?includePrinters=false'); remember(setup.token);
      $('dashboard-phone').hidden = false; $('dashboard-pair-code').textContent = setup.pairCode;
      $('dashboard-phone-urls').replaceChildren(...setup.phoneUrls.map(url => {
        const link = document.createElement('a'); link.href = url + '/dashboard'; link.textContent = link.href; return link;
      }));
    } else if (status.pairedRequired) { requirePairing(); return; }
    authenticated = true; epoch++; countsAt = 0; await refresh(true);
  } catch {
    connection('Offline', 'offline'); message('Start the printing service on your Windows PC, then tap refresh to connect.');
    $('dashboard-updated').textContent = 'Waiting for the printing PC.';
  } finally { connecting = false; $('dashboard-refresh').disabled = false; }
}
$('dashboard-refresh').addEventListener('click', () => { if (authenticated) void refresh(true); else void connect(); });
$('dashboard-pair-form').addEventListener('submit', async event => {
  event.preventDefault(); $('pair-button').disabled = true; $('pair-error').hidden = true;
  try {
    const data = await api('/api/pair', { code: $('pair-code').value }); remember(data.token);
    $('pair-code').value = ''; await connect();
  } catch (error) { $('pair-error').textContent = error.message || 'Could not connect. Try again.'; $('pair-error').hidden = false; }
  finally { $('pair-button').disabled = false; }
});
window.addEventListener('storage', event => {
  if (event.key !== 'labeldesk.token') return;
  token = event.newValue || ''; epoch++; authenticated = false; void connect();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (authenticated) void refresh(); else void connect(); } });
setInterval(() => { if (!document.hidden && authenticated) void refresh(); }, 15000);
void connect();
