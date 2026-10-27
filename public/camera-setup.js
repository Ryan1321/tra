const DRAFT_KEY = 'labeldesk.tra.draft.v1';
const TOKEN_KEY = 'labeldesk.token';
const MAX_DRAFT_BYTES = 50 * 1024;
const $ = id => document.getElementById(id);
let configuration = null;
let activeTransfer = null;

function error(message) {
  $('setup-error').textContent = message;
  $('setup-error').hidden = !message;
}

function finishTransfer(message) {
  if (activeTransfer) clearTimeout(activeTransfer.timer);
  activeTransfer = null;
  $('open-camera').disabled = false;
  if (message) $('setup-status').textContent = message;
}

function readTransferData() {
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const draft = localStorage.getItem(DRAFT_KEY);
  if (token && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Pairing could not be copied. Open the receipt page and pair again before continuing.');
  if (draft !== null && new TextEncoder().encode(draft).length > MAX_DRAFT_BYTES) {
    throw new Error('This saved receipt is too large to copy. Your draft remains on the original receipt page.');
  }
  return { token, draft };
}

window.addEventListener('message', event => {
  const transfer = activeTransfer;
  if (!transfer || event.origin !== transfer.origin || event.source !== transfer.window || !event.data || event.data.nonce !== transfer.nonce) return;
  if (event.data.type === 'labeldesk-camera-ready') {
    transfer.window.postMessage({ type: 'labeldesk-camera-transfer', nonce: transfer.nonce, ...transfer.data }, transfer.origin);
    $('setup-status').textContent = 'Secure page connected. Copying your saved receipt…';
  } else if (event.data.type === 'labeldesk-camera-transferred') {
    finishTransfer('The secure receipt page is ready in the new tab. Your original draft is still saved here.');
  } else if (event.data.type === 'labeldesk-camera-transfer-error') {
    finishTransfer('Check the secure page for the next step. Your original draft is still saved here.');
  }
});

$('open-camera').addEventListener('click', () => {
  if (!configuration || activeTransfer) return;
  error('');
  if (location.origin === configuration.httpsOrigin) {
    location.assign('/tra');
    return;
  }
  try {
    const data = readTransferData();
    const random = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
    const target = new URL('/camera-ready', configuration.httpsOrigin);
    target.hash = `nonce=${nonce}`;
    // Retain this specific opener only for the bounded, origin-checked transfer.
    const secureWindow = window.open(target.href, '_blank');
    if (!secureWindow) throw new Error('Allow the new tab to open, then tap Open live scanning again.');
    activeTransfer = {
      window: secureWindow, origin: configuration.httpsOrigin, nonce, data,
      timer: setTimeout(() => {
        finishTransfer('The secure page has not connected yet. Complete the certificate setup, then try Open live scanning again. Your original receipt is still saved here.');
      }, 120000),
    };
    $('open-camera').disabled = true;
    $('setup-status').textContent = 'Opening the secure page in a new tab. Keep this tab open until your receipt is copied.';
  } catch (problem) {
    error(problem.message || 'The saved receipt could not be copied. It is still available on the original receipt page.');
  }
});

async function initialize() {
  try {
    const response = await fetch('/api/camera-setup', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Camera setup could not be loaded. Check that the printing service is running.');
    const data = await response.json();
    if (!data.enabled) {
      $('setup-status').textContent = 'Live camera scanning is not set up on the Windows PC yet. Start the printing service with secure camera access enabled, then refresh this page.';
      return;
    }
    const secure = new URL(data.httpsUrl);
    const original = new URL(data.httpUrl);
    const certificate = new URL(data.certificateUrl, location.origin);
    if (secure.protocol !== 'https:' || secure.hostname !== location.hostname || secure.username || secure.password ||
        original.protocol !== 'http:' || original.hostname !== location.hostname || original.username || original.password ||
        ![secure.origin, original.origin].includes(location.origin) || certificate.origin !== location.origin) {
      throw new Error('Open camera setup using the address shown on your printing PC.');
    }
    configuration = { httpsOrigin: secure.origin };
    $('download-certificate').href = certificate.href;
    $('certificate-fingerprint').textContent = String(data.fingerprint || 'Fingerprint unavailable.');
    $('setup-status').textContent = 'Complete these three steps once on each Android phone.';
    $('setup-steps').hidden = false;
  } catch (problem) {
    $('setup-status').textContent = '';
    error(problem.name === 'TimeoutError' ? 'The printing PC took too long to respond. Refresh this page to try again.' : problem.message);
  }
}

initialize();
