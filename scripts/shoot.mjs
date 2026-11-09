// Screenshot loop for the studio, with a guard against the blank captures headless Chrome can produce.
// Usage: node scripts/shoot.mjs --gl|--gpu [--name shot] [--query "hands=1&x=2"] [--url http://localhost:3130/]
//                               [--w 1440 --h 900] [--frames 30] [--wait 0] [--out .shots] [--eval "js"]
//   --gl   headless Chromium on software WebGL 2 (adds ?gl=1). Layout and logic checks; not the look.
//   --gpu  headed Chrome with WebGPU on this Mac. The only mode for judging the look.
//   --eval runs an expression in the page once the scene is ready, awaits it and prints the result,
//          e.g. --eval "__sculptor.burst(200)" for frame times or "__sculptor.hash()" for the grid hash.
// Waits for window.__sceneReady plus --frames more frames, writes <out>/<name>_<mode>.png and exits
// non-zero if the page threw, the backend is not the one asked for, or the capture is flat.
// Elements marked data-hud are hidden for the flatness check, so a HUD over a black canvas still fails.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const mode = args.includes('--gpu') ? 'gpu' : args.includes('--gl') ? 'gl' : null
if (!mode) {
  console.error('shoot: pass --gl (headless, software WebGL 2) or --gpu (headed Chrome, WebGPU)')
  process.exit(2)
}
const name = opt('--name', 'shot')
const width = Number(opt('--w', 1440))
const height = Number(opt('--h', 900))
const frames = Number(opt('--frames', 30))
const settle = Number(opt('--wait', 0))
const outDir = resolve(opt('--out', '.shots'))
const evalCode = opt('--eval', '')
const MIN_SPREAD = 4 // standard deviation of luma (0-255) below which a capture counts as blank

const target = new URL(opt('--url', 'http://localhost:3130/'))
for (const [k, v] of new URLSearchParams(opt('--query', ''))) target.searchParams.set(k, v)
if (mode === 'gl') target.searchParams.set('gl', '1')

/** Decode a PNG (8-bit, non-interlaced, as Chrome writes them) to { width, height, channels, data }. */
function decodePng(buf) {
  let pos = 8
  let w = 0, h = 0, channels = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[body[9]]
      if (body[8] !== 8 || !channels || body[12] !== 0) throw new Error('unsupported PNG layout')
    } else if (type === 'IDAT') {
      idat.push(body)
    }
    pos += len + 12
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const data = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels] : 0
      const b = y ? data[row + x - stride] : 0
      const c = y && x >= channels ? data[row + x - stride - channels] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      data[row + x] = (raw[src + x] + pred) & 255
    }
  }
  return { width: w, height: h, channels, data }
}

/** Standard deviation of luma over the image. A black or single-colour canvas scores about zero. */
function spread(png) {
  const { data, channels } = png
  const grey = channels < 3
  let n = 0, sum = 0, sq = 0
  for (let i = 0; i < data.length; i += channels) {
    const l = grey ? data[i] : 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    n++
    sum += l
    sq += l * l
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sq / n - mean * mean))
}

const fail = async (msg, browser) => {
  console.error(`shoot: FAILED: ${msg}`)
  await browser?.close()
  process.exit(1)
}

const browser = mode === 'gl'
  ? await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl']
    })
  // Installed Chrome, in a window: the bundled headless shell has no WebGPU adapter worth trusting.
  : await chromium.launch({ headless: false, channel: 'chrome' })

const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const pageErrors = []
page.on('console', (m) => {
  // Headless SwiftShader says this about any WebGL canvas, even an empty one. It is not the page's.
  if (m.text().includes('GPU stall due to ReadPixels')) return
  if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text())
})
page.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.log('[pageerror]', e.message)
})

try {
  await page.goto(target.href, { waitUntil: 'networkidle' })
} catch (e) {
  await fail(`could not open ${target.href} (is \`npm run dev\` running?): ${e.message}`, browser)
}
try {
  await page.waitForFunction(() => window.__sceneReady === true, null, { timeout: 60000 })
} catch {
  await fail('window.__sceneReady never became true', browser)
}
await page.evaluate(() => document.querySelectorAll('#nuxt-devtools-container, nuxt-devtools-anchor, [id^="nuxt-devtools"]').forEach(e => e.remove()))

if (evalCode) {
  try {
    console.log(`${evalCode} → ${JSON.stringify(await page.evaluate(evalCode))}`)
  } catch (e) {
    await fail(`--eval threw: ${e.message}`, browser)
  }
}

// Real frames, not just a ready flag: wait for the counter to move.
const before = await page.evaluate(() => window.__sculptor.stats().frames)
try {
  await page.waitForFunction(n => window.__sculptor.stats().frames >= n, before + frames, { timeout: 60000 })
} catch {
  await fail(`the frame counter stalled before ${frames} more frames`, browser)
}
if (settle) await page.waitForTimeout(settle)

const stats = await page.evaluate(() => window.__sculptor.stats())
const wanted = mode === 'gpu' ? 'webgpu' : 'webgl2'
if (stats.backend !== wanted) await fail(`--${mode} expects the ${wanted} backend but the page is on ${stats.backend}`, browser)

// Park the pointer mid-canvas so no tooltip sits in the shot.
await page.mouse.move(width / 2, height / 2)
const hasHud = await page.evaluate(() => document.querySelector('[data-hud]') !== null)
let shot
let bare
if (hasHud) {
  const hide = await page.addStyleTag({ content: '[data-hud] { visibility: hidden !important }' })
  bare = await page.screenshot()
  await hide.evaluate(el => el.remove())
  shot = await page.screenshot()
} else {
  shot = bare = await page.screenshot()
}

mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, `${name}_${mode}.png`)
writeFileSync(out, shot)
const sd = spread(decodePng(bare))
console.log(`${out}\n  ${stats.backend} · ${stats.width}x${stats.height} · ${stats.frames} frames · ${stats.frameMs.toFixed(1)} ms/frame · ${stats.drawCalls} draws · ${stats.triangles} tris · luma spread ${sd.toFixed(1)}`)

if (sd < MIN_SPREAD) await fail(`the capture is flat (luma spread ${sd.toFixed(2)} < ${MIN_SPREAD}): blank or black canvas`, browser)
if (pageErrors.length) await fail(`${pageErrors.length} uncaught page error(s)`, browser)
await browser.close()
