import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedDrafts, emptyDraft, validateDraft } from '../lib/shared-drafts.js';
import { createService } from '../server.js';

async function fixture(t) {
  const dataDir = await mkdtemp(fileURLToPath(new URL('../.sync-test-', import.meta.url)));
  t.after(() => rm(dataDir, { recursive: true, force: true })); // Exact workspace mkdtemp path.
  let fail = false;
  const options = { dataDir, persist: async (path, value) => { if (fail) throw Error('Disk unavailable'); await writeFile(path, JSON.stringify(value)); } };
  return { store: await createSharedDrafts(options), options, dataDir, failWrites: () => { fail = true; } };
}
const edit = (draft, values) => ({ revision: draft.revision, changes: Object.entries(values).map(([key, value]) => ({ key, before: draft.data[key], value })) });

test('existing shared sticker drafts migrate to original stock and preserve all fields when switching sizes', async t => {
  const f = await fixture(t);
  const old = emptyDraft('stickers'); delete old.labelLayout; old.barcode = '000086'; old.productName = 'Saved product';
  await writeFile(join(f.dataDir, 'shared-drafts.json'), JSON.stringify({ version: 1, drafts: { stickers: { revision: 5, data: old } } }));
  const store = await createSharedDrafts(f.options);
  assert.equal(store.get('stickers').data.labelLayout, 'paired-v3');
  const result = await store.update('stickers', edit(store.get('stickers'), { labelLayout: 'paired-1p25x1-v1' }));
  assert.equal(result.draft.data.barcode, '000086'); assert.equal(result.draft.data.productName, 'Saved product');
  await assert.rejects(store.update('stickers', edit(result.draft, { labelLayout: 'unknown' })));
  assert.equal((await createSharedDrafts(f.options)).get('stickers').data.labelLayout, 'paired-1p25x1-v1');
});

test('shared drafts preserve incomplete input and zeros, isolate pages, and survive a service restart', async t => {
  const f = await fixture(t);
  for (const [kind, changes] of [['waybill', { '0.number': '00330', '1.phone': '09123456789' }], ['tra', { recipientName: '  Name being typed ', receiptNumber: '00' }], ['stickers', { productName: 'Spoon ', price: '125.', barcode: '000086', copies: '' }]]) {
    const original = f.store.get(kind);
    const { draft } = await f.store.update(kind, edit(original, changes));
    assert.equal(draft.revision, 1);
    for (const [key, value] of Object.entries(changes)) assert.equal(draft.data[key], value);
    const restarted = await createSharedDrafts(f.options);
    assert.deepEqual(restarted.get(kind), draft);
  }
  assert.equal(f.store.get('waybill').data['1.number'], '');
});

test('concurrent edits of different fields merge; same-field changes require a choice and cannot erase unrelated content', async t => {
  const { store } = await fixture(t);
  const blank = store.get('waybill');
  const [first, second] = await Promise.all([
    store.update('waybill', edit(blank, { '0.recipient': 'Phone user' })),
    store.update('waybill', edit(blank, { '0.phone': '09111111111' })),
  ]);
  assert.equal(first.draft.revision, 1); assert.equal(second.draft.revision, 2);
  const conflict = await store.update('waybill', edit(blank, { '0.recipient': 'Desktop user', '1.destination': 'Must not partially save' }));
  assert.equal(conflict.conflict, true); assert.deepEqual(conflict.conflicts, ['0.recipient']);
  assert.equal(store.get('waybill').data['1.destination'], '');
  const result = await store.update('waybill', edit(conflict.draft, { '0.recipient': 'Chosen name' }));
  assert.equal(result.draft.data['0.phone'], '09111111111');
});

test('repeating an acknowledged update is idempotent; disk failure retains the last acknowledged snapshot', async t => {
  const f = await fixture(t);
  const patch = edit(f.store.get('stickers'), { barcode: '000086' });
  const first = await f.store.update('stickers', patch);
  assert.deepEqual(await f.store.update('stickers', patch), first);
  f.failWrites();
  await assert.rejects(f.store.update('stickers', edit(first.draft, { barcode: '000087' })), /could not be saved/);
  assert.deepEqual(f.store.get('stickers'), first.draft);
});

test('TRA lists and editor state sync together while quantities and amounts remain validated', async t => {
  const { store } = await fixture(t);
  const initial = store.get('tra');
  const item = { id: 7, description: 'Spoon', barcode: '000086', quantity: 3, unitPrice: '0.10', amount: '999' };
  const result = await store.update('tra', edit(initial, { items: [item], editor: { description: 'Spoon', barcode: '000086', quantity: '4', unitPrice: '0.10', editingId: 7 } }));
  assert.equal(result.draft.data.items[0].amount, '0.30');
  assert.equal(result.draft.data.editor.editingId, 7);
  assert.equal(result.draft.data.editor.quantity, '4');
  await assert.rejects(store.update('tra', edit(result.draft, { items: Array(21).fill(item) })), /20/);
  await assert.rejects(store.update('tra', edit(result.draft, { items: [item, item] })), /unique/);
});

test('sticker batch drafts allow incomplete corrections and sync clears without affecting other pages', async t => {
  const { store } = await fixture(t);
  const batch = { queue: [{ id: 'product-0001', productId: '9', fields: { productName: 'Spoon', price: '', sku: '', barcode: '000086' }, copies: '' }], editingId: 'product-0001' };
  const result = await store.update('stickers', edit(store.get('stickers'), { batch }));
  assert.deepEqual(result.draft.data.batch, batch);
  assert.deepEqual(store.get('tra').data.items, []);
  const cleared = await store.update('stickers', edit(result.draft, emptyDraft('stickers')));
  assert.deepEqual(cleared.draft.data, emptyDraft('stickers'));
});

test('draft validation rejects unknown fields, paths, controls, duplicate changes and excessive payloads', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.get('../config'));
  assert.throws(() => validateDraft('waybill', {}));
  for (const changes of [[{ key: '__proto__', before: '', value: {} }], [{ key: '0.number', before: '', value: 'x'.repeat(100) }], [{ key: '0.recipient', before: '', value: 'a\nb' }], Array(2).fill({ key: '0.number', before: '', value: '4' })]) {
    await assert.rejects(store.update('waybill', { revision: 0, changes }));
  }
  assert.equal(store.get('waybill').revision, 0);
});

test('draft API requires pairing, rejects foreign origins, exposes conflicts and never invokes a printer', async t => {
  const f = await fixture(t);
  const fail = async () => assert.fail('Draft syncing must not access a printer.');
  const service = await createService({ dataDir: f.dataDir, port: 0, adapter: { listPrinters: fail, render: fail, print: fail }, receiptAdapter: { render: fail, print: fail }, waybillAdapter: { render: fail, print: fail } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve)); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (body, token = service.token, extra = {}) => fetch(base + '/api/drafts/waybill', { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request(null, '')).status, 401);
  const draft = (await (await request()).json()).draft;
  const patch = edit(draft, { '0.number': '0001' });
  assert.equal((await request(patch, '')).status, 401);
  assert.equal((await request(patch, service.token, { Origin: 'http://example.com' })).status, 403);
  assert.equal((await request(patch)).status, 200);
  const conflict = await request(edit(draft, { '0.number': '0002' }));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).draft.data['0.number'], '0001');
  assert.equal((await request({ padding: 'x'.repeat(200000) })).status, 413);
  assert.equal((await fetch(base + '/data/shared-drafts.json')).status, 404);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'shared-drafts.json'), 'utf8')).drafts.waybill.data['0.number'], '0001');
});
