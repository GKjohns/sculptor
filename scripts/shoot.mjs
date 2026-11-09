// Screenshot loop for the studio, with a guard against the blank captures headless Chrome can produce.
// Usage: node scripts/shoot.mjs --gl|--gpu [--name shot] [--query "hands=1&x=2"] [--url http://localhost:3130/]
//                               [--w 1440 --h 900] [--frames 30] [--wait 0] [--out .shots] [--eval "js"]
//   --gl   headless Chromium on software WebGL 2 (adds ?gl=1). Layout and logic checks; not the look.
//   --gpu  headed Chrome with WebGPU on this Mac. The only mode for judging the look.
//   --eval runs an expression in the page once the scene is ready, awaits it and prints the result,
//          e.g. --eval "__sculptor.burst(200)" for frame times or "__sculptor.hash()" for the grid hash.
//   --preset wide|medium|macro|raking|backlit  puts the camera on a look-book shot (app/studio/look.ts)
//   --seek n  with a ?replay= query: shows the stone as it stood after log entry n
//   --bare    leaves the HUD out of the picture that is saved
//   --webp    also writes <name>_<mode>.webp (cwebp -q 80, at most 1600 px wide, never upscaled)
//   --dpr n   device pixel ratio (1 if left out; the app itself draws at up to 2)
//   --unthrottled  no vsync and no frame-rate cap, so frame times show what a frame costs (timing only)
//   --lookbook [--prefix before_] [--only finished] shoots every preset of the three look-book stones
//             into docs/look/ as WebP. Needs --gpu. See docs/look/README.md.
//   --gesture  presses a key once the scene is ready: the user gesture that lets the page start its sound
//   --until "js"  after --eval, waits (two minutes at most) for an expression to turn truthy, e.g. a slab leaving the block
//   --sequence n [--every ms]  for motion: n pictures that far apart (120 ms if left out), written as
//             <name>_01_<mode>.png onward before the usual last one; with --webp, as WebP only
//   --api      lists every /api/ request the page made, at the end (a replay should make no model calls)
//   --downloads dir  saves whatever the page hands the browser to save (a film export) into dir,
//             e.g. --eval "__sculptor.film({ seconds: 60 })" --downloads .shots/films
// Waits for window.__sceneReady plus --frames more frames, writes <out>/<name>_<mode>.png and exits
// non-zero if the page threw, the backend is not the one asked for, or the capture is flat.
// Elements marked data-hud are hidden for the flatness check, so a HUD over a black canvas still fails.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const preset = opt('--preset', '')
const seek = opt('--seek', '')
const bareShot = args.includes('--bare')
const webp = args.includes('--webp')
const dpr = Number(opt('--dpr', 1))
const unthrottled = args.includes('--unthrottled')
const lookbook = args.includes('--lookbook')
const gesture = args.includes('--gesture')
const until = opt('--until', '')
const sequence = Number(opt('--sequence', 0))
const every = Number(opt('--every', 120))
const downloads = opt('--downloads', '')
const apiLog = args.includes('--api')
// The look book: three stones from saved study runs, early, middle and finished.
const OPUS_BUST = 'X-bust-opus-formed-ref-tune-2-20261109142712-095'
const SOL_BUST = 'C-bust-sol-formed-ref-20261109130608-a36'
const LOOK_STONES = [
  { name: 'early', run: OPUS_BUST, seek: 520 }, // part-way through the first rough-out: sawn planes and the first craters
  { name: 'middle', run: SOL_BUST, seek: 6121 }, // blocked in and the features cut, before the rasp
  { name: 'finished', run: OPUS_BUST, seek: null }
]
const LOOK_PRESETS = ['wide', 'medium', 'macro', 'raking', 'backlit']
const HIDE_ALL = '[data-hud], .fixed.inset-0 > :not(:first-child) { visibility: hidden !important }'
// Frames for TRAA and the eased focus to settle on a still camera.
const SETTLE_FRAMES = 70
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

/** Writes a PNG buffer as WebP beside nothing else: quality 80, 1600 px wide at most, never upscaled. */
function saveWebp(png, path, pngWidth) {
  const tmp = `${path}.tmp.png`
  writeFileSync(tmp, png)
  try {
    execFileSync('cwebp', ['-quiet', '-q', '80', ...(pngWidth > 1600 ? ['-resize', '1600', '0'] : []), tmp, '-o', path])
  } finally {
    rmSync(tmp, { force: true })
  }
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
  : await chromium.launch({ headless: false, channel: 'chrome', args: unthrottled ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [] })

const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr, acceptDownloads: !!downloads })
const saving = []
const apiCalls = []
if (apiLog) {
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/api/')) apiCalls.push(`${r.method()} ${path}`)
  })
}
if (downloads) {
  mkdirSync(resolve(downloads), { recursive: true })
  page.on('download', (d) => {
    const file = resolve(downloads, d.suggestedFilename())
    saving.push(d.saveAs(file).then(() => console.log(`saved ${file}`)))
  })
}
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

