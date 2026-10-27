import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const worker = fileURLToPath(new URL('../scripts/catalog.php', import.meta.url));
const defaults = Object.freeze({
  phpPath: 'C:\\xampp\\php\\php.exe', host: '127.0.0.1', port: 3306,
  database: 'products', table: 'products', user: 'root', password: '',
});

function catalogError(message, status = 503) { return Object.assign(new Error(message), { status }); }

export function parseCatalogQuery(params) {
  const query = (params.get('q') || '').trim();
  if (query.length > 100 || /[\x00-\x1F\x7F]/.test(query)) throw catalogError('Search must contain at most 100 characters on one line.', 400);
  function integer(name, fallback, maximum) {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > maximum) throw catalogError(`Invalid catalog ${name}.`, 400);
    return Number(raw);
  }
  return { query, page: integer('page', 1, 1000000), pageSize: integer('pageSize', 25, 100) };
}

export function validateProductId(id) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) throw catalogError('Invalid product ID.', 400);
  return id;
}

export function validateCatalogBarcode(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || value !== value.trim() || /[\x00-\x1F\x7F]/.test(value)) {
    throw catalogError('A barcode must contain 1 to 100 characters, without surrounding spaces or control characters.', 400);
  }
  return value;
}

export async function readCatalogSettings(dataDir) {
    let settings = {};
    try { settings = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw catalogError('The catalog settings could not be read. Check data/catalog.json on the PC.');
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw catalogError('The catalog settings are invalid. Check data/catalog.json on the PC.');
    }
    const config = { ...defaults, ...settings };
    if (typeof config.phpPath !== 'string' || !config.phpPath || typeof config.host !== 'string' || !/^[A-Za-z0-9.:[\]-]+$/.test(config.host) ||
        !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
        ![config.database, config.table].every(value => typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value)) ||
        typeof config.user !== 'string' || typeof config.password !== 'string') {
      throw catalogError('The catalog settings are invalid. Check data/catalog.json on the PC.');
    }
    return config;
}

export function createCatalog({ dataDir, execute = executePhp } = {}) {
  let active = 0;
  async function request(action, values) {
    const config = await readCatalogSettings(dataDir);
    if (active >= 4) throw catalogError('The catalog is busy. Try your search again in a moment.', 429);
    active++;
    try { return await execute(config.phpPath, { action, ...values, config }); }
    finally { active--; }
  }
  return {
    search: options => request('search', options),
    findByBarcode: value => request('barcode', { value: validateCatalogBarcode(value) }),
    getProduct: id => request('product', { id: validateProductId(id) }),
  };
}

function executePhp(phpPath, payload) {
  return new Promise((resolve, reject) => {
    // Settings travel through stdin, never through a URL or process arguments.
    const child = spawn(phpPath, ['-d', 'display_errors=stderr', worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, timedOut = false, oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { oversized = true; child.kill(); }
      else chunks.push(chunk);
    });
    // Driver diagnostics can include account/database details; never expose them.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', error => {
      clearTimeout(timer);
      reject(catalogError(error.code === 'ENOENT' ? 'XAMPP PHP was not found. Check phpPath in data/catalog.json on the PC.' : 'The catalog reader could not start on the PC.'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(catalogError('The product catalog took too long to respond. Check MySQL in XAMPP.'));
      if (oversized) return reject(catalogError('The product catalog returned too much data. Try a narrower search.'));
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(catalogError('The catalog reader returned an unexpected response. Check XAMPP PHP on the PC.')); }
      if (code !== 0 || result.error) return reject(catalogError(result.error || 'The catalog could not be read.', result.status || 503));
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
