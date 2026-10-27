const MAX_EDGE = 2400;
const RETRY_EDGE = 1600;
const MAX_ATTEMPTS = 10;
const TIME_LIMIT_MS = 10000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

function photoRegion(photo, crop) {
  const imageWidth = photo.naturalWidth;
  const imageHeight = photo.naturalHeight;
  if (!imageWidth || !imageHeight) throw new Error('This photo could not be opened. Choose another photo.');
  if (!crop) return { x: 0, y: 0, width: imageWidth, height: imageHeight };
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) {
    throw new Error('Select an area containing the full barcode.');
  }
  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const width = Math.min(imageWidth, crop.x + crop.width) - x;
  const height = Math.min(imageHeight, crop.y + crop.height) - y;
  if (width < 2 || height < 2) throw new Error('Select an area containing the full barcode.');
  return { x, y, width, height };
}

// ZXing reads lines across a 1D barcode. Estimate the direction across the bars
// from image gradients so a slightly tilted photo can also supply a full line.
function barcodeAngle(photo, region, canvas) {
  const scale = Math.min(1, 640 / Math.max(region.width, region.height));
  canvas.width = Math.max(3, Math.round(region.width * scale));
  canvas.height = Math.max(3, Math.round(region.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read barcode photos. Try opening the page in Chrome.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(photo, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i += 1) {
    const p = i * 4;
    gray[i] = (data[p] + 2 * data[p + 1] + data[p + 2]) / 4;
  }
  const bins = new Float64Array(36);
  const w = canvas.width;
  for (let y = 1; y < canvas.height - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      const gx = gray[p - w + 1] + 2 * gray[p + 1] + gray[p + w + 1]
        - gray[p - w - 1] - 2 * gray[p - 1] - gray[p + w - 1];
      const gy = gray[p + w - 1] + 2 * gray[p + w] + gray[p + w + 1]
        - gray[p - w - 1] - 2 * gray[p - w] - gray[p - w + 1];
      const strength = Math.hypot(gx, gy);
      if (strength < 60) continue;
      const angle = (Math.atan2(gy, gx) + Math.PI) % Math.PI;
      bins[Math.round(angle * bins.length / Math.PI) % bins.length] += strength;
    }
  }
  let peak = 0;
  for (let i = 1; i < bins.length; i += 1) if (bins[i] > bins[peak]) peak = i;
  let sin = 0;
  let cos = 0;
  for (let offset = -2; offset <= 2; offset += 1) {
    const i = (peak + offset + bins.length) % bins.length;
    const angle = i * Math.PI / bins.length;
    sin += Math.sin(2 * angle) * bins[i];
    cos += Math.cos(2 * angle) * bins[i];
  }
  return -Math.atan2(sin, cos) * 90 / Math.PI;
}

function drawAttempt(photo, region, canvas, edge, angle, contrast) {
  const radians = angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const boundsWidth = region.width * cos + region.height * sin;
  const boundsHeight = region.width * sin + region.height * cos;
  // A tight crop may have no quiet zone of its own. Reserve enough white space
  // even for short, large Code 128 symbols after scaling the original pixels.
  const padding = Math.ceil(edge / 8);
  const scale = Math.min(2, (edge - padding * 2) / Math.max(boundsWidth, boundsHeight));
  canvas.width = Math.ceil(boundsWidth * scale) + padding * 2;
  canvas.height = Math.ceil(boundsHeight * scale) + padding * 2;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read barcode photos. Try opening the page in Chrome.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.drawImage(photo, region.x, region.y, region.width, region.height,
    -region.width * scale / 2, -region.height * scale / 2, region.width * scale, region.height * scale);
  context.restore();
  if (contrast) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const histogram = new Uint32Array(256);
    const { data } = pixels;
    for (let i = 0; i < data.length; i += 4) histogram[(data[i] + 2 * data[i + 1] + data[i + 2]) >> 2] += 1;
    const cutoff = data.length / 4 * 0.02;
    let low = 0;
    let high = 255;
    let sum = 0;
    while (low < 254 && sum + histogram[low] < cutoff) sum += histogram[low++];
    sum = 0;
    while (high > low + 1 && sum + histogram[high] < cutoff) sum += histogram[high--];
    for (let i = 0; i < data.length; i += 4) {
      const gray = (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
      const value = Math.max(0, Math.min(255, (gray - low) * 255 / (high - low)));
      data[i] = value; data[i + 1] = value; data[i + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
  }
}

/** Decode the original photo, or a crop expressed in its native image pixels. */
export async function decodeBarcodePhoto(photo, { reader, crop = null, isCancelled = () => false, onProgress = () => {} } = {}) {
  if (!reader?.decodeFromCanvas) throw new Error('The barcode scanner is not ready. Try again.');
  const canvas = document.createElement('canvas');
  const analysis = document.createElement('canvas');
  const region = photoRegion(photo, crop);
  const started = performance.now();
  let attempts = 0;
  const seen = new Set();
  const stopped = () => isCancelled() || attempts >= MAX_ATTEMPTS || performance.now() - started > TIME_LIMIT_MS;
  async function attempt(area, edge, angle, contrast = false) {
    if (stopped()) return null;
    const key = [area.x, area.y, area.width, area.height, edge, angle.toFixed(1), contrast].join(':');
    if (seen.has(key)) return null;
    seen.add(key);
    await pause();
    if (stopped()) return null;
    drawAttempt(photo, area, canvas, edge, angle, contrast);
    await pause();
    if (stopped()) return null;
    attempts += 1;
    try {
      const result = await reader.decodeFromCanvas(canvas);
      return isCancelled() ? null : result;
    } catch {
      return null;
    }
  }
  try {
    onProgress('Reading the barcode photo...');
    let result = await attempt(region, MAX_EDGE, 0);
    if (result || stopped()) return result;
    await pause();
    if (stopped()) return null;
    const angle = barcodeAngle(photo, region, analysis);
    onProgress('Checking the barcode angle...');
    for (const rotation of [angle, angle - 6, angle + 6, 90]) {
      result = await attempt(region, RETRY_EDGE, rotation);
      if (result || stopped()) return result;
    }
    // Go back to the original pixels: enlarging an already reduced photo loses
    // the narrow bars. A manual selection already provides a focused region.
    if (!crop) {
      const center = {
        x: region.x + region.width * 0.15, y: region.y + region.height * 0.15,
        width: region.width * 0.7, height: region.height * 0.7,
      };
      onProgress('Checking the center of the photo...');
      const centerAngle = barcodeAngle(photo, center, analysis);
      for (const rotation of [centerAngle, centerAngle - 6, centerAngle + 6]) {
        result = await attempt(center, rotation === centerAngle ? MAX_EDGE : RETRY_EDGE, rotation);
        if (result || stopped()) return result;
      }
    }
    onProgress('Checking the barcode contrast...');
    result = await attempt(region, RETRY_EDGE, angle, true);
    if (result || stopped()) return result;
    return await attempt(region, RETRY_EDGE, 0, true);
  } finally {
    canvas.width = 1; canvas.height = 1;
    analysis.width = 1; analysis.height = 1;
  }
}
