import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { powershell } from './windows.js';
import { renderReceipt } from './receipt-renderer.js';

export function receiptWindowsAdapter(dataDir, { kind = 'receipt' } = {}) {
  async function run(input, printer, png) {
    const tmp = join(dataDir, 'tmp');
    await mkdir(tmp, { recursive: true });
    const imagePath = join(tmp, `receipt-${randomUUID()}.png`);
    try {
      const args = ['-PrinterName', printer, '-Paper', input.paper, '-Copies', String(input.copies)];
      if (kind === 'waybill') args.push('-DocumentKind', 'Waybill');
      if (png) { await writeFile(imagePath, png); args.push('-ImagePath', imagePath, '-Print'); }
      else args.push('-CheckPrinter');
      return await powershell('receipt-worker.ps1', args, png ? 90000 : 30000);
    } finally { if (png) await rm(imagePath, { force: true }).catch(() => {}); }
  }
  return { render: input => renderReceipt(input, dataDir, kind), check: (input, printer) => run(input, printer), print: run };
}
