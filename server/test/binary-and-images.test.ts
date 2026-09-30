// claude.cmd earlier on PATH, and JPEG tiles labelled PNG.
//
//   npx tsx server/test/binary-and-images.test.ts

import sharp from 'sharp'
import { check, done } from './helpers/scratch-app.js'

const binary = await import('../src/services/claude-binary.js') as Record<string, unknown>
const { preprocessImages, detectMediaType } = await import('../src/services/image-processor.js')

// ── claude.cmd on PATH ────────────────────────────────────────────────────────────────────────
type Finder = (pathEnv: string, platform: NodeJS.Platform, isFile: (p: string) => boolean) => string | null
const find = binary.findClaudeOnPath as Finder | undefined
check('the PATH search is exported and testable', typeof find === 'function')
if (find) {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe'])
  const isFile = (p: string) => files.has(p)
  const got = find('C:\\npm;C:\\Users\\me\\.local\\bin', 'win32', isFile)
  check('claude.exe wins even when claude.cmd is in an EARLIER PATH folder', got === 'C:\\Users\\me\\.local\\bin\\claude.exe', String(got))
  const onlyCmd = find('C:\\npm', 'win32', isFile)
  check('a .cmd shim alone is never returned (it cannot be spawned without a shell)', onlyCmd === null, String(onlyCmd))
  const posix = find('/usr/bin:/home/me/.local/bin', 'linux', p => p === '/home/me/.local/bin/claude')
  check('posix lookup still finds claude', posix === '/home/me/.local/bin/claude', String(posix))
}

// ── JPEG tiles ────────────────────────────────────────────────────────────────────────
// A phone-sized JPEG (4032x3024), noisy enough to be a realistic size.
const w = 4032, h = 3024
const raw = Buffer.alloc(w * h * 3)
for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24
const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 70 }).toBuffer()
const res = await preprocessImages([{ base64: jpeg.toString('base64'), mediaType: 'image/jpeg' }])
check('a 4032x3024 photo is tiled', res.images.length === 4, `${res.images.length} images`)
const mismatched = res.images.filter(img => img.mediaType !== detectMediaType(img.base64))
check('every tile is labelled with the type its bytes actually are', mismatched.length === 0,
  res.images.map(i => `declared ${i.mediaType} actual ${detectMediaType(i.base64)}`).join('; '))

// A small image whose caller mislabelled it is corrected too.
const smallPng = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
const small = await preprocessImages([{ base64: smallPng.toString('base64'), mediaType: 'image/jpeg' }])
check('a PNG sent labelled image/jpeg goes out as image/png', small.images[0]?.mediaType === 'image/png', small.images[0]?.mediaType)

done()
