import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const fields = { price: '199.00', productName: 'Sample shirt', sku: 'SKU-001', barcode: '00001234' };
const names = ['Citizen CL-S331', 'Citizen CL-S331 backup'];

async function fixture(t, overrides = {}, { initialJobs, catalog } = {}) {
  const dataDir = await mkdtemp(join(workspace, '.label-test-'));
  if (initialJobs) await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(initialJobs));
  const calls = { renders: [], prints: [] };
  const adapter = {
    async listPrinters() { return { printers: names.map(name => ({ name })) }; },
    async render(input) { calls.renders.push(input); return Buffer.from('PNG stub'); },
    async print(input, printer) { calls.prints.push({ input, printer }); },
    ...overrides,
  };
  const service = await createService({ dataDir, adapter, catalog, port: 0 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  service.setPort(service.server.address().port);
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
    const absolute = resolve(dataDir);
    assert.ok(absolute.startsWith(resolve(workspace) + sep) && absolute.split(sep).at(-1).startsWith('.label-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  async function api(path, { method = 'GET', body, headers = {}, token = service.token } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = response.headers.get('content-type');
    const data = contentType?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  return { service, dataDir, calls, api, base };
}

async function selectPrinter(f) {
  assert.equal((await f.api('/api/printer', { method: 'POST', body: { printerName: names[0] } })).status, 200);
}

test('dashboard requires pairing and loads without contacting a printer or database', async t => {
  let lookups = 0;
  const f = await fixture(t, { async listPrinters() { lookups++; throw new Error('Driver unavailable'); } });
  assert.equal((await f.api('/api/dashboard', { token: null })).status, 401);
  const status = await f.api('/api/status?includePrinters=false');
  assert.equal(status.status, 200); assert.equal(status.data.pairedRequired, false);
  const result = await f.api('/api/dashboard');
  assert.equal(result.status, 200); assert.deepEqual(result.data.activity, []);
  assert.deepEqual(result.data.today, { stickerPairs: 0, documentSheets: 0, submissions: 0 });
  assert.equal(lookups, 0); assert.equal(f.calls.prints.length, 0);
  for (const path of ['/dashboard', '/dashboard/', '/dashboard.js', '/dashboard.css']) assert.equal((await f.api(path, { token: null })).status, 200);
});

test('dashboard reflects newly sent copies and duplicate requests do not inflate totals', async t => {
  const f = await fixture(t); await selectPrinter(f);
  const body = { fields, copies: 20, requestId: 'dashboard-totals-request-001' };
  for (let i = 0; i < 2; i++) assert.equal((await f.api('/api/print', { method: 'POST', body })).status, 200);
  const result = (await f.api('/api/dashboard')).data;
  assert.equal(result.today.stickerPairs, 20); assert.equal(result.today.submissions, 1);
  assert.equal(result.activity[0].title, fields.productName); assert.equal(result.activity[0].href, '/');
  assert.equal(result.printers.stickers.name, names[0]); assert.equal(f.calls.prints.length, 1);
});

test('sticker variations separate preview caches, preserve print size, and prevent request IDs changing stock', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const compact = 'paired-1p25x1-v1';
  for (const labelLayout of ['paired-v3', compact, compact]) assert.equal((await f.api('/api/preview', { method: 'POST', body: { fields, labelLayout } })).status, 200);
  assert.deepEqual(f.calls.renders.map(input => input.widthDots), [900, 750]);
  const body = { fields, copies: 3, requestId: 'compact-print-request-001', labelLayout: compact };
  const result = await f.api('/api/print', { method: 'POST', body });
  assert.equal(result.data.job.status, 'submitted'); assert.equal(result.data.job.layoutVersion, compact);
  assert.equal(f.calls.prints[0].input.widthDots, 750); assert.equal(f.calls.prints[0].input.copies, 3);
  assert.equal(f.calls.renders.length, 2, 'Reuse the compact preview only.');
  assert.equal((await f.api('/api/print', { method: 'POST', body })).data.duplicate, true);
  assert.equal((await f.api('/api/print', { method: 'POST', body: { ...body, labelLayout: 'paired-v3' } })).status, 409);
  assert.equal((await f.api('/api/print', { method: 'POST', body: { ...body, labelLayout: 'unsupported' } })).status, 400);
  assert.equal(f.calls.prints.length, 1);
});

test('simultaneous previews share rendering and printing reuses the exact validated image', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const rendering = new Promise(resolve => { started = resolve; });
  const png = Buffer.from('same validated image');
  let renders = 0;
  const printed = [];
  const f = await fixture(t, {
    async render() { renders++; started(); await gate; return png; },
    async print(input, printer, image) { printed.push({ input, image }); return { timings: { submitMs: 12 } }; },
  });
  await selectPrinter(f);
  const previews = Array.from({ length: 3 }, () => f.api('/api/preview', { method: 'POST', body: { fields } }));
  await rendering;
  release();
  for (const response of await Promise.all(previews)) assert.equal(response.status, 200);
  assert.equal(renders, 1);
  const result = await f.api('/api/print', { method: 'POST', body: { fields, copies: 7, requestId: 'reuse-preview-request-001' } });
  assert.equal(result.data.job.status, 'submitted');
  assert.equal(result.data.job.timings.submitMs, 12);
  assert.equal(renders, 1, 'Printing must not render the preview again.');
  assert.equal(printed[0].image, png);
  assert.equal(printed[0].input.copies, 7);
});

test('a failed preview releases the shared render so corrected or repeated requests can recover', async t => {
  let count = 0;
  const f = await fixture(t, { render() { if (++count === 1) throw new Error('Temporary renderer failure'); return Buffer.from('recovered'); } });
  assert.equal((await f.api('/api/preview', { method: 'POST', body: { fields } })).status, 400);
  assert.equal((await f.api('/api/preview', { method: 'POST', body: { fields } })).status, 200);
  assert.equal(count, 2);
});

test('document catalog pairing on the PC does not wait for the sticker printer', async t => {
  let printerLookups = 0;
  const f = await fixture(t, { async listPrinters() { printerLookups++; throw new Error('Printer offline'); } });
  const setup = await f.api('/api/setup?includePrinters=false', { token: null });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.token, f.service.token);
  assert.equal(setup.data.pairCode, f.service.pairCode);
  assert.equal(setup.data.printers, undefined);
  assert.equal(printerLookups, 0);
});

