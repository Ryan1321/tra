import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const printerNames = ['Citizen CL-S331', 'Citizen CL-S331 backup'];
const fields = { price: '199', productName: 'Sample shirt', sku: 'SKU-001', barcode: '00001234' };
const terminalStates = new Set(['submitted', 'failed', 'stopped', 'interrupted']);
const item = (suffix, copies = 1) => ({ fields: { ...fields, productName: `Product ${suffix}`, sku: `SKU-${suffix}` }, copies });

async function fixture(t, overrides = {}, directory) {
  const dataDir = directory || await mkdtemp(join(workspace, '.label-test-batch-'));
  const calls = { renders: [], prints: [] };
  const adapter = {
    async listPrinters() { return { printers: printerNames.map(name => ({ name })) }; },
    async render(input) { calls.renders.push(input); return Buffer.from('PNG stub'); },
    async print(input, printer) { calls.prints.push({ input, printer }); },
    ...overrides,
  };
  const service = await createService({ dataDir, adapter, port: 0 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  service.setPort(service.server.address().port);
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function close() {
    if (!service.server.listening) return;
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
  }
  t.after(async () => {
    await close();
    if (directory) return;
    const target = resolve(dataDir);
    assert.ok(target.startsWith(resolve(workspace) + sep) && target.split(sep).at(-1).startsWith('.label-test-batch-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function api(path, { method = 'GET', body, token = service.token } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data };
  }
  return { dataDir, calls, api, close };
}

async function selectPrinter(f) {
  assert.equal((await f.api('/api/printer', { method: 'POST', body: { printerName: printerNames[0] } })).status, 200);
}

async function waitForPrinterRelease(f) {
  // A terminal batch status is visible before its final durable write finishes.
  // The printer remains reserved until that write completes.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await f.api('/api/printer', { method: 'POST', body: { printerName: printerNames[1] } });
    if (response.status === 200) {
      assert.equal(response.data.selectedPrinter, printerNames[1]);
      return;
    }
    assert.equal(response.status, 409);
    assert.equal(response.data.error, 'Wait for the current label to be submitted.');
    await delay(20);
  }
  assert.fail('The mock batch did not release the printer within five seconds.');
}

async function waitForBatch(f, id) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const response = await f.api(`/api/batches/${id}`);
    assert.equal(response.status, 200);
    if (terminalStates.has(response.data.batch.status)) return response.data.batch;
    await delay(20);
  }
  assert.fail('The mock batch did not finish within five seconds.');
}

test('the selected compact stock applies to every batch row and stays fixed on duplicate retries', async t => {
  const f = await fixture(t); await selectPrinter(f);
  const body = { requestId: 'compact-batch-request-001', labelLayout: 'paired-1p25x1-v1', items: [item('one', 2), item('two', 3)] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
  const batch = await waitForBatch(f, body.requestId);
  assert.equal(batch.status, 'submitted'); assert.equal(batch.layoutVersion, body.labelLayout);
  assert.deepEqual(f.calls.prints.map(call => [call.input.widthDots, call.input.copies]), [[750, 2], [750, 3]]);
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).data.duplicate, true);
  assert.equal((await f.api('/api/batches', { method: 'POST', body: { ...body, labelLayout: 'paired-v3' } })).status, 409);
  await waitForPrinterRelease(f);
  const invalid = { ...body, requestId: 'compact-batch-too-wide', items: [item('valid'), { fields: { ...fields, barcode: 'ABCDEFGHIJKLMNOP' }, copies: 1 }] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body: invalid })).status, 400);
  assert.equal(f.calls.prints.length, 2);
});

test('batch item IDs cannot collide with manual print request IDs', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const batchId = 'batch-collision-check-001';
  const manual = { fields, copies: 1, requestId: `${batchId}-1` };
  const first = await f.api('/api/print', { method: 'POST', body: manual });
  assert.equal(first.status, 200);
  await f.api('/api/batches', { method: 'POST', body: { requestId: batchId, items: [item('another')] } });
  assert.equal((await waitForBatch(f, batchId)).status, 'submitted');
  const retried = await f.api('/api/print', { method: 'POST', body: manual });
  assert.equal(retried.data.duplicate, true);
  assert.equal(retried.data.job.id, first.data.job.id);
  assert.equal(f.calls.prints.length, 2);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(new Set(saved.map(job => job.requestId)).size, 2);
});

test('batch endpoints require pairing and unknown batches return 404', async t => {
  const f = await fixture(t);
  const body = { requestId: 'batch-authentication-001', items: [item('one')] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body, token: null })).status, 401);
  assert.equal((await f.api(`/api/batches/${body.requestId}`, { token: null })).status, 401);
  assert.equal((await f.api(`/api/batches/${body.requestId}`)).status, 404);
  assert.equal(f.calls.renders.length, 0);
  assert.equal(f.calls.prints.length, 0);
});

