// Distribution chain Worker tests: only signed-manifest files are served,
// rollout fallback, and telemetry bounds (header-only keys, rate limits). Fake KV/R2 bindings, no wrangler, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { isInRollout } from '../src/index.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const req = (path, init = {}) => new Request(`https://updates.test${path}`, init);

function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    puts: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.puts++; store.set(k, v); },
  };
}

// R2 stand-in that keeps a sha256 checksum for objects seeded with one, like
// objects uploaded through PUT /admin/upload.
function fakeR2(seed) {
  const objects = new Map();
  for (const [k, v] of Object.entries(seed)) {
    const o = typeof v === 'string' ? { bytes: v, sum: null } : v;
    objects.set(k, o);
  }
  const meta = (k, o) => ({
    key: k,
    size: Buffer.byteLength(o.bytes),
    checksums: o.sum ? { sha256: Uint8Array.from(Buffer.from(o.sum, 'hex')).buffer } : {},
  });
  return {
    objects,
    async head(k) { const o = objects.get(k); return o ? meta(k, o) : null; },
    async get(k) {
      const o = objects.get(k);
      if (!o) return null;
      return { ...meta(k, o), body: new Response(o.bytes).body, async text() { return o.bytes; } };
    },
  };
}
const withSum = (bytes) => ({ bytes, sum: sha(bytes) });

const V = '2.2.0-beta.1';
const ZIP = `orcstrator-${V}.zip`;
const EXE = `OrcStrator-Setup-${V}.exe`;
const ZIP_BYTES = 'PK-real-payload';
const EXE_BYTES = 'MZ-real-installer';
const manifest = (over = {}) => ({
  schema: 1, version: V, channel: 'beta', file: ZIP, size: ZIP_BYTES.length, sha256: sha(ZIP_BYTES),
  installer: { file: EXE, size: EXE_BYTES.length, sha256: sha(EXE_BYTES) },
  ...over,
});
const envelope = (m = manifest()) => JSON.stringify({ manifest: m, signature: 'c2ln', alg: 'RS256' });
const env = (objects, over = {}) => ({ ORC_KV: fakeKv(), REQUIRE_KEY: 'false', PUBLIC_BASE: '', ORC_RELEASES: fakeR2(objects), ...over });

// --- only signed-manifest files are served -------------------------------------------------------

test('an exe no signed manifest names is not served, even with the right file name', async () => {
  // What a leaked upload token can do: store <v>/OrcStrator-Setup-<v>.exe for
  // a version that has no manifest (the upload route refuses unsigned ones).
  const e = env({ [`9.9.9/OrcStrator-Setup-9.9.9.exe`]: withSum('MZ-evil'), [`9.9.9/orcstrator-9.9.9.zip`]: withSum('PK-evil') });
  for (const p of ['/download/9.9.9/OrcStrator-Setup-9.9.9.exe', '/download/9.9.9/orcstrator-9.9.9.zip']) {
    const r = await worker.fetch(req(p), e);
    assert.equal(r.status, 404, `${p} served without a manifest`);
    assert.match(await r.text(), /no signed manifest names this file/);
  }
});

test('a file named by its version manifest is served', async () => {
  const e = env({ [`${V}/manifest.json`]: envelope(), [`${V}/${EXE}`]: withSum(EXE_BYTES), [`${V}/${ZIP}`]: withSum(ZIP_BYTES) });
  const exe = await worker.fetch(req(`/download/${V}/${EXE}`), e);
  assert.equal(exe.status, 200);
  assert.equal(await exe.text(), EXE_BYTES);
  const zip = await worker.fetch(req(`/download/${V}/${ZIP}`), e);
  assert.equal(zip.status, 200);
  assert.equal(await zip.text(), ZIP_BYTES);
});

