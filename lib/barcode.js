// Code 128 symbol widths from ISO/IEC 15417; alternating black and white runs.
const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112'
];

export function encodeCode128(value, availableWidth = 700) {
  if (typeof value !== 'string' || !/^[\x20-\x7E]{1,80}$/.test(value)) {
    throw new Error('Barcode must contain 1–80 plain letters, numbers, or symbols.');
  }
  // Find the shortest encoding using B for printable text and C for digit pairs.
  const memo = new Map();
  function path(index, set) {
    if (index === value.length) return [];
    const key = `${index}:${set}`;
    if (memo.has(key)) return memo.get(key);
    const choices = [];
    const pair = /^\d{2}$/.test(value.slice(index, index + 2));
    if (set === 'B') {
      choices.push([value.charCodeAt(index) - 32, ...path(index + 1, 'B')]);
      if (pair) choices.push([99, Number(value.slice(index, index + 2)), ...path(index + 2, 'C')]);
    } else {
      if (pair) choices.push([Number(value.slice(index, index + 2)), ...path(index + 2, 'C')]);
      choices.push([100, value.charCodeAt(index) - 32, ...path(index + 1, 'B')]);
    }
    const best = choices.reduce((a, b) => a.length <= b.length ? a : b);
    memo.set(key, best);
    return best;
  }
  const b = [104, ...path(0, 'B')];
  const c = /^\d{2}/.test(value) ? [105, ...path(0, 'C')] : b;
  const codes = b.length <= c.length ? b : c;
  const checksum = codes.reduce((sum, code, index) => sum + code * (index || 1), 0) % 103;
  codes.push(checksum, 106);
  const modules = codes.flatMap(code => [...PATTERNS[code]].map(Number));
  const barModules = modules.reduce((a, b) => a + b, 0);
  const totalModules = barModules + 5;
  // Share the selected padding with the renderer so it reserves the same width.
  const quietZone = (totalModules - barModules) / 2;
  // Use the largest uniform whole-dot bars that fit, including side padding.
  const moduleWidth = Math.floor(availableWidth / totalModules);
  if (moduleWidth < 2) {
    throw new Error('This barcode is too long for the sticker. Use a shorter value or a larger label.');
  }
  return { codes, modules, moduleWidth, quietZone, widthDots: totalModules * moduleWidth };
}
