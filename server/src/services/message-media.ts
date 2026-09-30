// What a chat message is allowed to weigh in the database.
//
// Every pasted screenshot used to be stored inside its message row as base64, at full size,
// for ever, and every scroll of that chat downloaded it again. One message on the live
// database was 2.8 MB. Tool calls were the other half: a Write of a large file stored the
// whole file as the tool's input, and the chat re-sent it on every page of history.
//
// Two rules now, applied when a message is saved:
//
//   1. IMAGES go to a file under the data dir (media/<sha256>.<ext>, so the same screenshot
//      pasted twice is stored once) and the message keeps a reference to it (`url`, served
//      by GET /api/media/:name) plus a small JPEG thumbnail in `base64`. The thumbnail is what
//      keeps an app that does not know about `url` yet showing something sensible, at a
//      few tens of KB instead of megabytes. Rows written before this keep their full
//      base64 and render exactly as before.
//
//   2. TOOL PAYLOADS are capped per string field, not per block. Cutting the JSON text in
//      the middle would leave something the chat cannot parse, so every long string inside
//      the tool's input is shortened on its own and the rest (the file path, the command)
//      is kept whole. The full text is still in the session transcript the CLI keeps; this
//      is only the chat's copy.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { DATA_DIR } from '../config.js'
import { detectMediaType } from './image-processor.js'
import { db } from '../db.js'

export const MEDIA_DIR = path.join(DATA_DIR, 'media')

/** Longest string kept inside a stored tool payload, in characters. */
export const TOOL_FIELD_CAP = 8_000
/** Longest thumbnail edge. Small enough to be cheap, big enough to recognise the picture. */
const THUMB_EDGE_PX = 320

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]))

/** A stored media name: exactly what saveImage writes, so nothing else can be asked for. */
const MEDIA_NAME = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/

/** The media type for a stored file name, or null when the name is not one this module wrote. */
export function mediaTypeForName(name: string): string | null {
  const m = MEDIA_NAME.exec(name)
  return m ? TYPE_BY_EXT[m[1]] ?? null : null
}

/** Absolute path of a stored file, or null for any name this module would not have written. */
export function mediaPathForName(name: string): string | null {
  return mediaTypeForName(name) ? path.join(MEDIA_DIR, name) : null
}

export function mediaUrlForName(name: string): string {
  return `/api/media/${name}`
}

/** Write the image once (content-addressed) and return its stored name. */
function saveImageBytes(bytes: Buffer, mediaType: string): string {
  const ext = EXT_BY_TYPE[mediaType] ?? 'png'
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`
  const file = path.join(MEDIA_DIR, name)
  // Held back from release and sweep while its message row is still being written (see Removal).
  recentlyWritten.set(name, Date.now())
  if (fs.existsSync(file)) {
    // The same picture pasted again: a fresh mtime keeps the age-based sweep off it too.
    try { const now = new Date(); fs.utimesSync(file, now, now) } catch { /* best effort */ }
  } else {
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    // Written beside and renamed into place, so a crash mid-write never leaves a torn file
    // under the name a message already points at.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
  }
  return name
}

// ── Removal ────────────────────────────────────────────────────────────────────────────────
//
// A stored screenshot must go when its chat goes. Before files, the picture lived inside the
// message rows, which cascade away with the chat; a secure close that scrubbed the transcript
// then left nothing behind. As a file it would outlive the chat and even a secure close.
// Files are shared by content hash, so one is removed only when no message
// anywhere still points at it:
//   - mediaNamesForInstances(ids) BEFORE the chat's rows are deleted: the names it references
//   - releaseMedia(names) AFTER: each name no remaining message references is deleted
// A paste writes the file, awaits its thumbnail, and only then inserts the row. The same
// screenshot pasted into another chat has the same name, so a release in that window would
// delete the file under the row about to point at it (reproduced). Every
// name saveImageBytes hands out is therefore held back for PENDING_MS (far longer than a
// thumbnail takes), and a release that meets a held name checks it again once the hold is over.
// sweepUnreferencedMedia() at boot and every few hours catches every other way a row disappears,
// and only takes files older than an hour (a repeat paste refreshes the mtime).

const PENDING_MS = 2 * 60_000
const recentlyWritten = new Map<string, number>()

/** Tests only: end every hold now, as if the pastes had long finished. */
export function forgetPendingMedia(): void {
  recentlyWritten.clear()
}

function isPending(name: string): boolean {
  const at = recentlyWritten.get(name)
  if (at === undefined) return false
  if (Date.now() - at < PENDING_MS) return true
  recentlyWritten.delete(name)
  return false
}

const MEDIA_REF = /\/api\/media\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))/g

function namesIn(text: string): string[] {
  return [...text.matchAll(MEDIA_REF)].map(m => m[1])
}

/** Every stored name any message still references: one pass over the table, not one per name. */
function referencedNames(): Set<string> {
  const rows = db.prepare("SELECT content FROM messages WHERE instr(content, '/api/media/') > 0").all() as Array<{ content: string }>
  return new Set(rows.flatMap(r => namesIn(r.content)))
}

export function mediaNamesForInstances(instanceIds: string[]): string[] {
  if (instanceIds.length === 0) return []
  try {
    const ph = instanceIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT content FROM messages WHERE instance_id IN (${ph}) AND instr(content, '/api/media/') > 0`).all(...instanceIds) as Array<{ content: string }>
    return [...new Set(rows.flatMap(r => namesIn(r.content)))]
  } catch (err) {
    console.warn('[message-media] could not list a chat\'s stored images:', (err as Error).message)
    return []
  }
}

