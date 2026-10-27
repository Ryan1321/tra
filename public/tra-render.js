import { formatTraMoney } from './tra-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT_FAMILY = 'Calibri, Arial, sans-serif';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Enlarge the entire form slightly to reduce its built-in blank margins.
// This shared viewBox keeps the preview, PDF and Epson output aligned.
const RECEIPT_SCALE = 1.06;
const ROWS = [170, 187.58, 205.16, 222.8, 240.38, 257.96, 275.54, 293.12, 310.7, 328.34, 343.46, 358.64, 373.76, 388.88, 404.06, 421.66, 439.24, 456.82, 474.46, 492.04, 509.62];
const measureContext = document.createElement('canvas').getContext('2d');

function fittedSize(text, width, maximum = 10, minimum = 7, weight = 'normal') {
  for (let size = maximum; size >= minimum; size -= 0.25) {
    measureContext.font = `${weight} ${size}px ${FONT_FAMILY}`;
    if (measureContext.measureText(text).width <= width) return size;
  }
  return null;
}

function fittedText(group, text, { x, y, width, label, maximum = 10, minimum = 7, anchor = 'start', center = false, weight = 'normal' }) {
  if (!text) return null;
  const size = fittedSize(text, width, maximum, minimum, weight);
  if (size === null) return `${label} is too long for its space on the template. Shorten it before printing.`;
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', String(x));
  node.setAttribute('y', String(y));
  node.setAttribute('font-size', String(size));
  node.setAttribute('font-weight', weight);
  node.setAttribute('text-anchor', anchor);
  if (center) node.setAttribute('dominant-baseline', 'central');
  node.textContent = text;
  group.append(node);
  return null;
}

function displayDate(value, longMonth = false) {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('Enter dates between years 0001 and 9999.');
  const [, year, month, day] = match;
  const date = new Date(`${value}T12:00:00`);
  if (Number(year) < 1 || !Number.isFinite(date.getTime()) || date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day)) {
    throw new Error('Enter a valid calendar date.');
  }
  return longMonth ? `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}` : `${day}/${month}/${year}`;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Catalog and manual items share the same validation and template renderer.
export function renderTraPreview(svg, receipt, details = {}) {
  const width = 612 / RECEIPT_SCALE, height = 792 / RECEIPT_SCALE;
  svg.setAttribute('viewBox', `${(612 - width) / 2} ${(792 - height) / 2} ${width} ${height}`);
  const group = svg.querySelector('#receipt-overlay');
  group.replaceChildren();
  const errors = [];
  const put = (text, options) => {
    const error = fittedText(group, text, options);
    if (error) errors.push(error);
  };
  const name = normalizedText(details.recipientName);
  const address = normalizedText(details.recipientAddress);
  const receiptNumber = normalizedText(details.receiptNumber);
  if (receiptNumber) {
    const match = /^#?([0-9]{1,20})$/.exec(receiptNumber);
    if (!match) {
      errors.push('Receipt number must contain 1 to 20 digits, with an optional # at the start.');
    } else {
      put(`#${match[1]}`, { x: 48, y: 82, width: 172, label: 'Receipt number', maximum: 22, minimum: 12, weight: '700' });
    }
  }
  const dates = {};
  for (const key of ['receiptDate', 'agreementStart', 'agreementEnd']) {
    try { dates[key] = displayDate(details[key], key === 'receiptDate'); }
    catch (error) { errors.push(error.message); }
  }
  if (details.agreementStart && details.agreementEnd && details.agreementStart > details.agreementEnd) {
    errors.push('The agreement end date must be on or after the start date.');
  }
  put(name, { x: 111.728, y: 106.54, width: 205.076, label: 'Name', maximum: 11 });
  put(dates.receiptDate, { x: 407.264, y: 106.54, width: 130.344, label: 'Date of receipt', maximum: 11 });
  put(address, { x: 112.78, y: 130.38, width: 345.294, label: 'Address', maximum: 11 });
  put(name, { x: 132.844, y: 534.74, width: 115.559, label: 'Name in the agreement', maximum: 9 });
  put(address, { x: 74, y: 547.94, width: 185.618, label: 'Address in the agreement', maximum: 9 });
  put(dates.agreementStart, { x: 217.787, y: 648.14, width: 65.699, label: 'Agreement start date', maximum: 9 });
  put(dates.agreementEnd, { x: 429.95, y: 648.14, width: 65.689, label: 'Agreement end date', maximum: 9 });

  receipt.items.forEach((item, index) => {
    const y = (ROWS[index] + ROWS[index + 1]) / 2;
    const label = `Item ${index + 1}`;
    put(String(item.quantity), { x: 97.21, y, width: 44.42, anchor: 'middle', center: true, label: `${label} quantity` });
    put(item.description, { x: 125.42, y, width: 219.38, maximum: 9.5, center: true, label: `${label} description` });
    put(item.barcode, { x: 376.87, y, width: 52.14, anchor: 'middle', center: true, maximum: 9.5, label: `${label} barcode` });
    put(formatTraMoney(item.unitPrice), { x: 466.12, y, width: 57.18, anchor: 'end', center: true, maximum: 9.5, label: `${label} unit price` });
    put(formatTraMoney(item.amount), { x: 536.58, y, width: 64.46, anchor: 'end', center: true, maximum: 9.5, label: `${label} amount` });
  });
  if (receipt.items.length) {
    const total = formatTraMoney(receipt.total);
    put(total, { x: 536.58, y: 518.41, width: 64.46, anchor: 'end', center: true, maximum: 10, label: 'Receipt total' });
    put(total, { x: 441.544, y: 561.14, width: 95.639, maximum: 9, label: 'Amount in the agreement' });
  }
  return [...new Set(errors)];
}