test('catalog routes require pairing and pass validated search values to the reader', async t => {
  const searches = [];
  let productReads = 0;
  const page = { products: [{ id: '1', ...fields }], total: 251, page: 1, pageSize: 25, totalPages: 11 };
  const catalog = {
    async search(options) { searches.push(options); return page; },
    async getProduct() { productReads++; return { product: { id: '1', ...fields } }; },
  };
  const f = await fixture(t, {}, { catalog });
  for (const path of ['/api/products', '/api/products/1']) assert.equal((await f.api(path, { token: null })).status, 401);
  assert.equal(searches.length, 0);
  assert.equal(productReads, 0);
  const response = await f.api('/api/products');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, page);
  assert.deepEqual(searches[0], { query: '', page: 1, pageSize: 25 });
  const query = "100%_ spoon' OR 1=1 --";
  await f.api('/api/products?' + new URLSearchParams({ q: `  ${query}  `, page: '2', pageSize: '10' }));
  assert.deepEqual(searches[1], { query, page: 2, pageSize: 10 });
  for (const suffix of ['?page=0', '?pageSize=101', '?q=' + 'a'.repeat(101), '?q=one%0Atwo']) {
    assert.equal((await f.api('/api/products' + suffix)).status, 400);
  }
  assert.equal(searches.length, 2, 'Invalid requests must not start a database reader.');
  assert.equal((await f.api('/api/products', { method: 'POST', body: {} })).status, 404);
  assert.equal(f.calls.renders.length, 0);
  assert.equal(f.calls.prints.length, 0);
});

test('catalog selection fetches current details by row ID and reports deleted or invalid rows', async t => {
  const ids = [];
  const products = new Map([
    ['102', { id: '102', ...fields, barcode: '100136', price: '199' }],
    ['103', { id: '103', ...fields, barcode: '100136', price: '219', sku: 'OTHER-103' }],
  ]);
  const catalog = {
    async search() { return { products: [...products.values()], total: 2, page: 1, pageSize: 25, totalPages: 1 }; },
    async getProduct(id) {
      ids.push(id);
      if (!products.has(id)) throw Object.assign(new Error('This product is no longer in the catalog. Refresh the list.'), { status: 404 });
      return { product: products.get(id) };
    },
  };
  const f = await fixture(t, {}, { catalog });
  await f.api('/api/products');
  products.set('103', { ...products.get('103'), price: '229' });
  const selected = await f.api('/api/products/103');
  assert.equal(selected.status, 200);
  assert.equal(selected.data.product.price, '229');
  assert.equal(selected.data.product.sku, 'OTHER-103', 'Products sharing a barcode must stay distinct.');
  products.delete('103');
  assert.equal((await f.api('/api/products/103')).status, 404);
  for (const path of ['/api/products/', '/api/products/0', '/api/products/01', '/api/products/2147483648', '/api/products/102/extra', '/api/products/1%20OR%201=1']) {
    assert.equal((await f.api(path)).status, 400, path);
  }
  assert.deepEqual(ids, ['103', '103']);
  assert.equal(f.calls.prints.length, 0, 'Selecting a catalog product must not print it.');
});

