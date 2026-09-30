// Worker tests. Run with:  cd worker && npm test
// No wrangler needed: the handler is exercised with fake KV/R2 bindings, so
// the routing, licence, rollout and kill-switch logic is all covered locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  hashInstallId, rolloutBucket, isInRollout, extractKey, checkLicence, applyPolicy, resolveInstaller,
} from '../src/index.js';

const ENVELOPE = {
  manifest: { schema: 1, version: '2.1.0', channel: 'stable', sha256: 'a'.repeat(64), file: 'orcstrator-2.1.0.zip' },
  signature: 'ZmFrZQ==',
  alg: 'RS256',
};

function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}
const req = (path, headers = {}) => new Request(`https://updates.test${path}`, { headers });
const baseEnv = (over = {}) => ({
  ORC_KV: fakeKv(),
  PUBLIC_BASE: 'https://bucket.test',
  REQUIRE_KEY: 'false',
  ...over,
});

// Serve the manifest from a stubbed fetch rather than a real bucket.
function stubFetch(envelope) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    envelope ? new Response(JSON.stringify(envelope), { status: 200 }) : new Response('', { status: 404 });
  return () => { globalThis.fetch = orig; };
}

test('hashInstallId is stable and spreads across buckets', () => {
  assert.equal(hashInstallId('abc'), hashInstallId('abc'));
  assert.notEqual(hashInstallId('abc'), hashInstallId('abd'));
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(rolloutBucket('install-' + i));
  // A hash that clumped would make percentage rollouts meaningless.
  assert.ok(seen.size > 60, `expected wide bucket spread, got ${seen.size}`);
});

test('rollout percentages gate correctly', () => {
  assert.equal(isInRollout('x', 100), true);
  assert.equal(isInRollout('x', 0), false);
  assert.equal(isInRollout('x', -5), false);
  assert.equal(isInRollout('x', 'nonsense'), false);
  // No install id must NOT ride a canary.
  assert.equal(isInRollout('', 50), false);
  assert.equal(isInRollout(null, 50), false);
  assert.equal(isInRollout('', 100), true);

  const ids = Array.from({ length: 2000 }, (_, i) => 'i' + i);
  const at10 = ids.filter((i) => isInRollout(i, 10)).length;
  assert.ok(at10 > 120 && at10 < 280, `10% of 2000 should be ~200, got ${at10}`);
  // Rollout must be monotonic, or widening it would drop installs that
  // already had the version.
  for (const id of ids.slice(0, 200)) {
    if (isInRollout(id, 25)) assert.equal(isInRollout(id, 50), true, `${id} dropped out when widening`);
  }
});

test('extractKey reads the bearer header only', () => {
  assert.equal(extractKey(req('/stable.json', { authorization: 'Bearer abc123' })), 'abc123');
  assert.equal(extractKey(req('/stable.json', { authorization: 'bearer  spaced  ' })), 'spaced');
  // A key in the URL lands in logs, so ?key= is no longer read.
  assert.equal(extractKey(req('/stable.json?key=qk')), null);
  assert.equal(extractKey(req('/stable.json')), null);
});

