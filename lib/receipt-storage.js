import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCatalogSettings, parseCatalogQuery } from './catalog.js';
import { validateReceiptRequest } from './receipt.js';
import { receiptStatus } from '../public/tra-status-model.js';

const worker = fileURLToPath(new URL('../scripts/receipt-storage.php', import.meta.url));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
export function receiptId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw bad('Invalid saved receipt ID.');
  return value;
}
export function normalizeSavedReceipt(data) {
  const { details, items, total } = validateReceiptRequest({ ...data, requestId: 'saved-receipt-validation', copies: 1, paper: 'Letter' });
  if (!details.recipientName) throw bad('Enter the recipient’s name before saving the receipt.');
  if (!items.length) throw bad('Add at least one item before saving the receipt.');
  details.receiptNumber = details.receiptNumber.replace(/^#/, '');
  return { version: 1, details, items, total };
}

export function createReceiptStorage({ dataDir, execute = executeReceiptPhp } = {}) {
  let active = 0;
  async function request(action, values = {}) {
    const config = await readCatalogSettings(dataDir);
    if (active >= 4) throw bad('Saved receipts are busy. Try again in a moment.', 429);
    active++;
    try { return await execute(config.phpPath, { action, ...values, config }); }
    finally { active--; }
  }
  async function reserveNumber(id, currentNumber = '') {
    receiptId(id);
    const numbers = [currentNumber].flat();
    // Previously printed and current draft numbers also seed a fresh sequence.
    for (const name of ['receipt-jobs.json', 'shared-drafts.json']) {
      try {
        const data = JSON.parse(await readFile(join(dataDir, name), 'utf8'));
        if (name === 'receipt-jobs.json') numbers.push(...data.map(job => job.receiptNumber));
        else numbers.push(data.drafts?.tra?.data?.receiptNumber);
      } catch (error) { if (error.code !== 'ENOENT') throw bad('Cannot read receipt numbering history on the PC. Keep the draft and try again after checking the data files.', 503); }
    }
    const floor = numbers.reduce((maximum, raw) => {
      const value = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
      return /^\d{1,20}$/.test(value) && BigInt(value) > maximum ? BigInt(value) : maximum;
    }, 0n).toString();
    return request('number', { id, floor });
  }
  return {
    initialize: () => request('initialize'),
    reserveNumber,
    search: params => request('search', { ...parseCatalogQuery(params), status: params.get('status') ? receiptStatus(params.get('status')) : '' }),
    get: id => request('get', { id: receiptId(id) }),
    updateStatus(id, data) {
      receiptId(id);
      const status = receiptStatus(data?.status);
      if (!Number.isInteger(data?.revision) || data.revision < 0 || data.revision >= 4294967295) throw bad('Invalid receipt status revision. Refresh the saved list and try again.');
      return request('status', { id, status, revision: data.revision });
    },
    save(data, currentNumber = '') {
      const id = receiptId(data?.requestId);
      const receipt = normalizeSavedReceipt(data);
      return (async () => {
        if (!receipt.details.receiptNumber) receipt.details.receiptNumber = (await reserveNumber(id, currentNumber)).number;
        const hash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
        return request('save', { id, hash, receipt });
      })();
    },
  };
}

export function executeReceiptPhp(phpPath, payload) {
  return new Promise((resolve, reject) => {
    // Credentials only travel over stdin; PHP is a local CLI worker.
    const child = spawn(phpPath, ['-d', 'display_errors=stderr', worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, timedOut = false, oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { oversized = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(bad('Cannot start receipt storage. Check XAMPP PHP and data/catalog.json on the PC.', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(bad('The database took too long. Keep your draft and retry saving; identical receipts are saved only once.', 503));
      if (oversized) return reject(bad('The database returned too much data. Narrow your saved receipt search.', 503));
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(bad('Receipt storage returned an unexpected response. Check XAMPP on the PC.', 503)); }
      if (code !== 0 || result.error) return reject(bad(result.error || 'Receipt storage is unavailable.', result.status || 503));
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
