/**
 * OrcStrator update Worker.
 *
 * Sits between installed launchers and the R2 bucket so we get the three
 * things a bare bucket cannot give us:
 *
 *   1. Per-user revocation   delete a key, that install stops updating
 *   2. Staged rollout        serve a new version to N% of installs first
 *   3. Kill switch           withdraw a bad release without rebuilding it
 *
 * It deliberately does NOT sign anything. Signing happens once, in CI, with a
 * key this Worker never sees. If the Worker is compromised, an attacker can
 * withhold updates or serve an OLD signed manifest, but cannot forge a new
 * one: the launcher verifies the signature against a public key baked into
 * setup.ps1. Downgrade is separately blocked client-side by version compare.
 *
 * Bindings (wrangler.toml):
 *   KV   ORC_KV       licence keys, rollout %, kill switches
 *   R2   ORC_RELEASES release bucket (optional; falls back to PUBLIC_BASE)
 *   var  PUBLIC_BASE  public bucket URL when not binding R2 directly
 *   var  REQUIRE_KEY  "true" to enforce licence keys
 *
 * Routes:
 *   GET  /                               tiny download page (version + SmartScreen help)
 *   GET  /health
 *   GET  /stable.json, /beta.json        signed channel manifest, as signed
 *   GET  /download/latest[?channel=beta] installer .exe named by the signed manifest
 *   GET  /download/<version>/<file>.zip  payload
 *   POST /telemetry
 *   PUT  /admin/upload/<key>             CI publishing (see below)
 *
 * Publishing (PUT /admin/upload/<key>), so CI needs no R2 S3 credentials:
 *   - Authorization: Bearer <UPLOAD_TOKEN> (Worker secret), compared in
 *     constant time. No secret set means the route is disabled (503).
 *   - Allowed keys only: <v>/orcstrator-<v>.zip, <v>/OrcStrator-Setup-<v>.exe,
 *     <v>/manifest.json, and the BETA pointer beta.json. stable.json is
 *     refused outright: stable is published by the maintainer, by hand.
 *   - Nothing is ever overwritten except beta.json. Re-sending identical
 *     bytes (same sha256) is a 200 no-op so a re-run can resume.
 *   - zip/exe: X-Orc-Sha256 is required and handed to R2, which rejects the
 *     write if the streamed bytes do not hash to it. The body is streamed
 *     straight into R2, never buffered (CPU time per request is capped).
 *   - manifest.json/beta.json: the envelope must verify (RS256) against
 *     RELEASE_PUBLIC_KEY, be channel "beta", and name a zip (and installer,
 *     when present) that already exist in R2 with the signed size, and the
 *     signed sha256 when R2 holds a checksum for them (everything uploaded
 *     through this route does). beta.json must also be byte-identical to the
 *     already uploaded <v>/manifest.json. The Worker still never signs.
 */

/** FNV-1a over the install id. Stable across runs and platforms, which
 *  matters: a rollout bucket that changed every request would trickle every
 *  install into the new version regardless of the percentage. */
export function hashInstallId(id) {
  let h = 0x811c9dc5;
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Which rollout bucket (0-99) an install falls in. */
export function rolloutBucket(installId) {
  return hashInstallId(installId) % 100;
}

/**
 * Should this install be offered this version?
 * An install with no id gets the conservative answer: only at 100%. Otherwise
 * a launcher that fails to send an id would ride every canary.
 */
export function isInRollout(installId, percent) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 100) return true;
  if (!installId) return false;
  return rolloutBucket(installId) < p;
}

/** Parse "Authorization: Bearer <key>". Header only: a key in the
 *  URL ends up in access logs, proxies and browser history. */
export function extractKey(request) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

/** An install id is a GUID the launcher generated. Anything else
 *  is treated as no id, which never rides a partial rollout. */
export const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function extractInstallId(request) {
  const id = (request.headers.get('x-orc-install-id') || '').trim();
  return INSTALL_ID_RE.test(id) ? id.toLowerCase() : '';
}

/** Telemetry limits: the body is tiny and every field has a shape. */
export const TELEMETRY_MAX_BYTES = 1024;
export const TELEMETRY_OUTCOMES = ['installed', 'updated', 'up-to-date', 'rolled-back', 'failed'];

