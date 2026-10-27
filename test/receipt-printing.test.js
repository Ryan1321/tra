import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.js';
import { validateReceiptRequest } from '../lib/receipt.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const epson = 'EPSON L120 Series';
const citizen = 'Citizen CL-S331';
const body = {
  requestId: 'receipt-request-0001', copies: 2, paper: 'Letter',
  details: { receiptNumber: '00297', recipientName: 'Test customer', recipientAddress: 'Bicutan', receiptDate: '2026-09-23' },
  items: [{ description: 'Salad spoon', barcode: '00001234', quantity: 3, unitPrice: '0.10', amount: '999' }], total: '999',
};

async function fixture(t, overrides = {}, initialJobs) {
  const dataDir = await mkdtemp(join(workspace, '.receipt-test-'));
  if (initialJobs) await writeFile(join(dataDir, 'receipt-jobs.json'), JSON.stringify(initialJobs));
  const calls = { rendered: [], checked: [], printed: [] };
  const receiptAdapter = {
    async render(input) { calls.rendered.push(input); return Buffer.from('receipt PNG'); },
    async check(input, printer) { calls.checked.push({ input, printer }); },
    async print(input, printer, png) { calls.printed.push({ input, printer, png }); },
    ...overrides,
  };
  const service = await createService({ dataDir, port: 0, receiptAdapter, adapter: {
    async listPrinters() { return { printers: [epson, citizen, 'Microsoft Print to PDF'].map(name => ({ name })) }; },
    async render() { assert.fail('Receipt must not render a sticker.'); },
    async print() { assert.fail('Receipt must not print on Citizen.'); },
  } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => {
    service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve));
    // Only remove the exact test directory returned by mkdtemp in this workspace.
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (path, data, token = service.token) => {
    const response = await fetch(base + '/api/receipts/' + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const finish = async (id = body.requestId) => {
    for (let i = 0; i < 100; i++) {
      const { data } = await api('jobs/' + id);
      if (data.job && !['preparing', 'submitting'].includes(data.job.status) && !(await api('status')).data.busy) return data.job;
      await delay(20);
    }
    assert.fail('Receipt job did not finish.');
  };
  return { api, finish, calls, dataDir };
}

test('receipt payload uses exact totals and preserves leading zeros; rejects invalid paper, dates and fields', () => {
  const input = validateReceiptRequest(body);
  assert.equal(input.total, '0.30'); assert.equal(input.items[0].amount, '0.30');
  assert.equal(input.items[0].barcode, '00001234'); assert.equal(input.details.receiptNumber, '00297');
  for (const change of [{ copies: 11 }, { copies: '1' }, { paper: '__proto__' }, { paper: 'label' }, { requestId: '../bad' }, { items: Array(21).fill(body.items[0]) }, { details: { receiptDate: '2026-02-30' } }, { details: { recipientName: '<hi>\nnext' } }, { details: { agreementStart: '2026-02-01', agreementEnd: '2026-01-01' } }]) assert.throws(() => validateReceiptRequest({ ...body, ...change }));
});

test('receipt API requires pairing, selects only the Epson, and keeps sticker selection separate', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('status', null, '')).status, 401);
  assert.equal((await f.api('print', body, '')).status, 401);
  assert.equal((await f.api('jobs/' + body.requestId, null, '')).status, 401);
  const status = (await f.api('status')).data;
  assert.equal(status.selectedPrinter, epson);
  assert.deepEqual(status.printers.map(p => p.name), [epson]);
  assert.equal((await f.api('printer', { printerName: citizen })).status, 400);
  assert.equal((await f.api('printer', { printerName: epson })).status, 200);
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.selectedPrinter, citizen); assert.equal(config.receiptPrinter, epson);
  assert.equal(f.calls.printed.length, 0);
});

test('receipt prints validated snapshot and deduplicates retries without exposing fingerprints', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('print', body)).status, 202);
  const job = await f.finish();
  assert.equal(job.status, 'submitted'); assert.equal(job.fingerprint, undefined);
  assert.equal(f.calls.printed.length, 1); assert.equal(f.calls.printed[0].printer, epson);
  assert.equal(f.calls.printed[0].input.total, '0.30'); assert.equal(f.calls.printed[0].input.copies, 2);
  assert.equal((await f.api('print', body)).data.duplicate, true);
  assert.equal((await f.api('print', { ...body, copies: 3 })).status, 409);
  assert.equal(f.calls.printed.length, 1);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'receipt-jobs.json'), 'utf8'));
  assert.equal(persisted[0].status, 'submitted'); assert.equal(persisted[0].id, body.requestId);
  assert.equal(persisted[0].details, undefined, 'No customer address is stored in print history.');
});

test('receipt rendering or driver failures never reach the printer', async t => {
  for (const stage of ['render', 'check']) {
    const f = await fixture(t, { async [stage]() { throw new Error(stage + ' failed'); } });
    await f.api('print', body);
    const job = await f.finish();
    assert.equal(job.status, 'failed'); assert.match(job.error, /failed/); assert.equal(f.calls.printed.length, 0);
    assert.equal((await f.api('print', body)).data.duplicate, true);
  }
});

test('receipt spooler failure is uncertain and a retry never prints a second copy', async t => {
  let count = 0;
  const f = await fixture(t, { async print() { count++; throw new Error('Spooler disconnected'); } });
  await f.api('print', body);
  const job = await f.finish();
  assert.equal(job.status, 'unknown'); assert.match(job.error, /Check the Windows print queue/);
  assert.equal((await f.api('print', body)).data.duplicate, true); assert.equal(count, 1);
});

test('concurrent receipt submission and printer changes cannot overtake the active request', async t => {
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { async render() { began(); await gate; return Buffer.from('PNG'); } });
  await f.api('print', body); await started;
  try {
    assert.equal((await f.api('print', body)).data.duplicate, true);
    assert.equal((await f.api('print', { ...body, requestId: 'receipt-request-0002' })).status, 409);
    assert.equal((await f.api('printer', { printerName: epson })).status, 409);
  } finally { release(); }
  assert.equal((await f.finish()).status, 'submitted'); assert.equal(f.calls.printed.length, 1);
});

test('restart reports unsent preparation and uncertain submission without replaying either', async t => {
  const f = await fixture(t, {}, [
    { id: 'receipt-restart-preparing', status: 'preparing' },
    { id: 'receipt-restart-submitting', status: 'submitting' },
  ]);
  assert.equal((await f.api('jobs/receipt-restart-preparing')).data.job.status, 'failed');
  assert.equal((await f.api('jobs/receipt-restart-submitting')).data.job.status, 'unknown');
  assert.equal(f.calls.printed.length, 0);
});
