import { normalizeWaybills } from '../public/waybill-model.js';

export function validateWaybillRequest(data) {
  if (!data || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(data.requestId)) throw new Error('Invalid waybill print request ID.');
  if (!Number.isInteger(data.copies) || data.copies < 1 || data.copies > 10) throw new Error('Copies must be a whole number from 1 to 10.');
  if (data.paper !== 'Letter') throw new Error('Use Letter / short bond paper for this two-waybill sheet.');
  return { waybills: normalizeWaybills(data.waybills, { forPrint: true }), copies: data.copies, paper: 'Letter' };
}
