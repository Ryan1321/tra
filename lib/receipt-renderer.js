import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

async function browserExecutable() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const filename of candidates) { try { await access(filename); return filename; } catch {} }
  throw new Error('Install Microsoft Edge or Google Chrome on the Windows PC to render receipts.');
}

// Each render has its own empty browser profile and a loopback-only debugging
// endpoint. It never opens the user's browser profile or navigates to a URL.
export async function renderReceipt(input, dataDir, kind = 'receipt') {
  const waybill = kind === 'waybill';
  const executable = await browserExecutable();
  const tmp = join(dataDir, 'tmp');
  await mkdir(tmp, { recursive: true });
  const profile = await mkdtemp(join(tmp, 'receipt-render-'));
  let child, socket, closed = false, exitError = null, sequence = 0;
  const pending = new Map();
  const rejectPending = message => {
    for (const { reject, timer, method } of pending.values()) { clearTimeout(timer); reject(new Error(`${message} (${method})`)); }
    pending.clear();
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('The receipt renderer closed unexpectedly.'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The receipt renderer took too long. No receipt was sent.')); }, 20000);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    child = spawn(executable, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    child.on('error', error => { exitError = error; closed = true; });
    child.on('close', () => { closed = true; rejectPending('The receipt renderer closed unexpectedly.'); });
    let endpoint;
    const deadline = Date.now() + 20000;
    while (!endpoint && Date.now() < deadline) {
      if (closed) throw new Error(`Cannot start the receipt renderer${exitError ? `: ${exitError.message}` : '.'}`);
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) endpoint = `ws://127.0.0.1:${port}${path}`;
      } catch {}
      if (!endpoint) await delay(100);
    }
    if (!endpoint) throw new Error('The receipt renderer could not start. Restart the printing service and try again.');
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cannot connect to the receipt renderer.')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Cannot connect to the receipt renderer.')); };
    });
    socket.onclose = () => rejectPending('The receipt renderer disconnected.');
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: 612, height: 792, deviceScaleFactor: 300 / 72, mobile: false });
    const { frameTree } = await page('Page.getFrameTree');
    const [template, model, renderer] = await Promise.all([
      waybill ? Promise.resolve(Buffer.alloc(0)) : readFile(join(publicDir, 'tra-template.svg')),
      readFile(join(publicDir, waybill ? 'waybill-model.js' : 'tra-model.js'), 'utf8'),
      readFile(join(publicDir, waybill ? 'waybill-render.js' : 'tra-render.js'), 'utf8'),
    ]);
    const uri = `data:image/svg+xml;base64,${template.toString('base64')}`;
    const artwork = waybill ? '<g id="waybill-content"></g>' : `<image href="${uri}" width="612" height="792"/><g id="receipt-overlay" fill="#000" font-family="Calibri, Arial, sans-serif"></g>`;
    // Fixed local markup only. All user strings enter via textContent in the
    // same renderer as the phone preview; none are interpolated into HTML.
    await page('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>html,body{margin:0;width:612px;height:792px;overflow:hidden;background:white}svg{display:block;width:612px;height:792px}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792">${artwork}</svg></body></html>` });
    const expression = `(async () => {
      ${model.replace(/^export /gm, '')}
      ${renderer.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')}
      const input = ${JSON.stringify(input)};
      ${waybill ? '' : `const image = new Image(); image.src = ${JSON.stringify(uri)}; await image.decode();`}
      await document.fonts.ready;
      const errors = ${waybill ? "renderWaybillPreview(document.querySelector('svg'), input.waybills)" : "renderTraPreview(document.querySelector('svg'), calculateReceipt(input.items), input.details)"};
      if (errors.length) throw new Error(errors.join(' '));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`;
    const rendered = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (rendered.exceptionDetails) throw new Error(rendered.exceptionDetails.exception?.description?.split('\n')[0] || 'The receipt does not fit the template.');
    const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = Buffer.from(data, 'base64');
    if (png.length < 24 || png.readUInt32BE(16) !== 2550 || png.readUInt32BE(20) !== 3300) throw new Error('The receipt renderer returned an unexpected page size.');
    return png;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
    socket?.close();
    for (let i = 0; child && !closed && i < 30; i++) await delay(100);
    if (child && !closed) child.kill();
    rejectPending('Receipt rendering finished.');
    // profile was created with mkdtemp directly inside the app's tmp directory.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  }
}
