import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCode128 as encodeAtWidth } from '../lib/barcode.js';
import { validateCopies, validateFields } from '../lib/validation.js';

// Test the physical sticker explicitly; the encoder's editable default may differ.
const encodeCode128 = value => encodeAtWidth(value, 438);

function decodeSymbols(codes) {
  let set = codes[0] === 105 ? 'C' : 'B';
  let decoded = '';
  for (const code of codes.slice(1, -2)) {
    if (set === 'B' && code === 99) set = 'C';
    else if (set === 'C' && code === 100) set = 'B';
    else decoded += set === 'B' ? String.fromCharCode(code + 32) : String(code).padStart(2, '0');
  }
  return decoded;
}

test('Code 128 uses known start/check/stop symbols and preserves zero-prefixed numbers', () => {
  assert.deepEqual(encodeCode128('ABC').codes, [104, 33, 34, 35, 1, 106]);
  assert.deepEqual(encodeCode128('001234').codes, [105, 0, 12, 34, 25, 106]);
  assert.deepEqual(encodeCode128('123456').codes, [105, 12, 34, 56, 44, 106]);
  assert.deepEqual(encodeCode128('AB123456CD').codes, [104, 33, 34, 99, 12, 34, 56, 100, 35, 36, 94, 106]);
});

test('Code 128 preserves mixed and odd-length values while maintaining checksum and integer bars', () => {
  const samples = ['0', '00', '001', '0012345', 'A000123B', '12AB34567890', 'AB123456CD', '>^_~', 'A12345B', '12345678901234567890123456'];
  for (const sample of samples) {
    const result = encodeCode128(sample);
    assert.equal(decodeSymbols(result.codes), sample);
    let checksum = result.codes[0];
    for (let i = 1; i < result.codes.length - 2; i++) checksum += result.codes[i] * i;
    assert.equal(result.codes.at(-2), checksum % 103);
    assert.equal(result.codes.at(-1), 106);
    assert.ok(result.modules.every(run => Number.isInteger(run) && run >= 1 && run <= 4));
    assert.ok(result.moduleWidth >= 2 && Number.isInteger(result.moduleWidth));
    assert.equal(result.widthDots, (result.modules.reduce((a, b) => a + b, 0) + 5) * result.moduleWidth);
    assert.ok(result.widthDots <= 438);
    assert.equal(result.quietZone, 2.5);
  }
});

test('sticker width rejects oversized data instead of shrinking bars below two dots', () => {
  assert.equal(encodeCode128('ABCDEFGHIJKLM').widthDots, 366);
  assert.equal(encodeCode128('12345678901234567890123456').widthDots, 366);
  assert.equal(encodeCode128('ABCDEFGHIJKLMNOP').widthDots, 432);
  assert.equal(encodeCode128('12'.repeat(15)).widthDots, 410);
  assert.equal(encodeCode128('12'.repeat(16)).widthDots, 432);
  assert.throws(() => encodeCode128('ABCDEFGHIJKLMNOPQ'), /too long/);
  assert.throws(() => encodeCode128('12'.repeat(17)), /too long/);
  for (const value of ['', 'a\nb', '商品', 123, 'a'.repeat(81)]) assert.throws(() => encodeCode128(value));
});

test('field validation retains barcode leading zeros and rejects controls or missing fields', () => {
  const fields = { price: '₱199.00', productName: '商品 Café', sku: 'SKU-01', barcode: '00001234' };
  assert.equal(validateFields(fields).fields.barcode, '00001234');
  assert.equal(validateFields(fields).fields.productName, '商品 Café');
  assert.throws(() => validateFields({ ...fields, price: '' }), /Price/);
  assert.throws(() => validateFields({ ...fields, productName: 'one\ntwo' }), /Product name/);
  assert.throws(() => validateFields({ ...fields, barcode: 1234 }), /Barcode/);
});

test('copies accepts only integer quantities within the print limit', () => {
  assert.equal(validateCopies(1), 1);
  assert.equal(validateCopies(100), 100);
  for (const copies of [0, -1, 101, 1.1, '2', null, undefined, Infinity, NaN]) assert.throws(() => validateCopies(copies));
});

test('compact pair uses a 2.5 by 1 inch row and encodes bars for the narrower right label', () => {
  const fields = { price: '1250', productName: 'Salad spoon', sku: 'SP-01', barcode: '100086' };
  const input = validateFields(fields, 'paired-1p25x1-v1');
  assert.equal(input.widthDots, 750); assert.equal(input.heightDots, 300); assert.equal(input.dpi, 300);
  assert.equal(input.layout.templateWidthDots, 363); assert.equal(input.layout.rightX, 375);
  assert.equal(input.layout.leftX + input.layout.templateWidthDots, 375);
  assert.equal(input.fields.price, '\u20b1 1,250.00');
  assert.equal(input.barcode.moduleWidth, 4); assert.equal(input.barcode.quietZone, 2.5);
  assert.ok(input.barcode.widthDots <= 363);
  assert.doesNotThrow(() => validateFields({ ...fields, barcode: 'ABCDEFGHIJKLMNOP' }));
  assert.throws(() => validateFields({ ...fields, barcode: 'ABCDEFGHIJKLMNOP' }, 'paired-1p25x1-v1'), /too long/);
  for (const value of ['made-up', null, { widthInches: 2.5 }]) assert.throws(() => validateFields(fields, value), /supported sticker sizes/);
});

test('paired labels use a full row while barcode sizing stays within Template 2', () => {
  const input = validateFields({ price: '199.00', productName: 'Ceramic Mug', sku: 'MUG-01', barcode: '001234' });
  assert.equal(input.widthDots, 900);
  assert.equal(input.heightDots, 300);
  assert.equal(input.layout.version, 'paired-v3');
  assert.equal(input.layout.leftX, 12);
  assert.equal(input.layout.rightX - input.layout.leftX, 438);
  assert.ok(input.layout.leftX + input.layout.templateWidthDots <= input.layout.rightX);
  assert.ok(input.layout.rightX + input.layout.templateWidthDots <= input.widthDots);
  assert.ok(input.barcode.widthDots <= input.layout.templateWidthDots);
  assert.throws(() => validateFields({ ...input.fields, barcode: 'ABCDEFGHIJKLMNOPQ' }), /too long/);
});

test('barcodes use the maximum uniform dot width that fits the right sticker', () => {
  for (const value of ['1', '1234', '100650', '000123456789', 'ABCDEFGHIJKLMN']) {
    const result = encodeCode128(value);
    const fullModules = result.modules.reduce((sum, run) => sum + run, 0) + 2 * result.quietZone;
    assert.ok(result.widthDots <= 438);
    assert.ok(fullModules * (result.moduleWidth + 1) > 438);
    assert.equal(result.quietZone, 2.5);
  }
  assert.equal(encodeCode128('100650').moduleWidth, 6);
  assert.equal(encodeCode128('100650').widthDots, 438);
  assert.equal(encodeCode128('1234').moduleWidth, 7);
  assert.equal(encodeCode128('1').moduleWidth, 8);
});
