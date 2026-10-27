export function formatPesoPrice(value) {
  const amount = value.trim().replace(/^(?:₱|PHP\s*|P\s*)\s*/i, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error('Enter a peso amount such as 199 or 1,234.50, with at most two decimal places.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const digits = whole.replaceAll(',', '').replace(/^0+(?=\d)/, '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₱ ${grouped}.${fraction.padEnd(2, '0')}`;
}
