import { validateFields, validateCopies } from './validation.js';

export const BATCH_LIMITS = Object.freeze({ items: 50, pairs: 500 });

export function validateBatch(data) {
  if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(data.requestId)) {
    throw new Error('A valid batch request ID is required. Refresh the page.');
  }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > BATCH_LIMITS.items) {
    throw new Error(`Add 1–${BATCH_LIMITS.items} products to a batch.`);
  }
  const inputs = data.items.map((item, index) => {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Enter the label details and copies.');
      return { ...validateFields(item.fields, data.labelLayout), copies: validateCopies(item.copies) };
    } catch (error) { throw new Error(`Item ${index + 1}: ${error.message}`); }
  });
  const totalPairs = inputs.reduce((total, item) => total + item.copies, 0);
  if (totalPairs > BATCH_LIMITS.pairs) throw new Error(`A batch can contain at most ${BATCH_LIMITS.pairs} pairs.`);
  return { inputs, totalPairs };
}
