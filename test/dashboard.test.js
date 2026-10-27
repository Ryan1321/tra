import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../lib/dashboard.js';

test('dashboard totals use local calendar days, sent quantities, and whole sticker pairs', () => {
  const now = new Date(2026, 9, 6, 12);
  const job = (id, overrides = {}) => ({ id, createdAt: new Date(2026, 9, 6, 0, 1).toISOString(), status: 'submitted', copies: 3, labelsPerCopy: 2, fields: { productName: 'Sample', price: 'secret price' }, fingerprint: 'private', requestId: 'private', ...overrides });
  const result = buildDashboard({
    now, config: { selectedPrinter: 'Citizen', receiptPrinter: 'Epson', token: 'private' }, printBusy: true, documentBusy: false,
    stickers: [job('today'), job('yesterday', { createdAt: new Date(2026, 9, 5, 23, 59).toISOString(), copies: 99 }), job('unknown', { status: 'unknown' }), job('legacy', { labelsPerCopy: 1, copies: 7 })],
    receipts: [job('receipt', { copies: 2, receiptNumber: '00350' }), job('preparing', { status: 'preparing' })],
    waybills: [job('waybill', { copies: 4, waybillNumbers: ['001', '002'] }), job('failed', { status: 'failed' })],
    batches: [{ status: 'validating' }, { status: 'submitted' }],
  });
  assert.equal(result.date, '2026-10-06');
  assert.deepEqual(result.today, { stickerPairs: 3, documentSheets: 6, submissions: 4 });
  assert.equal(result.attentionToday, 2);
  assert.equal(result.activeJobs, 1); assert.equal(result.activeBatches, 1);
  assert.equal(result.printers.stickers.busy, true);
  assert.equal(result.activity.find(row => row.id === 'receipt').title, 'Receipt #00350');
  assert.equal(result.activity.find(row => row.id === 'waybill').title, 'Waybill #001 / #002');
  assert.doesNotMatch(JSON.stringify(result), /private|secret price|fingerprint|requestId/);
});

test('dashboard handles empty histories and caps activity at the latest eight valid jobs', () => {
  const input = { stickers: [], receipts: [], waybills: [], batches: [], config: {}, printBusy: false, documentBusy: false };
  const empty = buildDashboard(input);
  assert.deepEqual(empty.today, { stickerPairs: 0, documentSheets: 0, submissions: 0 });
  assert.equal(empty.printers.stickers.name, null); assert.deepEqual(empty.activity, []);
  const stickers = Array.from({ length: 12 }, (_, i) => ({ id: String(i), createdAt: new Date(2026, 9, 6, i).toISOString(), status: 'submitted', copies: 1, labelsPerCopy: 2 }));
  stickers.push({ id: 'invalid', createdAt: 'not-a-date' });
  assert.deepEqual(buildDashboard({ ...input, stickers }).activity.map(row => row.id), ['11', '10', '9', '8', '7', '6', '5', '4']);
});
