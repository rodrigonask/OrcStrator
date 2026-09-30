// Tests for the CI publishing route, PUT /admin/upload/<key>.
// Signs with a THROWAWAY RSA key generated here; the real release key is
// never involved.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { classifyUploadKey, tokenMatches, importReleaseKeys, verifyEnvelope } from '../src/index.js';

const TOKEN = 'test-upload-token-0123456789abcdef';
const V = '2.1.1-beta.1';
const ZIP = `${V}/orcstrator-${V}.zip`;
const EXE = `${V}/OrcStrator-Setup-${V}.exe`;
const ZIP_BYTES = 'PK-zip-payload-bytes';
const EXE_BYTES = 'MZ-installer-bytes';
const sha = (s) => createHash('sha256').update(s).digest('hex');

let signKey;       // private CryptoKey (test only)
let publicXml;     // same XML shape setup.ps1 embeds
let otherPrivate;  // a second key the Worker does NOT trust

const b64 = (u8) => Buffer.from(u8).toString('base64');
const b64urlToB64 = (s) => Buffer.from(s, 'base64url').toString('base64');

async function genKey() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

before(async () => {
  const kp = await genKey();
  signKey = kp.privateKey;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  publicXml = `<RSAKeyValue><Modulus>${b64urlToB64(jwk.n)}</Modulus><Exponent>${b64urlToB64(jwk.e)}</Exponent></RSAKeyValue>`;
  otherPrivate = (await genKey()).privateKey;
});

function manifest(over = {}) {
  return {
    schema: 1, version: V, channel: 'beta', gitSha: 'f'.repeat(40), builtAt: '2026-09-24T10:00:00Z',
    nodeAbi: 127, minDbSchema: 0, blocked: false, bundledRuntime: true,
    file: `orcstrator-${V}.zip`, size: ZIP_BYTES.length, sha256: sha(ZIP_BYTES),
    url: `https://updates.test/download/${V}/orcstrator-${V}.zip`,
    installer: { file: `OrcStrator-Setup-${V}.exe`, size: EXE_BYTES.length, sha256: sha(EXE_BYTES) },
    ...over,
  };
}
async function envelopeText(m, key = signKey) {
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(JSON.stringify(m)));
  // Pretty-printed, like Build-Release writes it: the bytes on disk differ
  // from the signed canonical form, and that must still verify.
  return JSON.stringify({ manifest: m, signature: b64(new Uint8Array(sig)), alg: 'RS256' }, null, 2);
}

