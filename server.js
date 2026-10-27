import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LABEL, validateFields, validateCopies } from './lib/validation.js';
import { windowsAdapter } from './lib/windows.js';
import { createCatalog, parseCatalogQuery, validateCatalogBarcode, validateProductId } from './lib/catalog.js';
import { validateBatch, BATCH_LIMITS } from './lib/batch.js';
import { loadLocalHttps, certificateCoversHost } from './lib/local-https.js';
import { createReceiptPrinting } from './lib/receipt-printing.js';
import { receiptWindowsAdapter } from './lib/receipt-windows.js';
import { createSharedDrafts } from './lib/shared-drafts.js';
import { createReceiptStorage } from './lib/receipt-storage.js';
import { buildDashboard } from './lib/dashboard.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const VIRTUAL = /pdf|onenote|xps|fax/i;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
function safeEqual(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function readJson(req, maximumBytes = 8192) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw bad('Send JSON data.', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw bad('The request is too large.', 413);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { const data = JSON.parse(body); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; return data; }
  catch { throw bad('The request contains invalid JSON.'); }
}
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}. Restore the file or move it aside before restarting.`); }
}

export async function createService({ dataDir = join(root, 'data'), adapter = windowsAdapter(dataDir), receiptAdapter = receiptWindowsAdapter(dataDir), waybillAdapter = receiptWindowsAdapter(dataDir, { kind: 'waybill' }), catalog = createCatalog({ dataDir }), receiptStorage = createReceiptStorage({ dataDir }), port = 4173, tls = null } = {}) {
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json'), jobsPath = join(dataDir, 'jobs.json');
  const config = await loadJson(configPath, { selectedPrinter: null, token: randomBytes(32).toString('hex') });
  if (!config.token || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid token in data/config.json. Move this file aside to pair again.');
  const jobs = await loadJson(jobsPath, []);
  if (!Array.isArray(jobs)) throw new Error('Invalid data/jobs.json.');
  for (const job of jobs) if (job.status === 'submitting') { job.status = 'unknown'; job.error = 'Service restarted during submission. Check the Windows print queue before printing again.'; }
  const batchesPath = join(dataDir, 'batches.json');
  const batches = await loadJson(batchesPath, []);
  if (!Array.isArray(batches) || batches.some(batch => !Array.isArray(batch.items))) throw new Error('Invalid data/batches.json.');
  for (const batch of batches) {
    if (!['validating', 'printing'].includes(batch.status)) continue;
    batch.status = 'interrupted';
    batch.error = 'The service restarted before this batch finished. Check the Windows print queue. This batch will not resume automatically.';
    batch.finishedAt = new Date().toISOString();
    for (const item of batch.items) {
      if (item.status === 'submitting') item.status = 'unknown';
      else if (item.status === 'pending') item.status = 'not_sent';
    }
  }
  const writes = new Map();
  const persist = (path, value) => {
    const snapshot = JSON.stringify(value, null, 2);
    const operation = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, snapshot);
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${path}.tmp`, path); break; }
        catch (error) {
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          await delay(25 * (2 ** attempt));
        }
      }
    });
    writes.set(path, operation);
    return operation;
  };
  await persist(configPath, config);
  await persist(jobsPath, jobs);
  await persist(batchesPath, batches);
  const sharedDrafts = await createSharedDrafts({ dataDir, persist });
  const pairCode = String(randomInt(100000, 1000000));
  const attempts = new Map();
  let portNumber = port, printBusy = false, previewsRunning = 0, printersCache = null;
  let printerLookup = null;
  const previewCache = new Map();
  const previewPending = new Map();
  function addresses() { return [...new Set(Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address))]; }
  function allowedHosts(requestPort) { return new Set(['localhost', '127.0.0.1', '[::1]', ...addresses()].map(host => `${host}:${requestPort}`)); }
  let httpsServer = null;
  function cameraSetup(hostname) {
    const enabled = Boolean(httpsServer?.listening);
    const securePort = enabled ? httpsServer.address().port : null;
    const httpsUrls = enabled ? addresses().filter(ip => certificateCoversHost(tls.leaf, ip)).map(ip => `https://${ip}:${securePort}`) : [];
    const httpsUrl = enabled && certificateCoversHost(tls.leaf, hostname) ? `https://${hostname}:${securePort}` : (httpsUrls[0] || null);
    const httpPort = server.listening ? server.address().port : portNumber;
    return { enabled, httpsUrls, httpsUrl, httpUrl: `http://${hostname}:${httpPort}`, certificateUrl: tls ? '/camera-ca.crt' : null, fingerprint: tls?.authority.fingerprint256 || null };
  }
  async function printers() {
    if (printersCache && Date.now() - printersCache.at < 15000) return printersCache.value;
    if (printerLookup) return printerLookup;
    printerLookup = (async () => {
      let value;
      try {
        const result = await adapter.listPrinters();
        const list = (result.printers || []).filter(p => p.name && !VIRTUAL.test(p.name));
        const citizen = list.filter(p => /citizen.*331/i.test(p.name));
        if (!config.selectedPrinter && citizen.length === 1) { config.selectedPrinter = citizen[0].name; await persist(configPath, config); }
        value = { printers: list, selectedPrinter: list.some(p => p.name === config.selectedPrinter) ? config.selectedPrinter : null, printerError: result.error || null };
      } catch (error) { value = { printers: [], selectedPrinter: null, printerError: error.message }; }
      printersCache = { at: Date.now(), value };
      return value;
    })().finally(() => { printerLookup = null; });
    return printerLookup;
  }
  async function render(input) {
    // Copy count changes the print quantity, never the rendered sticker image.
    const { copies, ...renderInput } = input;
    const key = hash(renderInput);
    if (previewCache.has(key)) return previewCache.get(key);
    if (previewPending.has(key)) return previewPending.get(key);
    if (previewsRunning >= 2) throw bad('Preview is busy. Try again in a moment.', 429);
    previewsRunning++;
    const pending = Promise.resolve().then(() => adapter.render(renderInput)).then(png => {
      if (previewCache.size >= 24) previewCache.delete(previewCache.keys().next().value);
      previewCache.set(key, png);
      return png;
    }).finally(() => { previewsRunning--; previewPending.delete(key); });
    previewPending.set(key, pending);
    return pending;
  }
  const publicJob = ({ fingerprint, requestId, ...job }) => job;
  const publicBatch = ({ fingerprint, ...batch }) => batch;
  const documentPrintLock = { busy: false };
  const receiptPrinting = await createReceiptPrinting({ dataDir, config, configPath, persist, printers, adapter: receiptAdapter, lock: documentPrintLock });
  const waybillPrinting = await createReceiptPrinting({ dataDir, config, configPath, persist, printers, adapter: waybillAdapter, kind: 'waybill', lock: documentPrintLock });

  async function runBatch(batch, inputs) {
    let currentJob = null;
    // Retain all preflight images even when a batch exceeds the preview cache.
    const preparedImages = [];
    try {
      // Fit every label before sending any item. An invalid last item cannot
      // cause the beginning of a batch to print unexpectedly.
      for (let index = 0; index < inputs.length; index++) {
        try { preparedImages.push(await render(inputs[index])); }
        catch (error) { throw new Error(`Item ${index + 1} (${inputs[index].fields.productName}): ${error.message}`); }
        batch.validatedItems = index + 1;
        await persist(batchesPath, batches);
      }
      batch.status = 'printing';
      await persist(batchesPath, batches);
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index], item = batch.items[index];
        currentJob = {
          id: randomUUID(), requestId: `batch:${batch.id}:${index + 1}`,
          fingerprint: hash({ fields: input.fields, copies: input.copies, layout: input.layout.version }),
          createdAt: new Date().toISOString(), status: 'submitting', fields: input.fields,
          copies: input.copies, labelsPerCopy: 2, layoutVersion: input.layout.version,
          printer: batch.printer, batchId: batch.id, batchItem: index + 1,
        };
        jobs.push(currentJob);
        if (jobs.length > 200) jobs.splice(0, jobs.length - 200);
        item.jobId = currentJob.id;
        item.status = 'submitting';
        // Both records exist before touching the printer. On a crash we err on
        // the side of reporting uncertainty, never resubmitting a label.
        await persist(jobsPath, jobs);
        await persist(batchesPath, batches);
        try {
          const result = await adapter.print(input, batch.printer, preparedImages[index]);
          if (result?.timings) currentJob.timings = result.timings;
          if (result?.copyPlan) currentJob.copyPlan = result.copyPlan;
          currentJob.status = item.status = 'submitted';
        } catch (error) {
          currentJob.status = item.status = 'unknown';
          currentJob.error = item.error = `${error.message} Check the Windows print queue before printing again.`;
          batch.status = 'stopped';
          batch.error = `Stopped at item ${index + 1}. ${item.error}`;
          for (const remaining of batch.items.slice(index + 1)) remaining.status = 'not_sent';
        }
        await persist(jobsPath, jobs);
        await persist(batchesPath, batches);
        if (batch.status === 'stopped') break;
        currentJob = null;
      }
      if (batch.status === 'printing') batch.status = 'submitted';
      batch.finishedAt = new Date().toISOString();
      await persist(batchesPath, batches);
    } catch (error) {
      const started = batch.items.some(item => ['submitting', 'submitted', 'unknown'].includes(item.status));
      batch.status = started ? 'stopped' : 'failed';
      batch.error = started
        ? `${error.message} Check the Windows print queue before printing again. The remaining items were not sent.`
        : error.message;
      batch.finishedAt = new Date().toISOString();
      for (const item of batch.items) {
        if (item.status === 'submitting') item.status = 'unknown';
        else if (item.status === 'pending') item.status = 'not_sent';
      }
      if (currentJob?.status === 'submitting') {
        currentJob.status = 'unknown';
        currentJob.error = batch.error;
      }
      // If storage is unavailable, the pre-submission records still protect
      // retries after restart; the live API also retains the stopped result.
      await Promise.allSettled([persist(jobsPath, jobs), persist(batchesPath, batches)]);
    } finally { printBusy = false; }
  }

  const requestHandler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function json(status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    try {
      const host = req.headers.host;
      // Use the real socket, never proxy headers, to bind Host and Origin to
      // the listener that received this request.
      const protocol = req.socket.encrypted ? 'https' : 'http';
      const requestPort = req.socket.localPort;
      if (!allowedHosts(requestPort).has(host)) throw bad('Open the service using the address shown on the PC.', 403);
      if (req.headers.origin && req.headers.origin !== `${protocol}://${host}`) throw bad('This request came from another website.', 403);
      const url = new URL(req.url, `${protocol}://${host}`);
      const path = url.pathname;
      const local = LOOPBACK.has(req.socket.remoteAddress);
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const authed = safeEqual(token, config.token);
      if (req.method === 'GET' && path === '/api/camera-setup') return json(200, cameraSetup(url.hostname));
      if (['GET', 'HEAD'].includes(req.method) && path === '/camera-ca.crt') {
        if (!tls) throw bad('Camera HTTPS has not been set up on this PC.', 404);
        const certificate = tls.authority.raw;
        res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="citizen-camera-ca.crt"', 'Content-Length': certificate.length });
        return res.end(req.method === 'HEAD' ? undefined : certificate);
      }
      if (req.method === 'GET' && path === '/api/status') {
        return json(200, { service: 'citizen-mobile-labels', pairedRequired: !authed, localSetup: local, label: LABEL, ...(authed ? { ...(url.searchParams.get('includePrinters') === 'false' ? {} : await printers()), recentJobs: jobs.slice(-12).reverse().map(publicJob), batchLimits: BATCH_LIMITS } : {}) });
      }
      if (req.method === 'GET' && path === '/api/setup') {
        if (!local) throw bad('Pair your phone using the code shown on the Windows PC.', 403);
        return json(200, { pairCode, token: config.token, phoneUrls: addresses().map(ip => `http://${ip}:${portNumber}`), label: LABEL, ...(url.searchParams.get('includePrinters') === 'false' ? {} : await printers()) });
      }
      if (req.method === 'POST' && path === '/api/pair') {
        const data = await readJson(req);
        const ip = req.socket.remoteAddress;
        for (const [key, value] of attempts) if (Date.now() - value.since > 900000) attempts.delete(key);
        const entry = attempts.get(ip) || { count: 0, since: Date.now() };
        if (entry.count >= 10 || attempts.size > 1000) throw bad('Too many pairing attempts. Wait 15 minutes or restart the service.', 429);
        entry.count++; attempts.set(ip, entry);
        if (!safeEqual(String(data.code || ''), pairCode)) throw bad('That pairing code does not match the code on the PC.', 401);
        attempts.delete(ip);
        return json(200, { token: config.token });
      }
      if (path.startsWith('/api/')) {
        if (!authed) throw bad('Pair this device with the Windows PC first.', 401);
        if (req.method === 'GET' && path === '/api/dashboard') return json(200, buildDashboard({
          stickers: jobs, receipts: receiptPrinting.history(), waybills: waybillPrinting.history(), batches,
          config, printBusy, documentBusy: documentPrintLock.busy,
        }));
        if (path.startsWith('/api/drafts/')) {
          const kind = path.slice('/api/drafts/'.length);
          if (req.method === 'GET') return json(200, { draft: sharedDrafts.get(kind) });
          if (req.method === 'POST') {
            const result = await sharedDrafts.update(kind, await readJson(req, 196608));
            return json(result.conflict ? 409 : 200, result);
          }
        }
        if (req.method === 'GET' && path === '/api/waybills/status') return json(200, await waybillPrinting.status());
        if (req.method === 'POST' && path === '/api/waybills/printer') return json(200, await waybillPrinting.select((await readJson(req)).printerName));
        if (req.method === 'POST' && path === '/api/waybills/print') {
          const result = await waybillPrinting.submit(await readJson(req, 16384));
          return json(result.duplicate ? 200 : 202, result);
        }
        if (req.method === 'GET' && path.startsWith('/api/waybills/jobs/')) return json(200, waybillPrinting.get(path.slice('/api/waybills/jobs/'.length)));
        if (req.method === 'POST' && path === '/api/receipts/number') {
          const data = await readJson(req);
          if (data.currentNumber !== undefined && (typeof data.currentNumber !== 'string' || !/^(?:#?[0-9]{1,20})?$/.test(data.currentNumber))) throw bad('Invalid current receipt number.');
          return json(200, await receiptStorage.reserveNumber(data.requestId, [sharedDrafts.get('tra').data.receiptNumber, data.currentNumber]));
        }
        if (req.method === 'GET' && path === '/api/receipts/saved') return json(200, await receiptStorage.search(url.searchParams));
        if (req.method === 'POST' && path === '/api/receipts/saved') {
          const result = await receiptStorage.save(await readJson(req, 32768), sharedDrafts.get('tra').data.receiptNumber);
          return json(result.duplicate ? 200 : 201, result);
        }
        if (req.method === 'POST' && /^\/api\/receipts\/saved\/[a-f0-9]{32}\/status$/.test(path)) {
          const result = await receiptStorage.updateStatus(path.split('/')[4], await readJson(req));
          return json(result.conflict ? 409 : 200, result);
        }
        if (req.method === 'GET' && path.startsWith('/api/receipts/saved/')) return json(200, await receiptStorage.get(path.slice('/api/receipts/saved/'.length)));
        if (req.method === 'GET' && path === '/api/receipts/status') return json(200, await receiptPrinting.status());
        if (req.method === 'POST' && path === '/api/receipts/printer') return json(200, await receiptPrinting.select((await readJson(req)).printerName));
        if (req.method === 'POST' && path === '/api/receipts/print') {
          const result = await receiptPrinting.submit(await readJson(req, 32768));
          return json(result.duplicate ? 200 : 202, result);
        }
        if (req.method === 'GET' && path.startsWith('/api/receipts/jobs/')) return json(200, receiptPrinting.get(path.slice('/api/receipts/jobs/'.length)));
        if (req.method === 'GET' && path === '/api/products') return json(200, await catalog.search(parseCatalogQuery(url.searchParams)));
        if (req.method === 'GET' && path === '/api/products/barcode') return json(200, await catalog.findByBarcode(validateCatalogBarcode(url.searchParams.get('value'))));
        if (req.method === 'GET' && path.startsWith('/api/products/')) return json(200, await catalog.getProduct(validateProductId(path.slice('/api/products/'.length))));
        if (req.method === 'GET' && path === '/api/jobs') return json(200, { jobs: jobs.slice(-12).reverse().map(publicJob) });
        if (req.method === 'GET' && path.startsWith('/api/batches/')) {
          const id = path.slice('/api/batches/'.length);
          if (!/^[a-zA-Z0-9-]{16,64}$/.test(id)) throw bad('Invalid batch request ID.');
          const batch = batches.find(entry => entry.id === id);
          if (!batch) throw bad('This batch was not found on the PC.', 404);
          return json(200, { batch: publicBatch(batch) });
        }
        if (req.method === 'POST' && path === '/api/batches') {
          const data = await readJson(req, 65536);
          const { inputs, totalPairs } = validateBatch(data);
          const fingerprint = hash(inputs.map(input => ({ fields: input.fields, copies: input.copies, layout: input.layout.version })));
          const previous = batches.find(batch => batch.id === data.requestId);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw bad('This request ID belongs to a different batch.', 409);
            return json(200, { batch: publicBatch(previous), duplicate: true });
          }
          if (printBusy) throw bad('Another print job is being sent. Try again when it finishes.', 409);
          printBusy = true;
          let handedToWorker = false;
          try {
            const available = await printers();
            if (!available.selectedPrinter) throw bad('Select the Citizen printer in setup on your Windows PC.');
            const batch = {
              id: data.requestId, fingerprint, createdAt: new Date().toISOString(), status: 'validating', validatedItems: 0,
              printer: available.selectedPrinter, totalPairs, labelsPerCopy: 2, layoutVersion: inputs[0].layout.version,
              items: inputs.map(input => ({ fields: input.fields, copies: input.copies, status: 'pending' })),
            };
            batches.push(batch);
            // Retain batch IDs independently of the shorter per-label history.
            if (batches.length > 200) batches.splice(0, batches.length - 200);
            try { await persist(batchesPath, batches); }
            catch {
              batch.status = 'failed';
              batch.error = 'The batch could not be saved. No labels were sent.';
              batch.items.forEach(item => { item.status = 'not_sent'; });
              throw bad(batch.error, 500);
            }
            const result = { batch: publicBatch(batch) };
            handedToWorker = true;
            void runBatch(batch, inputs);
            return json(202, result);
          } finally { if (!handedToWorker) printBusy = false; }
        }
        if (req.method === 'POST' && path === '/api/printer') {
          if (printBusy) throw bad('Wait for the current label to be submitted.', 409);
          const data = await readJson(req);
          const available = await printers();
          if (!available.printers.some(p => p.name === data.printerName)) throw bad('Choose an installed label printer.');
          config.selectedPrinter = data.printerName;
          await persist(configPath, config); printersCache = null;
          return json(200, { selectedPrinter: data.printerName });
        }
        if (req.method === 'POST' && path === '/api/preview') {
          const data = await readJson(req), input = validateFields(data.fields, data.labelLayout);
          const png = await render(input);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); return res.end(png);
        }
        if (req.method === 'POST' && path === '/api/print') {
          const data = await readJson(req), input = validateFields(data.fields, data.labelLayout), copies = validateCopies(data.copies);
          if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId)) throw bad('A valid print request ID is required. Refresh the page.');
          const fingerprint = hash({ fields: input.fields, copies, layout: input.layout.version });
          const previous = jobs.find(j => j.requestId === data.requestId);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw bad('This request ID belongs to a different label.', 409);
            return json(200, { job: publicJob(previous), duplicate: true });
          }
          if (printBusy) throw bad('Another label is being sent. Try again shortly.', 409);
          printBusy = true;
          try {
            const available = await printers();
            if (!available.selectedPrinter) throw bad('Select the Citizen printer in setup on your Windows PC.');
            // Validate text fitting before recording/submitting a print job.
            const preparedImage = await render(input);
            const job = { id: randomUUID(), requestId: data.requestId, fingerprint, createdAt: new Date().toISOString(), status: 'submitting', fields: input.fields, copies, labelsPerCopy: 2, layoutVersion: input.layout.version, printer: available.selectedPrinter };
            jobs.push(job);
            if (jobs.length > 200) jobs.splice(0, jobs.length - 200);
            await persist(jobsPath, jobs);
            try {
              const result = await adapter.print({ ...input, copies }, job.printer, preparedImage);
              if (result?.timings) job.timings = result.timings;
              if (result?.copyPlan) job.copyPlan = result.copyPlan;
              job.status = 'submitted';
            } catch (error) {
              job.status = 'unknown';
              job.error = `${error.message} Check the Windows print queue before trying again.`;
            }
            try { await persist(jobsPath, jobs); }
            catch { throw bad('The print result could not be saved. Check the Windows print queue before trying again.', 500); }
            return json(200, { job: publicJob(job) });
          } finally { printBusy = false; }
        }
        throw bad('API route not found.', 404);
      }
      const files = {
        '/glass.css': 'glass.css',
        '/mobile-workspace.js': 'mobile-workspace.js',
        '/liquid-glass.js': 'liquid-glass.js',
        '/draft-sync.js': 'draft-sync.js', '/draft-sync.css': 'draft-sync.css',
        '/label-layouts.js': 'label-layouts.js',
        '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/icon.svg': 'icon.svg',
        '/dashboard': 'dashboard.html', '/dashboard/': 'dashboard.html',
        '/dashboard.js': 'dashboard.js', '/dashboard.css': 'dashboard.css',
        '/tra': 'tra.html', '/tra/': 'tra.html', '/tra.html': 'tra.html', '/tra.js': 'tra.js',
        '/tra.css': 'tra.css', '/tra-model.js': 'tra-model.js', '/tra-template.svg': 'tra-template.svg', '/tra-catalog.js': 'tra-catalog.js',
        '/tra-render.js': 'tra-render.js', '/tra-print.js': 'tra-print.js', '/tra-saved.js': 'tra-saved.js', '/tra-numbering.js': 'tra-numbering.js', '/tra-status-model.js': 'tra-status-model.js',
        '/waybill': 'waybill.html', '/waybill/': 'waybill.html', '/waybill.html': 'waybill.html',
        '/waybill.js': 'waybill.js', '/waybill.css': 'waybill.css', '/waybill-model.js': 'waybill-model.js', '/waybill-render.js': 'waybill-render.js',
        '/tra-scanner.js': 'tra-scanner.js', '/vendor/zxing-browser-0.1.5.min.js': 'vendor/zxing-browser-0.1.5.min.js',
        '/tra-photo.js': 'tra-photo.js',
        '/camera-setup': 'camera-setup.html', '/camera-setup.html': 'camera-setup.html', '/camera-setup.js': 'camera-setup.js', '/camera-setup.css': 'camera-setup.css',
        '/camera-ready': 'camera-ready.html', '/camera-ready.html': 'camera-ready.html', '/camera-ready.js': 'camera-ready.js',
        '/tra-auto-reader.js': 'tra-auto-reader.js', '/tra-auto-worker.js': 'tra-auto-worker.js',
        '/vendor/zxing-wasm-3.1.4-reader.js': 'vendor/zxing-wasm-3.1.4-reader.js', '/vendor/zxing-wasm-3.1.4-reader.wasm': 'vendor/zxing-wasm-3.1.4-reader.wasm',
      };
      if (!files[path] || !['GET', 'HEAD'].includes(req.method)) throw bad('Page not found.', 404);
      const filename = files[path], extension = filename.slice(filename.lastIndexOf('.'));
      const content = await readFile(join(root, 'public', filename));
      if (filename === 'tra-template.svg') {
        // Permit only this fixed template's embedded font definitions. The
        // rest of the app keeps its existing policy against inline styles.
        const fontStyle = content.toString('utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1].replace(/\r\n?/g, '\n');
        if (fontStyle === undefined) throw new Error('The TRA template font definitions are missing.');
        const styleHash = createHash('sha256').update(fontStyle).digest('base64');
        res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'sha256-${styleHash}'; font-src data:; frame-ancestors 'none'; base-uri 'none'`);
      }
      res.writeHead(200, { 'Content-Type': mime[extension], 'Content-Length': content.length });
      return res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(error.status || 400, { error: error.message || 'Something went wrong.' });
      else res.end();
    }
  };
  const server = http.createServer(requestHandler);
  if (tls) httpsServer = https.createServer({ key: tls.key, cert: tls.cert, minVersion: tls.minVersion || 'TLSv1.2' }, requestHandler);
  for (const listener of [server, httpsServer].filter(Boolean)) {
    listener.requestTimeout = 30000;
    listener.headersTimeout = 10000;
    listener.keepAliveTimeout = 5000;
  }
  return { server, httpsServer, cameraSetup, pairCode, token: config.token, setPort: value => { portNumber = value; }, phoneUrls: () => addresses().map(ip => `http://${ip}:${portNumber}`) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be from 1024 to 65535.');
  let tls = null;
  let securePort = Number(process.env.HTTPS_PORT || 4175);
  try {
    if (!Number.isInteger(securePort) || securePort < 1024 || securePort > 65535 || securePort === port) throw new Error('HTTPS_PORT must be a different port from PORT, between 1024 and 65535.');
    tls = await loadLocalHttps(join(root, 'data'));
  } catch (error) { console.error(`Camera HTTPS is unavailable: ${error.message} HTTP printing remains available.`); }
  const service = await createService({ port, tls });
  service.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://localhost:${port} or choose another PORT.` : error.message); process.exitCode = 1; });
  service.server.listen(port, '0.0.0.0', () => {
    console.log(`\nCitizen mobile labels\nPC: http://localhost:${port}\n${service.phoneUrls().map(url => `Phone: ${url}`).join('\n')}\nPairing code: ${service.pairCode}\nKeep this service running while printing.\n`);
  });
  if (service.httpsServer) {
    service.httpsServer.on('error', error => { console.error(`Camera HTTPS is unavailable: ${error.code === 'EADDRINUSE' ? `port ${securePort} is already in use.` : error.message} HTTP printing remains available.`); });
    service.httpsServer.listen(securePort, '0.0.0.0', () => {
      console.log(`Camera HTTPS: https://localhost:${securePort}/tra\n${service.cameraSetup('localhost').httpsUrls.map(url => `Phone camera: ${url}/tra`).join('\n')}\nInstall this PC's camera certificate on your phone once, using the setup shown on the Trust Receipt page.\n`);
    });
  }
}
