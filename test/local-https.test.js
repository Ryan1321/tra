import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.js';
import { loadLocalHttps } from '../lib/local-https.js';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const openSsl = 'C:\\xampp\\apache\\bin\\openssl.exe';
const hasOpenSsl = process.platform === 'win32' && await access(openSsl).then(() => true, () => false);
let fixtureDirectory, tls, ca;

async function setupCertificates() {
  await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(workspace, 'scripts/setup-camera-https.ps1'), '-DataDirectory', fixtureDirectory, '-OpenSslPath', openSsl]);
}

before(async () => {
  await mkdir(join(workspace, 'data'), { recursive: true });
  fixtureDirectory = await mkdtemp(join(workspace, 'data', '.camera-https-test-'));
  if (hasOpenSsl) {
    await setupCertificates();
    tls = await loadLocalHttps(fixtureDirectory);
    ca = await readFile(join(fixtureDirectory, 'tls', 'ca.crt'));
  }
});

after(async () => {
  if (!fixtureDirectory) return;
  const absolute = resolve(fixtureDirectory);
  assert.ok(absolute.startsWith(resolve(workspace, 'data') + sep + '.camera-https-test-'));
  await rm(absolute, { recursive: true, force: true });
});

async function fixture(t, useTls = true) {
  const dataDir = await mkdtemp(join(fixtureDirectory, 'service-'));
  const calls = [];
  const service = await createService({ dataDir, port: 0, tls: useTls ? tls : null,
    adapter: { async listPrinters() { return { printers: [] }; }, async render() { assert.fail('No rendering expected.'); }, async print() { assert.fail('No physical printing expected.'); } },
    catalog: { async search(query) { calls.push(query); return { products: [], total: 0 }; } },
  });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const listener of [service.server, service.httpsServer].filter(Boolean)) {
      listener.closeAllConnections();
      if (listener.listening) await new Promise(resolve => listener.close(resolve));
    }
  });
  return { service, calls };
}

function request(service, path, { secure = false, headers = {}, method = 'GET', body } = {}) {
  const listener = secure ? service.httpsServer : service.server;
  const port = listener.address().port;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({ hostname: '127.0.0.1', port, path, method, ca,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, data: res.headers['content-type']?.includes('application/json') && method !== 'HEAD' ? JSON.parse(bytes) : null });
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('without certificate files the service remains HTTP-only and does not expose keys', async t => {
  const empty = await mkdtemp(join(fixtureDirectory, 'empty-'));
  assert.equal(await loadLocalHttps(empty), null);
  const { service } = await fixture(t, false);
  assert.equal(service.httpsServer, null);
  const setup = await request(service, '/api/camera-setup');
  assert.equal(setup.status, 200);
  assert.deepEqual(setup.data, { enabled: false, httpsUrls: [], httpsUrl: null, httpUrl: `http://127.0.0.1:${service.server.address().port}`, certificateUrl: null, fingerprint: null });
  assert.equal((await request(service, '/camera-ca.crt')).status, 404);
  await mkdir(join(empty, 'tls'));
  await writeFile(join(empty, 'tls', 'ca.crt'), 'incomplete');
  await assert.rejects(loadLocalHttps(empty), /incomplete/);
});

test('HTTPS verifies against its local CA and shares pairing and catalog access with HTTP', { skip: !hasOpenSsl }, async t => {
  const { service, calls } = await fixture(t);
  assert.equal((await request(service, '/api/camera-setup')).data.enabled, false);
  await new Promise(resolve => service.httpsServer.listen(0, '127.0.0.1', resolve));
  const secureOrigin = `https://127.0.0.1:${service.httpsServer.address().port}`;
  const setup = await request(service, '/api/camera-setup');
  assert.equal(setup.data.enabled, true);
  assert.equal(setup.data.httpsUrl, secureOrigin);
  assert.equal(setup.data.fingerprint, tls.authority.fingerprint256);
  assert.equal(setup.data.token, undefined);
  assert.equal(setup.data.pairCode, undefined);
  const paired = await request(service, '/api/pair', { secure: true, method: 'POST', body: { code: service.pairCode }, headers: { Origin: secureOrigin } });
  assert.equal(paired.status, 200);
  assert.equal(paired.data.token, service.token);
  for (const secure of [false, true]) {
    assert.equal((await request(service, '/api/products', { secure })).status, 401);
    assert.equal((await request(service, '/api/products', { secure, headers: { Authorization: `Bearer ${paired.data.token}` } })).status, 200);
  }
  assert.equal(calls.length, 2);
  assert.equal((await request(service, '/api/setup?includePrinters=false', { secure: true })).data.token, service.token);
  const downloaded = await request(service, '/camera-ca.crt');
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['content-type'], 'application/x-x509-ca-cert');
  assert.equal(new X509Certificate(downloaded.bytes).fingerprint256, tls.authority.fingerprint256);
  assert.equal((await request(service, '/camera-ca.crt', { method: 'HEAD' })).bytes.length, 0);
  for (const path of ['/data/tls/ca.key', '/data/tls/server.key', '/server.key', '/ca.key', '/tls/server.key']) {
    assert.equal((await request(service, path, { secure: true })).status, 404);
  }
});

