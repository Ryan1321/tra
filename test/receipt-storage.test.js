import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createReceiptStorage, normalizeSavedReceipt } from '../lib/receipt-storage.js';
import { createService } from '../server.js';

const body = {
  requestId: 'a'.repeat(32), details: { receiptNumber: '#00297', recipientName: 'Customer', recipientAddress: 'Bicutan', receiptDate: '2026-09-30' },
  items: [{ description: 'Spoon', barcode: '00100086', quantity: 3, unitPrice: '0.10', amount: '99' }], total: '999',
};
test('saved receipts retain zeros and original prices, recompute money, and reject incomplete or invalid documents', () => {
  const result = normalizeSavedReceipt(body);
  assert.equal(result.details.receiptNumber, '00297');
  assert.equal(result.items[0].barcode, '00100086');
  assert.equal(result.items[0].unitPrice, '0.10');
  assert.equal(result.items[0].amount, '0.30'); assert.equal(result.total, '0.30');
  assert.equal(result.requestId, undefined);
  for (const changes of [{ details: {} }, { items: [] }, { items: Array(21).fill(body.items[0]) }, { details: { ...body.details, receiptDate: '2026-02-30' } }, { items: [{ ...body.items[0], quantity: 0 }] }]) {
    assert.throws(() => normalizeSavedReceipt({ ...body, ...changes }));
  }
});
test('database save fingerprints ignore request IDs and untrusted totals; only content changes create a new copy', async () => {
  const calls = [];
  const storage = createReceiptStorage({ dataDir: 'test/nonexistent', execute: async (_, payload) => { calls.push(payload); return {}; } });
  await storage.save(body);
  await storage.save({ ...body, requestId: 'b'.repeat(32), total: '1' });
  await storage.save({ ...body, items: [{ ...body.items[0], quantity: 4 }] });
  assert.equal(calls[0].hash, calls[1].hash); assert.notEqual(calls[1].hash, calls[2].hash);
  assert.throws(() => storage.save({ ...body, requestId: '../bad' }));
  assert.throws(() => storage.get('../config.json'));
  assert.throws(() => storage.search(new URLSearchParams({ q: '\n' + 'a'.repeat(101) })));
});
test('saved receipt routes require pairing, bound payloads, and never invoke a printer', async t => {
  const workspace = resolve('.'), dataDir = await mkdtemp(join(workspace, '.saved-receipt-test-'));
  const saved = new Map(); let duplicate = false;
  const storage = createReceiptStorage({ dataDir, execute: async (_, payload) => {
    if (payload.action === 'number') return { number: '351' };
    if (payload.action === 'save') { const receipt = { id: payload.id }; saved.set(payload.id, payload.receipt); return { saved: receipt, duplicate }; }
    if (payload.action === 'search') return { receipts: [...saved.keys()].map(id => ({ id })), total: saved.size, page: 1, totalPages: 1 };
    if (payload.action === 'get') {
      if (!saved.has(payload.id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return { receipt: saved.get(payload.id), saved: { id: payload.id } };
    }
    if (payload.action === 'status') {
      if (!saved.has(payload.id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return { conflict: payload.revision !== 0, saved: { id: payload.id, status: payload.status, statusRevision: 1 } };
    }
  } });
  const noPrint = () => assert.fail('Saving must not contact a printer');
  const service = await createService({ dataDir, receiptStorage: storage, port: 0, adapter: { listPrinters: noPrint, render: noPrint, print: noPrint }, receiptAdapter: { render: noPrint, check: noPrint, print: noPrint } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve)); assert.ok(resolve(dataDir).startsWith(workspace + sep + '.saved-receipt-test-')); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const api = (path = '', data, token = service.token, origin) => fetch(base + '/api/receipts/saved' + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) }, body: data ? JSON.stringify(data) : undefined });
  assert.equal((await api('', body, '')).status, 401);
  assert.equal((await api('', undefined, '')).status, 401);
  assert.equal((await api('/' + body.requestId, undefined, '')).status, 401);
  assert.equal((await api('', body, service.token, 'https://elsewhere.example')).status, 403);
  assert.equal((await api('', body)).status, 201);
  duplicate = true; assert.equal((await api('', body)).status, 200);
  assert.equal((await (await api('/' + body.requestId)).json()).receipt.total, '0.30');
  assert.equal((await (await api()).json()).total, 1);
  assert.equal((await api('/' + 'c'.repeat(32))).status, 404);
  assert.equal((await api('/bad')).status, 400);
  assert.equal((await api('', { ...body, items: [] })).status, 400);
  assert.equal((await api('', { ...body, padding: 'a'.repeat(33000) })).status, 413);
  assert.equal((await api('?page=0')).status, 400);
  assert.equal((await fetch(base + '/tra-saved.js')).status, 200);
  assert.equal((await fetch(base + '/scripts/receipt-storage.php')).status, 404);
  const number = (data, token = service.token) => fetch(base + '/api/receipts/number', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await number({ requestId: body.requestId }, '')).status, 401);
  assert.equal((await number({ requestId: '../bad' })).status, 400);
  assert.equal((await (await number({ requestId: body.requestId })).json()).number, '351');
  assert.equal((await api('/' + body.requestId + '/status', { status: 'completed', revision: 0 }, '')).status, 401);
  assert.equal((await api('/' + body.requestId + '/status', { status: 'completed', revision: 0 }, service.token, 'https://elsewhere.example')).status, 403);
  assert.equal((await api('/' + body.requestId + '/status', { status: 'completed', revision: 0 })).status, 200);
  const conflict = await api('/' + body.requestId + '/status', { status: 'outstanding', revision: 9 });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).conflict, true);
  assert.equal((await api('/' + body.requestId + '/status', { status: 'bad', revision: 0 })).status, 400);
  assert.equal((await api('/' + 'd'.repeat(32) + '/status', { status: 'completed', revision: 0 })).status, 404);
  assert.equal((await api('?status=unknown')).status, 400);
});