test('exact barcode lookup requires pairing and distinguishes missing, unique and duplicate products', async t => {
  const scans = [];
  let unavailable = false;
  const products = [
    { id: '1', ...fields, barcode: '00123' },
    { id: '2', ...fields, barcode: '123', sku: 'SKU-002' },
    { id: '3', ...fields, barcode: '123', sku: 'SKU-003' },
  ];
  const catalog = {
    async findByBarcode(value) {
      scans.push(value);
      if (unavailable) throw Object.assign(new Error('Cannot connect to the product catalog. Start MySQL in XAMPP.'), { status: 503 });
      const matches = products.filter(product => product.barcode === value);
      return { products: matches, total: matches.length };
    },
    async getProduct() { assert.fail('The barcode route must precede the product ID route.'); },
  };
  const f = await fixture(t, {}, { catalog });
  const path = value => '/api/products/barcode?' + new URLSearchParams({ value });
  assert.equal((await f.api(path('00123'), { token: null })).status, 401);
  assert.deepEqual(scans, []);
  const unique = await f.api(path('00123'));
  assert.equal(unique.status, 200);
  assert.deepEqual(unique.data, { products: [products[0]], total: 1 });
  const duplicates = await f.api(path('123'));
  assert.equal(duplicates.status, 200);
  assert.deepEqual(duplicates.data, { products: products.slice(1), total: 2 });
  const missing = await f.api(path("123%_ OR '1'='1"));
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data, { products: [], total: 0 });
  assert.deepEqual(scans, ['00123', '123', "123%_ OR '1'='1"]);
  for (const invalid of ['', ' 00123', '00123 ', '00123\n', '001\u000023', 'a'.repeat(101)]) {
    assert.equal((await f.api(path(invalid))).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await f.api('/api/products/barcode')).status, 400);
  assert.equal(scans.length, 3);
  unavailable = true;
  const failure = await f.api(path('00123'));
  assert.equal(failure.status, 503);
  assert.match(failure.data.error, /Start MySQL/);
  assert.equal(f.calls.renders.length, 0);
  assert.equal(f.calls.prints.length, 0, 'Scanning must not print a sticker.');
});

test('catalog outage leaves manual preview and printing available and can recover without restart', async t => {
  let unavailable = true;
  const catalog = {
    async search() {
      if (unavailable) throw Object.assign(new Error('Cannot connect to the product catalog. Start MySQL in XAMPP.'), { status: 503 });
      return { products: [], total: 0, page: 1, pageSize: 25, totalPages: 0 };
    },
    async getProduct() { throw Object.assign(new Error('The catalog is busy. Try again.'), { status: 429 }); },
  };
  const f = await fixture(t, {}, { catalog });
  const failure = await f.api('/api/products');
  assert.equal(failure.status, 503);
  assert.match(failure.data.error, /Start MySQL/);
  assert.equal((await f.api('/api/products/1')).status, 429);
  const preview = await f.api('/api/preview', { method: 'POST', body: { fields } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /^image\/png/);
  await selectPrinter(f);
  const printed = await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'catalog-outage-print-001' } });
  assert.equal(printed.status, 200);
  assert.equal(printed.data.job.status, 'submitted');
  assert.equal(f.calls.prints.length, 1);
  unavailable = false;
  const recovered = await f.api('/api/products');
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data.products, []);
});

