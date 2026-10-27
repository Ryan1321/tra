import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalog, parseCatalogQuery, validateCatalogBarcode, validateProductId } from '../lib/catalog.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const search = { query: '', page: 1, pageSize: 25 };

async function dataDirectory(t) {
  const dataDir = await mkdtemp(join(workspace, '.catalog-test-'));
  t.after(async () => {
    const absolute = resolve(dataDir);
    assert.ok(absolute.startsWith(resolve(workspace) + sep) && absolute.split(sep).at(-1).startsWith('.catalog-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  return dataDir;
}

test('catalog search accepts ordinary names, literal punctuation and bounded pagination', () => {
  assert.deepEqual(parseCatalogQuery(new URLSearchParams()), search);
  assert.deepEqual(parseCatalogQuery(new URLSearchParams({ q: '  Café 100%_="spoon"  ', page: '1000000', pageSize: '100' })), {
    query: 'Café 100%_="spoon"', page: 1000000, pageSize: 100,
  });
  assert.equal(parseCatalogQuery(new URLSearchParams({ q: 'a'.repeat(100) })).query.length, 100);
  for (const values of [
    { q: 'a'.repeat(101) }, { q: 'one\ntwo' }, { q: 'sku\u0000tail' }, { q: 'sku\u007f' },
    { page: '' }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '01' },
    { page: '1e2' }, { page: '1000001' }, { page: '99999999999999999999999999' },
    { pageSize: '0' }, { pageSize: '101' }, { pageSize: '25;SELECT 1' },
  ]) {
    assert.throws(() => parseCatalogQuery(new URLSearchParams(values)), error => error.status === 400, JSON.stringify(values));
  }
});

test('catalog selection validates the database row ID without substituting a barcode', () => {
  assert.equal(validateProductId('1'), '1');
  assert.equal(validateProductId('2147483647'), '2147483647');
  for (const id of [undefined, null, 1, '', '0', '01', '-1', '1.0', '1/2', '1 OR 1=1', '2147483648', '12345678901']) {
    assert.throws(() => validateProductId(id), error => error.status === 400, String(id));
  }
});

test('barcode lookup preserves leading zeros and literal characters and rejects invalid input', () => {
  for (const value of ['00123', '123', 'ABC-def', "100%_ OR '1'='1", 'a'.repeat(100)]) {
    assert.equal(validateCatalogBarcode(value), value);
  }
  for (const value of [undefined, null, 123, '', ' ', ' 123', '123 ', 'one\ntwo', '\n123', 'sku\u0000tail', 'sku\u007f', 'a'.repeat(101)]) {
    assert.throws(() => validateCatalogBarcode(value), error => error.status === 400, String(value));
  }
});

test('barcode lookup passes exact text separately from configuration and retains duplicate rows', async t => {
  const dataDir = await dataDirectory(t);
  const calls = [];
  const duplicate = { products: [
    { id: '7', productName: 'Spoon', price: '0', sku: 'S-7', barcode: '00123' },
    { id: '8', productName: 'Spoon alternate', price: '10', sku: 'S-8', barcode: '00123' },
  ], total: 2 };
  const catalog = createCatalog({ dataDir, execute: async (executable, payload) => { calls.push(payload); return duplicate; } });
  assert.deepEqual(await catalog.findByBarcode('00123'), duplicate);
  assert.equal(calls[0].action, 'barcode');
  assert.equal(calls[0].value, '00123');
  assert.equal(typeof calls[0].value, 'string');
  assert.throws(() => catalog.findByBarcode(''), error => error.status === 400);
  assert.throws(() => catalog.findByBarcode('123\n'), error => error.status === 400);
  assert.equal(calls.length, 1, 'Invalid scans must not launch PHP.');
});

test('catalog uses XAMPP defaults and reloads custom settings without exposing them in results', async t => {
  const dataDir = await dataDirectory(t);
  const calls = [];
  const result = { products: [{ id: '7', productName: 'Spoon', price: '0', sku: 'S-7', barcode: '100007' }], total: 1, page: 1, pageSize: 25, totalPages: 1 };
  const catalog = createCatalog({ dataDir, execute: async (executable, payload) => { calls.push({ executable, payload }); return result; } });
  assert.deepEqual(await catalog.search(search), result);
  assert.equal(calls[0].executable, 'C:\\xampp\\php\\php.exe');
  assert.deepEqual(calls[0].payload.config, {
    phpPath: 'C:\\xampp\\php\\php.exe', host: '127.0.0.1', port: 3306,
    database: 'products', table: 'products', user: 'root', password: '',
  });
  assert.equal(calls[0].payload.action, 'search');
  const custom = { phpPath: 'C:\\tools\\php.exe', port: 3307, database: 'shop_catalog', table: 'items', user: 'catalog_reader', password: 'test-only-password' };
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(custom));
  assert.deepEqual(await catalog.getProduct('7'), result);
  assert.equal(calls[1].executable, custom.phpPath);
  assert.deepEqual(calls[1].payload, { action: 'product', id: '7', config: { ...calls[0].payload.config, ...custom } });
  assert.equal(result.config, undefined);
});

test('invalid or malformed catalog settings fail before execution and do not echo secrets', async t => {
  const dataDir = await dataDirectory(t);
  let executions = 0;
  const catalog = createCatalog({ dataDir, execute: async () => { executions++; } });
  const invalid = [
    null, [], 'test-only-password', 7,
    { host: 'localhost;dbname=private' }, { port: '3306' }, { port: 0 }, { port: 65536 },
    { database: 'products` WHERE 1=1' }, { table: 'other.items' }, { user: null }, { password: 123 }, { phpPath: '' },
  ];
  for (const settings of invalid) {
    await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(settings));
    await assert.rejects(catalog.search(search), error => {
      assert.equal(error.status, 503);
      assert.match(error.message, /catalog settings.*data\/catalog\.json/i);
      assert.doesNotMatch(error.message, /test-only-password|private|WHERE 1=1|other\.items/);
      return true;
    });
  }
  await writeFile(join(dataDir, 'catalog.json'), '{"password":"test-only-password",');
  await assert.rejects(catalog.search(search), error => error.status === 503 && !error.message.includes('test-only-password'));
  assert.equal(executions, 0);
});

test('catalog limits simultaneous readers and releases capacity after a failed read', async t => {
  const dataDir = await dataDirectory(t);
  let release, markStarted, executions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const catalog = createCatalog({ dataDir, execute: async () => {
    const call = ++executions;
    if (call <= 4) {
      if (call === 4) markStarted();
      await gate;
      if (call === 1) throw Object.assign(new Error('Reader unavailable.'), { status: 503 });
    }
    return { products: [], total: 0, page: 1, pageSize: 25, totalPages: 0 };
  } });
  const pending = Promise.allSettled(Array.from({ length: 4 }, () => catalog.search(search)));
  await started;
  try {
    await assert.rejects(catalog.search(search), error => error.status === 429);
    assert.equal(executions, 4);
  } finally { release(); }
  const outcomes = await pending;
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await catalog.search(search)).total, 0);
  assert.equal(executions, 5);
});

test('missing PHP executable returns a helpful error without connection credentials', async t => {
  const dataDir = await dataDirectory(t);
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify({ phpPath: join(dataDir, 'missing-php.exe'), user: 'private-account', password: 'test-only-password' }));
  const catalog = createCatalog({ dataDir });
  await assert.rejects(catalog.search(search), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /XAMPP PHP was not found/);
    assert.doesNotMatch(error.message, /private-account|test-only-password|missing-php/);
    return true;
  });
});
