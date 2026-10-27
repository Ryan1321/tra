import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('native label helpers preserve ink bounds and exact copy counts with driver fallback', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./label-native-check.ps1', import.meta.url))], { windowsHide: true, timeout: 30000 });
  assert.match(stdout, /Ink bounds preserve/);
  assert.match(stdout, /Copy plans preserve quantities/);
});