test('service protects API with pairing, validates origins and hosts, and hides job data before pairing', async t => {
  const f = await fixture(t);
  const status = await f.api('/api/status', { token: null });
  assert.equal(status.status, 200);
  assert.equal(status.data.pairedRequired, true);
  assert.equal(status.data.recentJobs, undefined);
  assert.equal((await f.api('/api/jobs', { token: null })).status, 401);
  assert.equal((await f.api('/api/pair', { method: 'POST', token: null, body: { code: 'wrong' } })).status, 401);
  const pair = await f.api('/api/pair', { method: 'POST', token: null, body: { code: f.service.pairCode } });
  assert.equal(pair.data.token, f.service.token);
  assert.equal((await f.api('/api/jobs', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.base + '/api/setup', { headers: { Host: 'rebinding.example:4173' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await f.api('/api/status', { headers: { Origin: f.base } })).status, 200);
});

test('pairing rate limit applies after ten unsuccessful attempts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.api('/api/pair', { method: 'POST', token: null, body: { code: 'wrong' } })).status, 401);
  assert.equal((await f.api('/api/pair', { method: 'POST', token: null, body: { code: f.service.pairCode } })).status, 429);
});

test('print preserves copies and data and deduplicates matching requests, including after response', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const body = { fields, copies: 3, requestId: 'request-0000000001' };
  const first = await f.api('/api/print', { method: 'POST', body });
  assert.equal(first.status, 200);
  assert.equal(first.data.job.status, 'submitted');
  const repeated = await f.api('/api/print', { method: 'POST', body });
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.job.id, first.data.job.id);
  assert.equal(f.calls.prints.length, 1);
  assert.equal(f.calls.prints[0].input.copies, 3);
  assert.equal(f.calls.prints[0].input.fields.barcode, '00001234');
  assert.equal(f.calls.prints[0].input.fields.price, '₱ 199.00');
  const equivalentPrice = await f.api('/api/print', { method: 'POST', body: { ...body, fields: { ...fields, price: '₱199' } } });
  assert.equal(equivalentPrice.data.duplicate, true);
  assert.equal(f.calls.prints.length, 1);
  const conflict = await f.api('/api/print', { method: 'POST', body: { ...body, copies: 4 } });
  assert.equal(conflict.status, 409);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(saved[0].status, 'submitted');
  assert.equal(saved[0].requestId, body.requestId);
});

test('one copy sends one whole sticker pair and uses the same layout as the preview', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const status = await f.api('/api/status');
  assert.equal(status.data.label.labelsPerCopy, 2);
  assert.equal(status.data.label.editableTemplate, 2);
  assert.equal(status.data.label.widthInches, 3);
  assert.equal(status.data.label.heightInches, 1);
  const preview = await f.api('/api/preview', { method: 'POST', body: { fields } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /^image\/png/);
  for (const copies of [1, 3]) {
    const response = await f.api('/api/print', { method: 'POST', body: { fields, copies, requestId: `paired-request-000${copies}` } });
    assert.equal(response.status, 200);
    assert.equal(response.data.job.copies, copies);
    assert.equal(response.data.job.labelsPerCopy, 2);
    assert.equal(response.data.job.layoutVersion, status.data.label.layoutVersion);
    const submitted = f.calls.prints.at(-1).input;
    const { copies: submittedCopies, ...renderedInput } = submitted;
    assert.equal(submittedCopies, copies, 'Each requested copy is a complete row; the service must not double the quantity.');
    assert.deepEqual(renderedInput, f.calls.renders[0]);
    assert.equal(submitted.widthDots, 900);
    assert.equal(submitted.heightDots, 300);
    assert.ok(submitted.barcode.widthDots <= submitted.layout.templateWidthDots);
  }
  assert.equal(f.calls.prints.length, 2);
  const history = (await f.api('/api/jobs')).data.jobs;
  assert.deepEqual(history.map(job => [job.copies, job.labelsPerCopy]), [[3, 2], [1, 2]]);
});

