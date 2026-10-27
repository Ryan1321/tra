import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RECEIPT_PAPERS, validateReceiptRequest } from './receipt.js';
import { validateWaybillRequest } from './waybill.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const publicJob = ({ fingerprint, ...job }) => ({ ...job });
const documentPrinter = printer => !/citizen|label|zebra|dymo|pdf|onenote|xps|fax/i.test(printer.name);

export async function createReceiptPrinting({ dataDir, config, configPath, persist, printers, adapter, kind = 'receipt', lock = { busy: false } }) {
  const waybill = kind === 'waybill';
  const noun = waybill ? 'waybill' : 'receipt';
  const title = waybill ? 'Waybill' : 'Receipt';
  const jobsPath = join(dataDir, `${noun}-jobs.json`);
  let jobs;
  try { jobs = JSON.parse(await readFile(jobsPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read data/${noun}-jobs.json. Restore it before restarting.`); jobs = []; }
  if (!Array.isArray(jobs)) throw new Error(`Invalid data/${noun}-jobs.json.`);
  for (const job of jobs) {
    if (job.status === 'preparing') { job.status = 'failed'; job.error = `Service restarted before this ${noun} was sent. No ${noun} was sent.`; }
    if (job.status === 'submitting') { job.status = 'unknown'; job.error = 'Service restarted during submission. Check the Windows print queue before printing again.'; }
  }
  await persist(jobsPath, jobs);
  async function status() {
    const available = await printers();
    const list = available.printers.filter(documentPrinter);
    const epson = list.filter(p => /epson.*l12[01]/i.test(p.name));
    if (!config.receiptPrinter && epson.length === 1) {
      config.receiptPrinter = epson[0].name;
      await persist(configPath, config);
    }
    return {
      printers: list, selectedPrinter: list.some(p => p.name === config.receiptPrinter) ? config.receiptPrinter : null,
      printerError: available.printerError, busy: lock.busy, papers: waybill ? { Letter: RECEIPT_PAPERS.Letter } : RECEIPT_PAPERS,
      recentJobs: jobs.slice(-8).reverse().map(publicJob),
    };
  }
  async function select(printerName) {
    if (lock.busy) throw bad('Wait for the current document to finish submitting.', 409);
    const available = await status();
    if (lock.busy) throw bad('Wait for the current document to finish submitting.', 409);
    if (!available.printers.some(p => p.name === printerName)) throw bad('Choose an installed document printer.');
    config.receiptPrinter = printerName;
    await persist(configPath, config);
    return { selectedPrinter: printerName };
  }
  function get(id) {
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(id)) throw bad(`Invalid ${noun} print request ID.`);
    const job = jobs.find(job => job.id === id);
    if (!job) throw bad(`${title} print job not found.`, 404);
    return { job: publicJob(job) };
  }
  async function run(job, input) {
    try {
      // Rendering and driver validation finish before the submission record.
      // Never accept client HTML, SVG, image bytes or a local file path.
      const png = await adapter.render(input);
      await adapter.check(input, job.printer);
      job.status = 'submitting';
      try { await persist(jobsPath, jobs); }
      catch { job.status = 'failed'; throw new Error(`The ${noun} could not be saved before printing. No ${noun} was sent.`); }
      await adapter.print(input, job.printer, png);
      job.status = 'submitted';
    } catch (error) {
      const uncertain = job.status === 'submitting';
      job.status = uncertain ? 'unknown' : 'failed';
      job.error = uncertain ? `${error.message} Check the Windows print queue before printing again.` : error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      try { await persist(jobsPath, jobs); }
      catch { job.status = 'unknown'; job.error = 'The result could not be saved. Check the Windows print queue before printing again.'; }
      lock.busy = false;
    }
  }
  async function submit(data) {
    const input = waybill ? validateWaybillRequest(data) : validateReceiptRequest(data);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = jobs.find(job => job.id === data.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw bad(`This request ID belongs to a different ${noun}.`, 409);
      return { job: publicJob(previous), duplicate: true };
    }
    if (lock.busy) throw bad('Another document is being sent. Try again when it finishes.', 409);
    lock.busy = true;
    let started = false;
    try {
      const available = await status();
      if (!available.selectedPrinter) throw bad('Select the Epson document printer first.');
      const job = {
        id: data.requestId, fingerprint, status: 'preparing', createdAt: new Date().toISOString(),
        printer: available.selectedPrinter,
        copies: input.copies, paper: input.paper,
        ...(waybill ? { waybillNumbers: input.waybills.map(entry => entry.number) }
          : { receiptNumber: input.details.receiptNumber, itemCount: input.items.length, total: input.total }),
      };
      jobs.push(job);
      try { await persist(jobsPath, jobs); }
      catch { job.status = 'failed'; job.error = `The ${noun} print request could not be saved. No ${noun} was sent.`; throw bad(job.error, 500); }
      started = true;
      void run(job, input);
      return { job: publicJob(job) };
    } finally { if (!started) lock.busy = false; }
  }
  return { status, select, get, submit, history: () => jobs.map(publicJob) };
}
