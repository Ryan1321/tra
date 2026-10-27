import { createAutoBarcodeReader } from '/tra-auto-reader.js';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_PIXELS = 60_000_000;
const FRAME_EDGE = 1600;
const SCAN_INTERVAL_MS = 180;
const CAMERA_LIMIT_MS = 120000;

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop();
}

function cameraError(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) {
    return 'Allow camera access for this site in Chrome, then tap Scan barcode again.';
  }
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'No camera was found on this device.';
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return 'The camera is busy. Close other camera apps and try again.';
  return error?.message || 'The camera could not start. Try scanning again.';
}

export function initializeTraScanner({ onScan, onStatus } = {}) {
  const $ = id => document.getElementById(id);
  const elements = {
    container: $('tra-scanner'), start: $('tra-scanner-start'), photo: $('tra-scanner-photo'),
    dialog: $('tra-scanner-dialog'), video: $('tra-scanner-video'), stop: $('tra-scanner-stop'),
    status: $('tra-scanner-status'), liveStatus: $('tra-scanner-live-status'), hint: $('tra-scanner-hint'),
    setup: $('tra-scanner-setup'), photoCancel: $('tra-scanner-photo-cancel'),
  };
  const liveSupported = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  const state = {
    version: 0, disabled: false, active: false, delivering: false, pendingPermission: false,
    stream: null, reader: null, timer: null, startedAt: 0, photoUrl: null,
  };
  const canvas = document.createElement('canvas');

  function status(message) {
    elements.status.textContent = message;
    onStatus?.(message);
  }
  function liveStatus(message) {
    if (elements.liveStatus.textContent !== message) elements.liveStatus.textContent = message;
  }
  function controls() {
    const blocked = state.disabled || state.active || state.delivering;
    elements.start.disabled = blocked || state.pendingPermission;
    elements.photo.disabled = blocked;
    elements.photoCancel.hidden = !state.active || elements.dialog.open;
    elements.container.setAttribute('aria-busy', String(state.active || state.delivering));
  }
  function stop() {
    state.version += 1;
    clearTimeout(state.timer);
    state.timer = null;
    state.reader?.dispose();
    state.reader = null;
    stopTracks(state.stream);
    stopTracks(elements.video.srcObject);
    state.stream = null;
    elements.video.pause();
    elements.video.srcObject = null;
    if (elements.dialog.open) elements.dialog.close();
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = null;
    canvas.width = 1;
    canvas.height = 1;
    state.active = false;
    controls();
  }
  function usableCodes(results) {
    return [...new Set(results.map(result => String(result.text ?? '')).filter(value =>
      value && value.length <= 100 && value === value.trim() && !/[\x00-\x1F\x7F]/.test(value)))];
  }
  async function deliver(value, version) {
    if (version !== state.version) return;
    // Close the view and release the camera before the catalog request begins.
    stop();
    state.delivering = true;
    controls();
    status('Barcode read: ' + value + '.');
    try { await onScan?.(value); }
    catch { status('Barcode read: ' + value + '. The item could not be loaded. Try again.'); }
    finally { state.delivering = false; controls(); }
  }
  function drawSource(source, width, height) {
    const scale = Math.min(1, FRAME_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser cannot scan barcodes. Open this page in Chrome.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  async function scanFrame(version) {
    if (version !== state.version || !state.active) return;
    if (performance.now() - state.startedAt > CAMERA_LIMIT_MS) {
      stop();
      status('Camera stopped after two minutes. Tap Scan barcode to try again.');
      return;
    }
    try {
      if (elements.video.readyState >= 2 && elements.video.videoWidth) {
        drawSource(elements.video, elements.video.videoWidth, elements.video.videoHeight);
        const codes = usableCodes(await state.reader.read(canvas));
        if (version !== state.version) return;
        if (codes.length === 1) {
          await deliver(codes[0], version);
          return;
        }
        liveStatus(codes.length > 1
          ? 'Several barcodes are visible. Point at one item.'
          : 'Point at one barcode and hold still. It will be read automatically.');
      }
    } catch (error) {
      if (version !== state.version) return;
      stop();
      status(error.message || 'The barcode scanner could not read the camera. Tap Scan barcode to try again.');
      return;
    }
    if (version === state.version) state.timer = setTimeout(() => { void scanFrame(version); }, SCAN_INTERVAL_MS);
  }
  async function startLive() {
    if (!liveSupported || state.disabled || state.active || state.delivering || state.pendingPermission) return;
    stop();
    const version = state.version;
    state.active = true;
    state.pendingPermission = true;
    elements.dialog.showModal();
    liveStatus('Opening the camera. Allow camera access if Chrome asks.');
    status('Camera open. Point at one barcode.');
    controls();
    let stream, reader;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (version !== state.version) { stopTracks(stream); return; }
      state.stream = stream;
      elements.video.srcObject = stream;
      await elements.video.play();
      if (version !== state.version) return;
      liveStatus('Preparing automatic barcode detection...');
      reader = await createAutoBarcodeReader();
      if (version !== state.version) { reader.dispose(); return; }
      state.reader = reader;
      state.startedAt = performance.now();
      void scanFrame(version);
    } catch (error) {
      stopTracks(stream);
      if (version === state.version) { stop(); status(cameraError(error)); }
    } finally {
      state.pendingPermission = false;
      controls();
    }
  }
  async function scanPhoto(file) {
    if (!file || state.disabled || state.active || state.delivering) return;
    stop();
    const version = state.version;
    if (!file.size || file.size > MAX_PHOTO_BYTES) { status('Choose a barcode photo smaller than 20 MB.'); return; }
    if (file.type && !file.type.startsWith('image/')) { status('Choose a barcode image such as JPG or PNG.'); return; }
    state.active = true;
    controls();
    status('Finding the barcode in the photo automatically...');
    const photo = new Image();
    let reader;
    try {
      state.photoUrl = URL.createObjectURL(file);
      photo.src = state.photoUrl;
      await photo.decode();
      if (version !== state.version) return;
      if (!photo.naturalWidth || !photo.naturalHeight || photo.naturalWidth * photo.naturalHeight > MAX_PHOTO_PIXELS) {
        throw new Error('This photo is too large. Choose a smaller photo.');
      }
      reader = await createAutoBarcodeReader();
      if (version !== state.version) { reader.dispose(); return; }
      state.reader = reader;
      drawSource(photo, photo.naturalWidth, photo.naturalHeight);
      const codes = usableCodes(await reader.read(canvas));
      if (version !== state.version) return;
      if (codes.length === 1) await deliver(codes[0], version);
      else {
        stop();
        status(codes.length > 1 ? 'Several barcodes are visible. Use a photo of one item.' : 'No barcode could be read. Try the live camera and move closer to the barcode.');
      }
    } catch (error) {
      if (version === state.version) { stop(); status(error.message || 'The photo could not be read. Try the live camera.'); }
    } finally {
      photo.src = '';
      if (version === state.version) stop();
    }
  }
  function cancel() { stop(); status('Scanning stopped. Tap Scan barcode when ready.'); }
  elements.start.hidden = !liveSupported;
  elements.setup.hidden = liveSupported;
  elements.hint.textContent = liveSupported
    ? 'Tap Scan barcode. Once detected, the camera closes and the quantity field opens.'
    : 'Enable the live camera once on this phone to scan automatically without taking a photo.';
  elements.start.addEventListener('click', () => { void startLive(); });
  elements.stop.addEventListener('click', cancel);
  elements.photoCancel.addEventListener('click', cancel);
  elements.dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
  elements.photo.addEventListener('change', () => {
    const file = elements.photo.files?.[0];
    elements.photo.value = '';
    void scanPhoto(file);
  });
  window.addEventListener('pagehide', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.active) { stop(); status('Camera paused. Tap Scan barcode to continue.'); }
  });
  controls();
  return {
    stop,
    setDisabled(disabled) {
      state.disabled = Boolean(disabled);
      if (state.disabled && state.active) stop();
      controls();
    },
  };
}
