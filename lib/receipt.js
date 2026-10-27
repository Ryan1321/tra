import { calculateReceipt } from '../public/tra-model.js';

export const RECEIPT_PAPERS = Object.freeze({
  Letter: 'Letter / short bond (8.5 × 11 in)',
  A4: 'A4 (210 × 297 mm)',
  Long: 'Long bond (8.5 × 13 in)',
});

export function validateReceiptRequest(data) {
  if (!data || !/^[a-zA-Z0-9-]{16,64}$/.test(data.requestId || '')) throw new Error('Invalid receipt print request ID.');
  if (!Number.isInteger(data.copies) || data.copies < 1 || data.copies > 10) throw new Error('Copies must be a whole number from 1 to 10.');
  if (!Object.hasOwn(RECEIPT_PAPERS, data.paper)) throw new Error('Choose Letter, A4 or long bond paper.');
  if (!data.details || typeof data.details !== 'object' || Array.isArray(data.details)) throw new Error('Enter the receipt details.');
  const details = {};
  for (const [key, maximum] of Object.entries({ receiptNumber: 21, recipientName: 100, recipientAddress: 180, receiptDate: 10, agreementStart: 10, agreementEnd: 10 })) {
    const value = data.details[key] ?? '';
    if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid receipt detail: ${key}.`);
    details[key] = value.trim();
  }
  if (details.receiptNumber && !/^#?[0-9]{1,20}$/.test(details.receiptNumber)) throw new Error('Receipt number must contain 1 to 20 digits.');
  for (const key of ['receiptDate', 'agreementStart', 'agreementEnd']) {
    if (!details[key]) continue;
    const date = new Date(`${details[key]}T12:00:00Z`);
    if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(details[key]) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== details[key]) throw new Error('Enter a valid calendar date.');
  }
  if (details.agreementStart && details.agreementEnd && details.agreementStart > details.agreementEnd) throw new Error('The agreement end date must be on or after the start date.');
  const receipt = calculateReceipt(data.items);
  return { details, ...receipt, paper: data.paper, copies: data.copies };
}
