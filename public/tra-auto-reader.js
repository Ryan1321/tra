const MAX_EDGE = 1600;
const NATIVE_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_93', 'itf'];

/** One reader per camera session. Call read(canvas) serially; dispose stops its worker. */
export async function createAutoBarcodeReader() {
  let detector = null;
  if (typeof globalThis.BarcodeDetector === 'function') {
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((format) => supported.includes(format));
      if (formats.length) detector = new BarcodeDetector({ formats });
    } catch { /* The local decoder also works when the native service is unavailable. */ }
  }
  let disposed = false;
  let worker = null;
  let pending = null;
  let sequence = 0;
  let busy = false;
  const frame = document.createElement('canvas');
  const context = frame.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read barcodes. Open this page in Chrome.');
  function stopWorker(error) {
    worker?.terminate();
    worker = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  }
  function localRead(pixels) {
    if (!worker) {
      worker = new Worker('/tra-auto-worker.js');
      worker.onmessage = ({ data }) => {
        if (!pending || data.id !== pending.id) return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.results || []);
      };
      worker.onerror = () => stopWorker(new Error('The barcode reader could not load. Refresh this page and try again.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => stopWorker(new Error('The barcode reader took too long. Try scanning again.')), 15000);
      pending = { id, resolve, reject, timer };
      worker.postMessage({ id, width: pixels.width, height: pixels.height, pixels: pixels.data.buffer }, [pixels.data.buffer]);
    });
  }
  return {
    async read(source) {
      if (disposed) return [];
      if (busy) throw new Error('A barcode read is already running.');
      busy = true;
      try {
        const width = source.videoWidth || source.naturalWidth || source.width;
        const height = source.videoHeight || source.naturalHeight || source.height;
        if (!width || !height) return [];
        const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
        frame.width = Math.max(1, Math.round(width * scale));
        frame.height = Math.max(1, Math.round(height * scale));
        context.drawImage(source, 0, 0, frame.width, frame.height);
        if (detector) {
          try {
            const results = await detector.detect(frame);
            if (disposed) return [];
            if (results.length) return results.map((result) => ({
              text: result.rawValue, format: result.format, position: result.cornerPoints,
            }));
          } catch { detector = null; }
        }
        if (disposed) return [];
        const results = await localRead(context.getImageData(0, 0, frame.width, frame.height));
        return disposed ? [] : results;
      } finally { busy = false; }
    },
    dispose() {
      disposed = true;
      stopWorker(new DOMException('Barcode scanning cancelled.', 'AbortError'));
      frame.width = 1;
      frame.height = 1;
    },
  };
}
