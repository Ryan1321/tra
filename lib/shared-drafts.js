import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { WAYBILL_FIELDS } from '../public/waybill-model.js';
import { calculateReceipt } from '../public/tra-model.js';
import { DEFAULT_LABEL_LAYOUT, getLabelVariation } from '../public/label-layouts.js';

const bad = message => Object.assign(new Error(message), { status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 200) => {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw bad('Draft fields must be bounded, single-line text.');
  return value; // Preserve incomplete input, spaces, and leading zeros while typing.
};
const fields = (value, limits) => {
  if (!object(value)) throw bad('Invalid draft fields.');
  return Object.fromEntries(Object.entries(limits).map(([key, maximum]) => [key, text(value[key], maximum)]));
};
const labelLimits = { productName: 200, price: 64, sku: 100, barcode: 100 };
const detailLimits = { receiptNumber: 21, recipientName: 100, recipientAddress: 180, receiptDate: 10, agreementStart: 10, agreementEnd: 10 };
const itemLimits = { description: 100, barcode: 32, quantity: 16, unitPrice: 24 };
const id = value => { if (!Number.isSafeInteger(value) || value < 1) throw bad('Invalid receipt item ID.'); return value; };

export function emptyDraft(kind) {
  if (kind === 'waybill') return Object.fromEntries([0, 1].flatMap(index => WAYBILL_FIELDS.map(field => [`${index}.${field.key}`, ''])));
  if (kind === 'tra') return { ...Object.fromEntries(Object.keys(detailLimits).map(key => [key, ''])), items: [], editor: { description: '', barcode: '', quantity: '1', unitPrice: '', editingId: null } };
  if (kind === 'stickers') return { ...Object.fromEntries(Object.keys(labelLimits).map(key => [key, ''])), copies: '1', formProductId: '', batch: { queue: [], editingId: '' }, labelLayout: DEFAULT_LABEL_LAYOUT };
  throw bad('Unknown draft page.');
}

export function validateDraft(kind, data) {
  if (kind === 'stickers' && object(data) && !Object.hasOwn(data, 'labelLayout')) data = { ...data, labelLayout: DEFAULT_LABEL_LAYOUT };
  const expected = Object.keys(emptyDraft(kind));
  if (!object(data) || Object.keys(data).length !== expected.length || expected.some(key => !Object.hasOwn(data, key))) throw bad('Invalid shared draft.');
  if (kind === 'waybill') return fields(data, Object.fromEntries([0, 1].flatMap(index => WAYBILL_FIELDS.map(field => [`${index}.${field.key}`, field.maximum]))));
  if (kind === 'tra') {
    const receipt = calculateReceipt(data.items);
    const items = receipt.items.map((item, index) => ({ ...item, id: id(data.items[index].id) }));
    if (new Set(items.map(item => item.id)).size !== items.length) throw bad('Receipt item IDs must be unique.');
    const editor = { ...fields(data.editor, itemLimits), editingId: data.editor.editingId === null ? null : id(data.editor.editingId) };
    return { ...fields(data, detailLimits), items, editor };
  }
  if (!object(data.batch) || !Array.isArray(data.batch.queue) || data.batch.queue.length > 50) throw bad('A draft batch holds at most 50 products.');
  const queue = data.batch.queue.map(item => {
    if (!object(item)) throw bad('Invalid draft batch item.');
    const entry = { id: text(item.id, 80), productId: text(item.productId || '', 80), fields: fields(item.fields, labelLimits), copies: text(String(item.copies), 16) };
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(entry.id)) throw bad('Invalid batch item ID.');
    return entry;
  });
  if (new Set(queue.map(item => item.id)).size !== queue.length) throw bad('Batch item IDs must be unique.');
  return { ...fields(data, labelLimits), copies: text(data.copies, 16), formProductId: text(data.formProductId, 80), batch: { queue, editingId: text(data.batch.editingId, 80) }, labelLayout: getLabelVariation(data.labelLayout).layout.version };
}

export async function createSharedDrafts({ dataDir, persist }) {
  const path = join(dataDir, 'shared-drafts.json');
  let saved = { version: 1, drafts: {} }, serial = Promise.resolve();
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read data/shared-drafts.json. Restore it before restarting.'); }
  if (saved.version !== 1 || !object(saved.drafts)) throw new Error('Invalid data/shared-drafts.json.');
  for (const [kind, draft] of Object.entries(saved.drafts)) {
    draft.data = validateDraft(kind, draft.data);
    if (!Number.isSafeInteger(draft.revision) || draft.revision < 1) throw new Error('Invalid shared draft revision.');
  }
  function get(kind) {
    const blank = emptyDraft(kind);
    return structuredClone(saved.drafts[kind] || { revision: 0, data: blank, updatedAt: null });
  }
  function update(kind, request) {
    const work = serial.catch(() => {}).then(async () => {
      const current = get(kind);
      if (!object(request) || !Number.isSafeInteger(request.revision) || request.revision < 0 || !Array.isArray(request.changes) || request.changes.length > Object.keys(current.data).length) throw bad('Invalid draft update.');
      const seen = new Set(), conflicts = [];
      const candidate = structuredClone(current.data);
      for (const change of request.changes) {
        if (!object(change) || !Object.hasOwn(current.data, change.key) || seen.has(change.key) || !Object.hasOwn(change, 'before') || !Object.hasOwn(change, 'value')) throw bad('Invalid draft change.');
        seen.add(change.key);
        if (!equal(current.data[change.key], change.before) && !equal(current.data[change.key], change.value)) conflicts.push(change.key);
        candidate[change.key] = change.value;
      }
      const data = validateDraft(kind, candidate);
      if (conflicts.length) return { conflict: true, conflicts, draft: current };
      if (equal(data, current.data)) return { draft: current };
      const draft = { revision: current.revision + 1, data, updatedAt: new Date().toISOString() };
      const next = { version: 1, drafts: { ...saved.drafts, [kind]: draft } };
      // Publish only after an atomic file replacement succeeds. Both listeners
      // share this store; a failed write leaves the last acknowledged draft intact.
      try { await persist(path, next); } catch { throw Object.assign(new Error('The shared draft could not be saved on the PC. Your local draft is retained.'), { status: 503 }); }
      saved = next;
      return { draft: structuredClone(draft) };
    });
    serial = work;
    return work;
  }
  return { get, update };
}