/** Delete each named file that no remaining message references. Returns how many went. */
export function releaseMedia(names: string[]): number {
  const valid = names.filter(n => mediaPathForName(n))
  const held = valid.filter(isPending)
  if (held.length) setTimeout(() => { releaseMedia(held) }, PENDING_MS + 1000).unref()
  const candidates = valid.filter(n => !held.includes(n))
  if (candidates.length === 0) return 0
  let used: Set<string>
  try { used = referencedNames() } catch (err) {
    console.warn('[message-media] could not check which images are still used, keeping them:', (err as Error).message)
    return 0
  }
  let removed = 0
  for (const name of candidates) {
    if (used.has(name)) continue
    try {
      fs.rmSync(mediaPathForName(name)!, { force: true })
      removed++
    } catch (err) {
      console.warn(`[message-media] could not remove ${name}:`, (err as Error).message)
    }
  }
  return removed
}

/** Remove stored files no message references and older than `minAgeMs`. Returns how many went. */
export function sweepUnreferencedMedia(minAgeMs = 60 * 60_000): number {
  let names: string[]
  try { names = fs.readdirSync(MEDIA_DIR).filter(n => MEDIA_NAME.test(n)) } catch { return 0 }
  if (names.length === 0) return 0
  try {
    const used = referencedNames()
    const cutoff = Date.now() - minAgeMs
    let removed = 0
    for (const n of names) {
      if (used.has(n) || isPending(n)) continue
      const file = path.join(MEDIA_DIR, n)
      try { if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed++ } } catch { /* raced */ }
    }
    if (removed) console.log(`[message-media] removed ${removed} stored image(s) no chat uses any more`)
    return removed
  } catch (err) {
    console.warn('[message-media] media sweep skipped:', (err as Error).message)
    return 0
  }
}

/** Largest thumbnail kept in a row, in base64 characters. Anything bigger is dropped. */
const THUMB_MAX_CHARS = 64 * 1024

/**
 * A small JPEG preview. Always JPEG, whatever the original: a PNG thumbnail of a photo or a
 * busy screenshot can be larger than a whole compressed original, which would defeat the
 * point. Transparency is flattened onto white, the way the chat shows it anyway.
 */
async function thumbnail(bytes: Buffer): Promise<string> {
  const out = await sharp(bytes, { animated: false })
    .resize(THUMB_EDGE_PX, THUMB_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 60 })
    .toBuffer()
  const b64 = out.toString('base64')
  return b64.length <= THUMB_MAX_CHARS ? b64 : ''
}

export interface StoredImageBlock {
  type: 'image'
  base64: string
  mediaType: string
  url?: string
}