test('batch validates every row and all quantity limits before acceptance', async t => {
  const f = await fixture(t);
  const body = { requestId: 'batch-validation-0001', items: [item('one')] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 400, 'A printer must be selected first.');
  await selectPrinter(f);
  const invalid = [
    { ...body, items: [] },
    { ...body, items: null },
    { ...body, items: [null] },
    { ...body, items: [item('one'), { fields: { ...fields, sku: '' }, copies: 1 }] },
    { ...body, items: [item('one'), { fields: { ...fields, price: '-1' }, copies: 1 }] },
    { ...body, requestId: 'too-short' },
    ...[0, 101, 1.5, '1'].map(copies => ({ ...body, items: [item('one', copies)] })),
    { ...body, items: Array.from({ length: 51 }, (_, i) => item(i)) },
    { ...body, items: Array.from({ length: 6 }, (_, i) => item(i, i < 5 ? 100 : 1)) },
  ];
  for (const request of invalid) {
    const response = await f.api('/api/batches', { method: 'POST', body: request });
    assert.equal(response.status, 400, JSON.stringify(request));
  }
  assert.equal(f.calls.renders.length, 0);
  assert.equal(f.calls.prints.length, 0);
  assert.equal((await f.api(`/api/batches/${body.requestId}`)).status, 404);
});

test('batch renders all products before submission and keeps product order, quantities, and history', async t => {
  const events = [];
  const f = await fixture(t, {
    async render(input) { events.push(['render', input.fields.sku]); return Buffer.from('PNG'); },
    async print(input, printer) { events.push(['print', input.fields.sku, input.copies, printer, input.fields.price]); },
  });
  await selectPrinter(f);
  const body = { requestId: 'batch-order-and-copies-01', items: [item('first', 2), item('second', 3), item('third', 1)] };
  const response = await f.api('/api/batches', { method: 'POST', body });
  assert.equal(response.status, 202);
  assert.equal(response.data.batch.id, body.requestId);
  const batch = await waitForBatch(f, body.requestId);
  assert.equal(batch.status, 'submitted');
  assert.deepEqual(batch.items.map(entry => entry.status), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(batch.items.map(entry => entry.copies), [2, 3, 1]);
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ['render', 'SKU-first'], ['render', 'SKU-second'], ['render', 'SKU-third'],
    ['print', 'SKU-first'], ['print', 'SKU-second'], ['print', 'SKU-third'],
  ]);
  assert.deepEqual(events.slice(3).map(event => event[2]), [2, 3, 1]);
  for (const event of events.slice(3)) {
    assert.equal(event[3], printerNames[0]);
    assert.equal(event[4], '\u20b1 199.00');
  }
  const jobs = (await f.api('/api/jobs')).data.jobs;
  assert.deepEqual(jobs.map(job => [job.fields.sku, job.copies]), [['SKU-third', 1], ['SKU-second', 3], ['SKU-first', 2]]);
  assert.ok(jobs.every(job => job.status === 'submitted' && job.labelsPerCopy === 2));
  const duplicate = await f.api('/api/batches', { method: 'POST', body });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.batch.id, body.requestId);
  assert.equal(events.filter(event => event[0] === 'print').length, 3);
  assert.equal((await f.api('/api/batches', { method: 'POST', body: { ...body, items: [item('changed')] } })).status, 409);
});

test('batch accepts fifty products and five hundred pairs at the documented limits', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const body = {
    requestId: 'batch-maximum-limits-01',
    items: Array.from({ length: 50 }, (_, i) => ({
      fields: { ...fields, productName: `Available catalog product number ${i} with standard label details`, sku: `SKU-product-${i}-with-long-name` }, copies: 10,
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 8192, 'Exercise batch payloads beyond the single-label limit.');
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
  const batch = await waitForBatch(f, body.requestId);
  assert.equal(batch.status, 'submitted');
  assert.equal(f.calls.prints.length, 50);
  assert.equal(f.calls.prints.reduce((sum, call) => sum + call.input.copies, 0), 500);
});

test('large batches retain validated images beyond the preview cache and reuse images across copy counts', async t => {
  const renders = [], prints = [];
  const f = await fixture(t, {
    async render(input) { renders.push(input); return Buffer.from(input.fields.sku); },
    async print(input, printer, image) { prints.push({ sku: input.fields.sku, copies: input.copies, image: image?.toString() }); },
  });
  await selectPrinter(f);
  const first = item('cached', 3);
  assert.equal((await f.api('/api/preview', { method: 'POST', body: { fields: first.fields } })).status, 200);
  const items = [first, { ...first, copies: 7 }, ...Array.from({ length: 25 }, (_, i) => item(i))];
  const id = 'batch-reuse-prepared-images-001';
  await f.api('/api/batches', { method: 'POST', body: { requestId: id, items } });
  assert.equal((await waitForBatch(f, id)).status, 'submitted');
  assert.equal(renders.length, 26, 'Copy quantities must not cause extra renders.');
  assert.deepEqual(prints, items.map(item => ({ sku: item.fields.sku, copies: item.copies, image: item.fields.sku })));
});

test('active batch deduplicates retries and reserves the printer during validation and submission', async t => {
  let releaseRender, releasePrint;
  let markRender, markPrint;
  const rendering = new Promise(resolve => { markRender = resolve; });
  const printing = new Promise(resolve => { markPrint = resolve; });
  const renderGate = new Promise(resolve => { releaseRender = resolve; });
  const printGate = new Promise(resolve => { releasePrint = resolve; });
  let printCount = 0;
  const f = await fixture(t, {
    async render() { markRender(); await renderGate; return Buffer.from('PNG'); },
    async print() { printCount++; markPrint(); await printGate; },
  });
  await selectPrinter(f);
  const body = { requestId: 'batch-active-reservation-01', items: [item('one'), item('two')] };
  try {
    assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
    await rendering;
    for (const stage of ['validating', 'printing']) {
      const repeated = await f.api('/api/batches', { method: 'POST', body });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.data.batch.id, body.requestId);
      assert.equal(repeated.data.batch.status, stage);
      assert.equal((await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'single-while-batch-0001' } })).status, 409);
      assert.equal((await f.api('/api/printer', { method: 'POST', body: { printerName: printerNames[1] } })).status, 409);
      assert.equal((await f.api('/api/batches', { method: 'POST', body: { ...body, requestId: 'batch-other-reservation-01' } })).status, 409);
      if (stage === 'validating') { releaseRender(); await printing; }
    }
    assert.equal(printCount, 1);
  } finally { releaseRender(); releasePrint(); }
  assert.equal((await waitForBatch(f, body.requestId)).status, 'submitted');
  assert.equal(printCount, 2);
  await waitForPrinterRelease(f);
});

