// A local Web Push service for tests. It speaks the real protocol: HTTPS, VAPID (RFC 8292) ES256 JWT verified against
// the key the sender presents, aes128gcm (RFC 8291) payloads decrypted with each fake device's own P-256 key and auth
// secret. Each device can be scripted to answer 201, 410, 429 (+Retry-After), 500 or to drop the connection.
import https from 'node:https';
import {createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function selfSignedLocalhost() {
  const dir = mkdtempSync(join(tmpdir(), 'pool-alerts-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio: 'ignore'});
    return {key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem'))};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

// RFC 8291 decryption of a single-record aes128gcm body for a user agent holding (ecdh, auth).
export function decryptAes128gcm(body, ecdh, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const serverPublic = body.subarray(21, 21 + idlen), ciphertext = body.subarray(21 + idlen);
  if (idlen !== 65 || rs < 18) throw new Error('bad aes128gcm header');
  const shared = ecdh.computeSecret(serverPublic);
  const uaPublic = ecdh.getPublicKey();
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, serverPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('missing last-record delimiter');
  return padded.subarray(0, end).toString('utf8');
}

function verifyVapid(header, audience, subject, nowSeconds) {
  const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), ?k=([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!match) throw new Error('missing vapid authorization');
  const [h, p, s] = match[1].split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (head.alg !== 'ES256') throw new Error('vapid alg');
  const raw = Buffer.from(match[2], 'base64url');
  const key = createPublicKey({key: {kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url')}, format: 'jwk'});
  if (!verify('sha256', Buffer.from(`${h}.${p}`), {key, dsaEncoding: 'ieee-p1363'}, Buffer.from(s, 'base64url'))) throw new Error('vapid signature');
  if (claims.aud !== audience) throw new Error(`vapid aud ${claims.aud}`);
  if (!(claims.exp > nowSeconds && claims.exp <= nowSeconds + 86400)) throw new Error('vapid exp');
  if (claims.sub !== subject) throw new Error('vapid sub');
  return match[2];
}

export async function startPushService({subject}) {
  const tls = selfSignedLocalhost();
  const devices = new Map(), messages = [], rejections = [];
  let port = 0;
  const server = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const id = /^\/push\/([a-z0-9-]+)$/.exec(req.url)?.[1], device = id && devices.get(id);
      if (req.method !== 'POST' || !device) { res.writeHead(404).end(); return; }
      const script = device.script.length ? device.script.shift() : {status: 201};
      if (script.drop) { req.socket.destroy(); return; }
      try {
        const vapidKey = verifyVapid(req.headers.authorization, `https://localhost:${port}`, subject, Math.floor(Date.now() / 1000));
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('content-encoding');
        const ttl = Number(req.headers.ttl);
        if (!Number.isInteger(ttl) || ttl < 0) throw new Error('ttl');
        const payload = JSON.parse(decryptAes128gcm(Buffer.concat(chunks), device.ecdh, device.auth));
        messages.push({device: id, payload, ttl, urgency: req.headers.urgency || null, topic: req.headers.topic || null, vapidKey, status: script.status, at: Date.now()});
      } catch (error) {
        rejections.push({device: id, reason: error.message});
        res.writeHead(400).end(); return;
      }
      res.writeHead(script.status, script.retryAfter ? {'Retry-After': String(script.retryAfter)} : {}).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    port, ca: tls.cert, messages, rejections,
    // A fake browser: a real P-256 key pair and auth secret; its endpoint is on this service.
    device(name, script = []) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = randomBytes(16), id = `${name}-${randomBytes(4).toString('hex')}`;
      devices.set(id, {ecdh, auth, script: [...script]});
      return {id, subscription: {endpoint: `https://localhost:${port}/push/${id}`,
        keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url')}}};
    },
    script(id, script) { devices.get(id).script.push(...script); },
    received(id) { return messages.filter(m => m.device === id && m.status >= 200 && m.status < 300); },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}