test('receipt statuses validate exact choices, revisions and IDs before reaching the database', async () => {
  const calls = [];
  const storage = createReceiptStorage({ dataDir: 'test/nonexistent', execute: async (_, payload) => { calls.push(payload); return {}; } });
  for (const status of ['outstanding', 'partially_returned', 'completed']) {
    await storage.updateStatus(body.requestId, { status, revision: 7 });
    await storage.search(new URLSearchParams({ status }));
  }
  assert.deepEqual(calls.filter(p => p.action === 'status').map(p => [p.id, p.status, p.revision]), ['outstanding', 'partially_returned', 'completed'].map(status => [body.requestId, status, 7]));
  for (const status of ['', null, 0, '__proto__', 'complete', 'COMPLETED']) assert.throws(() => storage.updateStatus(body.requestId, { status, revision: 0 }), error => error.status === 400);
  for (const revision of [undefined, null, '0', -1, 0.1, 4294967295]) assert.throws(() => storage.updateStatus(body.requestId, { status: 'completed', revision }), error => error.status === 400);
  assert.throws(() => storage.updateStatus('../bad', { status: 'completed', revision: 0 }));
  assert.equal(calls.length, 6);
});

test('numbering seeds from draft and print history without rounding large numbers, and auto-numbers blank saves', async t => {
  const workspace = resolve('.'), dataDir = await mkdtemp(join(workspace, '.saved-receipt-test-'));
  t.after(async () => { assert.ok(resolve(dataDir).startsWith(workspace + sep + '.saved-receipt-test-')); await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(join(dataDir, 'receipt-jobs.json'), JSON.stringify([{ receiptNumber: '90071992547409931234' }]));
  await writeFile(join(dataDir, 'shared-drafts.json'), JSON.stringify({ drafts: { tra: { data: { receiptNumber: '#00450' } } } }));
  const calls = [];
  const storage = createReceiptStorage({ dataDir, execute: async (_, payload) => {
    calls.push(payload);
    return payload.action === 'number' ? { number: '90071992547409931235' } : { saved: { receiptNumber: payload.receipt.details.receiptNumber } };
  } });
  assert.equal((await storage.reserveNumber(body.requestId, '460')).number, '90071992547409931235');
  assert.equal(calls[0].floor, '90071992547409931234');
  const result = await storage.save({ ...body, details: { ...body.details, receiptNumber: '' } });
  assert.equal(result.saved.receiptNumber, '90071992547409931235');
  assert.equal(calls.at(-1).receipt.details.receiptNumber, '90071992547409931235');
  await assert.rejects(storage.reserveNumber('bad'), error => error.status === 400);
  await writeFile(join(dataDir, 'shared-drafts.json'), 'invalid');
  await assert.rejects(storage.reserveNumber(body.requestId), error => error.status === 503);
});