/** Read at most `max` bytes of a body; null when it is longer. */
async function readLimited(request, max) {
  const len = request.headers.get('content-length');
  if (len != null && Number(len) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * Rate limit through the Workers Rate Limiting binding ORC_RATE_LIMITER
 * (wrangler.toml), keyed by client IP and route class. No binding (local
 * tests, or before it is deployed) means no limit, never a refusal.
 */
async function rateLimited(env, request, what) {
  if (!env.ORC_RATE_LIMITER) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await env.ORC_RATE_LIMITER.limit({ key: `${what}:${ip}` });
    return !success;
  } catch {
    return false;
  }
}

/**
 * Decide access for a key. Returns { ok, status, reason, record }.
 * Fails CLOSED when a key is required: an unreadable or missing record is a
 * refusal, never a default-allow.
 */
export async function checkLicence(kv, key, requireKey) {
  if (!requireKey) return { ok: true, status: 200, reason: 'open', record: null };
  if (!key) return { ok: false, status: 401, reason: 'licence key required' };

  let raw = null;
  try {
    raw = await kv.get(`licence:${key}`);
  } catch {
    return { ok: false, status: 503, reason: 'licence lookup unavailable' };
  }
  if (!raw) return { ok: false, status: 403, reason: 'unknown licence key' };

  let rec;
  try { rec = JSON.parse(raw); } catch { return { ok: false, status: 403, reason: 'malformed licence record' }; }

  if (rec.revoked) return { ok: false, status: 403, reason: 'licence revoked' };
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
    return { ok: false, status: 403, reason: 'licence expired' };
  }
  return { ok: true, status: 200, reason: 'ok', record: rec };
}

/**
 * Apply server-side policy to a signed manifest envelope.
 *
 * IMPORTANT: this must never MUTATE the manifest. It is signed; changing a
 * field would break verification on every client. Policy can only decide
 * whether to serve the envelope at all, so a withheld release is served as
 * the previous one (or 204), not as a doctored manifest.
 */
export function applyPolicy(envelope, { installId, rolloutPercent, blockedVersions }) {
  const version = envelope?.manifest?.version;
  if (!version) return { serve: false, reason: 'manifest has no version' };

  const blocked = Array.isArray(blockedVersions) ? blockedVersions : [];
  if (blocked.includes(version)) return { serve: false, reason: 'version withdrawn' };

  const pct = rolloutPercent == null ? 100 : rolloutPercent;
  if (!isInRollout(installId, pct)) {
    return { serve: false, reason: `not in rollout (${pct}%)` };
  }
  return { serve: true, reason: 'ok' };
}

async function kvJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readManifest(env, channel) {
  const name = `${channel}.json`;
  if (env.ORC_RELEASES) {
    const obj = await env.ORC_RELEASES.get(name);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  }
  if (env.PUBLIC_BASE) {
    const r = await fetch(`${env.PUBLIC_BASE.replace(/\/$/, '')}/${name}`, {
      cf: { cacheTtl: 30 },
    });
    if (!r.ok) return null;
    return await r.json();
  }
  return null;
}

export const CHANNELS = ['stable', 'beta'];

/**
 * Where the installer .exe for a channel lives, read from the SIGNED channel
 * manifest (`manifest.installer = { file, sha256, size }`, written by CI and
 * covered by the same signature as the payload). The Worker only reads it;
 * nothing here signs or rewrites the manifest.
 *
 * R2 key layout: `<version>/<installer.file>`, next to the payload zip.
 */
export function resolveInstaller(envelope) {
  const m = envelope?.manifest;
  const version = m?.version;
  if (!version) return { ok: false, status: 404, reason: 'manifest has no version' };
  const inst = m.installer;
  if (!inst || !inst.file) return { ok: false, status: 404, reason: 'no installer in this release' };
  // Same shape rules as the payload path guard: segments start alphanumeric,
  // so neither half can be "." or "..".
  if (!/^[A-Za-z0-9][\w.\-+]*$/.test(version)) return { ok: false, status: 500, reason: 'bad version in manifest' };
  if (!/^[A-Za-z0-9][\w.\-+]*\.exe$/.test(inst.file)) return { ok: false, status: 500, reason: 'bad installer name in manifest' };
  return {
    ok: true,
    version,
    file: inst.file,
    sha256: String(inst.sha256 || ''),
    key: `${version}/${inst.file}`,
  };
}

// --- publishing (PUT /admin/upload/<key>) ----------------------------------

