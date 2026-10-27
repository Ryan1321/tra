import { normalizeWaybills } from './waybill-model.js';

const WAYBILL_SVG_NS = 'http://www.w3.org/2000/svg';
const waybillMeasure = document.createElement('canvas').getContext('2d');
const WAYBILL_FONT = 'Calibri, Arial, sans-serif';

// Two independent half-page waybills, preserving the large number, red
// destination and centered bold delivery details from the supplied Word file.
export function renderWaybillPreview(svg, values) {
  const waybills = normalizeWaybills(values);
  const group = svg.querySelector('#waybill-content');
  group.replaceChildren();
  const errors = [];
  function put(text, { x, y, width, size, minimum, anchor = 'middle', color = '#000', name }) {
    if (!text) return;
    let fitted = size;
    for (; fitted >= minimum; fitted -= 0.5) {
      waybillMeasure.font = `700 ${fitted}px ${WAYBILL_FONT}`;
      if (waybillMeasure.measureText(text).width <= width) break;
    }
    if (fitted < minimum) { errors.push(`${name} is too long for the waybill. Shorten it before printing.`); return; }
    const node = document.createElementNS(WAYBILL_SVG_NS, 'text');
    for (const [key, value] of Object.entries({ x, y, 'font-size': fitted, 'font-weight': '700', 'font-family': WAYBILL_FONT, 'text-anchor': anchor, fill: color })) node.setAttribute(key, String(value));
    node.textContent = text;
    group.append(node);
  }
  waybills.forEach((waybill, index) => {
    const offset = index * 396;
    const label = `Waybill ${index + 1}`;
    put(waybill.number ? `#${waybill.number}` : '', { x: 18, y: offset + 91, width: 277, size: 100, minimum: 26, anchor: 'start', name: `${label} number` });
    put(waybill.destination, { x: 576, y: offset + 76, width: 266, size: 38, minimum: 19, anchor: 'end', color: '#ee0000', name: `${label} destination` });
    for (const [key, y] of [['transport', 163], ['location', 219], ['recipient', 283], ['phone', 341]]) {
      put(waybill[key], { x: 306, y: offset + y, width: 540, size: 48, minimum: 22, name: `${label} ${key}` });
    }
  });
  return errors;
}