async function open(href) {
  try {
    await page.goto(href, { waitUntil: 'networkidle' })
  } catch (e) {
    await fail(`could not open ${href} (is \`npm run dev\` running?): ${e.message}`, browser)
  }
  try {
    await page.waitForFunction(() => window.__sceneReady === true, null, { timeout: 60000 })
  } catch {
    await fail('window.__sceneReady never became true', browser)
  }
  await page.evaluate(() => document.querySelectorAll('#nuxt-devtools-container, nuxt-devtools-anchor, [id^="nuxt-devtools"]').forEach(e => e.remove()))
}

/** The stone of the loaded replay as it stood after log entry n. */
const seekTo = n => page.evaluate(async (to) => {
  const player = window.__sculptor.replay()
  if (!player) throw new Error('--seek needs a ?replay= run on the stage')
  player.pause()
  await player.timeline.seek(to)
  await window.__sculptor.studio().rendered(2)
}, n)

const settleFrames = async (count) => {
  const from = await page.evaluate(() => window.__sculptor.stats().frames)
  await page.waitForFunction(n => window.__sculptor.stats().frames >= n, from + count, { timeout: 60000 })
}

if (lookbook) {
  if (mode !== 'gpu') await fail('--lookbook needs --gpu: the look is only ever judged on WebGPU', browser)
  const dir = resolve(opt('--out', 'docs/look'))
  const prefix = opt('--prefix', '')
  const only = opt('--only', '')
  mkdirSync(dir, { recursive: true })
  for (const stone of LOOK_STONES) {
    if (only && !only.split(',').includes(stone.name)) continue
    const url = new URL(target.href)
    url.searchParams.set('replay', stone.run)
    if (stone.seek === null) url.searchParams.set('at', 'end')
    else url.searchParams.set('speed', '1')
    await open(url.href)
    if (stone.seek !== null) await seekTo(stone.seek)
    await page.addStyleTag({ content: HIDE_ALL })
    for (const look of LOOK_PRESETS) {
      if (preset && !preset.split(',').includes(look)) continue
      await page.evaluate(name => window.__sculptor.look(name), look)
      await settleFrames(SETTLE_FRAMES)
      const png = await page.screenshot()
      const sd = spread(decodePng(png))
      const out = resolve(dir, `${prefix}${stone.name}_${look}.webp`)
      saveWebp(png, out, width * dpr)
      console.log(`${out}  luma spread ${sd.toFixed(1)}`)
      if (sd < MIN_SPREAD) await fail(`${stone.name}/${look} is flat (luma spread ${sd.toFixed(2)}): blank or black canvas`, browser)
    }
  }
  const stats = await page.evaluate(() => window.__sculptor.stats())
  console.log(`  ${stats.backend} · ${stats.width}x${stats.height} · ${stats.frameMs.toFixed(1)} ms/frame · ${stats.drawCalls} draws · ${stats.triangles} tris`)
  if (pageErrors.length) await fail(`${pageErrors.length} uncaught page error(s)`, browser)
  await browser.close()
  process.exit(0)
}

await open(target.href)
if (gesture) await page.keyboard.press('Shift')
if (seek) await seekTo(Number(seek))
if (preset) await page.evaluate(name => window.__sculptor.look(name), preset)

if (evalCode) {
  try {
    console.log(`${evalCode} → ${JSON.stringify(await page.evaluate(evalCode))}`)
  } catch (e) {
    await fail(`--eval threw: ${e.message}`, browser)
  }
}

await Promise.all(saving)

if (until) {
  try {
    await page.waitForFunction(until, null, { timeout: 120000, polling: 'raf' })
  } catch {
    await fail(`--until never came true: ${until}`, browser)
  }
}
if (sequence > 0) {
  mkdirSync(outDir, { recursive: true })
  if (bareShot) await page.addStyleTag({ content: HIDE_ALL })
  const t0 = Date.now()
  for (let i = 1; i <= sequence; i++) {
    const png = await page.screenshot()
    const file = resolve(outDir, `${name}_${String(i).padStart(2, '0')}_${mode}.png`)
    if (webp) saveWebp(png, file.replace(/\.png$/, '.webp'), width * dpr)
    else writeFileSync(file, png)
    const wait = t0 + i * every - Date.now()
    if (wait > 0) await page.waitForTimeout(wait)
  }
  console.log(`${sequence} pictures, ${Math.round((Date.now() - t0) / sequence)} ms apart: ${resolve(outDir, `${name}_01..${String(sequence).padStart(2, '0')}_${mode}`)}`)
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
if (bareShot) {
  // Everything over the canvas, marked or not: the canvas's host is the first child of the scene's root.
  await page.addStyleTag({ content: HIDE_ALL })
  shot = bare = await page.screenshot()
} else if (hasHud) {
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
if (webp) saveWebp(shot, out.replace(/\.png$/, '.webp'), width * dpr)
console.log(`${out}\n  ${stats.backend} · ${stats.width}x${stats.height} · ${stats.frames} frames · ${stats.frameMs.toFixed(1)} ms/frame · ${stats.drawCalls} draws · ${stats.triangles} tris · luma spread ${sd.toFixed(1)}`)

if (apiLog) console.log(`api requests (${apiCalls.length}): ${apiCalls.join(', ') || 'none'}`)
if (sd < MIN_SPREAD) await fail(`the capture is flat (luma spread ${sd.toFixed(2)} < ${MIN_SPREAD}): blank or black canvas`, browser)
if (pageErrors.length) await fail(`${pageErrors.length} uncaught page error(s)`, browser)
await browser.close()