test('checkLicence fails closed when keys are required', async () => {
  const kv = fakeKv({
    'licence:good': JSON.stringify({ owner: 'alice' }),
    'licence:revoked': JSON.stringify({ revoked: true }),
    'licence:expired': JSON.stringify({ expiresAt: '2020-01-01T00:00:00Z' }),
    'licence:future': JSON.stringify({ expiresAt: '2999-01-01T00:00:00Z' }),
    'licence:broken': '{not json',
  });
  assert.equal((await checkLicence(kv, 'good', true)).ok, true);
  assert.equal((await checkLicence(kv, 'future', true)).ok, true);
  assert.equal((await checkLicence(kv, null, true)).status, 401);
  assert.equal((await checkLicence(kv, 'nope', true)).status, 403);
  assert.equal((await checkLicence(kv, 'revoked', true)).reason, 'licence revoked');
  assert.equal((await checkLicence(kv, 'expired', true)).reason, 'licence expired');
  assert.equal((await checkLicence(kv, 'broken', true)).ok, false);
  // Open mode still lets everyone through.
  assert.equal((await checkLicence(kv, null, false)).ok, true);
  // A KV outage must not become a free-for-all.
  const dead = { async get() { throw new Error('kv down'); } };
  const r = await checkLicence(dead, 'good', true);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('applyPolicy never mutates the signed manifest', () => {
  const before = JSON.stringify(ENVELOPE);
  applyPolicy(ENVELOPE, { installId: 'a', rolloutPercent: 10, blockedVersions: ['2.1.0'] });
  assert.equal(JSON.stringify(ENVELOPE), before, 'policy mutated a signed manifest');
});

test('applyPolicy honours the kill switch and rollout', () => {
  assert.equal(applyPolicy(ENVELOPE, { installId: 'a' }).serve, true);
  assert.equal(applyPolicy(ENVELOPE, { installId: 'a', blockedVersions: ['2.1.0'] }).serve, false);
  assert.equal(applyPolicy(ENVELOPE, { installId: 'a', blockedVersions: ['9.9.9'] }).serve, true);
  assert.equal(applyPolicy(ENVELOPE, { installId: 'a', rolloutPercent: 0 }).serve, false);
  assert.equal(applyPolicy({ manifest: {} }, { installId: 'a' }).serve, false);
});

test('GET /stable.json serves the envelope byte for byte', async () => {
  const restore = stubFetch(ENVELOPE);
  try {
    const res = await worker.fetch(req('/stable.json', { 'x-orc-install-id': 'i1' }), baseEnv());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), ENVELOPE);
  } finally { restore(); }
});

test('a withheld release is 204, not a doctored manifest', async () => {
  const restore = stubFetch(ENVELOPE);
  try {
    const env = baseEnv({ ORC_KV: fakeKv({ 'policy:stable': JSON.stringify({ blockedVersions: ['2.1.0'] }) }) });
    const res = await worker.fetch(req('/stable.json', { 'x-orc-install-id': 'i1' }), env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('x-orc-reason'), 'version withdrawn');
    assert.equal(await res.text(), '');
  } finally { restore(); }
});

