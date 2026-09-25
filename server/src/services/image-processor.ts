import sharp from 'sharp'

export interface ProcessedImage {
  base64: string
  mediaType: string
}

export interface PreprocessResult {
  images: ProcessedImage[]
  textPrefix: string
}

const MAX_BINARY_BYTES = 1.5 * 1024 * 1024 // 1.5MB binary → fits within 2MB base64
const MAX_IMAGES_PER_MESSAGE = 5
const TILE_THRESHOLD_PX = 2000

export async function preprocessImages(
  rawImages: Array<{ base64: string; mediaType: string }>
): Promise<PreprocessResult> {
  if (rawImages.length === 0) return { images: [], textPrefix: '' }

  const notes: string[] = []
  let processed: ProcessedImage[] = []

  for (let i = 0; i < rawImages.length; i++) {
    const raw = rawImages[i]
    const buffer = Buffer.from(raw.base64, 'base64')
    const metadata = await sharp(buffer).metadata()
    const w = metadata.width ?? 0
    const h = metadata.height ?? 0

    if (w > TILE_THRESHOLD_PX || h > TILE_THRESHOLD_PX) {
      const tiles = await tileImage(buffer, w, h)
      const cols = w > TILE_THRESHOLD_PX ? 2 : 1
      const rows = h > TILE_THRESHOLD_PX ? 2 : 1
      const regionDesc = tiles.length === 4
        ? 'top-left, top-right, bottom-left, bottom-right'
        : rows === 2 ? 'top half, bottom half' : 'left half, right half'
      notes.push(
        `[Image ${i + 1} was ${w}×${h}px and has been tiled into ${tiles.length} regions ` +
        `for better detail reading: ${regionDesc}]`
      )
      for (const tile of tiles) {
        processed.push(await compressIfNeeded(tile))
      }
    } else {
      processed.push(await compressIfNeeded({ base64: raw.base64, mediaType: raw.mediaType }))
    }
  }

  // Stitch pairs iteratively until count fits within the per-message limit
  if (processed.length > MAX_IMAGES_PER_MESSAGE) {
    const before = processed.length
    processed = await stitchUntilFits(processed)
    notes.push(
      `[${before} images were combined into ${processed.length} side-by-side pairs ` +
      `to stay within the ${MAX_IMAGES_PER_MESSAGE}-image message limit]`
    )
  }

  const textPrefix = notes.length > 0 ? notes.join('\n') + '\n\n' : ''
  return { images: processed, textPrefix }
}

async function compressIfNeeded(img: ProcessedImage): Promise<ProcessedImage> {
  const buffer = Buffer.from(img.base64, 'base64')
  if (buffer.length <= MAX_BINARY_BYTES) return img

  // Iteratively reduce quality until within limit
  for (const quality of [80, 65, 50]) {
    const compressed = await sharp(buffer).jpeg({ quality }).toBuffer()
    if (compressed.length <= MAX_BINARY_BYTES) {
      return { base64: compressed.toString('base64'), mediaType: 'image/jpeg' }
    }
  }

  // Last resort: resize to max 1200px wide
  const resized = await sharp(buffer).resize(1200).jpeg({ quality: 60 }).toBuffer()
  return { base64: resized.toString('base64'), mediaType: 'image/jpeg' }
}

async function tileImage(buffer: Buffer, w: number, h: number): Promise<ProcessedImage[]> {
  const cols = w > TILE_THRESHOLD_PX ? 2 : 1
  const rows = h > TILE_THRESHOLD_PX ? 2 : 1
  const tileW = Math.ceil(w / cols)
  const tileH = Math.ceil(h / rows)
  const tiles: ProcessedImage[] = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const extractW = Math.min(tileW, w - c * tileW)
      const extractH = Math.min(tileH, h - r * tileH)
      const tileBuffer = await sharp(buffer)
        .extract({ left: c * tileW, top: r * tileH, width: extractW, height: extractH })
        .toBuffer()
      tiles.push({ base64: tileBuffer.toString('base64'), mediaType: 'image/png' })
    }
  }
  return tiles
}

async function stitchPairs(images: ProcessedImage[]): Promise<ProcessedImage[]> {
  const result: ProcessedImage[] = []
  const TARGET_WIDTH = 800 // resize each image to this width before stitching

  for (let i = 0; i < images.length; i += 2) {
    if (i + 1 >= images.length) {
      result.push(images[i])
      continue
    }

    const bufA = Buffer.from(images[i].base64, 'base64')
    const bufB = Buffer.from(images[i + 1].base64, 'base64')
    const [metaA, metaB] = await Promise.all([sharp(bufA).metadata(), sharp(bufB).metadata()])

    // Resize both to TARGET_WIDTH maintaining aspect ratio
    const hA = Math.round(TARGET_WIDTH * (metaA.height ?? 600) / (metaA.width ?? 800))
    const hB = Math.round(TARGET_WIDTH * (metaB.height ?? 600) / (metaB.width ?? 800))
    const totalH = Math.max(hA, hB)

    const [rA, rB] = await Promise.all([
      sharp(bufA)
        .resize(TARGET_WIDTH, totalH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 255 } })
        .png()
        .toBuffer(),
      sharp(bufB)
        .resize(TARGET_WIDTH, totalH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 255 } })
        .png()
        .toBuffer(),
    ])

    const stitched = await sharp({
      create: { width: TARGET_WIDTH * 2, height: totalH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } }
    })
      .composite([
        { input: rA, left: 0, top: 0 },
        { input: rB, left: TARGET_WIDTH, top: 0 },
      ])
      .jpeg({ quality: 80 })
      .toBuffer()

    result.push(await compressIfNeeded({ base64: stitched.toString('base64'), mediaType: 'image/jpeg' }))
  }
  return result
}

async function stitchUntilFits(images: ProcessedImage[]): Promise<ProcessedImage[]> {
  let current = images
  while (current.length > MAX_IMAGES_PER_MESSAGE) {
    current = await stitchPairs(current)
  }
  return current
}

// Detect image media type from magic bytes in base64 string
export function detectMediaType(base64: string): string {
  const bytes = Buffer.from(base64.substring(0, 16), 'base64')
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/webp'
  return 'image/png' // fallback
}
