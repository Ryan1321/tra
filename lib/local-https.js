import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';

// TLS is opt-in: only the desktop entry point loads these fixed local paths.
// Tests and callers of createService remain HTTP-only unless they pass tls.
export async function loadLocalHttps(dataDir) {
  const directory = join(dataDir, 'tls');
  const names = ['ca.crt', 'server.crt', 'server.key'];
  const files = await Promise.all(names.map(async name => {
    try { return await readFile(join(directory, name)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  if (files.every(file => file === null)) return null;
  if (files.some(file => file === null)) throw new Error('Camera HTTPS files are incomplete. Run scripts/setup-camera-https.ps1 again.');
  const [ca, cert, key] = files;
  const authority = new X509Certificate(ca);
  const leaf = new X509Certificate(cert);
  const now = Date.now();
  for (const certificate of [authority, leaf]) {
    if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) {
      throw new Error('The camera HTTPS certificate is not currently valid. Check the PC clock and run scripts/setup-camera-https.ps1 again.');
    }
  }
  if (!authority.ca || leaf.ca || !leaf.verify(authority.publicKey) || !leaf.checkPrivateKey(createPrivateKey(key))) {
    throw new Error('Camera HTTPS certificates and key do not match. Run scripts/setup-camera-https.ps1 again.');
  }
  return { key, cert, minVersion: 'TLSv1.2', authority, leaf };
}

export function certificateCoversHost(certificate, hostname) {
  if (!certificate) return false;
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost'
    ? Boolean(certificate.checkHost(host, { subject: 'never' }))
    : Boolean(certificate.checkIP(host));
}