/**
 * The image block a message stores for one pasted image: file on disk, reference plus
 * thumbnail in the row. If anything about that fails (a full disk, bytes sharp cannot read),
 * the image is kept inline exactly as before: a large row is a performance problem, a lost
 * screenshot is a data loss.
 */
export async function storeImageBlock(base64: string, mediaType?: string): Promise<StoredImageBlock> {
  const type = mediaType || detectMediaType(base64)
  try {
    const bytes = Buffer.from(base64, 'base64')
    const name = saveImageBytes(bytes, type)
    let thumb = ''
    try { thumb = await thumbnail(bytes) } catch { thumb = '' }
    // `mediaType` describes what is in `base64`, which is what an app without `url` support
    // renders: the JPEG thumbnail. The file behind `url` is served with its own type.
    return { type: 'image', base64: thumb, mediaType: thumb ? 'image/jpeg' : type, url: mediaUrlForName(name) }
  } catch (err) {
    console.warn('[message-media] could not store an image on disk, keeping it inline:', (err as Error).message)
    return { type: 'image', base64, mediaType: type }
  }
}

function capString(s: string, cap: number): string {
  if (s.length <= cap) return s
  const dropped = s.length - cap
  return `${s.slice(0, cap)}\n[... ${dropped.toLocaleString('en-US')} more characters not kept in the chat history. The full text is in the session transcript.]`
}

/** Every string inside a tool payload capped at `cap`, the structure left intact. */
export function capToolValue(value: unknown, cap = TOOL_FIELD_CAP, depth = 0): unknown {
  if (typeof value === 'string') return capString(value, cap)
  if (depth > 20 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => capToolValue(v, cap, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capToolValue(v, cap, depth + 1)
  return out
}

/** A tool call's input as the chat stores it: valid JSON, long strings shortened. */
export function storedToolInput(input: unknown): string {
  return JSON.stringify(capToolValue(input ?? {}))
}

/**
 * The per-block limits for content the stream handler saves. Synchronous on purpose: it
 * runs inside the stdout handler, which must not await. A tool-call's input arrives here
 * already stringified, so it is parsed, capped and written back; a tool-result's output is
 * a plain string. An inline base64 image in an assistant block (rare) is dropped from the
 * stored copy with a note rather than written to disk from the hot path.
 */
/**
 * Tool calls whose input IS what the person reads and acts on: the plan they approve (ExitPlanMode,
 * or a Write into .claude/plans/) and the questions they answer (AskUserQuestion). The approval
 * card is rebuilt from the stored message, so cutting these would show a truncated plan at the
 * moment it is approved. They are kept whole.
 */
function keepWhole(b: Record<string, unknown>): boolean {
  if (b.toolName === 'ExitPlanMode' || b.toolName === 'AskUserQuestion') return true
  if (b.toolName !== 'Write' || typeof b.input !== 'string') return false
  const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(b.input)
  return !!m && m[1].replace(/\\\//g, '/').includes('.claude/plans/')
}

export function compactContentForStorage<T extends Record<string, unknown>>(blocks: T[]): T[] {
  return blocks.map(b => {
    if (!b || typeof b !== 'object') return b
    if (b.type === 'tool-call' && typeof b.input === 'string' && b.input.length > TOOL_FIELD_CAP && !keepWhole(b)) {
      let input: string
      try { input = storedToolInput(JSON.parse(b.input)) } catch { input = capString(b.input, TOOL_FIELD_CAP) }
      return { ...b, input }
    }
    if (b.type === 'tool-result' && typeof b.output === 'string' && b.output.length > TOOL_FIELD_CAP) {
      return { ...b, output: capString(b.output, TOOL_FIELD_CAP) }
    }
    if (b.type === 'image') {
      const src = b.source as { type?: string; data?: unknown } | undefined
      if (src?.type === 'base64' && typeof src.data === 'string' && src.data.length > TOOL_FIELD_CAP) {
        return { type: 'text', text: '[An image was here. It is kept in the session transcript, not in the chat history.]' } as unknown as T
      }
    }
    return b
  })
}
