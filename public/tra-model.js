export const MAX_TRA_ITEMS = 20;

function centsFrom(value) {
  if (typeof value !== 'string' || value.length > 40) throw new Error('Enter a unit price such as 199.00.');
  const price = value.trim().replace(/^(?:₱|PHP\s*)\s*/i, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(price)) {
    throw new Error('Enter a peso amount with at most two decimal places, such as 199.00.');
  }
  const [whole, decimal = ''] = price.replaceAll(',', '').split('.');
  return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}

function decimalFrom(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function textField(value, label, maximum) {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\x00-\x1F\x7F]/.test(text)) {
    throw new Error(`${label} must contain 1–${maximum} characters on one line.`);
  }
  return text;
}

// Catalog selection and manual entry share the same exact-cent receipt model.
export function calculateReceipt(items) {
  if (!Array.isArray(items) || items.length > MAX_TRA_ITEMS) throw new Error(`This template holds up to ${MAX_TRA_ITEMS} items.`);
  let total = 0n;
  const normalized = items.map((item, index) => {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Enter the item details.');
      const rawQuantity = typeof item.quantity === 'number' || typeof item.quantity === 'string' ? String(item.quantity).trim() : '';
      if (!/^[1-9]\d{0,3}$/.test(rawQuantity)) throw new Error('Quantity must be a whole number from 1 to 9999.');
      const quantity = Number(rawQuantity);
      const description = textField(item.description, 'Description', 100);
      const barcode = textField(item.barcode, 'Barcode', 32);
      const unitPrice = centsFrom(item.unitPrice);
      if (unitPrice > 999999999n) throw new Error('Unit price must not exceed ₱9,999,999.99.');
      const amount = unitPrice * BigInt(quantity);
      total += amount;
      return { quantity, description, barcode, unitPrice: decimalFrom(unitPrice), amount: decimalFrom(amount) };
    } catch (error) { throw new Error(`Item ${index + 1}: ${error.message}`); }
  });
  return { items: normalized, total: decimalFrom(total) };
}

export function formatTraMoney(value, { currency = false } = {}) {
  const [whole, decimal] = decimalFrom(centsFrom(value)).split('.');
  return `${currency ? '₱ ' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}
