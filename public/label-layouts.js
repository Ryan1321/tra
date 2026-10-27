export const DEFAULT_LABEL_LAYOUT = 'paired-v3';

// Nominal sticker sizes include the existing outer stock margins. All geometry
// is an allowlisted preset, never a set of dimensions supplied by a phone.
export const LABEL_VARIATIONS = Object.freeze([
  { version: DEFAULT_LABEL_LAYOUT, title: '1.5 × 1 in each — original pair', paperWidthDots: 900, templateWidthDots: 438, rightX: 450 },
  { version: 'paired-1p25x1-v1', title: '1.25 × 1 in each — compact pair', paperWidthDots: 750, templateWidthDots: 363, rightX: 375 },
].map(preset => Object.freeze({
  label: Object.freeze({
    title: preset.title, widthInches: preset.paperWidthDots / 300, heightInches: 1, dpi: 300,
    templateWidthInches: preset.version === DEFAULT_LABEL_LAYOUT ? 1.461 : 1.211, templateHeightInches: 1,
    labelsPerCopy: 2, editableTemplate: 2, layoutVersion: preset.version,
  }),
  layout: Object.freeze({
    version: preset.version, paperWidthDots: preset.paperWidthDots, paperHeightDots: 300,
    templateWidthDots: preset.templateWidthDots, templateHeightDots: 300,
    leftX: 12, rightX: preset.rightX, topY: 0,
  }),
})));

export function getLabelVariation(id = DEFAULT_LABEL_LAYOUT) {
  const variation = LABEL_VARIATIONS.find(entry => entry.layout.version === id);
  if (!variation) throw new Error('Choose one of the supported sticker sizes.');
  return variation;
}
