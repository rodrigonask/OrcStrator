import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

const SRC = 'C:/Users/Rodrigo Nask/Desktop/Sprites';
const DEST = 'C:/agents/nasklaude/client/public/spritesheets';

const FRAME_SIZE = 128;

// Characters: 4 frames, strip = 512x128
// Monsters: 6 frames, strip = 768x128
const SPRITES = [
  { src: 'Glowing staff wizard.png', dest: 'mage.png',    frames: 4, width: FRAME_SIZE * 4, height: FRAME_SIZE },
  { src: 'Warrior.png',              dest: 'warrior.png',  frames: 4, width: FRAME_SIZE * 4, height: FRAME_SIZE },
  { src: 'Archer.png',               dest: 'archer.png',   frames: 4, width: FRAME_SIZE * 4, height: FRAME_SIZE },
  { src: 'Paladin with banner.png',  dest: 'paladin.png',  frames: 4, width: FRAME_SIZE * 4, height: FRAME_SIZE },
  { src: 'Dragon.png',         dest: 'dragon.png',  frames: 6, srcFrames: 6, width: FRAME_SIZE * 6, height: FRAME_SIZE },
  { src: 'Orc.png',            dest: 'orc.png',     frames: 6, srcFrames: 5, width: FRAME_SIZE * 6, height: FRAME_SIZE },
  { src: 'Sneaky Goblin.png',  dest: 'goblin.png',  frames: 6, srcFrames: 5, width: FRAME_SIZE * 6, height: FRAME_SIZE },
  { src: 'Slime.png',          dest: 'slime.png',   frames: 6, srcFrames: 5, width: FRAME_SIZE * 6, height: FRAME_SIZE },
];

async function removeWhiteBg(input) {
  const { data, info } = await input
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const buf = Buffer.from(data);

  for (let i = 0; i < buf.length; i += channels) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    if (r > 240 && g > 240 && b > 240) {
      buf[i + 3] = 0;
    }
  }

  return sharp(buf, { raw: { width, height, channels } }).png();
}

async function extractFrames(srcPath, numFrames) {
  const meta = await sharp(srcPath).metadata();
  const hasAlpha = meta.channels === 4 && meta.hasAlpha;

  let cleaned;
  if (hasAlpha) {
    cleaned = sharp(srcPath).ensureAlpha();
  } else {
    // Remove white/light bg with lower threshold for checkered patterns
    const { data, info } = await sharp(srcPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const buf = Buffer.from(data);
    for (let i = 0; i < buf.length; i += channels) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      if (r > 180 && g > 180 && b > 180) buf[i + 3] = 0;
    }
    cleaned = sharp(buf, { raw: { width, height, channels } }).png();
  }

  const trimmedBuf = await cleaned.trim({ threshold: 10 }).toBuffer();
  const trimMeta = await sharp(trimmedBuf).metadata();
  console.log(`  Trimmed to: ${trimMeta.width}x${trimMeta.height}`);

  const colWidth = Math.floor(trimMeta.width / numFrames);
  const frames = [];

  for (let i = 0; i < numFrames; i++) {
    const left = i * colWidth;
    const extractWidth = (i === numFrames - 1) ? (trimMeta.width - left) : colWidth;

    const colBuf = await sharp(trimmedBuf)
      .extract({ left, top: 0, width: extractWidth, height: trimMeta.height })
      .toBuffer();

    const frameTrimmed = await sharp(colBuf).trim({ threshold: 10 }).toBuffer();

    // Resize to FRAME_SIZE x FRAME_SIZE with Lanczos (smooth scaling)
    const frameResized = await sharp(frameTrimmed)
      .resize(FRAME_SIZE, FRAME_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: 'lanczos3',
      })
      .toBuffer();

    frames.push(frameResized);
  }

  return frames;
}

async function composeStrip(frames, totalWidth, totalHeight) {
  const base = sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }
  }).png();

  const composites = frames.map((frameBuf, i) => ({
    input: frameBuf,
    left: i * FRAME_SIZE,
    top: 0,
  }));

  return base.composite(composites).png().toBuffer();
}

