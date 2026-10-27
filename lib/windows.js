import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptRoot = fileURLToPath(new URL('../scripts/', import.meta.url));
export function powershell(script, args = [], timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scriptRoot, script), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Windows took too long to respond. Check the Windows print queue before trying again.'));
      if (code !== 0) {
        let message = stderr.trim() || stdout.trim() || 'Windows could not process the label.';
        try { message = JSON.parse(stdout).error || message; } catch {}
        return reject(new Error(message.slice(0, 700)));
      }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('Windows returned an unexpected response.')); }
    });
  });
}
export function windowsAdapter(dataDir) {
  const tmp = join(dataDir, 'tmp');
  async function run(input, printer, preparedImage) {
    await mkdir(tmp, { recursive: true });
    const id = randomUUID();
    const inputPath = join(tmp, `${id}.json`), outputPath = join(tmp, `${id}.png`), preparedPath = join(tmp, `${id}-prepared.png`);
    try {
      await writeFile(inputPath, JSON.stringify(input), 'utf8');
      const args = ['-InputPath', inputPath];
      if (printer && preparedImage) {
        await writeFile(preparedPath, preparedImage);
        args.push('-PreparedImagePath', preparedPath);
      }
      if (!printer) args.push('-OutputPath', outputPath);
      if (printer) args.push('-Print', '-PrinterName', printer);
      const result = await powershell('label-worker.ps1', args, printer ? 90000 : 30000);
      return printer ? { timings: result.timings, totalMs: result.totalMs, copyPlan: result.copyPlan } : await readFile(outputPath);
    } finally {
      await Promise.allSettled([rm(inputPath, { force: true }), rm(outputPath, { force: true }), rm(preparedPath, { force: true })]);
    }
  }
  return { listPrinters: () => powershell('printers.ps1'), render: input => run(input), print: (input, printer, preparedImage) => run(input, printer, preparedImage) };
}