test('a file named only by the channel pointer on that version is served (hand-published stable)', async () => {
  const stable = manifest({ version: '2.1.0', channel: 'stable', file: 'orcstrator-2.1.0.zip', installer: undefined });
  const e = env({ 'stable.json': envelope(stable), '2.1.0/orcstrator-2.1.0.zip': ZIP_BYTES });
  assert.equal((await worker.fetch(req('/download/2.1.0/orcstrator-2.1.0.zip'), e)).status, 200);
  // The pointer names 2.1.0's files only.
  const other = await worker.fetch(req('/download/2.1.0/orcstrator-2.1.0-other.zip'), e);
  assert.equal(other.status, 404);
});

test('a stored file whose bytes differ from the signed hash is refused', async () => {
  // Same name, different bytes (an upload-token holder replacing an object is
  // not possible through the route, but R2 contents are checked anyway).
  const e = env({ [`${V}/manifest.json`]: envelope(), [`${V}/${EXE}`]: withSum('MZ-real-installeR') });
  const r = await worker.fetch(req(`/download/${V}/${EXE}`), e);
  assert.equal(r.status, 409);
  assert.match(await r.text(), /does not match its signed manifest/);
});

test('/download/latest refuses an installer whose stored hash differs from the signed one', async () => {
  const e = env({ 'beta.json': envelope(), [`${V}/${EXE}`]: withSum('MZ-real-installeR') });
  assert.equal((await worker.fetch(req('/download/latest?channel=beta'), e)).status, 409);
  const good = env({ 'beta.json': envelope(), [`${V}/${EXE}`]: withSum(EXE_BYTES) });
  const r = await worker.fetch(req('/download/latest?channel=beta'), good);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), EXE_BYTES);
});

test('public-bucket mode redirects only for a named file', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).endsWith(`/${V}/manifest.json`)
    ? new Response(envelope(), { status: 200 })
    : new Response('', { status: 404 }));
  try {
    const e = { ORC_KV: fakeKv(), REQUIRE_KEY: 'false', PUBLIC_BASE: 'https://bucket.test' };
    const ok = await worker.fetch(req(`/download/${V}/${EXE}`), e);
    assert.equal(ok.status, 302);
    const no = await worker.fetch(req('/download/9.9.9/OrcStrator-Setup-9.9.9.exe'), e);
    assert.equal(no.status, 404);
  } finally { globalThis.fetch = orig; }
});

// --- rollout fallback ----------------------------------------------------------

const OLD = '2.1.1-beta.3';
const oldManifest = manifest({ version: OLD, file: `orcstrator-${OLD}.zip`, installer: undefined });

test('an install outside a staged rollout gets the fallback release, not a 204 old launchers read as an attack', async () => {
  const kv = fakeKv({ 'policy:beta': JSON.stringify({ rolloutPercent: 0, fallbackVersion: OLD }) });
  const e = env({ 'beta.json': envelope(), [`${OLD}/manifest.json`]: envelope(oldManifest) }, { ORC_KV: kv });
  const r = await worker.fetch(req('/beta.json', { headers: { 'x-orc-install-id': '00000000-0000-4000-8000-00000000000b' } }), e);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), envelope(oldManifest), 'the stored signed bytes, unchanged');
  assert.match(r.headers.get('x-orc-reason'), /serving 2\.1\.1-beta\.3/);
});

test('the fallback is refused when it is withdrawn, on another channel, or missing (then 204)', async () => {
  const cases = [
    { policy: { rolloutPercent: 0, fallbackVersion: OLD, blockedVersions: [OLD] }, objects: { [`${OLD}/manifest.json`]: envelope(oldManifest) } },
    { policy: { rolloutPercent: 0, fallbackVersion: OLD }, objects: { [`${OLD}/manifest.json`]: envelope({ ...oldManifest, channel: 'stable' }) } },
    { policy: { rolloutPercent: 0, fallbackVersion: OLD }, objects: {} },
    { policy: { rolloutPercent: 0, fallbackVersion: '../stable' }, objects: {} },
    { policy: { rolloutPercent: 0 }, objects: {} },
  ];
  for (const c of cases) {
    const e = env({ 'beta.json': envelope(), ...c.objects }, { ORC_KV: fakeKv({ 'policy:beta': JSON.stringify(c.policy) }) });
    const r = await worker.fetch(req('/beta.json'), e);
    assert.equal(r.status, 204, JSON.stringify(c.policy));
  }
});

