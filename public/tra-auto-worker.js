/* Decoder runs outside the page thread so camera controls remain responsive. */
importScripts('/vendor/zxing-wasm-3.1.4-reader.js');
ZXingWASM.prepareZXingModule({ overrides: {
  locateFile: () => '/vendor/zxing-wasm-3.1.4-reader.wasm',
} });

const OPTIONS = {
  formats: ['Code128', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code39', 'Code93', 'ITF'],
  tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
  minLineCount: 3, maxNumberOfSymbols: 4, textMode: 'Plain', returnErrors: false,
};
const original = new OffscreenCanvas(1, 1);
const rotated = new OffscreenCanvas(1, 1);
const stripe = new OffscreenCanvas(1, 1);

function grayPixels(image) {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i += 1) {
    const p = i * 4;
    gray[i] = (image.data[p] + 2 * image.data[p + 1] + image.data[p + 2]) >> 2;
  }
  return gray;
}

// Estimate the direction across parallel bars. Dominant edges from the product
// label also help when the barcode is tilted relative to the camera.
function barcodeAngle(gray, width, height) {
  const step = Math.max(1, Math.floor(Math.max(width, height) / 640));
  let sin = 0;
  let cos = 0;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const p = y * width + x;
      // Sobel smoothing keeps stair-stepped diagonal edges from all voting for
      // 45 degrees. Accumulate the structure tensor: opposite gradients agree,
      // while unrelated logo/text edges tend to cancel each other out.
      const gx = gray[p - width + 1] + 2 * gray[p + 1] + gray[p + width + 1]
        - gray[p - width - 1] - 2 * gray[p - 1] - gray[p + width - 1];
      const gy = gray[p + width - 1] + 2 * gray[p + width] + gray[p + width + 1]
        - gray[p - width - 1] - 2 * gray[p - width] - gray[p - width + 1];
      const strength = Math.hypot(gx, gy);
      if (strength < 150) continue;
      sin += 2 * gx * gy;
      cos += gx * gx - gy * gy;
    }
  }
  return -Math.atan2(sin, cos) / 2;
}

// Printed labels intentionally have narrow side margins. Find repeated dark /
// light runs automatically and read a short strip with white padding restored.
// This keeps logos and the table surface outside the barcode's quiet zones.
function stripeCandidates(gray, width, height) {
  const candidates = [];
  const rowStep = Math.max(3, Math.floor(height / 64));
  const maximumRun = Math.max(12, Math.round(width / 40));
  for (let y = rowStep; y < height - rowStep; y += rowStep) {
    const offset = y * width;
    let low = 255;
    let high = 0;
    for (let x = 0; x < width; x += 3) {
      low = Math.min(low, gray[offset + x]);
      high = Math.max(high, gray[offset + x]);
    }
    if (high - low < 50) continue;
    const threshold = (high + low) / 2;
    let start = -1;
    let end = -1;
    let bars = 0;
    const flush = () => {
      if (bars >= 14 && end - start >= 65) {
        const candidate = { x: start, y, width: end - start, bars };
        if (!candidates.some((old) => Math.abs(old.x - start) < 12 && Math.abs(old.width - candidate.width) < 16 && Math.abs(old.y - y) < rowStep * 3)) {
          candidates.push(candidate);
        }
      }
      start = -1;
      end = -1;
      bars = 0;
    };
    for (let x = 0; x < width;) {
      const dark = gray[offset + x] < threshold;
      const runStart = x;
      while (x < width && (gray[offset + x] < threshold) === dark) x += 1;
      const length = x - runStart;
      if (length > maximumRun) { flush(); continue; }
      if (dark) {
        if (start < 0) start = runStart;
        bars += 1;
        end = x;
      }
    }
    flush();
  }
  return candidates.sort((a, b) => b.bars - a.bars).slice(0, 12);
}

async function decode(image) {
  const results = await ZXingWASM.readBarcodes(image, OPTIONS);
  return results.filter((result) => result.isValid && !result.error && result.text).map((result) => ({
    text: result.text, format: result.format, position: result.position,
  }));
}

async function readStripes(canvas, pixels) {
  for (const candidate of stripeCandidates(grayPixels(pixels), pixels.width, pixels.height)) {
    const halfHeight = Math.max(5, Math.min(16, Math.round(candidate.width / 35)));
    const y = Math.max(0, candidate.y - halfHeight);
    const h = Math.min(canvas.height - y, halfHeight * 2);
    const padding = Math.max(30, Math.ceil(candidate.width / 5));
    stripe.width = candidate.width + padding * 2;
    stripe.height = h + 30;
    const context = stripe.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, stripe.width, stripe.height);
    context.drawImage(canvas, candidate.x, y, candidate.width, h, padding, 15, candidate.width, h);
    const result = await decode(context.getImageData(0, 0, stripe.width, stripe.height));
    if (result.length) return result;
  }
  return [];
}

async function readFrame(image) {
  const full = await decode(image);
  if (full.length) return full;
  original.width = image.width;
  original.height = image.height;
  original.getContext('2d').putImageData(image, 0, 0);
  const direct = await readStripes(original, image);
  if (direct.length) return direct;
  const angle = barcodeAngle(grayPixels(image), image.width, image.height);
  const angles = Math.abs(angle) < 0.025 ? [Math.PI / 2] : [angle, angle - 0.05, angle + 0.05];
  for (const rotation of angles) {
    const cos = Math.abs(Math.cos(rotation));
    const sin = Math.abs(Math.sin(rotation));
    rotated.width = Math.ceil(image.width * cos + image.height * sin);
    rotated.height = Math.ceil(image.height * cos + image.width * sin);
    const context = rotated.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, rotated.width, rotated.height);
    context.translate(rotated.width / 2, rotated.height / 2);
    context.rotate(rotation);
    context.drawImage(original, -image.width / 2, -image.height / 2);
    const pixels = context.getImageData(0, 0, rotated.width, rotated.height);
    const result = await readStripes(rotated, pixels);
    if (result.length) return result;
  }
  return [];
}

self.onmessage = async ({ data }) => {
  try {
    const pixels = new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height);
    const results = await readFrame(pixels);
    self.postMessage({ id: data.id, results });
  } catch {
    self.postMessage({ id: data.id, error: 'The barcode reader could not read this frame. Refresh the page and try again.' });
  }
};
