import { encodeCode128 } from './barcode.js';
import { formatPesoPrice } from './price.js';
import { DEFAULT_LABEL_LAYOUT, getLabelVariation } from '../public/label-layouts.js';

export const PAIR_LAYOUT = getLabelVariation().layout;
export const LABEL = getLabelVariation().label;
export function validateFields(input, labelLayout = DEFAULT_LABEL_LAYOUT) {
  const { label, layout } = getLabelVariation(labelLayout);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter the four label fields.');
  const fields = {};
  for (const [key, title, max] of [['price', 'Price', 24], ['productName', 'Product name', 80], ['sku', 'SKU', 40], ['barcode', 'Barcode', 80]]) {
    if (typeof input[key] !== 'string') throw new Error(`${title} is required.`);
    const value = input[key].trim();
    if (!value || value.length > max || /[\x00-\x1F\x7F]/.test(value)) throw new Error(`${title} must contain 1–${max} characters on one line.`);
    fields[key] = value;
  }
  fields.price = formatPesoPrice(fields.price);
  const widthDots = Math.round(label.widthInches * label.dpi);
  return {
    widthDots, heightDots: Math.round(label.heightInches * label.dpi), dpi: label.dpi,
    layout, fields,
    barcode: encodeCode128(fields.barcode, layout.templateWidthDots),
  };
}
export function validateCopies(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Copies must be a whole number from 1 to 100.');
  return value;
}
