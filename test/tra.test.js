import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReceipt, formatTraMoney, MAX_TRA_ITEMS } from '../public/tra-model.js';

const item = { quantity: 3, description: 'Salad spoon', barcode: '00001234', unitPrice: '0.10' };

test('TRA calculates exact cent totals, retains barcode zeros and normalizes peso prices', () => {
  const receipt = calculateReceipt([item, { ...item, quantity: '2', unitPrice: '₱ 1,234.50' }]);
  assert.equal(receipt.items[0].amount, '0.30');
  assert.equal(receipt.items[0].barcode, '00001234');
  assert.equal(receipt.items[1].unitPrice, '1234.50');
  assert.equal(receipt.items[1].amount, '2469.00');
  assert.equal(receipt.total, '2469.30');
  assert.equal(formatTraMoney(receipt.total), '2,469.30');
  assert.equal(formatTraMoney(receipt.total, { currency: true }), '₱ 2,469.30');
  assert.equal(calculateReceipt([{ ...item, unitPrice: '0' }]).total, '0.00');
});

test('TRA accepts a blank template and exactly twenty rows with bounded quantities', () => {
  assert.deepEqual(calculateReceipt([]), { items: [], total: '0.00' });
  const rows = Array.from({ length: MAX_TRA_ITEMS }, () => ({ ...item, quantity: 9999, unitPrice: '9999999.99' }));
  assert.equal(calculateReceipt(rows).items.length, 20);
  assert.equal(calculateReceipt(rows).total, '1999799998000.20');
  assert.throws(() => calculateReceipt([...rows, item]), /20 items/);
});

test('TRA rejects invalid prices, fractional quantities and unusable item fields', () => {
  for (const quantity of [0, -1, 1.5, '1e2', '01', 10000, true]) {
    assert.throws(() => calculateReceipt([{ ...item, quantity }]), /Item 1: Quantity/);
  }
  for (const unitPrice of ['-1', '$19', '1.999', '1,23', '1e3', '10000000', '', 199]) {
    assert.throws(() => calculateReceipt([{ ...item, unitPrice }]), /Item 1:/);
  }
  for (const change of [{ description: '' }, { description: 'x'.repeat(101) }, { barcode: '' }, { barcode: 'x'.repeat(33) }, { barcode: 'code\n123' }]) {
    assert.throws(() => calculateReceipt([{ ...item, ...change }]), /Item 1:/);
  }
});