test('Host and Origin must match the actual listener even when forwarding headers claim otherwise', { skip: !hasOpenSsl }, async t => {
  const { service } = await fixture(t);
  await new Promise(resolve => service.httpsServer.listen(0, '127.0.0.1', resolve));
  const httpHost = `127.0.0.1:${service.server.address().port}`;
  const httpsHost = `127.0.0.1:${service.httpsServer.address().port}`;
  for (const [secure, headers] of [
    [false, { Host: httpsHost }], [true, { Host: httpHost }],
    [false, { Origin: `https://${httpHost}`, 'X-Forwarded-Proto': 'https' }],
    [true, { Origin: `http://${httpsHost}`, 'X-Forwarded-Proto': 'http' }],
    [true, { Origin: 'https://attacker.example', 'X-Forwarded-Host': 'attacker.example' }],
  ]) assert.equal((await request(service, '/api/status', { secure, headers })).status, 403);
  for (const secure of [false, true]) {
    const origin = secure ? `https://${httpsHost}` : `http://${httpHost}`;
    assert.equal((await request(service, '/api/status', { secure, headers: { Origin: origin } })).status, 200);
  }
  service.httpsServer.closeAllConnections();
  await new Promise(resolve => service.httpsServer.close(resolve));
  const setup = await request(service, '/api/camera-setup');
  assert.equal(setup.data.enabled, false);
  assert.equal(setup.data.httpsUrl, null);
  assert.equal((await request(service, '/api/status')).status, 200);
});

test('certificate refresh preserves the installed CA and signs only local server names', { skip: !hasOpenSsl }, async () => {
  const before = tls.authority.fingerprint256;
  await setupCertificates();
  const refreshed = await loadLocalHttps(fixtureDirectory);
  assert.equal(refreshed.authority.fingerprint256, before);
  assert.notEqual(refreshed.leaf.fingerprint256, tls.leaf.fingerprint256);
  assert.ok(refreshed.leaf.checkIP('127.0.0.1'));
  assert.ok(refreshed.leaf.checkHost('localhost'));
  const certificateDetails = await exec(openSsl, ['x509', '-in', join(fixtureDirectory, 'tls', 'ca.crt'), '-noout', '-text']);
  assert.match(certificateDetails.stdout, /Name Constraints: critical/);
  assert.match(certificateDetails.stdout, /DNS:localhost/);
  assert.match(certificateDetails.stdout, /IP:192\.168\.0\.0\/255\.255\.0\.0/);
  const invalid = await mkdtemp(join(fixtureDirectory, 'mismatch-'));
  await mkdir(join(invalid, 'tls'));
  await writeFile(join(invalid, 'tls', 'ca.crt'), ca);
  await writeFile(join(invalid, 'tls', 'server.crt'), refreshed.cert);
  await writeFile(join(invalid, 'tls', 'server.key'), tls.key);
  await assert.rejects(loadLocalHttps(invalid), /do not match/);
});