test('the install id header places an install inside a partial rollout', async () => {
  const kv = fakeKv({ 'policy:beta': JSON.stringify({ rolloutPercent: 50 }) });
  const e = env({ 'beta.json': envelope() }, { ORC_KV: kv });
  let inside = null; let outside = null;
  for (let i = 0; i < 200 && (!inside || !outside); i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (isInRollout(id, 50)) inside ??= id; else outside ??= id;
  }
  assert.equal((await worker.fetch(req('/beta.json', { headers: { 'x-orc-install-id': inside } }), e)).status, 200);
  assert.equal((await worker.fetch(req('/beta.json', { headers: { 'x-orc-install-id': outside } }), e)).status, 204);
  assert.equal((await worker.fetch(req('/beta.json'), e)).status, 204, 'no id never rides a partial rollout');
});

// --- telemetry bounds ----------------------------------------------------------

const GUID = '00000000-0000-4000-8000-00000000000a';
const post = (body, headers = {}, init = {}) => req('/telemetry', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, ...init,
});
const tenv = (over = {}) => ({ ORC_KV: fakeKv(), REQUIRE_KEY: 'false', PUBLIC_BASE: '', ...over });

test('telemetry over 1 KB is refused and stores nothing, with or without a content-length', async () => {
  const e = tenv();
  const big = JSON.stringify({ version: '2.1.0', outcome: 'updated', pad: 'x'.repeat(2000) });
  const r1 = await worker.fetch(post(big, { 'x-orc-install-id': GUID }), e);
  assert.equal(r1.status, 413);
  // A streamed body has no content-length; the read itself stops at the cap.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 8; i++) c.enqueue(new TextEncoder().encode('x'.repeat(512))); c.close(); } });
  const r2 = await worker.fetch(req('/telemetry', { method: 'POST', headers: { 'x-orc-install-id': GUID }, body: stream, duplex: 'half' }), e);
  assert.equal(r2.status, 413);
  assert.equal(e.ORC_KV.puts, 0);
});

test('telemetry is stored only with a GUID install id (header), a real version and a known outcome', async () => {
  const e = tenv();
  const ok = JSON.stringify({ version: '2.2.0-beta.1', outcome: 'updated' });
  const refused = [
    post(ok, { 'x-orc-install-id': 'not-a-guid' }),
    post(ok, { 'x-orc-install-id': `${GUID}x` }),
    new Request(`https://updates.test/telemetry?install=${GUID}`, { method: 'POST', body: ok }),
    post(JSON.stringify({ version: '<script>', outcome: 'updated' }), { 'x-orc-install-id': GUID }),
    post(JSON.stringify({ version: '2.1.0', outcome: 'x'.repeat(40) }), { 'x-orc-install-id': GUID }),
    post('not json', { 'x-orc-install-id': GUID }),
  ];
  for (const r of refused) assert.equal((await worker.fetch(r, e)).status, 204, 'never an error to a client');
  assert.equal(e.ORC_KV.puts, 0, 'nothing stored for any of them');

  await worker.fetch(post(JSON.stringify({ version: '2.2.0-beta.1', outcome: 'updated', extra: 'y'.repeat(500) }), { 'x-orc-install-id': GUID }), e);
  const saved = JSON.parse(e.ORC_KV.store.get(`install:${GUID}`));
  assert.deepEqual(Object.keys(saved).sort(), ['at', 'outcome', 'version'], 'only the known fields are kept');
  assert.equal(saved.version, '2.2.0-beta.1');
});

