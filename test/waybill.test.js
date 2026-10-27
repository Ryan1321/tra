import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.js';
import { validateWaybillRequest } from '../lib/waybill.js';
import { blankWaybills, normalizeWaybills, nextWaybillNumber } from '../public/waybill-model.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const epson = 'EPSON L120 Series';
const body = {
  requestId: 'waybill-request-0001', copies: 2, paper: 'Letter',
  waybills: ['00330', '00331'].map((number, index) => ({ number, destination: `BRANCH ${index + 1}`, transport: 'BUS', location: 'TERMINAL', recipient: `Customer ${index + 1}`, phone: '09123456789' })),
};
const receipt = { requestId: 'receipt-request-0001', copies: 1, paper: 'Letter', details: {}, items: [{ description: 'Spoon', barcode: '000123', quantity: 1, unitPrice: '20.00' }] };

async function fixture(t, overrides = {}, initialJobs) {
  const dataDir = await mkdtemp(join(workspace, '.waybill-test-'));
  if (initialJobs) await writeFile(join(dataDir, 'waybill-jobs.json'), JSON.stringify(initialJobs));
  const printed = [];
  let receipts = 0;
  const service = await createService({ dataDir, port: 0, adapter: {
    async listPrinters() { return { printers: [epson, 'Citizen CL-S331', 'Microsoft Print to PDF'].map(name => ({ name })) }; },
    async render() { assert.fail('Must not render a sticker.'); },
    async print() { assert.fail('Must not print a sticker.'); },
  }, waybillAdapter: {
    async render() { return Buffer.from('PNG'); }, async check() {},
    async print(input, printer) { printed.push({ input, printer }); }, ...overrides,
  }, receiptAdapter: {
    async render() { return Buffer.from('PNG'); }, async check() {}, async print() { receipts++; },
  } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => {
    service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true }); // Exact mkdtemp path within this workspace.
  });
  const api = async (path, data, token = service.token, kind = 'waybills') => {
    const response = await fetch(`${base}/api/${kind}/${path}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const finish = async () => {
    for (let i = 0; i < 100; i++) {
      const { data } = await api('jobs/' + body.requestId);
      if (data.job && !['preparing', 'submitting'].includes(data.job.status) && !(await api('status')).data.busy) return data.job;
      await delay(20);
    }
    assert.fail('Job did not finish.');
  };
  return { api, finish, printed, dataDir, base, receiptCount: () => receipts };
}

test('waybill fields preserve independent values, leading zeros, and a separate normalized snapshot', () => {
  const source = structuredClone(body);
  source.waybills[0].number = '#00330'; source.waybills[0].recipient = '  Customer   One  ';
  const input = validateWaybillRequest(source);
  assert.equal(input.waybills[0].number, '00330');
  assert.equal(input.waybills[0].recipient, 'Customer One');
  assert.equal(input.waybills[0].phone, '09123456789');
  assert.equal(input.waybills[1].destination, 'BRANCH 2');
  source.waybills[0].destination = 'Changed';
  assert.equal(input.waybills[0].destination, 'BRANCH 1');
  const blank = blankWaybills(); blank[0].number = '1'; assert.equal(blank[1].number, '');
  assert.doesNotThrow(() => normalizeWaybills(blank));
  assert.throws(() => normalizeWaybills(blank, { forPrint: true }), /destination/);
  assert.equal(nextWaybillNumber('00999'), '01000');
  assert.equal(nextWaybillNumber('9007199254740993'), '9007199254740994');
  assert.equal(nextWaybillNumber('99999999999999999999'), '');
  assert.equal(nextWaybillNumber('TR-5'), '');
});

test('waybill validation rejects incomplete sheets, unsafe fields and unsupported paper or copies', () => {
  for (const change of [{ copies: 0 }, { copies: 11 }, { copies: '2' }, { paper: 'A4' }, { requestId: '../bad' }, { waybills: [] }, { waybills: [body.waybills[0]] }]) {
    assert.throws(() => validateWaybillRequest({ ...body, ...change }));
  }
  for (const change of [{ phone: 9123456789 }, { phone: '' }, { recipient: 'Line\nTwo' }, { recipient: 'a'.repeat(91) }, { number: '<script>' }, { destination: '' }]) {
    assert.throws(() => validateWaybillRequest({ ...body, waybills: [body.waybills[0], { ...body.waybills[1], ...change }] }));
  }
});

test('waybill page and assets load; API requires pairing and never selects a sticker queue', async t => {
  const f = await fixture(t);
  for (const path of ['/waybill', '/waybill/', '/waybill.js', '/waybill.css', '/waybill-model.js', '/waybill-render.js']) assert.equal((await fetch(f.base + path)).status, 200);
  for (const [path, data] of [['status'], ['print', body], ['printer', { printerName: epson }], ['jobs/' + body.requestId]]) assert.equal((await f.api(path, data, '')).status, 401);
  const status = (await f.api('status')).data;
  assert.equal(status.selectedPrinter, epson); assert.deepEqual(Object.keys(status.papers), ['Letter']);
  assert.deepEqual(status.printers.map(p => p.name), [epson]);
  assert.equal((await f.api('printer', { printerName: 'Citizen CL-S331' })).status, 400);
  assert.equal((await f.api('print', { ...body, paper: 'A4' })).status, 400);
  assert.equal(f.printed.length, 0);
});

test('waybill submission sends both edited halves as a single sheet job, deduplicates and retains only job metadata', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('print', body)).status, 202);
  const job = await f.finish(); assert.equal(job.status, 'submitted'); assert.equal(job.fingerprint, undefined);
  assert.deepEqual(job.waybillNumbers, ['00330', '00331']);
  assert.equal(f.printed.length, 1); assert.equal(f.printed[0].printer, epson);
  assert.deepEqual(f.printed[0].input, validateWaybillRequest(body));
  assert.equal((await f.api('print', body)).data.duplicate, true);
  assert.equal((await f.api('print', { ...body, copies: 3 })).status, 409);
  assert.equal(f.printed.length, 1); assert.equal(f.receiptCount(), 0);
  const history = await readFile(join(f.dataDir, 'waybill-jobs.json'), 'utf8');
  assert.doesNotMatch(history, /Customer|09123456789|BRANCH|recipient/);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'receipt-jobs.json'), 'utf8')), []);
});

test('waybill render and driver failures do not print, and spooler uncertainty cannot be retried into a duplicate', async t => {
  for (const stage of ['render', 'check', 'print']) {
    let attempts = 0;
    const f = await fixture(t, { async [stage]() { attempts++; throw new Error('Test failure'); } });
    await f.api('print', body);
    assert.equal((await f.finish()).status, stage === 'print' ? 'unknown' : 'failed');
    assert.equal((await f.api('print', body)).data.duplicate, true);
    assert.equal(attempts, 1); assert.equal(f.printed.length, 0);
  }
});

test('waybills and receipts share the Epson submission lock and prevent printer changes while busy', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async render() { await gate; return Buffer.from('PNG'); } });
  await f.api('print', body);
  try {
    assert.equal((await f.api('status', null, undefined, 'receipts')).data.busy, true);
    assert.equal((await f.api('print', receipt, undefined, 'receipts')).status, 409);
    assert.equal((await f.api('printer', { printerName: epson }, undefined, 'receipts')).status, 409);
    assert.equal((await f.api('print', body)).data.duplicate, true);
    assert.equal(f.receiptCount(), 0);
  } finally { release(); }
  await f.finish();
  assert.equal((await f.api('status', null, undefined, 'receipts')).data.busy, false);
});

test('waybill restart recovery reports unsent and uncertain jobs without replaying them', async t => {
  const f = await fixture(t, {}, [{ id: 'waybill-restart-preparing', status: 'preparing' }, { id: 'waybill-restart-submitting', status: 'submitting' }]);
  assert.equal((await f.api('jobs/waybill-restart-preparing')).data.job.status, 'failed');
  assert.equal((await f.api('jobs/waybill-restart-submitting')).data.job.status, 'unknown');
  assert.equal(f.printed.length, 0);
});
