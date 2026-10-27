export const WAYBILL_FIELDS = Object.freeze([
  { key: 'number', label: 'Waybill number', maximum: 20 },
  { key: 'destination', label: 'Destination / branch', maximum: 70 },
  { key: 'transport', label: 'Bus / courier', maximum: 70 },
  { key: 'location', label: 'Terminal / location', maximum: 70 },
  { key: 'recipient', label: 'Recipient name', maximum: 90 },
  { key: 'phone', label: 'Contact number', maximum: 40 },
]);

export function blankWaybills() {
  return [0, 1].map(() => Object.fromEntries(WAYBILL_FIELDS.map(field => [field.key, ''])));
}

export function normalizeWaybills(value, { forPrint = false } = {}) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('A sheet must contain exactly two waybills.');
  const waybills = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Enter the details for waybill ${index + 1}.`);
    const result = {};
    for (const { key, label, maximum } of WAYBILL_FIELDS) {
      const text = entry[key] ?? '';
      if (typeof text !== 'string' || text.length > maximum || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`Waybill ${index + 1}: ${label} must be a single line of at most ${maximum} characters.`);
      result[key] = text.trim().replace(/\s+/g, ' ');
    }
    result.number = result.number.replace(/^#/, '');
    if (result.number && !/^[A-Za-z0-9-]{1,20}$/.test(result.number)) throw new Error(`Waybill ${index + 1}: use letters, numbers or hyphens for the waybill number.`);
    if (forPrint) {
      for (const key of ['number', 'destination', 'recipient', 'phone']) {
        if (!result[key]) throw new Error(`Waybill ${index + 1}: enter ${WAYBILL_FIELDS.find(field => field.key === key).label.toLowerCase()}.`);
      }
    }
    return result;
  });
  return waybills;
}

export function nextWaybillNumber(value) {
  const text = String(value).replace(/^#/, '');
  if (!/^\d{1,20}$/.test(text)) return '';
  const next = String(BigInt(text) + 1n).padStart(text.length, '0');
  return next.length <= 20 ? next : '';
}