export const UPLOAD_PREFIX = '/admin/upload/';
/** Plain semver with an optional dotted prerelease. No build metadata, no
 *  leading "v", nothing that could be "." or "..". */
export const UPLOAD_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,4})?$/;
/** The only channel this route may publish. */
export const UPLOAD_CHANNEL = 'beta';
const MAX_MANIFEST_BYTES = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Map an upload key to what it is. Works on the RAW (still percent-encoded)
 * path, so an encoded "%2e%2e" can never match: every allowed key is built
 * only from characters that are never encoded.
 */
export function classifyUploadKey(key) {
  if (key === 'stable.json') {
    return { ok: false, status: 403, reason: 'stable.json is never published through this route; stable is published by hand' };
  }
  if (key === `${UPLOAD_CHANNEL}.json`) return { ok: true, kind: 'pointer', key };
  const m = /^([^/]+)\/([^/]+)$/.exec(key);
  if (!m || !UPLOAD_VERSION_RE.test(m[1])) return { ok: false, status: 400, reason: 'key not allowed' };
  const [, v, file] = m;
  if (file === `orcstrator-${v}.zip`) return { ok: true, kind: 'zip', key, version: v };
  if (file === `OrcStrator-Setup-${v}.exe`) return { ok: true, kind: 'exe', key, version: v };
  if (file === 'manifest.json') return { ok: true, kind: 'manifest', key, version: v };
  return { ok: false, status: 400, reason: 'key not allowed' };
}

async function sha256Bytes(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
}

