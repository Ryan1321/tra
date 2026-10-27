const $ = id => document.getElementById(id);
const PENDING_KEY = 'labeldesk.tra.number.pending.v1';

export function initializeReceiptNumbering({ getDraft, applyNumber, canChange }) {
  let busy = false;
  function message(text, error = false) {
    $('receipt-number-status').textContent = text;
    $('receipt-number-status').dataset.error = String(error);
  }
  async function assign({ newReceipt = false } = {}) {
    if (busy) throw new Error('Wait for the receipt number to finish.');
    if (!canChange()) throw new Error('Finish the current print or product selection before assigning a receipt number.');
    if (!newReceipt && $('receipt-number').value.trim()) return;
    busy = true;
    $('receipt-next-number').disabled = $('clear-receipt').disabled = true;
    const before = JSON.stringify(getDraft());
    try {
      const token = localStorage.getItem('labeldesk.token') || '';
      if (!token) throw new Error('Pair this device using the catalog form before getting a receipt number.');
      let requestId = localStorage.getItem(PENDING_KEY);
      if (!/^[a-f0-9]{32}$/.test(requestId || '')) {
        requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        // Keep the same request across timeouts/reloads to avoid consuming another number on retry.
        localStorage.setItem(PENDING_KEY, requestId);
      }
      message('Getting the next receipt number…');
      const current = $('receipt-number').value.trim();
      const response = await fetch('/api/receipts/number', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, currentNumber: /^#?[0-9]{1,20}$/.test(current) ? current : '' }), signal: AbortSignal.timeout(20000), cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The next receipt number is unavailable.');
      if (typeof result.number !== 'string' || !/^[0-9]{1,20}$/.test(result.number)) throw new Error('The PC returned an invalid receipt number.');
      // Remove the retry ID before applying. If the page closes here, a skipped
      // number is preferable to accidentally using the same number for a new receipt.
      localStorage.removeItem(PENDING_KEY);
      if (JSON.stringify(getDraft()) !== before || !canChange()) throw new Error(`Your draft changed while loading. Number #${result.number} was reserved but not applied. Try again when ready.`);
      applyNumber(result.number, newReceipt);
      message(`Receipt #${result.number} is ready. You can change the number manually if needed.`);
    } catch (error) {
      message(error.message || 'Cannot reach the PC. Your draft is kept; retry to recover the same number.', true);
      throw error;
    } finally {
      busy = false;
      $('receipt-next-number').disabled = $('clear-receipt').disabled = false;
    }
  }
  return { assign, isBusy: () => busy, clearStatus: () => message('') };
}
