import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPesoPrice } from '../lib/price.js';
import { validateFields } from '../lib/validation.js';

test('every accepted price prints one peso sign and two decimal places', () => {
  for (const input of ['199', '199.0', '199.00', '₱199', '₱ 199.00', 'PHP 199', 'P199', '000199']) {
    assert.equal(formatPesoPrice(input), '₱ 199.00');
  }
  assert.equal(formatPesoPrice('0'), '₱ 0.00');
  assert.equal(formatPesoPrice('1234.5'), '₱ 1,234.50');
  assert.equal(formatPesoPrice('1,234.50'), '₱ 1,234.50');
  assert.equal(formatPesoPrice('1234567890123456.01'), '₱ 1,234,567,890,123,456.01');
});

test('price validation rejects ambiguous amounts and other currencies', () => {
  for (const input of ['free', '$199', '-1', '1.234', '12,34', '1e3', '₱ ₱ 199', '199 PHP', '']) {
    assert.throws(() => formatPesoPrice(input), /peso amount/);
  }
  assert.equal(validateFields({ price: '199', productName: 'Mug', sku: 'MUG-01', barcode: '000123' }).fields.price, '₱ 199.00');
});