/** -1 / 0 / 1 by semver precedence (same rules as the launcher's Compare-OrcVersion). */
export function compareVersions(a, b) {
  const split = (s) => {
    const v = String(s).split('+')[0];
    const i = v.indexOf('-');
    const core = (i < 0 ? v : v.slice(0, i)).split('.').map((x) => parseInt(x, 10) || 0);
    while (core.length < 3) core.push(0);
    return { core, pre: i < 0 ? [] : v.slice(i + 1).split('.') };
  };
  const x = split(a); const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] || 0) - (y.core[i] || 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    let c;
    if (pn && qn) {
      const p2 = p.replace(/^0+/, ''); const q2 = q.replace(/^0+/, '');
      c = p2.length !== q2.length ? Math.sign(p2.length - q2.length) : (p2 < q2 ? -1 : p2 > q2 ? 1 : 0);
    } else if (pn) c = -1;
    else if (qn) c = 1;
    else c = p < q ? -1 : p > q ? 1 : 0;
    if (c) return c;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

/** Constant-time token check: both sides are hashed to 32 bytes first, so
 *  neither the length nor the first differing byte leaks through timing. */
export async function tokenMatches(given, expected) {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256Bytes(given ?? ''), sha256Bytes(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && !!given;
}

const b64ToB64url = (s) => String(s).trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Import every <RSAKeyValue> in RELEASE_PUBLIC_KEY (the same XML the
 *  launcher embeds; several are accepted during a key rotation). */
export async function importReleaseKeys(xml) {
  const keys = [];
  const blocks = String(xml || '').match(/<RSAKeyValue>[\s\S]*?<\/RSAKeyValue>/g) || [];
  for (const b of blocks) {
    const n = /<Modulus>([^<]+)<\/Modulus>/.exec(b);
    const e = /<Exponent>([^<]+)<\/Exponent>/.exec(b);
    if (!n || !e) continue;
    try {
      keys.push(await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: b64ToB64url(n[1]), e: b64ToB64url(e[1]), alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ));
    } catch {
      // a malformed key in the list must not abort the others
    }
  }
  return keys;
}

/**
 * Verify an envelope the way the launcher does: RS256 over the canonical
 * bytes of `manifest` alone. CI signs PowerShell's `ConvertTo-Json -Compress`
 * of an ordered dictionary; JSON.stringify of the parsed object reproduces
 * those bytes for every field a manifest carries (ASCII strings, integers,
 * booleans, key order preserved). Any divergence fails CLOSED.
 */
export async function verifyEnvelope(envelope, keys) {
  try {
    if (!envelope || typeof envelope !== 'object') return false;
    if (!envelope.manifest || typeof envelope.manifest !== 'object') return false;
    if (envelope.alg !== 'RS256' || typeof envelope.signature !== 'string' || !envelope.signature) return false;
    const sig = Uint8Array.from(atob(envelope.signature), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(JSON.stringify(envelope.manifest));
    for (const k of keys) {
      if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, sig, data)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const bufToHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
/** The sha256 R2 stored with an object, or null when it was put without one. */
function storedSha256(obj) {
  const s = obj?.checksums?.sha256;
  return s ? bufToHex(s) : null;
}

/** An object the signed manifest names must exist with the signed size (and
 *  the signed sha256 when R2 has one). Returns an error string or null. */
async function checkReferenced(bucket, key, size, sha256) {
  const obj = await bucket.head(key);
  if (!obj) return `${key} is not in storage yet; upload it before the manifest`;
  if (Number(obj.size) !== Number(size)) return `${key} is ${obj.size} bytes in storage but the manifest says ${size}`;
  const stored = storedSha256(obj);
  if (stored && stored !== String(sha256 || '').toLowerCase()) return `${key} sha256 in storage does not match the manifest`;
  return null;
}

/**
 * The signed manifest of policy.fallbackVersion, as stored text, or null.
 * Only a version stored through the upload route (so signature-checked), on
 * the same channel, and not itself withdrawn. Never rewritten.
 */
async function readFallback(env, channel, cfg) {
  const v = String(cfg?.fallbackVersion || '');
  if (!v || !UPLOAD_VERSION_RE.test(v) || !env.ORC_RELEASES) return null;
  const blocked = Array.isArray(cfg.blockedVersions) ? cfg.blockedVersions : [];
  if (blocked.includes(v)) return null;
  try {
    const obj = await env.ORC_RELEASES.get(`${v}/manifest.json`);
    if (!obj) return null;
    const text = await obj.text();
    const m = JSON.parse(text.trimStart())?.manifest;
    if (!m || m.version !== v || m.channel !== channel) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Which signed manifest names the download `<version>/<file>`?
 * Looks at that version's stored manifest (<version>/manifest.json), then at
 * each channel pointer that is on that version. Every manifest in the bucket
 * got there either through PUT /admin/upload, which verifies its signature
 * against RELEASE_PUBLIC_KEY before storing it, or by the maintainer's hand,
 * so a manifest found here is a signed one. The upload token alone can add a
 * zip or exe but never a manifest naming it.
 * Returns { ok: true, sha256, size } or { ok: false, reason }.
 */
export async function findNamingManifest(env, key) {
  const [version, file] = key.split('/');
  const candidates = [];
  const read = async (name) => {
    try {
      if (env.ORC_RELEASES) {
        const obj = await env.ORC_RELEASES.get(name);
        return obj ? JSON.parse(await obj.text()) : null;
      }
      if (env.PUBLIC_BASE) {
        const r = await fetch(`${env.PUBLIC_BASE.replace(/\/$/, '')}/${name}`, { cf: { cacheTtl: 30 } });
        return r.ok ? await r.json() : null;
      }
    } catch {
      // unreadable or not JSON: it names nothing
    }
    return null;
  };
  candidates.push(await read(`${version}/manifest.json`));
  for (const ch of CHANNELS) {
    const e = await read(`${ch}.json`);
    if (e?.manifest?.version === version) candidates.push(e);
  }
  for (const e of candidates) {
    const m = e?.manifest;
    if (!m || m.version !== version) continue;
    if (m.file === file) return { ok: true, sha256: String(m.sha256 || ''), size: m.size };
    if (m.installer && m.installer.file === file) return { ok: true, sha256: String(m.installer.sha256 || ''), size: m.installer.size };
  }
  return { ok: false, reason: 'no signed manifest names this file' };
}

/** The stored object must be the one the manifest signed for: its size, and
 *  its sha256 whenever R2 holds one (everything uploaded through
 *  PUT /admin/upload does). Returns an error string or null. */
function storedMismatch(obj, want) {
  if (want.size != null && obj.size != null && Number(obj.size) !== Number(want.size)) {
    return 'stored file does not match its signed manifest (size)';
  }
  const stored = storedSha256(obj);
  if (stored && stored !== String(want.sha256 || '').toLowerCase()) {
    return 'stored file does not match its signed manifest (sha256)';
  }
  return null;
}

async function handleUpload(request, env, url) {
  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405, { allow: 'PUT' });
  // Auth before anything else, so an anonymous caller learns nothing about
  // which keys exist or are allowed.
  if (!env.UPLOAD_TOKEN) return json({ error: 'upload disabled' }, 503);
  const auth = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '');
  if (!(await tokenMatches(auth ? auth[1] : '', env.UPLOAD_TOKEN))) return json({ error: 'unauthorized' }, 401);
  if (!env.ORC_RELEASES) return json({ error: 'no release storage configured' }, 500);

  const target = classifyUploadKey(url.pathname.slice(UPLOAD_PREFIX.length));
  if (!target.ok) return json({ error: target.reason }, target.status);
  const bucket = env.ORC_RELEASES;
  const len = Number(request.headers.get('content-length'));
  if (!request.headers.has('content-length') || !Number.isInteger(len) || len <= 0) {
    return json({ error: 'content-length required' }, 411);
  }

  // --- payload zip / installer exe: streamed, never buffered --------------
  if (target.kind === 'zip' || target.kind === 'exe') {
    const sha = String(request.headers.get('x-orc-sha256') || '').toLowerCase();
    if (!HEX64.test(sha)) return json({ error: 'x-orc-sha256 (64 hex) required' }, 400);
    const existing = await bucket.head(target.key);
    if (existing) {
      if (storedSha256(existing) === sha && Number(existing.size) === len) {
        return json({ status: 'unchanged', key: target.key, size: existing.size });
      }
      return json({ error: `${target.key} already exists; objects are never overwritten` }, 409);
    }
    const contentType = target.kind === 'zip' ? 'application/zip' : 'application/vnd.microsoft.portable-executable';
    try {
      // R2 hashes the stream itself and refuses the write on a mismatch.
      const obj = await bucket.put(target.key, request.body, { sha256: sha, httpMetadata: { contentType } });
      return json({ status: 'created', key: target.key, size: obj?.size ?? len }, 201);
    } catch (e) {
      return json({ error: `upload rejected: ${String(e?.message || e).slice(0, 200)}` }, 400);
    }
  }

  // --- signed manifests: small, verified before they are stored -----------
  if (len > MAX_MANIFEST_BYTES) return json({ error: 'manifest too large' }, 413);
  const text = await request.text();
  if (text.length > MAX_MANIFEST_BYTES) return json({ error: 'manifest too large' }, 413);
  let envelope;
  try { envelope = JSON.parse(text.replace(/^﻿/, '')); } catch { return json({ error: 'manifest is not JSON' }, 400); }

  const keys = await importReleaseKeys(env.RELEASE_PUBLIC_KEY);
  if (!keys.length) return json({ error: 'RELEASE_PUBLIC_KEY not configured' }, 503);
  if (!(await verifyEnvelope(envelope, keys))) return json({ error: 'signature does not verify against the release key' }, 400);

  const m = envelope.manifest;
  if (m.channel !== UPLOAD_CHANNEL) return json({ error: `manifest channel is '${m.channel}'; this route only publishes '${UPLOAD_CHANNEL}'` }, 403);
  const v = String(m.version || '');
  if (!UPLOAD_VERSION_RE.test(v)) return json({ error: 'manifest version not allowed' }, 400);
  if (target.kind === 'manifest' && v !== target.version) return json({ error: `manifest version ${v} does not match key ${target.key}` }, 400);
  if (m.file !== `orcstrator-${v}.zip`) return json({ error: 'manifest names an unexpected payload file' }, 400);
  let problem = await checkReferenced(bucket, `${v}/${m.file}`, m.size, m.sha256);
  if (!problem && m.installer != null) {
    if (m.installer.file !== `OrcStrator-Setup-${v}.exe`) return json({ error: 'manifest names an unexpected installer file' }, 400);
    problem = await checkReferenced(bucket, `${v}/${m.installer.file}`, m.installer.size, m.installer.sha256);
  }
  if (problem) return json({ error: problem }, 409);

  const put = (key, extraMeta = {}) => bucket.put(key, text, { httpMetadata: { contentType: 'application/json', ...extraMeta } });

  if (target.kind === 'manifest') {
    const existing = await bucket.get(target.key);
    if (existing) {
      if ((await existing.text()) === text) return json({ status: 'unchanged', key: target.key, version: v });
      return json({ error: `${target.key} already exists; objects are never overwritten` }, 409);
    }
    await put(target.key);
    return json({ status: 'created', key: target.key, version: v }, 201);
  }

  // Pointer: the flip that makes a release live. Only after the exact same
  // envelope is already stored as that version's manifest.
  const versioned = await bucket.get(`${v}/manifest.json`);
  if (!versioned || (await versioned.text()) !== text) {
    return json({ error: `${UPLOAD_CHANNEL}.json must be byte-identical to an uploaded ${v}/manifest.json` }, 409);
  }
  // Never backwards: the upload token alone must not be able to
  // point the channel at an OLDER signed release and freeze every install on
  // it. Withdrawing a release is the KV kill switch (blockedVersions), not a
  // pointer rollback.
  const current = await bucket.get(`${UPLOAD_CHANNEL}.json`);
  if (current) {
    let cv = null;
    try { cv = JSON.parse((await current.text()).trimStart())?.manifest?.version ?? null; } catch { cv = null; }
    if (cv && compareVersions(v, cv) < 0) {
      return json({ error: `${UPLOAD_CHANNEL}.json is on ${cv}; it never moves back to ${v}. Use the kill switch (blockedVersions) to withdraw a release.` }, 409);
    }
  }
  // Conditional on the pointer we just compared against, so two uploads
  // racing cannot land an older version after a newer one.
  const opts = { httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache, max-age=0' } };
  if (current?.etag) opts.onlyIf = { etagMatches: current.etag };
  const done = await bucket.put(target.key, text, opts);
  if (done === null) return json({ error: `${UPLOAD_CHANNEL}.json changed while this upload was checked; send it again` }, 409);
  return json({ status: 'published', key: target.key, version: v, channel: UPLOAD_CHANNEL }, 200);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The page behind the bare Worker URL: one download button and the one line
 * a first-time Windows user needs, because the installer is not code-signed
 * yet and SmartScreen shows its blue box BEFORE the installer's own pages.
 * Plain ASCII, no scripts, no external assets. `version` is the current
 * stable version, or null when none is published (the page still renders).
 */
export function renderHomePage(version) {
  const ver = version ? `<p class="ver">Version ${escapeHtml(version)} for Windows</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrcStrator</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#12121a;color:#e8e8ef;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:520px;padding:32px;text-align:center}
h1{letter-spacing:.08em;margin:0 0 8px}
.ver{color:#9a9aad;margin:0 0 28px}
a.btn{display:inline-block;background:#2a6df4;color:#fff;text-decoration:none;font-weight:600;padding:14px 28px;border-radius:8px}
.help{margin-top:28px;color:#c8c8d4;line-height:1.5}
</style>
</head>
<body>
<main>
<h1>OrcStrator</h1>
${ver}
<a class="btn" href="/download/latest">Download for Windows</a>
<p class="help">Windows may show a blue 'Windows protected your PC' box. Click More info, then Run anyway.</p>
</main>
</body>
</html>
`;
}

/**
 * A person clicking "Download for Windows" gets a plain page, not JSON, when
 * a download cannot be served. Programs (the launcher, CI) still get the
 * JSON; the technical reason is kept in the x-orc-error header either way.
 */
export function renderDownloadProblem(status) {
  const msg = status === 429 ? 'Too many downloads from this connection. Please wait a minute and try again.'
    : (status === 401 || status === 403) ? 'This download is by invitation. Use the download link you were sent.'
    : status === 404 ? 'This download link is not valid any more. Go back and use the current download button.'
    : 'The download is not available right now. Please try again in a few minutes.';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OrcStrator</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#12121a;color:#e8e8ef;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:520px;padding:32px;text-align:center}a{color:#8fb0ff}</style>
</head>
<body><main><h1>OrcStrator</h1><p>${escapeHtml(msg)}</p><p><a href="/">Back</a></p></main></body>
</html>
`;
}

async function friendlyDownloadError(request, url, res) {
  if (res.status < 400 || !url.pathname.startsWith('/download/')) return res;
  if (!/text\/html/i.test(request.headers.get('accept') || '')) return res;
  let reason = '';
  try { reason = String((await res.clone().json())?.error || ''); } catch { /* not JSON */ }
  return new Response(request.method === 'HEAD' ? null : renderDownloadProblem(res.status), {
    status: res.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-orc-error': reason.slice(0, 200) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return friendlyDownloadError(request, url, await handle(request, env));
  },
};

async function handle(request, env) {
  {
    const url = new URL(request.url);
    const requireKey = String(env.REQUIRE_KEY ?? 'false') === 'true';
    const installId = extractInstallId(request);

    if (url.pathname === '/health') return json({ status: 'ok' });

    // --- download page ------------------------------------------------------
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      let version = null;
      try {
        const envelope = await readManifest(env, 'stable');
        const target = resolveInstaller(envelope);
        const cfg = await kvJson(env.ORC_KV, 'policy:stable', {});
        const blocked = Array.isArray(cfg.blockedVersions) ? cfg.blockedVersions : [];
        if (target.ok && !blocked.includes(target.version)) version = target.version;
      } catch {
        // The page must render even when the manifest cannot be read.
      }
      return new Response(request.method === 'HEAD' ? null : renderHomePage(version), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
      });
    }

    if (url.pathname.startsWith(UPLOAD_PREFIX)) return handleUpload(request, env, url);

    // --- channel manifest -------------------------------------------------
    if (url.pathname === '/stable.json' || url.pathname === '/beta.json') {
      const channel = url.pathname.slice(1).replace('.json', '');

      if (requireKey && await rateLimited(env, request, 'licence')) return json({ error: 'too many requests' }, 429);
      const lic = await checkLicence(env.ORC_KV, extractKey(request), requireKey);
      if (!lic.ok) return json({ error: lic.reason }, lic.status);

      const envelope = await readManifest(env, channel);
      if (!envelope) return json({ error: 'no release published' }, 404);

      const cfg = await kvJson(env.ORC_KV, `policy:${channel}`, {});
      const decision = applyPolicy(envelope, {
        installId,
        rolloutPercent: cfg.rolloutPercent,
        blockedVersions: cfg.blockedVersions,
      });

      if (!decision.serve) {
        // Launchers released before 2.2 read a 204 as a failed
        // signature and show a red alarm. With policy fallbackVersion set
        // (the release before the withheld one), serve THAT version's signed
        // manifest instead: every launcher already on it sees "up to date",
        // and the downgrade guard keeps anyone newer where they are.
        const fb = await readFallback(env, channel, cfg);
        if (fb) {
          return new Response(fb, {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-orc-reason': `${decision.reason}; serving ${cfg.fallbackVersion}` },
          });
        }
        // 204 rather than an error: the launcher is healthy and correctly
        // configured, there is simply nothing for it to install right now.
        return new Response(null, {
          status: 204,
          headers: { 'x-orc-reason': decision.reason, 'cache-control': 'no-store' },
        });
      }
      // Byte-for-byte as signed.
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    // --- installer (stable download link for the website) -----------------
    if (url.pathname === '/download/latest') {
      if (requireKey && await rateLimited(env, request, 'licence')) return json({ error: 'too many requests' }, 429);
      const lic = await checkLicence(env.ORC_KV, extractKey(request), requireKey);
      if (!lic.ok) return json({ error: lic.reason }, lic.status);

      const channel = url.searchParams.get('channel') || 'stable';
      if (!CHANNELS.includes(channel)) return json({ error: 'unknown channel' }, 400);

      const envelope = await readManifest(env, channel);
      if (!envelope) return json({ error: 'no release published' }, 404);

      const target = resolveInstaller(envelope);
      if (!target.ok) return json({ error: target.reason }, target.status);

      // The kill switch applies to fresh downloads too. Rollout percentage
      // does not: a brand new install has no id and no current version.
      const cfg = await kvJson(env.ORC_KV, `policy:${channel}`, {});
      const blocked = Array.isArray(cfg.blockedVersions) ? cfg.blockedVersions : [];
      if (blocked.includes(target.version)) return json({ error: 'version withdrawn' }, 404);

      const headers = {
        'content-type': 'application/vnd.microsoft.portable-executable',
        'content-disposition': `attachment; filename="${target.file}"`,
        // Never cached: this URL points at a different file every release.
        'cache-control': 'no-store',
        'x-orc-version': target.version,
        'x-orc-sha256': target.sha256,
      };
      if (env.ORC_RELEASES) {
        const obj = request.method === 'HEAD'
          ? await env.ORC_RELEASES.head(target.key)
          : await env.ORC_RELEASES.get(target.key);
        if (!obj) return json({ error: 'installer missing from storage' }, 404);
        const bad = storedMismatch(obj, { sha256: target.sha256, size: envelope.manifest.installer.size });
        if (bad) return json({ error: bad }, 409);
        if (obj.size != null) headers['content-length'] = String(obj.size);
        return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
      }
      if (env.PUBLIC_BASE) {
        return Response.redirect(`${env.PUBLIC_BASE.replace(/\/$/, '')}/${target.key}`, 302);
      }
      return json({ error: 'no release storage configured' }, 500);
    }

    // --- payload ----------------------------------------------------------
    if (url.pathname.startsWith('/download/')) {
      if (requireKey && await rateLimited(env, request, 'licence')) return json({ error: 'too many requests' }, 429);
      const lic = await checkLicence(env.ORC_KV, extractKey(request), requireKey);
      if (!lic.ok) return json({ error: lic.reason }, lic.status);

      let key;
      try { key = decodeURIComponent(url.pathname.slice('/download/'.length)); } catch { return json({ error: 'bad payload path' }, 400); }
      // Path traversal guard: exactly "<version>/<name>.zip",
      // "<version>/<name>.exe" (that release's installer) or
      // "<version>/manifest.json" (that release's signed manifest, so a
      // pinned installer download can be checked against its signed hash).
      //
      // Each segment must START with an alphanumeric. That is load-bearing,
      // not cosmetic: `.` is a legal character mid-segment, so a class like
      // [\w.\-+]+ happily matches "..", and an encoded "%2e%2e%2f" would then
      // pass validation. On the redirect path the browser normalises
      // "<base>/../secrets.zip" back up out of the version prefix.
      const m = /^[A-Za-z0-9][\w.\-+]*\/(?:[A-Za-z0-9][\w.\-+]*\.(zip|exe)|manifest\.(json))$/.exec(key);
      if (!m) {
        return json({ error: 'bad payload path' }, 400);
      }
      const ext = m[1] || m[2];
      const TYPES = { zip: 'application/zip', exe: 'application/vnd.microsoft.portable-executable', json: 'application/json' };
      // A zip or exe is served only when a signed manifest names
      // it. Without this, anyone holding the upload token could put any exe
      // at <version>/OrcStrator-Setup-<version>.exe and have it served from
      // the official address.
      let named = null;
      if (ext !== 'json') {
        named = await findNamingManifest(env, key);
        if (!named.ok) return json({ error: named.reason }, 404);
      }
      if (env.ORC_RELEASES) {
        const obj = await env.ORC_RELEASES.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        if (named) {
          const bad = storedMismatch(obj, named);
          if (bad) return json({ error: bad }, 409);
        }
        const headers = {
          'content-type': TYPES[ext],
          'cache-control': ext === 'json' ? 'no-store' : 'public, max-age=31536000, immutable',
        };
        if (ext === 'exe') headers['content-disposition'] = `attachment; filename="${key.split('/')[1]}"`;
        return new Response(obj.body, { headers });
      }
      if (env.PUBLIC_BASE) {
        return Response.redirect(`${env.PUBLIC_BASE.replace(/\/$/, '')}/${key}`, 302);
      }
      return json({ error: 'no release storage configured' }, 500);
    }

    // --- telemetry --------------------------------------------------------
    if (url.pathname === '/telemetry' && request.method === 'POST') {
      // Bounded, validated and rate limited, so nobody can fill the
      // update server's storage. A refused report is still a 204 (or a 429),
      // never an error a client could trip over.
      if (await rateLimited(env, request, 'telemetry')) return new Response(null, { status: 429 });
      try {
        const text = await readLimited(request, TELEMETRY_MAX_BYTES);
        if (text == null) return new Response(null, { status: 413 });
        const body = JSON.parse(text);
        const version = typeof body?.version === 'string' && UPLOAD_VERSION_RE.test(body.version) ? body.version : null;
        const outcome = TELEMETRY_OUTCOMES.includes(body?.outcome) ? body.outcome : null;
        if (installId && version && outcome) {
          await env.ORC_KV.put(
            `install:${installId}`,
            JSON.stringify({ version, outcome, at: new Date().toISOString() }),
            { expirationTtl: 60 * 60 * 24 * 90 }
          );
        }
      } catch {
        // Telemetry must never be able to break a client.
      }
      return new Response(null, { status: 204 });
    }

    return json({ error: 'not found' }, 404);
  }
}
