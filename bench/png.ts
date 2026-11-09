import { deflateSync, inflateSync } from 'node:zlib'

// PNG at the edges: the kernel and observer only ever deal in RGBA. Node-only, so it lives
// in bench/ and never ships to the browser (which uses a canvas instead).

export interface Rgba { width: number, height: number, data: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length))
  return out
}

// Opaque images are written as RGB, and every row takes whichever PNG filter leaves the smallest
// residue. On a contact sheet that is two thirds the size of unfiltered RGBA, which matters
// because every look in the conversation is uploaded again on every turn.
export function encodePng(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  let opaque = true
  for (let i = 3; i < width * height * 4; i += 4) {
    if (data[i] !== 255) {
      opaque = false
      break
    }
  }
  const ch = opaque ? 3 : 4
  const stride = width * ch
  const px = new Uint8Array(stride * height)
  if (opaque) {
    for (let i = 0, o = 0; i < width * height * 4; i += 4, o += 3) {
      px[o] = data[i]!
      px[o + 1] = data[i + 1]!
      px[o + 2] = data[i + 2]!
    }
  } else {
    px.set(data.subarray(0, stride * height))
  }
  const raw = new Uint8Array((stride + 1) * height)
  const tries = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride))
  for (let y = 0; y < height; y++) {
    const row = y * stride
    let best = 0
    let bestSum = Infinity
    for (let f = 0; f < 5; f++) {
      const out = tries[f]!
      let sum = 0
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? px[row + x - ch]! : 0
        const b = y > 0 ? px[row - stride + x]! : 0
        let predicted = 0
        if (f === 1) predicted = a
        else if (f === 2) predicted = b
        else if (f === 3) predicted = (a + b) >> 1
        else if (f === 4) {
          const c = x >= ch && y > 0 ? px[row - stride + x - ch]! : 0
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        const v = (px[row + x]! - predicted) & 0xff
        out[x] = v
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = f
      }
    }
    raw[y * (stride + 1)] = best
    raw.set(tries[best]!, y * (stride + 1) + 1)
  }
  const head = new Uint8Array(13)
  const view = new DataView(head.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  head[8] = 8 // bit depth
  head[9] = opaque ? 2 : 6 // RGB or RGBA
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// Decodes 8-bit, non-interlaced grey, grey+alpha, RGB and RGBA, which covers our own output
// and what the image model returns. Anything else throws.
export function decodePng(bytes: Uint8Array): Rgba {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      const colour = body[9]!
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour] ?? 0
      if (body[8] !== 8 || !channels || body[12] !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced, not paletted)')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  const packed = new Uint8Array(idat.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of idat) {
    packed.set(p, offset)
    offset += p.length
  }
  const raw = inflateSync(packed)
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0
      let predicted = 0
      if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[y * stride + x] = (raw[line + x]! + predicted) & 0xff
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const grey = channels < 3
    data[i * 4] = pixels[s]!
    data[i * 4 + 1] = grey ? pixels[s]! : pixels[s + 1]!
    data[i * 4 + 2] = grey ? pixels[s]! : pixels[s + 2]!
    data[i * 4 + 3] = channels === 4 ? pixels[s + 3]! : channels === 2 ? pixels[s + 1]! : 255
  }
  return { width, height, data }
}