async function processSprite(spec) {
  const srcPath = path.join(SRC, spec.src);
  if (!fs.existsSync(srcPath)) {
    console.log(`  SKIP (not found): ${srcPath}`);
    return;
  }
  const destPath = path.join(DEST, spec.dest);

  console.log(`\nProcessing: ${spec.src} → ${spec.dest}`);

  const actualSrcFrames = spec.srcFrames || spec.frames;
  let frames = await extractFrames(srcPath, actualSrcFrames);
  console.log(`  Extracted ${frames.length} frames at ${FRAME_SIZE}x${FRAME_SIZE}`);

  while (frames.length < spec.frames) {
    frames.push(frames[frames.length - 1]);
  }

  const strip = await composeStrip(frames, spec.width, spec.height);
  fs.writeFileSync(destPath, strip);
  console.log(`  Saved: ${destPath} (${strip.length} bytes)`);
}

function writeAtlas(name, totalFrames, frameSize, isMonster) {
  const atlas = {
    frames: {},
    meta: {
      image: `${name}.png`,
      format: 'RGBA8888',
      size: { w: frameSize * totalFrames, h: frameSize },
      scale: '1',
    },
  };

  // PixiJS v8 requires explicit "animations" key (no auto-grouping from frame names)
  atlas.animations = {};

  if (isMonster) {
    // Monsters: first 3 = idle, last 3 = hurt
    const idleCount = Math.ceil(totalFrames / 2);
    const hurtCount = totalFrames - idleCount;
    const idleFrameNames = [];
    const hurtFrameNames = [];
    for (let i = 0; i < idleCount; i++) {
      const frameName = `${name}-idle-${i}`;
      idleFrameNames.push(frameName);
      atlas.frames[frameName] = {
        frame: { x: i * frameSize, y: 0, w: frameSize, h: frameSize },
        sourceSize: { w: frameSize, h: frameSize },
        spriteSourceSize: { x: 0, y: 0, w: frameSize, h: frameSize },
      };
    }
    for (let i = 0; i < hurtCount; i++) {
      const frameName = `${name}-hurt-${i}`;
      hurtFrameNames.push(frameName);
      atlas.frames[frameName] = {
        frame: { x: (idleCount + i) * frameSize, y: 0, w: frameSize, h: frameSize },
        sourceSize: { w: frameSize, h: frameSize },
        spriteSourceSize: { x: 0, y: 0, w: frameSize, h: frameSize },
      };
    }
    atlas.animations[`${name}-idle`] = idleFrameNames;
    atlas.animations[`${name}-hurt`] = hurtFrameNames;
  } else {
    // Characters: all frames are idle
    const idleFrameNames = [];
    for (let i = 0; i < totalFrames; i++) {
      const frameName = `${name}-idle-${i}`;
      idleFrameNames.push(frameName);
      atlas.frames[frameName] = {
        frame: { x: i * frameSize, y: 0, w: frameSize, h: frameSize },
        sourceSize: { w: frameSize, h: frameSize },
        spriteSourceSize: { x: 0, y: 0, w: frameSize, h: frameSize },
      };
    }
    atlas.animations[`${name}-idle`] = idleFrameNames;
  }

  const destPath = path.join(DEST, `${name}.json`);
  fs.writeFileSync(destPath, JSON.stringify(atlas, null, 2));
  console.log(`  Atlas: ${destPath}`);
}

async function main() {
  console.log('=== Sprite Processing (128x128 per frame) ===');
  console.log(`Source: ${SRC}`);
  console.log(`Destination: ${DEST}`);

  for (const spec of SPRITES) {
    await processSprite(spec);
    const name = spec.dest.replace('.png', '');
    const isMonster = spec.frames === 6;
    writeAtlas(name, spec.frames, FRAME_SIZE, isMonster);
  }

  console.log('\n=== Done! All sprites processed. ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