test('one product that cannot render prevents every product in its batch from printing', async t => {
  let renderCount = 0;
  const f = await fixture(t, {
    async render() {
      renderCount++;
      if (renderCount === 2) throw new Error('Product name does not fit on the label.');
      return Buffer.from('PNG');
    },
  });
  await selectPrinter(f);
  const body = { requestId: 'batch-preflight-failure-01', items: [item('first'), item('second'), item('third')] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
  const batch = await waitForBatch(f, body.requestId);
  assert.equal(batch.status, 'failed');
  assert.ok(batch.items.every(entry => entry.status === 'not_sent'));
  assert.match(JSON.stringify(batch), /does not fit/);
  assert.equal(f.calls.prints.length, 0);
  assert.deepEqual((await f.api('/api/jobs')).data.jobs, []);
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 200);
  assert.equal(renderCount, 2, 'Retrying the same failed batch must not restart it.');
  await waitForPrinterRelease(f);
});

test('ambiguous printer failure stops remaining batch items and cannot be replayed', async t => {
  const printed = [];
  const f = await fixture(t, {
    async print(input) { printed.push(input.fields.sku); if (printed.length === 2) throw new Error('Spooler stopped responding.'); },
  });
  await selectPrinter(f);
  const body = { requestId: 'batch-spooler-failure-01', items: [item('first'), item('second'), item('third')] };
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
  const batch = await waitForBatch(f, body.requestId);
  assert.equal(batch.status, 'stopped');
  assert.deepEqual(batch.items.map(entry => entry.status), ['submitted', 'unknown', 'not_sent']);
  assert.deepEqual(printed, ['SKU-first', 'SKU-second']);
  assert.match(JSON.stringify(batch), /Windows print queue/i);
  const jobs = (await f.api('/api/jobs')).data.jobs;
  assert.deepEqual(jobs.map(job => job.status), ['unknown', 'submitted']);
  assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 200);
  assert.equal(printed.length, 2);
});

test('restart interrupts saved batches, preserves submitted rows, and never resumes automatically', async t => {
  for (const phase of ['validating', 'printing']) {
    await t.test(phase, async t => {
      const f = await fixture(t);
      await selectPrinter(f);
      const body = { requestId: `batch-restart-${phase}-01`, items: [item('first'), item('second'), item('third')] };
      assert.equal((await f.api('/api/batches', { method: 'POST', body })).status, 202);
      assert.equal((await waitForBatch(f, body.requestId)).status, 'submitted');
      // Finish the real worker's durable write before replacing its file with
      // the simulated interrupted state. Closing HTTP alone does not do that.
      await waitForPrinterRelease(f);
      await f.close();
      const path = join(f.dataDir, 'batches.json');
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const batch = saved.find(entry => entry.id === body.requestId);
      assert.ok(batch, 'The accepted batch must be persisted by request ID.');
      batch.status = phase;
      batch.items.forEach((entry, index) => { entry.status = phase === 'validating' ? 'pending' : ['submitted', 'submitting', 'pending'][index]; });
      await writeFile(path, JSON.stringify(saved));
      const restarted = await fixture(t, {}, f.dataDir);
      try {
        const recovered = await waitForBatch(restarted, body.requestId);
        assert.equal(recovered.status, 'interrupted');
        assert.deepEqual(recovered.items.map(entry => entry.status), phase === 'validating' ? ['not_sent', 'not_sent', 'not_sent'] : ['submitted', 'unknown', 'not_sent']);
        const repeated = await restarted.api('/api/batches', { method: 'POST', body });
        assert.equal(repeated.status, 200);
        assert.equal(repeated.data.batch.status, 'interrupted');
        assert.equal(restarted.calls.renders.length, 0);
        assert.equal(restarted.calls.prints.length, 0);
      } finally { await restarted.close(); }
    });
  }
});