test('legacy single-label history keeps its original quantity and cannot reuse its request ID for a pair', async t => {
  const legacy = {
    id: 'legacy-single-label', requestId: 'legacy-request-0001',
    fingerprint: createHash('sha256').update(JSON.stringify({ fields, copies: 3 })).digest('hex'),
    createdAt: '2026-09-15T00:00:00.000Z', status: 'submitted', fields, copies: 3, printer: names[0],
  };
  const f = await fixture(t, {}, { initialJobs: [legacy] });
  await selectPrinter(f);
  for (const history of [(await f.api('/api/jobs')).data.jobs, (await f.api('/api/status')).data.recentJobs]) {
    assert.equal(history.length, 1);
    assert.equal(history[0].copies, 3);
    assert.equal(history[0].labelsPerCopy, undefined, 'Existing single-label jobs must not become three pairs.');
    assert.equal(history[0].layoutVersion, undefined);
    assert.equal(history[0].requestId, undefined);
    assert.equal(history[0].fingerprint, undefined);
  }
  const reused = await f.api('/api/print', { method: 'POST', body: { fields, copies: 3, requestId: legacy.requestId } });
  assert.equal(reused.status, 409);
  assert.match(reused.data.error, /different label/);
  assert.equal(f.calls.prints.length, 0);
  assert.equal(f.calls.renders.length, 0);
  const fresh = await f.api('/api/print', { method: 'POST', body: { fields, copies: 3, requestId: 'paired-request-new001' } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.job.labelsPerCopy, 2);
  assert.equal(f.calls.prints.length, 1);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.deepEqual(saved[0], legacy, 'Printing a pair must leave the historical single-label job unchanged.');
  assert.equal(saved[1].labelsPerCopy, 2);
});

test('ambiguous printer failure is recorded and matching retry cannot submit another label', async t => {
  let printCount = 0;
  const f = await fixture(t, { async print() { printCount++; throw new Error('Spooler stopped responding.'); } });
  await selectPrinter(f);
  const body = { fields, copies: 1, requestId: 'request-0000000002' };
  const response = await f.api('/api/print', { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.equal(response.data.job.status, 'unknown');
  assert.match(response.data.job.error, /Check the Windows print queue/);
  assert.equal((await f.api('/api/print', { method: 'POST', body })).data.duplicate, true);
  assert.equal(printCount, 1);
});

test('another print cannot overtake a pending printer submission', async t => {
  let release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let printCount = 0;
  const f = await fixture(t, { async print() { printCount++; markStarted(); await gate; } });
  await selectPrinter(f);
  const first = f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'request-0000000003' } });
  await started;
  try {
    const repeated = await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'request-0000000003' } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.duplicate, true);
    assert.equal(repeated.data.job.status, 'submitting');
    const second = await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'request-0000000004' } });
    assert.equal(second.status, 409);
    assert.equal(printCount, 1);
  } finally { release(); }
  assert.equal((await first).data.job.status, 'submitted');
});

test('invalid copies, oversized input, and unselected printer never submit a job', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'request-0000000005' } })).status, 400);
  await selectPrinter(f);
  for (const copies of [0, 101, 2.2, '1']) assert.equal((await f.api('/api/print', { method: 'POST', body: { fields, copies, requestId: 'request-0000000005' } })).status, 400);
  assert.equal((await f.api('/api/preview', { method: 'POST', body: { fields, padding: 'x'.repeat(9000) } })).status, 413);
  assert.equal(f.calls.prints.length, 0);
});

test('render failure stops printing before a job is recorded', async t => {
  const f = await fixture(t, { async render() { throw new Error('Product name does not fit on the label.'); } });
  await selectPrinter(f);
  const response = await f.api('/api/print', { method: 'POST', body: { fields, copies: 1, requestId: 'request-0000000007' } });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /does not fit/);
  assert.equal(f.calls.prints.length, 0);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(saved.length, 0);
});

test('UTF-8 product names survive a network chunk split within a multibyte character', async t => {
  const f = await fixture(t);
  const unicodeFields = { ...fields, productName: '商品 Café' };
  const payload = Buffer.from(JSON.stringify({ fields: unicodeFields }), 'utf8');
  const split = payload.indexOf(Buffer.from('商')) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/preview', { method: 'POST', headers: { Authorization: `Bearer ${f.service.token}`, 'Content-Type': 'application/json' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 25);
  });
  assert.equal(response, 200);
  assert.equal(f.calls.renders[0].fields.productName, unicodeFields.productName);
});

test('concurrent printer selections persist a complete config and report success or explicit busy', async t => {
  const f = await fixture(t);
  await f.api('/api/status');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.api('/api/printer', { method: 'POST', body: { printerName: names[i % names.length] } })));
  for (const result of results) assert.ok([200, 409].includes(result.status), JSON.stringify(result));
  const saved = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.ok(names.includes(saved.selectedPrinter));
  assert.equal(saved.token, f.service.token);
});

test('service restart marks an interrupted submission unknown and retains request deduplication', async t => {
  const f = await fixture(t);
  await selectPrinter(f);
  const body = { fields, copies: 1, requestId: 'request-0000000006' };
  await f.api('/api/print', { method: 'POST', body });
  const saved = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  saved[0].status = 'submitting';
  await writeFile(join(f.dataDir, 'jobs.json'), JSON.stringify(saved));
  let printCount = 0;
  const restarted = await createService({ dataDir: f.dataDir, adapter: { async listPrinters() { return { printers: names.map(name => ({ name })) }; }, async render() { return Buffer.from('PNG'); }, async print() { printCount++; } }, port: 0 });
  await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
  restarted.setPort(restarted.server.address().port);
  t.after(async () => { restarted.server.closeAllConnections(); await new Promise(resolve => restarted.server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/print`, { method: 'POST', headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(result.duplicate, true);
  assert.equal(result.job.status, 'unknown');
  assert.equal(printCount, 0);
});