// R2 stand-in: head/get/put, stores the sha256 checksum only when put() was
// given one, and refuses the write on a mismatch like real R2 does.
function fakeR2(seed = {}) {
  const objects = new Map();
  for (const [k, v] of Object.entries(seed)) objects.set(k, { bytes: Buffer.from(v), sha256: null });
  const meta = (k, o) => ({
    key: k,
    size: o.bytes.length,
    checksums: o.sha256 ? { sha256: Uint8Array.from(Buffer.from(o.sha256, 'hex')).buffer } : {},
  });
  return {
    objects,
    puts: [],
    async head(k) { const o = objects.get(k); return o ? meta(k, o) : null; },
    async get(k) {
      const o = objects.get(k);
      if (!o) return null;
      return { ...meta(k, o), etag: sha(o.bytes), body: new Response(o.bytes).body, async text() { return o.bytes.toString('utf8'); } };
    },
    async put(k, body, opts = {}) {
      // Like R2: a failed onlyIf precondition writes nothing and returns null.
      if (opts.onlyIf?.etagMatches) {
        const cur = objects.get(k);
        if (!cur || sha(cur.bytes) !== opts.onlyIf.etagMatches) return null;
      }
      const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer());
      if (opts.sha256 && sha(bytes) !== opts.sha256) throw new Error('The SHA-256 checksum you specified did not match what we received.');
      objects.set(k, { bytes, sha256: opts.sha256 || null });
      this.puts.push([k, opts]);
      return meta(k, objects.get(k));
    },
  };
}
const env = (bucket = fakeR2(), over = {}) => ({
  ORC_KV: { async get() { return null; }, async put() {} },
  ORC_RELEASES: bucket,
  REQUIRE_KEY: 'false',
  UPLOAD_TOKEN: TOKEN,
  RELEASE_PUBLIC_KEY: publicXml,
  ...over,
});
function put(key, body, { token = TOKEN, sha256 = null, headers = {} } = {}) {
  const h = { 'content-length': String(Buffer.byteLength(body)), ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  if (sha256) h['x-orc-sha256'] = sha256;
  return new Request(`https://updates.test/admin/upload/${key}`, { method: 'PUT', body, headers: h });
}
const call = (r, e) => worker.fetch(r, e);

// Uploads zip + exe the way CI does, returns the bucket.
async function withPayload() {
  const b = fakeR2();
  const e = env(b);
  assert.equal((await call(put(ZIP, ZIP_BYTES, { sha256: sha(ZIP_BYTES) }), e)).status, 201);
  assert.equal((await call(put(EXE, EXE_BYTES, { sha256: sha(EXE_BYTES) }), e)).status, 201);
  return { b, e };
}

test('classifyUploadKey allows exactly the release files and beta.json', () => {
  assert.equal(classifyUploadKey(ZIP).kind, 'zip');
  assert.equal(classifyUploadKey(EXE).kind, 'exe');
  assert.equal(classifyUploadKey(`${V}/manifest.json`).kind, 'manifest');
  assert.equal(classifyUploadKey('beta.json').kind, 'pointer');
  assert.equal(classifyUploadKey('2.2.0/orcstrator-2.2.0.zip').ok, true);
  for (const bad of [
    'stable.json', 'test.json', 'foo.json', '',
    '2.1.0/orcstrator-2.2.0.zip',              // file does not match its version dir
    '2.1.0/evil.exe', '2.1.0/stable.json', '2.1.0/manifest.json/x',
    'v2.1.0/orcstrator-v2.1.0.zip', '../stable.json', '%2e%2e/stable.json',
    '2.1.0/../stable.json', '2.1.0+x/orcstrator-2.1.0+x.zip', '2.1/orcstrator-2.1.zip',
    'a/b/c',
  ]) {
    assert.equal(classifyUploadKey(bad).ok, false, `${bad} must be refused`);
  }
  assert.equal(classifyUploadKey('stable.json').status, 403);
});

test('tokenMatches is exact', async () => {
  assert.equal(await tokenMatches(TOKEN, TOKEN), true);
  assert.equal(await tokenMatches(TOKEN + 'x', TOKEN), false);
  assert.equal(await tokenMatches('', TOKEN), false);
  assert.equal(await tokenMatches(null, TOKEN), false);
  assert.equal(await tokenMatches(TOKEN, ''), false);
  assert.equal(await tokenMatches('', ''), false);
});

test('upload refuses without the right token, and is disabled with no secret', async () => {
  const b = fakeR2();
  const body = ZIP_BYTES;
  assert.equal((await call(put(ZIP, body, { token: null, sha256: sha(body) }), env(b))).status, 401);
  assert.equal((await call(put(ZIP, body, { token: 'wrong', sha256: sha(body) }), env(b))).status, 401);
  // Auth comes BEFORE key classification: an anonymous caller cannot probe.
  assert.equal((await call(put('stable.json', '{}', { token: 'wrong' }), env(b))).status, 401);
  assert.equal((await call(put(ZIP, body, { sha256: sha(body) }), env(b, { UPLOAD_TOKEN: '' }))).status, 503);
  assert.equal((await call(put(ZIP, body, { sha256: sha(body) }), env(b, { UPLOAD_TOKEN: undefined }))).status, 503);
  // GET/POST on the route is not an upload.
  const get = new Request(`https://updates.test/admin/upload/${ZIP}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal((await call(get, env(b))).status, 405);
  assert.equal(b.objects.size, 0, 'nothing may be written by a refused request');
});

test('upload refuses keys outside the allowlist', async () => {
  const b = fakeR2();
  for (const k of ['2.1.0/evil.exe', 'foo.json', '2.1.0/orcstrator-2.2.0.zip', 'v1/x.zip', '2.1.0%2forcstrator-2.1.0.zip']) {
    const r = await call(put(k, 'x', { sha256: sha('x') }), env(b));
    assert.equal(r.status, 400, `${k} -> ${r.status}`);
  }
  // An encoded dot-segment is normalised away by the URL parser before the
  // Worker sees it, so it never reaches the upload route at all.
  const r = await call(put('%2e%2e/beta.json', 'x'), env(b));
  assert.ok(r.status >= 400, `%2e%2e -> ${r.status}`);
  assert.equal(b.objects.size, 0);
});

test('stable.json is refused even with a valid token and a valid signature', async () => {
  const { b, e } = await withPayload();
  const text = await envelopeText(manifest({ channel: 'stable' }));
  const r = await call(put('stable.json', text), e);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /stable/);
  assert.equal(b.objects.has('stable.json'), false);
  // A stable-channel manifest cannot be smuggled in as a versioned manifest.
  assert.equal((await call(put(`${V}/manifest.json`, text), e)).status, 403);
});

test('existing objects are never overwritten (except beta.json)', async () => {
  // The SPENT stable release, uploaded by hand without checksums.
  const b = fakeR2({ '2.1.0/orcstrator-2.1.0.zip': 'stable-zip', '2.1.0/OrcStrator-Setup-2.1.0.exe': 'stable-exe' });
  const e = env(b);
  for (const [k, body] of [['2.1.0/orcstrator-2.1.0.zip', 'evil'], ['2.1.0/OrcStrator-Setup-2.1.0.exe', 'evil'], ['2.1.0/OrcStrator-Setup-2.1.0.exe', 'stable-exe']]) {
    const r = await call(put(k, body, { sha256: sha(body) }), e);
    assert.equal(r.status, 409, `${k} overwrite -> ${r.status}`);
  }
  assert.equal(b.objects.get('2.1.0/orcstrator-2.1.0.zip').bytes.toString(), 'stable-zip');
  assert.equal(b.objects.get('2.1.0/OrcStrator-Setup-2.1.0.exe').bytes.toString(), 'stable-exe');
  assert.equal(b.puts.length, 0);

  // Re-sending the identical bytes of something WE uploaded is a no-op 200,
  // so a failed run can be re-run; different bytes are a 409.
  const { b: b2, e: e2 } = await withPayload();
  assert.equal((await call(put(ZIP, ZIP_BYTES, { sha256: sha(ZIP_BYTES) }), e2)).status, 200);
  assert.equal((await call(put(ZIP, 'PK-other', { sha256: sha('PK-other') }), e2)).status, 409);
  assert.equal(b2.objects.get(ZIP).bytes.toString(), ZIP_BYTES);
});

test('payload uploads need a sha256 and R2 refuses a mismatching body', async () => {
  const b = fakeR2();
  assert.equal((await call(put(ZIP, ZIP_BYTES), env(b))).status, 400);
  assert.equal((await call(put(ZIP, ZIP_BYTES, { sha256: 'nothex' }), env(b))).status, 400);
  assert.equal((await call(put(ZIP, ZIP_BYTES, { sha256: sha('something else') }), env(b))).status, 400);
  assert.equal(b.objects.size, 0);
  const ok = await call(put(ZIP, ZIP_BYTES, { sha256: sha(ZIP_BYTES) }), env(b));
  assert.equal(ok.status, 201);
  assert.equal(b.puts[0][1].sha256, sha(ZIP_BYTES), 'the checksum must be handed to R2');
  assert.equal(b.puts[0][1].httpMetadata.contentType, 'application/zip');
});

test('a bad signature is refused', async () => {
  const { b, e } = await withPayload();
  // Signed by a key the Worker does not trust.
  assert.equal((await call(put(`${V}/manifest.json`, await envelopeText(manifest(), otherPrivate)), e)).status, 400);
  // Signed correctly, then tampered with.
  const env1 = JSON.parse(await envelopeText(manifest()));
  env1.manifest.size += 1;
  assert.equal((await call(put(`${V}/manifest.json`, JSON.stringify(env1)), e)).status, 400);
  // Unsigned / wrong alg / not JSON.
  env1.alg = 'unsigned';
  assert.equal((await call(put(`${V}/manifest.json`, JSON.stringify(env1)), e)).status, 400);
  assert.equal((await call(put(`${V}/manifest.json`, 'not json'), e)).status, 400);
  // No public key configured fails closed.
  assert.equal((await call(put(`${V}/manifest.json`, await envelopeText(manifest())), env(b, { RELEASE_PUBLIC_KEY: '' }))).status, 503);
  assert.equal(b.objects.has(`${V}/manifest.json`), false);
});

test('a good signature is accepted and beta.json flips last', async () => {
  const { b, e } = await withPayload();
  const text = await envelopeText(manifest());

  // Pointer before the versioned manifest exists: refused.
  assert.equal((await call(put('beta.json', text), e)).status, 409);

  const r1 = await call(put(`${V}/manifest.json`, text), e);
  assert.equal(r1.status, 201);
  assert.equal(b.objects.get(`${V}/manifest.json`).bytes.toString(), text, 'stored byte for byte');
  // Idempotent re-send.
  assert.equal((await call(put(`${V}/manifest.json`, text), e)).status, 200);

  const r2 = await call(put('beta.json', text), e);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).version, V);
  assert.equal(b.objects.get('beta.json').bytes.toString(), text);

  // And the existing read path serves it and the installer.
  const dl = await call(new Request('https://updates.test/download/latest?channel=beta'), e);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-orc-sha256'), sha(EXE_BYTES));
  assert.equal(await dl.text(), EXE_BYTES);
});

test('beta.json may be overwritten, but only by a byte-identical versioned manifest', async () => {
  const { b, e } = await withPayload();
  const text = await envelopeText(manifest());
  await call(put(`${V}/manifest.json`, text), e);
  await call(put('beta.json', text), e);
  assert.equal((await call(put('beta.json', text), e)).status, 200, 'beta.json is the one overwritable key');
  // Validly signed, different bytes than the stored versioned manifest.
  const other = await envelopeText(manifest({ builtAt: '2026-09-25T00:00:00Z' }));
  assert.equal((await call(put('beta.json', other), e)).status, 409);
  assert.equal(b.objects.get('beta.json').bytes.toString(), text);
});

test('beta.json never moves back to an older release (the upload token alone cannot freeze installs)', async () => {
  const { b, e } = await withPayload();
  const text = await envelopeText(manifest());
  await call(put(`${V}/manifest.json`, text), e);
  // The channel is already on a newer release.
  const newer = await envelopeText(manifest({ version: '2.1.1-beta.2', file: 'orcstrator-2.1.1-beta.2.zip' }));
  b.objects.set('beta.json', { bytes: Buffer.from(newer), sha256: null });
  const r = await call(put('beta.json', text), e);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /never moves back/);
  assert.equal(b.objects.get('beta.json').bytes.toString(), newer, 'pointer unchanged');
});

test('a pointer flip that raced another upload is refused, not written over it', async () => {
  const { b, e } = await withPayload();
  const text = await envelopeText(manifest());
  await call(put(`${V}/manifest.json`, text), e);
  const first = await envelopeText(manifest({ version: '2.1.1-alpha.1', file: 'orcstrator-2.1.1-alpha.1.zip' }));
  b.objects.set('beta.json', { bytes: Buffer.from(first), sha256: null });
  // Another upload lands between this one's check and its write.
  const newer = await envelopeText(manifest({ version: '2.1.1-beta.2', file: 'orcstrator-2.1.1-beta.2.zip' }));
  const realGet = b.get.bind(b);
  let raced = false;
  b.get = async (k) => {
    const r = await realGet(k);
    if (k === 'beta.json' && !raced) { raced = true; b.objects.set('beta.json', { bytes: Buffer.from(newer), sha256: null }); }
    return r;
  };
  const res = await call(put('beta.json', text), e);
  assert.equal(res.status, 409);
  assert.equal(b.objects.get('beta.json').bytes.toString(), newer, 'the newer pointer stays');
});

test('compareVersions follows semver precedence', async () => {
  const { compareVersions } = await import('../src/index.js');
  const lt = [['2.9.0', '2.10.0'], ['2.1.0-beta.10', '2.1.0'], ['2.1.0-beta.9', '2.1.0-beta.10'], ['2.1.0-beta.1', '2.1.0-beta.1.1'], ['2.1.0-1', '2.1.0-alpha']];
  for (const [a, c] of lt) {
    assert.equal(compareVersions(a, c), -1, `${a} < ${c}`);
    assert.equal(compareVersions(c, a), 1, `${c} > ${a}`);
  }
  assert.equal(compareVersions('2.1.0+b1', '2.1.0'), 0);
});

test('manifests must match what is actually in storage', async () => {
  const { b, e } = await withPayload();
  const mk = (over) => envelopeText(manifest(over));
  // Size mismatch against the stored zip.
  assert.equal((await call(put(`${V}/manifest.json`, await mk({ size: 999 })), e)).status, 409);
  // sha256 mismatch against R2's stored checksum.
  assert.equal((await call(put(`${V}/manifest.json`, await mk({ sha256: sha('other') })), e)).status, 409);
  // Installer mismatch.
  assert.equal((await call(put(`${V}/manifest.json`, await mk({ installer: { file: `OrcStrator-Setup-${V}.exe`, size: 1, sha256: sha(EXE_BYTES) } })), e)).status, 409);
  // Version in the manifest must match the key it is uploaded to.
  assert.equal((await call(put('2.1.1-beta.2/manifest.json', await mk({})), e)).status, 400);
  // Referenced payload not uploaded yet.
  const fresh = env(fakeR2());
  assert.equal((await call(put(`${V}/manifest.json`, await mk({})), fresh)).status, 409);
  assert.equal(b.objects.has(`${V}/manifest.json`), false);
});

test('release public key XML parses and verifies an envelope shape', async () => {
  // Round trip through the same XML parser the Worker uses in production.
  const keys = await importReleaseKeys(`  ${publicXml}\n`);
  assert.equal(keys.length, 1);
  const env1 = JSON.parse(await envelopeText(manifest()));
  assert.equal(await verifyEnvelope(env1, keys), true);
  assert.equal(await verifyEnvelope(null, keys), false);
  assert.equal(await verifyEnvelope({ ...env1, signature: '!!notbase64' }, keys), false);
  assert.equal((await importReleaseKeys('<RSAKeyValue><Modulus>AAAA</Modulus></RSAKeyValue>')).length, 0);
  assert.equal((await importReleaseKeys('')).length, 0);
});
