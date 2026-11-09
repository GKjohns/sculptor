/**
 * The reference sheet as a plain PNG no larger than it needs to be. Image models send JPEG as
 * often as PNG, and at whatever size they like; the sheet rides in the cached prefix of every
 * turn, so it is cut to 1024 px on its long side (a quadrant is then about 0.25 cm a pixel,
 * finer than the 0.4 cm outline cells).
 *
 * Conversion is macOS's own `sips`, as in the bench: no image library in the dependencies.
 * Where there is no sips (a Linux deploy) the bytes go back as they came with their real
 * media type, and the browser, which can decode anything, takes it from there.
 *
 * Plain Node, no Nitro imports.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIPS = '/usr/bin/sips'
export const SHEET_MAX_SIDE = 1024

export interface SheetImage {
  bytes: Uint8Array
  mediaType: string
  width: number | null
  height: number | null
}

export function sniffImageType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  return 'application/octet-stream'
}

// Width and height from a PNG's IHDR, which is always its first chunk.
export function pngSize(b: Uint8Array): { width: number, height: number } | null {
  if (sniffImageType(b) !== 'image/png' || b.length < 24) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function sips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(SIPS, args, { timeout: 20_000 }, err => err ? reject(err) : resolve())
  })
}

export async function toSheetPng(bytes: Uint8Array, maxSide = SHEET_MAX_SIDE): Promise<SheetImage> {
  const type = sniffImageType(bytes)
  const size = pngSize(bytes)
  if (size && Math.max(size.width, size.height) <= maxSide) return { bytes, mediaType: type, ...size }
  if (!existsSync(SIPS)) return { bytes, mediaType: type, width: size?.width ?? null, height: size?.height ?? null }
  const dir = await mkdtemp(join(tmpdir(), 'sculptor-sheet-'))
  try {
    const src = join(dir, 'in.img')
    const out = join(dir, 'out.png')
    await writeFile(src, bytes)
    await sips(['-s', 'format', 'png', src, '--out', out])
    let png = new Uint8Array(await readFile(out))
    let dims = pngSize(png)
    // -Z also enlarges, so it is only used on a sheet that is known to be too big.
    if (dims && Math.max(dims.width, dims.height) > maxSide) {
      await sips(['-Z', String(maxSide), out])
      png = new Uint8Array(await readFile(out))
      dims = pngSize(png)
    }
    return { bytes: png, mediaType: 'image/png', width: dims?.width ?? null, height: dims?.height ?? null }
  } catch {
    return { bytes, mediaType: type, width: size?.width ?? null, height: size?.height ?? null }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
