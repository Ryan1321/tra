export const RECEIPT_STATUSES = Object.freeze({
  outstanding: 'Outstanding',
  partially_returned: 'Partially returned',
  completed: 'Completed',
});

export function receiptStatus(value) {
  if (typeof value !== 'string' || !Object.hasOwn(RECEIPT_STATUSES, value)) {
    throw Object.assign(new Error('Choose Outstanding, Partially returned or Completed.'), { status: 400 });
  }
  return value;
}