test('the rate limiter answers 429 and stores nothing, keyed by client IP', async () => {
  const keys = [];
  const limiter = { async limit({ key }) { keys.push(key); return { success: keys.length <= 2 }; } };
  const e = tenv({ ORC_RATE_LIMITER: limiter });
  const body = JSON.stringify({ version: '2.1.0', outcome: 'updated' });
  const h = { 'x-orc-install-id': GUID, 'cf-connecting-ip': '203.0.113.9' };
  assert.equal((await worker.fetch(post(body, h), e)).status, 204);
  assert.equal((await worker.fetch(post(body, h), e)).status, 204);
  const puts = e.ORC_KV.puts;
  assert.equal((await worker.fetch(post(body, h), e)).status, 429);
  assert.equal(e.ORC_KV.puts, puts, 'a limited request writes nothing');
  assert.deepEqual([...new Set(keys)], ['telemetry:203.0.113.9']);
});

test('licence lookups are rate limited once keys are required, and the key is read from the header only', async () => {
  const limiter = { async limit() { return { success: false } } };
  const kv = fakeKv({ 'licence:vip': JSON.stringify({ owner: 'x' }) });
  const limited = env({ 'beta.json': envelope() }, { REQUIRE_KEY: 'true', ORC_KV: kv, ORC_RATE_LIMITER: limiter });
  assert.equal((await worker.fetch(req('/beta.json', { headers: { authorization: 'Bearer vip' } }), limited)).status, 429);
  const open = env({ 'beta.json': envelope() }, { REQUIRE_KEY: 'true', ORC_KV: kv });
  assert.equal((await worker.fetch(req('/beta.json?key=vip'), open)).status, 401, 'a key in the URL is not read');
  assert.equal((await worker.fetch(req('/beta.json', { headers: { authorization: 'Bearer vip' } }), open)).status, 200);
  // With keys off, the manifest route never consults the limiter.
  const free = env({ 'beta.json': envelope() }, { ORC_RATE_LIMITER: limiter });
  assert.equal((await worker.fetch(req('/beta.json'), free)).status, 200);
});

test('wrangler.toml binds the rate limiter the code looks for', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  // The deployed config when this checkout has one, else the example every fork copies.
  const real = new URL('../wrangler.toml', import.meta.url);
  const toml = readFileSync(existsSync(real) ? real : new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[\[ratelimits\]\]\s*\nname = "ORC_RATE_LIMITER"/);
  assert.match(toml, /\[ratelimits\.simple\]\s*\n\s*limit = \d+\s*\n\s*period = (10|60)\b/);
});

test('a malformed percent-encoding on /download/ is a 400, not an uncaught exception', async () => {
  const r = await worker.fetch(req('/download/%E0%A4%A'), env({}));
  assert.equal(r.status, 400);
});

// --- user angle: a person in a browser never sees raw JSON ----

test('a browser download that cannot be served gets a plain page; programs still get JSON', async () => {
  const e = env({});
  const html = await worker.fetch(req('/download/9.9.9/OrcStrator-Setup-9.9.9.exe', { headers: { accept: 'text/html,application/xhtml+xml' } }), e);
  assert.equal(html.status, 404);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const page = await html.text();
  assert.match(page, /link is not valid any more/);
  assert.ok(!/signed manifest/.test(page), 'no jargon on the page');
  assert.equal(html.headers.get('x-orc-error'), 'no signed manifest names this file');
  const prog = await worker.fetch(req('/download/9.9.9/OrcStrator-Setup-9.9.9.exe'), e);
  assert.match(prog.headers.get('content-type'), /application\/json/);
  const limited = await worker.fetch(req('/download/latest', { headers: { accept: 'text/html' } }),
    env({}, { REQUIRE_KEY: 'true', ORC_RATE_LIMITER: { async limit() { return { success: false }; } } }));
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /wait a minute/);
  const lic = await worker.fetch(req('/download/latest', { headers: { accept: 'text/html' } }), env({}, { REQUIRE_KEY: 'true' }));
  assert.equal(lic.status, 401);
  assert.match(await lic.text(), /by invitation/);
});