test('staged rollout splits installs', async () => {
  const restore = stubFetch(ENVELOPE);
  try {
    const env = baseEnv({ ORC_KV: fakeKv({ 'policy:stable': JSON.stringify({ rolloutPercent: 10 }) }) });
    let served = 0;
    for (let i = 0; i < 300; i++) {
      // Install ids are GUIDs; anything else counts as no id.
      const res = await worker.fetch(req('/stable.json', { 'x-orc-install-id': `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }), env);
      if (res.status === 200) served++;
    }
    assert.ok(served > 10 && served < 70, `~30 of 300 expected at 10%, got ${served}`);
  } finally { restore(); }
});

test('licence enforcement blocks unknown keys end to end', async () => {
  const restore = stubFetch(ENVELOPE);
  try {
    const env = baseEnv({
      REQUIRE_KEY: 'true',
      ORC_KV: fakeKv({ 'licence:vip': JSON.stringify({ owner: 'alice' }) }),
    });
    assert.equal((await worker.fetch(req('/stable.json'), env)).status, 401);
    assert.equal((await worker.fetch(req('/stable.json', { authorization: 'Bearer nope' }), env)).status, 403);
    assert.equal((await worker.fetch(req('/stable.json', { authorization: 'Bearer vip' }), env)).status, 200);
  } finally { restore(); }
});

test('404 when no release is published', async () => {
  const restore = stubFetch(null);
  try {
    const res = await worker.fetch(req('/stable.json'), baseEnv());
    assert.equal(res.status, 404);
  } finally { restore(); }
});

test('/download rejects path traversal', async () => {
  const env = baseEnv();

  // Percent-encoded traversal survives URL normalisation and reaches the
  // validator, so this is the case that actually matters.
  // These reach the validator with a decoded "../" and must be refused there.
  for (const bad of [
    '/download/%2e%2e%2fsecrets.zip',
    '/download/..%2fsecrets.zip',
    '/download/a/b/c.zip',
    '/download/evil.exe',
    '/download/x.zip',
    '/download/.hidden/x.zip',
    '/download/2.1.0/evil.ps1',
    '/download/2.1.0/other.json',
    '/download/2.1.0/.manifest.json',
    '/download/2.1.0/..%2fstable.json',
    '/download/2.1.0/a/manifest.json',
  ]) {
    const res = await worker.fetch(req(bad), env);
    assert.equal(res.status, 400, `${bad} should be rejected, got ${res.status}`);
  }

  // These get collapsed by the URL parser before we see them, so they stop
  // being /download/ requests at all. Different status, equally not served.
  for (const collapsed of ['/download/../secrets.zip', '/download/%2e%2e/secrets.zip']) {
    const res = await worker.fetch(req(collapsed), env);
    assert.equal(res.status, 404, `${collapsed} should not serve, got ${res.status}`);
  }

  // A well-formed path is served only once a signed manifest names it.
  const restore = stubFetch(ENVELOPE);
  try {
    const ok = await worker.fetch(req('/download/2.1.0/orcstrator-2.1.0.zip'), env);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), 'https://bucket.test/2.1.0/orcstrator-2.1.0.zip');
  } finally { restore(); }
});

test('telemetry records and never throws', async () => {
  const kv = fakeKv();
  const env = baseEnv({ ORC_KV: kv });
  const res = await worker.fetch(
    new Request('https://updates.test/telemetry', {
      method: 'POST',
      // A GUID id and a known outcome (both are validated).
      headers: { 'x-orc-install-id': '00000000-0000-4000-8000-00000000000a', 'content-type': 'application/json' },
      body: JSON.stringify({ version: '2.1.0', outcome: 'updated' }),
    }),
    env
  );
  assert.equal(res.status, 204);
  assert.match(kv.store.get('install:00000000-0000-4000-8000-00000000000a'), /2\.1\.0/);

  const bad = await worker.fetch(
    new Request('https://updates.test/telemetry', {
      method: 'POST',
      headers: { 'x-orc-install-id': '00000000-0000-4000-8000-00000000000a' },
      body: 'not json',
    }),
    env
  );
  assert.equal(bad.status, 204, 'malformed telemetry must not error the client');
});

test('health and unknown routes', async () => {
  assert.equal((await worker.fetch(req('/health'), baseEnv())).status, 200);
  assert.equal((await worker.fetch(req('/nope'), baseEnv())).status, 404);
});

// --- /download/latest --------------------------------------------------------
// The installer location comes from the SIGNED channel manifest, so the Worker
// cannot be talked into serving anything the release pipeline did not sign for.

const INSTALLER_ENVELOPE = {
  manifest: {
    ...ENVELOPE.manifest,
    installer: { file: 'OrcStrator-Setup-2.1.0.exe', sha256: 'b'.repeat(64), size: 5 },
  },
  signature: 'ZmFrZQ==',
  alg: 'RS256',
};
const BETA_ENVELOPE = {
  manifest: {
    ...ENVELOPE.manifest,
    version: '2.2.0-beta.1',
    channel: 'beta',
    installer: { file: 'OrcStrator-Setup-2.2.0-beta.1.exe', sha256: 'c'.repeat(64), size: 4 },
  },
  signature: 'ZmFrZQ==',
  alg: 'RS256',
};

// Minimal R2 binding: get() returns a body, head() returns metadata only.
function fakeR2(objects) {
  const calls = [];
  const meta = (k) => ({ key: k, size: new TextEncoder().encode(objects[k]).length });
  return {
    calls,
    async get(k) {
      calls.push(['get', k]);
      if (!(k in objects)) return null;
      const text = objects[k];
      return { ...meta(k), body: new Response(text).body, async text() { return text; } };
    },
    async head(k) {
      calls.push(['head', k]);
      return k in objects ? meta(k) : null;
    },
  };
}
const r2Env = (objects, over = {}) => baseEnv({ PUBLIC_BASE: '', ORC_RELEASES: fakeR2(objects), ...over });

test('/download/<v>/ serves a pinned installer and its signed manifest', async () => {
  const env = r2Env({
    '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe',
    '2.1.0/manifest.json': JSON.stringify(INSTALLER_ENVELOPE),
  });
  const exe = await worker.fetch(req('/download/2.1.0/OrcStrator-Setup-2.1.0.exe'), env);
  assert.equal(exe.status, 200);
  assert.equal(exe.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
  assert.match(exe.headers.get('content-disposition'), /OrcStrator-Setup-2\.1\.0\.exe/);
  assert.equal(await exe.text(), 'MZexe');

  const man = await worker.fetch(req('/download/2.1.0/manifest.json'), env);
  assert.equal(man.status, 200);
  assert.equal(man.headers.get('content-type'), 'application/json');
  assert.equal(man.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(await man.text()), INSTALLER_ENVELOPE, 'served as stored, never rewritten');

  const missing = await worker.fetch(req('/download/9.9.9/manifest.json'), env);
  assert.equal(missing.status, 404);
});

test('resolveInstaller reads the signed manifest and refuses bad names', () => {
  const ok = resolveInstaller(INSTALLER_ENVELOPE);
  assert.equal(ok.ok, true);
  assert.equal(ok.key, '2.1.0/OrcStrator-Setup-2.1.0.exe');
  assert.equal(ok.sha256, 'b'.repeat(64));

  assert.equal(resolveInstaller(ENVELOPE).status, 404, 'a release without an installer is 404');
  assert.equal(resolveInstaller({}).ok, false);
  for (const file of ['../x.exe', '.x.exe', 'a/b.exe', 'x.zip', 'x.exe.bat', '']) {
    const e = { manifest: { version: '2.1.0', installer: { file } } };
    assert.equal(resolveInstaller(e).ok, false, `${file} should be refused`);
  }
  const badVersion = { manifest: { version: '..', installer: { file: 'x.exe' } } };
  assert.equal(resolveInstaller(badVersion).ok, false);
});

test('GET /download/latest streams the stable installer as an attachment', async () => {
  const env = r2Env({
    'stable.json': JSON.stringify(INSTALLER_ENVELOPE),
    '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe',
  });
  const res = await worker.fetch(req('/download/latest'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="OrcStrator-Setup-2.1.0.exe"');
  assert.equal(res.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
  assert.equal(res.headers.get('x-orc-version'), '2.1.0');
  assert.equal(res.headers.get('x-orc-sha256'), 'b'.repeat(64));
  assert.equal(res.headers.get('content-length'), '5');
  assert.equal(await res.text(), 'MZexe');
});

test('GET /download/latest?channel=beta serves the beta installer', async () => {
  const env = r2Env({
    'stable.json': JSON.stringify(INSTALLER_ENVELOPE),
    'beta.json': JSON.stringify(BETA_ENVELOPE),
    '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe',
    '2.2.0-beta.1/OrcStrator-Setup-2.2.0-beta.1.exe': 'MZb1',
  });
  const res = await worker.fetch(req('/download/latest?channel=beta'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-orc-version'), '2.2.0-beta.1');
  assert.equal(await res.text(), 'MZb1');
});

test('HEAD /download/latest does not read the body', async () => {
  const env = r2Env({
    'stable.json': JSON.stringify(INSTALLER_ENVELOPE),
    '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe',
  });
  const res = await worker.fetch(
    new Request('https://updates.test/download/latest', { method: 'HEAD' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '5');
  assert.deepEqual(
    env.ORC_RELEASES.calls.filter(([, k]) => k.endsWith('.exe')),
    [['head', '2.1.0/OrcStrator-Setup-2.1.0.exe']]);
});

test('/download/latest failure modes', async () => {
  // Nothing published yet.
  assert.equal((await worker.fetch(req('/download/latest'), r2Env({}))).status, 404);
  // Unknown channel is refused before touching storage.
  const env = r2Env({ 'stable.json': JSON.stringify(INSTALLER_ENVELOPE) });
  assert.equal((await worker.fetch(req('/download/latest?channel=../stable'), env)).status, 400);
  assert.equal((await worker.fetch(req('/download/latest?channel=nightly'), env)).status, 400);
  // Manifest names an installer that was never uploaded.
  const missing = await worker.fetch(req('/download/latest'), env);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /installer missing/);
  // Release with no installer field.
  const noInst = r2Env({ 'stable.json': JSON.stringify(ENVELOPE) });
  assert.equal((await worker.fetch(req('/download/latest'), noInst)).status, 404);
  // Kill switch covers fresh downloads.
  const blocked = r2Env(
    { 'stable.json': JSON.stringify(INSTALLER_ENVELOPE), '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe' },
    { ORC_KV: fakeKv({ 'policy:stable': JSON.stringify({ blockedVersions: ['2.1.0'] }) }) });
  assert.equal((await worker.fetch(req('/download/latest'), blocked)).status, 404);
  // Staged rollout does NOT gate a fresh download (a new install has no id).
  const canary = r2Env(
    { 'stable.json': JSON.stringify(INSTALLER_ENVELOPE), '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe' },
    { ORC_KV: fakeKv({ 'policy:stable': JSON.stringify({ rolloutPercent: 10 }) }) });
  assert.equal((await worker.fetch(req('/download/latest'), canary)).status, 200);
});

test('/download/latest honours licence enforcement', async () => {
  const env = r2Env(
    { 'stable.json': JSON.stringify(INSTALLER_ENVELOPE), '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe' },
    { REQUIRE_KEY: 'true', ORC_KV: fakeKv({ 'licence:vip': JSON.stringify({ owner: 'x' }) }) });
  assert.equal((await worker.fetch(req('/download/latest'), env)).status, 401);
  // Header only; the same key in the URL is not read.
  assert.equal((await worker.fetch(req('/download/latest?key=vip'), env)).status, 401);
  assert.equal((await worker.fetch(req('/download/latest', { authorization: 'Bearer vip' }), env)).status, 200);
});

test('/download/latest never mutates the stored manifest', async () => {
  const stored = JSON.stringify(INSTALLER_ENVELOPE);
  const env = r2Env({ 'stable.json': stored, '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe' });
  await worker.fetch(req('/download/latest'), env);
  const res = await worker.fetch(req('/stable.json', { 'x-orc-install-id': 'i1' }), env);
  assert.equal(await res.text(), stored, 'manifest must be served byte for byte after a download');
});

test('/download/latest redirects when only a public bucket is configured', async () => {
  const restore = stubFetch(INSTALLER_ENVELOPE);
  try {
    const res = await worker.fetch(req('/download/latest'), baseEnv());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://bucket.test/2.1.0/OrcStrator-Setup-2.1.0.exe');
  } finally { restore(); }
});

// --- GET / (download page) ---------------------------------------------------
// The bare Worker URL is what people are sent. It must show the stable
// version, link the installer, and explain the SmartScreen box, in ASCII.

test('GET / renders the download page with the stable version and SmartScreen help', async () => {
  const env = r2Env({ 'stable.json': JSON.stringify(INSTALLER_ENVELOPE) });
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.match(html, /<title>OrcStrator<\/title>/);
  assert.match(html, /href="\/download\/latest"/);
  assert.match(html, /Version 2\.1\.0 for Windows/);
  assert.ok(html.includes("Windows may show a blue 'Windows protected your PC' box. Click More info, then Run anyway."));
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(html), 'the page must be plain ASCII');
  assert.ok(!/<script/i.test(html), 'no scripts on the page');
});

test('GET / still renders without a published or downloadable stable release', async () => {
  const none = await worker.fetch(req('/'), r2Env({}));
  assert.equal(none.status, 200);
  const html = await none.text();
  assert.match(html, /href="\/download\/latest"/);
  assert.ok(!/Version /.test(html), 'no version line when nothing is published');

  const withdrawn = r2Env({ 'stable.json': JSON.stringify(INSTALLER_ENVELOPE) }, {
    ORC_KV: fakeKv({ 'policy:stable': JSON.stringify({ blockedVersions: ['2.1.0'] }) }),
  });
  assert.ok(!/Version 2\.1\.0/.test(await (await worker.fetch(req('/'), withdrawn)).text()), 'a withdrawn version is not advertised');
});

test('GET / does not shadow the other routes', async () => {
  const env = r2Env({
    'stable.json': JSON.stringify(INSTALLER_ENVELOPE),
    '2.1.0/OrcStrator-Setup-2.1.0.exe': 'MZexe',
  });
  assert.equal((await worker.fetch(req('/stable.json'), env)).status, 200);
  assert.equal((await worker.fetch(req('/download/latest'), env)).status, 200);
  assert.equal((await worker.fetch(req('/health'), env)).status, 200);
  assert.equal((await worker.fetch(req('/index.html'), env)).status, 404);
});