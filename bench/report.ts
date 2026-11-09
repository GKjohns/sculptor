// The study report: one self-contained page built from the runs under .data/study.
//
//   npm run bench:report [-- --dir .data/study --out internal_docs/20261108_ai_sculptor/study]
//
// Writes <out>/report.html and, beside it, the images it shows as WebP (cwebp -q 72, never
// enlarged). Renders with whatever has been run so far; rounds not yet run say so.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { analyzeReference } from '../shared/agent/reference.ts'
import { replayLog } from '../shared/agent/studio.ts'
import { createGrid } from '../shared/sculpt/grid.ts'
import { silhouetteAgreement } from '../shared/sculpt/measure.ts'
import { KERNEL_VERSION } from '../shared/sculpt/version.ts'
import { parseArgs } from './args.ts'
import { decodePng } from './png.ts'
import { readStrikeLog } from './sculpt.ts'
import type { RunFile } from './sculpt.ts'
import { SUBJECT_IDS, tidySentence } from './subjects.ts'
import type { SubjectId } from './subjects.ts'

const CWEBP = existsSync('/opt/homebrew/bin/cwebp') ? '/opt/homebrew/bin/cwebp' : 'cwebp'
const GATE_USD = 8

interface Loaded { run: RunFile, dir: string }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)
const usd = (v: number) => `$${v.toFixed(2)}`
// Every sum and difference on the page is worked from the figures as printed, to the cent,
// so a reader adding up a column gets the total the page states.
const shown2 = (v: number) => Math.round(v * 100) / 100
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const num = (v: number | undefined, digits = 2) => v === undefined || Number.isNaN(v) ? '–' : v.toFixed(digits)

function loadRuns(studyDir: string): Loaded[] {
  if (!existsSync(studyDir)) return []
  const out: Loaded[] = []
  for (const name of readdirSync(studyDir)) {
    const file = join(studyDir, name, 'run.json')
    if (!existsSync(file)) continue
    try {
      out.push({ run: JSON.parse(readFileSync(file, 'utf8')) as RunFile, dir: join(studyDir, name) })
    } catch {
      console.error(`bench:report: skipped ${file} (not valid JSON)`)
    }
  }
  return out.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))
}

const armKey = (r: RunFile) => [r.config.round, r.config.subject, r.config.model, r.config.tools, r.config.ref ? 'ref' : 'noref'].join('|')
const configKey = (r: RunFile) => [r.config.model, r.config.tools, r.config.ref ? 'ref' : 'noref'].join('|')
const configName = (r: RunFile) => `${r.config.model} · ${r.config.tools} · reference ${r.config.ref ? 'on' : 'off'}`

// The newest finished run of each arm; an unfinished one only if the arm has nothing else.
function latestPerArm(all: Loaded[]): Loaded[] {
  const best = new Map<string, Loaded>()
  for (const l of all) {
    const had = best.get(armKey(l.run))
    if (!had || l.run.status === 'done' || had.run.status !== 'done') best.set(armKey(l.run), l)
  }
  return [...best.values()]
}

// ---------- images ----------

class Images {
  readonly used = new Set<string>()
  private readonly out: string
  constructor(out: string) {
    this.out = out
  }

  // Converts <dir>/<file> to <out>/<name>.webp unless it is already there and newer.
  webp(dir: string, file: string, name: string): string | null {
    const src = join(dir, file)
    if (!existsSync(src)) return null
    const target = `${name}.webp`
    const dst = join(this.out, target)
    if (!existsSync(dst) || statSync(dst).mtimeMs < statSync(src).mtimeMs) {
      try {
        execFileSync(CWEBP, ['-quiet', '-q', '72', src, '-o', dst], { stdio: 'ignore' })
      } catch (err) {
        console.error(`bench:report: cwebp failed on ${src}: ${(err as Error).message}`)
        return null
      }
    }
    this.used.add(target)
    return target
  }

  // Images from runs that are no longer shown do not stay behind.
  sweep(): void {
    for (const name of readdirSync(this.out)) {
      if (/\.(webp|png)$/.test(name) && !this.used.has(name)) rmSync(join(this.out, name))
    }
  }
}

// ---------- the no-reference twin measured against the reference ----------

interface Agreement { front: number, left: number }

// How well a stone carved without the reference happens to agree with the outlines its twin
// was given. The log is replayed to get the stone back; the answer is kept beside the run.
function twinAgreement(twin: Loaded, withRef: Loaded): Agreement | null {
  const cache = join(twin.dir, `agreement-${withRef.run.id}.json`)
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as Agreement
  const sheet = join(withRef.dir, 'reference.png')
  if (!existsSync(sheet) || !withRef.run.reference?.outlines || twin.run.kernel !== KERNEL_VERSION) return null
  try {
    const masks = analyzeReference(decodePng(readFileSync(sheet))).masks
    if (!masks) return null
    const grid = replayLog(readStrikeLog(twin.dir), g => createGrid(g))
    const round = (v: number) => Math.round(v * 1000) / 1000
    const out = { front: round(silhouetteAgreement(grid, 'front', masks.front).iou), left: round(silhouetteAgreement(grid, 'left', masks.left).iou) }
    writeFileSync(cache, JSON.stringify(out))
    return out
  } catch (err) {
    console.error(`bench:report: could not measure ${twin.run.id} against ${withRef.run.id}: ${(err as Error).message}`)
    return null
  }
}

const ownAgreement = (r: RunFile): Agreement | null => {
  const n = r.final?.numbers
  return n && n.silhouette_front_iou !== undefined && n.silhouette_left_iou !== undefined ? { front: n.silhouette_front_iou, left: n.silhouette_left_iou } : null
}

// ---------- pieces of the page ----------

function verdictCell(r: RunFile | undefined): string {
  if (!r) return '<span class="dim">not run</span>'
  if (r.status !== 'done') return '<span class="dim">running</span>'
  const j = r.judge
  if (!j) return '<span class="dim">not judged</span>'
  if (j.error) return '<span class="bad">judge failed</span>'
  return `<span class="${j.correct ? 'good' : 'bad'}">${j.correct ? '✓' : '✗'} ${esc(j.pick)}</span> <span class="dim">${j.confidence.toFixed(2)}</span>`
}

// What a person saw in a finished piece that the automated judge did not. Keyed by run id;
// shown on that run's card and quoted beside the gate.
const REVIEWER_NOTES: Record<string, string> = {
  'B-bust-opus-formed-ref-20261109124813-027': 'A reviewer found the face of the Opus reference bust cratered, yet the judge picked "bust" at 0.93.'
}

const allowance = (r: RunFile) => shown2(r.cost.unmeteredUsd) > 0 ? ` <span class="warn">+${usd(r.cost.unmeteredUsd)}†</span>` : ''
const costCell = (r: RunFile | undefined) => r ? `${usd(r.cost.totalUsd)}${allowance(r)}${r.cost.totalUsd >= GATE_USD ? ' <span class="bad">over</span>' : ''}` : '<span class="dim">–</span>'
const ALLOWANCE_NOTE = '<p class="dim">† An allowance for turns that timed out and were asked again. The provider bills the abandoned call but never reports its usage, so the bench adds the price of the run\'s dearest turn to the study ledger. It is an estimate, kept apart from the metered cost.</p>'
const turnsCell = (r: RunFile | undefined) => r?.result ? `${r.result.turns} <span class="dim">${esc(r.result.endReason)}</span>` : '<span class="dim">–</span>'

function referenceSummary(r: RunFile): string {
  const ref = r.reference
  return `<p class="tags"><span class="tag">${ref?.outlines ? 'outlines traced' : 'view only'}</span>${ref?.attempts?.length ? `<span class="tag">${ref.attempts.length} image${ref.attempts.length === 1 ? '' : 's'} drawn</span>` : ''}<span class="tag">cost ${usd(r.cost.referenceUsd)}</span>${ref?.heightSpread !== null && ref?.heightSpread !== undefined ? `<span class="tag">views agree ${num(ref.consistency ?? undefined)} of 1</span>` : ''}</p>`
}

// `besideReference`: the run's reference sheet has a card of its own right next to this one.
function card(l: Loaded | undefined, images: Images, placeholder: string, besideReference = false): string {
  if (!l) return `<article class="card empty"><p class="dim">${esc(placeholder)}</p></article>`
  const r = l.run
  const c = r.config
  const n = r.final?.numbers ?? {}
  const final = images.webp(l.dir, 'final.png', `${r.id}_final`)
  const round = images.webp(l.dir, 'final_round.png', `${r.id}_round`)
  const j = r.judge
  const agreement = ownAgreement(r)
  const facts: [string, string][] = [
    ['cost', `${usd(r.cost.totalUsd)}${r.cost.referenceUsd ? ` <span class="dim">(reference ${usd(r.cost.referenceUsd)})</span>` : ''}${shown2(r.cost.unmeteredUsd) > 0 ? ` <span class="warn">+${usd(r.cost.unmeteredUsd)} allowed for timed-out turns</span>` : ''}`],
    ['turns', r.result ? `${r.result.turns} of ${c.maxTurns}, ${r.result.passes} passes, ${r.result.strikes.toLocaleString('en-US')} strikes` : 'running'],
    ['ended', r.result ? `<span class="${r.result.endReason === 'finish' ? 'good' : 'warn'}">${esc(r.result.endReason)}</span>${r.result.error ? ` <span class="bad">${esc(r.result.error)}</span>` : ''}` : '–'],
    ['stone left', n.mass_kg !== undefined ? `${n.mass_kg} kg <span class="dim">(${num(n.removed_pct, 1)}% removed, ${num(n.bbox_y_max_cm, 0)} cm tall)</span>` : '–']
  ]
  if (agreement) facts.push(['silhouette', `front ${num(agreement.front)} · left ${num(agreement.left)} <span class="dim">IoU with the reference</span>`])
  if (n.form_proud_mean_cm !== undefined) facts.push(['proud of own form', `mean ${num(n.form_proud_mean_cm)} cm, max ${num(n.form_proud_max_cm, 1)} cm`])
  if (r.replay && !r.replay.ok) facts.push(['replay', '<span class="bad">the strike log does not reproduce this stone</span>'])
  const passes = r.state?.passes ?? []
  const note = REVIEWER_NOTES[r.id]
  // Any run that worked from a reference shows the sheet its silhouette numbers refer to.
  let sheet = ''
  if (c.ref && !besideReference) {
    const img = images.webp(l.dir, 'reference.png', `${r.id}_reference`)
    sheet = `<details><summary>the reference sheet this sculptor worked from</summary>${referenceSummary(r)}${img
      ? `<a href="${esc(img)}"><img src="${esc(img)}" alt="Reference sheet for ${esc(c.subject)}, ${esc(c.model)}" loading="lazy"></a>`
      : `<p class="bad">No sheet: ${esc(r.reference?.error ?? 'none was made')}; this run carved without one.</p>`}${r.reference?.brief ? `<p class="label">the sculptor's brief to the image model</p><p class="why">${esc(r.reference.brief)}</p>` : ''}</details>`
  }
  return `<article class="card">
  <header>
    <h3>${esc(c.subject)} <span class="dim">·</span> ${esc(c.model)} <span class="dim">·</span> ${esc(c.tools)} <span class="dim">·</span> ref ${c.ref ? 'on' : 'off'}</h3>
    <p class="tags"><span class="tag">round ${esc(c.round)}</span>${c.dry ? '<span class="tag dry">dry run</span>' : ''}${r.status !== 'done' ? '<span class="tag dry">unfinished</span>' : ''}${c.name ? `<span class="tag">${esc(c.name)}</span>` : ''}</p>
  </header>
  ${final ? `<a href="${esc(final)}"><img src="${esc(final)}" alt="Final contact sheet: ${esc(c.subject)}, ${esc(c.model)}" loading="lazy"></a>` : '<p class="dim">no contact sheet yet</p>'}
  ${round ? `<a href="${esc(round)}"><img src="${esc(round)}" alt="Three-quarter views" loading="lazy"></a>` : ''}
  <p class="verdict">${j
    ? j.error
      ? `<span class="bad">The judge failed: ${esc(j.error)}</span>`
      : `<span class="${j.correct ? 'good' : 'bad'}">${j.correct ? '✓ Judge: ' : '✗ Judge: '}${esc(j.pick)}</span> <span class="dim">confidence ${j.confidence.toFixed(2)}${j.correct ? '' : `; it is a ${esc(c.subjectLabel)}`}</span><br><span class="why">${esc(tidySentence(j.reasoning))}</span>`
    : '<span class="dim">Not judged.</span>'}</p>
  ${note ? `<p class="note"><strong>Reviewer:</strong> ${esc(note)}</p>` : ''}
  <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
  ${r.result?.finish ? `<blockquote><span class="label">the sculptor's own statement (the model's words about its piece, not a finding)</span><strong>${esc(r.result.finish.title)}</strong><br>${esc(r.result.finish.statement)}</blockquote>` : ''}
  ${sheet}
  <details><summary>${passes.length} passes</summary><ol class="passes">${passes.map(p => `<li value="${p.n}"><span class="tool">${esc(p.tool)}</span> <span class="dim">turn ${p.turn}, ${p.strikes} strikes</span><br>${p.why ? `<span class="why">“${esc(p.why)}”</span><br>` : ''}<span class="dim">${esc(p.summary)}</span></li>`).join('')}</ol></details>
  <p class="id dim">${esc(r.id)}</p>
</article>`
}

function referenceCard(l: Loaded | undefined, images: Images): string {
  if (!l) return '<article class="card empty"><p class="dim">Reference sheet: not run yet.</p></article>'
  const ref = l.run.reference
  const img = images.webp(l.dir, 'reference.png', `${l.run.id}_reference`)
  return `<article class="card">
  <header><h3>reference sheet</h3>${referenceSummary(l.run)}</header>
  ${img ? `<a href="${esc(img)}"><img src="${esc(img)}" alt="Reference sheet for ${esc(l.run.config.subject)}" loading="lazy"></a>` : `<p class="bad">No sheet: ${esc(ref?.error ?? 'none was made')}</p>`}
  ${ref?.brief ? `<details><summary>the sculptor's brief to the image model</summary><p class="why">${esc(ref.brief)}</p></details>` : ''}
</article>`
}

// A column is its header, or [header, label]: the label names the cell once the table is
// stacked for a narrow pane and the header row is gone. Each cell's content sits in one span,
// so that when stacked it stays together beside its label.
type Column = string | [string, string]

function table(head: Column[], rows: string[][], foot = '', cls = ''): string {
  const header = (c: Column) => typeof c === 'string' ? c : c[0]
  const label = (c: Column | undefined) => c === undefined ? '' : typeof c === 'string' ? c : c[1]
  return `<div class="scroll${cls ? ` ${cls}` : ''}"><table><thead><tr>${head.map(h => `<th>${esc(header(h))}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${esc(label(head[i]))}"><span>${c}</span></td>`).join('')}</tr>`).join('')}</tbody>${foot}</table></div>`
}

// ---------- the page ----------

function build(all: Loaded[], images: Images, studyDir: string): string {
  const shown = latestPerArm(all)
  const find = (round: string, subject: string, pred: (r: RunFile) => boolean = () => true) =>
    shown.find(l => l.run.config.round === round && l.run.config.subject === subject && pred(l.run))
  const inRound = (round: string) => shown.filter(l => l.run.config.round === round)
  const done = (l: Loaded | undefined): l is Loaded => !!l && l.run.status === 'done'
  const right = (ls: (Loaded | undefined)[]) => ls.filter(l => done(l) && l.run.judge?.correct).length
  const costs = (ls: (Loaded | undefined)[]) => ls.filter(done).map(l => shown2(l.run.cost.totalUsd))

  // --- gate ---
  const configs = new Map<string, { name: string, cat?: RunFile, bust?: RunFile }>()
  for (const l of shown) {
    const r = l.run
    if (r.status !== 'done' || (r.config.subject !== 'cat' && r.config.subject !== 'bust')) continue
    const entry = configs.get(configKey(r)) ?? { name: configName(r) }
    const had = entry[r.config.subject]
    // Where two rounds ran the same configuration, the newer run stands.
    if (!had || had.startedAt < r.startedAt) entry[r.config.subject] = r
    configs.set(configKey(r), entry)
  }
  type Config = { name: string, cat?: RunFile, bust?: RunFile }
  // Why one run keeps a configuration from passing; null when it does not.
  const fault = (subject: string, r: RunFile | undefined): string | null => {
    if (!r) return `no ${subject} run`
    if (!r.judge) return `${subject} not judged`
    if (r.judge.error) return `the judge failed on the ${subject}`
    if (!r.judge.correct) return `${subject} judged “${r.judge.pick}”`
    if (r.cost.totalUsd >= GATE_USD) return `${subject} cost ${usd(r.cost.totalUsd)}`
    return null
  }
  const faults = (c: Config) => [fault('cat', c.cat), fault('bust', c.bust)].filter((f): f is string => f !== null)
  const every = [...configs.values()]
  const complete = every.filter(c => c.cat && c.bust)
  const passing = complete.filter(c => faults(c).length === 0)
  // Every configuration is listed, passing or not, with what decided it.
  const line = (c: Config) => {
    const why = faults(c)
    const verdict = why.length === 0 ? '<span class="good">pass</span>' : c.cat && c.bust ? `<span class="bad">fail: ${esc(why.join('; '))}</span>` : `<span class="dim">incomplete: ${esc(why.filter(w => w.startsWith('no ')).join('; '))}</span>`
    return `<li><strong>${esc(c.name)}</strong>: ${verdict}<br><span class="dim">cat</span> ${verdictCell(c.cat)} ${costCell(c.cat)} <span class="dim">· bust</span> ${verdictCell(c.bust)} ${costCell(c.bust)}</li>`
  }
  const tally = `${passing.length} of ${complete.length} configuration${complete.length === 1 ? '' : 's'} with both a cat and a bust pass${passing.length === 1 ? 'es' : ''}`
  const gate = complete.length === 0
    ? `<p class="gate pending"><strong>Gate: not yet.</strong> No configuration has both a finished cat and a finished bust.</p>${every.length ? `<ul class="configs">${every.map(line).join('')}</ul>` : ''}`
    : `<p class="gate ${passing.length ? 'pass' : 'fail'}"><strong>Gate, the part code can check: ${passing.length ? 'PASS' : 'FAIL'}.</strong> It asks for one configuration where the judge picks correctly for both the cat and the bust, each under ${usd(GATE_USD)}. ${tally}:</p><ul class="configs">${every.map(line).join('')}</ul>`
  const noted = shown.filter(l => REVIEWER_NOTES[l.run.id])
  const caveat = `<div class="caveat"><strong>What the judge can't tell you.</strong> The automated judge is lenient. It sees shape only and must pick the nearest of twelve labels, so "correct" means the piece was not mistaken for one of the other eleven, and nothing more. Its pick is a floor, not a verdict on whether the piece is good.${noted.map(l => ` Example: ${esc(REVIEWER_NOTES[l.run.id])} <span class="dim">(${esc(l.run.id)})</span>`).join('')}</div>`
  const anyDry = shown.some(l => l.run.config.dry)

  // --- direct vs formed ---
  const a = (subject: SubjectId, tools: string) => find('A', subject, r => r.config.tools === tools)
  const aRows = SUBJECT_IDS.map((s) => {
    const d = a(s, 'direct')?.run
    const f = a(s, 'formed')?.run
    return [esc(s), verdictCell(d), costCell(d), turnsCell(d), verdictCell(f), costCell(f), turnsCell(f)]
  })
  const direct = SUBJECT_IDS.map(s => a(s, 'direct'))
  const formed = SUBJECT_IDS.map(s => a(s, 'formed'))
  const aSays = inRound('A').some(done)
    ? `<p>Judge correct: direct <strong>${right(direct)} of ${direct.filter(done).length}</strong>, formed <strong>${right(formed)} of ${formed.filter(done).length}</strong>. Mean cost: direct ${usd(mean(costs(direct)) || 0)}, formed ${usd(mean(costs(formed)) || 0)}.</p>`
    : '<p class="dim">Round A has not been run.</p>'

  // --- reference ---
  const pairs = SUBJECT_IDS.map((s) => {
    const b = find('B', s)
    const twin = b ? find('A', s, r => r.config.tools === b.run.config.tools && r.config.model === b.run.config.model) : undefined
    return { subject: s, b, twin, twinFit: done(b) && done(twin) ? twinAgreement(twin, b) : null }
  })
  const fit = (g: Agreement | null) => g ? `${num(g.front)} / ${num(g.left)}` : '<span class="dim">–</span>'
  const bRows = pairs.map(({ subject, b, twin, twinFit }) => {
    // From the two figures as printed, so the row subtracts to what it shows.
    const diff = done(b) && done(twin) ? shown2(shown2(b.run.cost.totalUsd) - shown2(twin.run.cost.totalUsd)) : NaN
    return [esc(subject), verdictCell(twin?.run), fit(twinFit), costCell(twin?.run), verdictCell(b?.run), fit(b ? ownAgreement(b.run) : null), costCell(b?.run), Number.isNaN(diff) ? '<span class="dim">–</span>' : `${diff >= 0 ? '+' : '−'}${usd(Math.abs(diff))}`]
  })
  const both = pairs.filter(p => done(p.b) && done(p.twin))
  const bSays = both.length
    ? `<p>Across ${both.length} subject${both.length === 1 ? '' : 's'} run both ways: judge correct <strong>${right(both.map(p => p.b))} with</strong> the reference, <strong>${right(both.map(p => p.twin))} without</strong>. Mean silhouette agreement (front and left IoU) ${num(mean(both.flatMap(p => (ownAgreement(p.b!.run) ? [ownAgreement(p.b!.run)!.front, ownAgreement(p.b!.run)!.left] : []))))} with, ${num(mean(both.flatMap(p => p.twinFit ? [p.twinFit.front, p.twinFit.left] : [])))} without. Mean cost ${usd(mean(costs(both.map(p => p.b))))} with, ${usd(mean(costs(both.map(p => p.twin))))} without.</p>`
    : '<p class="dim">Round B has not been run (or its Round A twins are missing).</p>'

  // --- models ---
  const cRuns = inRound('C')
  const cConfig = cRuns[0]?.run.config
  // Opus's runs in the same configuration, from the earlier rounds, as the baseline row.
  const baseline = (s: string) => cConfig ? shown.find(l => l.run.config.round !== 'C' && l.run.config.subject === s && l.run.config.model === 'opus' && l.run.config.tools === cConfig.tools && l.run.config.ref === cConfig.ref) : undefined
  const models = cConfig ? ['opus', ...new Set(cRuns.map(l => l.run.config.model))] : []
  const cRows = models.map((m) => {
    const get = (s: string) => m === 'opus' ? baseline(s)?.run : find('C', s, r => r.config.model === m)?.run
    return [esc(m) + (m === 'opus' ? ' <span class="dim">(earlier round)</span>' : ''), verdictCell(get('cat')), costCell(get('cat')), turnsCell(get('cat')), verdictCell(get('bust')), costCell(get('bust')), turnsCell(get('bust'))]
  })

  const metered = shown2(all.reduce((nn, l) => nn + shown2(l.run.cost.totalUsd), 0))
  const allowed = shown2(all.reduce((nn, l) => nn + shown2(l.run.cost.unmeteredUsd), 0))
  const total = shown2(metered + allowed)
  const spent = allowed > 0 ? `${usd(total)} counted against the study cap: ${usd(metered)} metered plus a ${usd(allowed)} allowance for timed-out turns†` : `${usd(total)} spent in all`
  const anyAllowance = shown.some(l => shown2(l.run.cost.unmeteredUsd) > 0)
  const other = shown.filter(l => !['A', 'B', 'C'].includes(l.run.config.round))

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sculptor study</title>
<style>
  :root { color-scheme: dark; --bg: #0f1115; --panel: #171a21; --line: #272c36; --text: #e6e9ef; --dim: #8b93a3; --good: #6fd08c; --bad: #f0776c; --warn: #e8b85a; --accent: #7fb4ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1500px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 40px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 0; }
  p { margin: 8px 0; }
  a { color: var(--accent); }
  .dim { color: var(--dim); }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .warn { color: var(--warn); }
  .gate { padding: 12px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); }
  .gate.pass { border-color: var(--good); }
  .gate.fail { border-color: var(--bad); }
  .gate.pending { border-color: var(--warn); }
  .banner { padding: 10px 14px; border-radius: 8px; border: 1px dashed var(--warn); color: var(--warn); }
  /* A table wider than its box scrolls sideways; a blue edge shows on the side that hides more. */
  .scroll { overflow-x: auto; background: linear-gradient(to right, var(--bg) 30%, transparent) left / 36px 100% no-repeat local, linear-gradient(to left, var(--bg) 30%, transparent) right / 36px 100% no-repeat local, linear-gradient(to right, rgba(127, 180, 255, 0.45), transparent) left / 12px 100% no-repeat scroll, linear-gradient(to left, rgba(127, 180, 255, 0.45), transparent) right / 12px 100% no-repeat scroll; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; white-space: nowrap; }
  td:first-child { white-space: nowrap; }
  /* Run ids are long; they may break so the table's last columns stay in view. */
  .ids td:first-child { white-space: normal; overflow-wrap: anywhere; min-width: 11em; }
  tfoot td { border-bottom: 0; font-weight: 600; }
  /* Narrow pane: no header row; every row becomes a block of "label  value" lines. */
  @media (max-width: 700px) {
    .scroll { background: none; }
    table, tbody, tfoot, tr, td { display: block; }
    thead { display: none; }
    tr { padding: 8px 0; border-bottom: 1px solid var(--line); }
    td { display: grid; grid-template-columns: 9em minmax(0, 1fr); gap: 0 10px; padding: 1px 0; border: 0; overflow-wrap: anywhere; }
    td::before { content: attr(data-label); color: var(--dim); }
    td:first-child { white-space: normal; font-weight: 600; }
    td:first-child::before { font-weight: 400; }
    td:empty { display: none; }
  }
  .configs { padding-left: 20px; }
  .configs li { margin: 6px 0; }
  .caveat { margin: 12px 0; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--warn); background: var(--panel); }
  .note { margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--warn); color: var(--warn); font-size: 14px; }
  .label { display: block; margin: 0 0 4px; font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--dim); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin: 12px 0; align-items: start; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; min-width: 0; }
  .card.empty { display: grid; place-items: center; min-height: 120px; border-style: dashed; }
  .card img { display: block; width: 100%; height: auto; border-radius: 6px; margin: 8px 0; background: #0b0d10; }
  .tags { margin: 4px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { font-size: 12px; color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
  .tag.dry { color: var(--warn); border-color: var(--warn); }
  .verdict { font-size: 15px; }
  .why { font-style: italic; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0; font-size: 14px; }
  dt { color: var(--dim); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  blockquote { margin: 10px 0; padding: 8px 12px; border-left: 3px solid var(--line); color: var(--text); }
  details { margin-top: 8px; font-size: 14px; }
  summary { cursor: pointer; color: var(--accent); }
  .passes { padding-left: 28px; }
  .passes li { margin: 6px 0; overflow-wrap: anywhere; }
  .tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .id { font-size: 11px; margin: 8px 0 0; overflow-wrap: anywhere; }
  .pair { border: 1px solid var(--line); border-radius: 12px; padding: 4px 12px 0; margin: 14px 0; }
  .pair > h3 { margin: 10px 0 0; }
</style>
</head>
<body>
<main>
<h1>Can a model carve? The Sprint 2 study</h1>
<p class="dim">${all.length} run${all.length === 1 ? '' : 's'} in ${esc(relative(process.cwd(), studyDir).startsWith('..') ? studyDir : relative(process.cwd(), studyDir) || '.')}, ${spent}. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC on kernel ${KERNEL_VERSION}. Each arm shows its newest finished run.</p>
${anyDry ? '<p class="banner">Some of these are dry runs: a scripted Brain, a reference drawn by code, a scripted judge and pretend prices. They prove the bench, not the sculptor.</p>' : ''}

${gate}
${caveat}
<p><strong>Still for Kyle to judge:</strong> does the bust read as a head and shoulders to a person? The judge's pick and the numbers cannot settle that. Then lock the tool set, the default model, and whether the reference is on by default.</p>

<h2>Direct or formed tools? <span class="dim">Round A: Opus 5.5, no reference</span></h2>
${aSays}
${table(['subject', ['direct: judge', 'direct: judge'], ['cost', 'direct: cost'], ['turns', 'direct: turns'], ['formed: judge', 'formed: judge'], ['cost', 'formed: cost'], ['turns', 'formed: turns']], aRows)}

<h2>Does the reference sheet help? <span class="dim">Round B against its Round A twins</span></h2>
${bSays}
${table(['subject', ['without: judge', 'without: judge'], ['IoU front / left', 'without: IoU front / left'], ['cost', 'without: cost'], ['with: judge', 'with: judge'], ['IoU front / left', 'with: IoU front / left'], ['cost', 'with: cost'], ['cost difference', 'cost difference']], bRows)}
<p class="dim">IoU is the overlap of the stone's silhouette with the reference outline, 1 being identical. The "without" stone is measured against the outlines its twin was given, which its own sculptor never saw, so read it as a baseline, not a score.</p>

<h2>Which model? <span class="dim">Round C: cat and bust${cConfig ? `, ${esc(cConfig.tools)} tools, reference ${cConfig.ref ? 'on' : 'off'}` : ''}</span></h2>
${cRows.length ? `<p>Each run had its own reference sheet drawn from its own sculptor's brief, so this comparison reflects differences between the sheets as well as between the models. Each card below shows the sheet that run worked from.</p>${table(['model', ['cat: judge', 'cat: judge'], ['cost', 'cat: cost'], ['turns', 'cat: turns'], ['bust: judge', 'bust: judge'], ['cost', 'bust: cost'], ['turns', 'bust: turns']], cRows)}${cRuns.some(l => shown2(l.run.cost.unmeteredUsd) > 0) ? ALLOWANCE_NOTE : ''}` : '<p class="dim">Round C has not been run.</p>'}

<h2>Round A: tool sets side by side</h2>
${SUBJECT_IDS.map(s => `<div class="pair"><h3>${esc(s)}</h3><div class="cards">${card(a(s, 'direct'), images, `${s}, direct tools: not run yet`)}${card(a(s, 'formed'), images, `${s}, formed tools: not run yet`)}</div></div>`).join('\n')}

<h2>Round B: with the reference, beside the twin without</h2>
${pairs.map(p => `<div class="pair"><h3>${esc(p.subject)}</h3><div class="cards">${card(p.twin, images, `${p.subject}, no reference: no Round A twin`)}${card(p.b, images, `${p.subject}, with reference: not run yet`, true)}${referenceCard(p.b, images)}</div></div>`).join('\n')}

<h2>Round C: models</h2>
${cRuns.length ? '<p class="dim">Every run here drew its own reference sheet; open "the reference sheet this sculptor worked from" on a card to see it.</p>' : ''}
${cRuns.length ? ['cat', 'bust'].map(s => `<div class="pair"><h3>${s}</h3><div class="cards">${cRuns.filter(l => l.run.config.subject === s).map(l => card(l, images, '')).join('')}</div></div>`).join('\n') : '<p class="dim">Not run yet.</p>'}

${other.length ? `<h2>Other runs</h2><div class="cards">${other.map(l => card(l, images, '')).join('')}</div>` : ''}

<h2>Every run</h2>
${table(['run', 'status', 'ended', 'turns', 'cost', ['allowance†', 'allowance†'], 'judge', 'replay'], all.map(l => [
  `<span class="dim">${esc(l.run.id)}</span>`,
  esc(l.run.status),
  esc(l.run.result?.endReason ?? '–'),
  String(l.run.result?.turns ?? '–'),
  usd(l.run.cost.totalUsd),
  shown2(l.run.cost.unmeteredUsd) > 0 ? `<span class="warn">+${usd(l.run.cost.unmeteredUsd)}</span>` : '<span class="dim">–</span>',
  verdictCell(l.run),
  l.run.replay ? (l.run.replay.ok ? '<span class="good">matches</span>' : '<span class="bad">differs</span>') : '<span class="dim">–</span>'
]), all.length ? `<tfoot><tr><td data-label="total"><span>Total ${usd(total)}</span></td><td></td><td></td><td></td><td data-label="metered"><span>${usd(metered)}</span></td><td data-label="allowance†"><span>${allowed > 0 ? `+${usd(allowed)}` : '–'}</span></td><td></td><td></td></tr></tfoot>` : '', 'ids')}
<p class="dim">The cost column sums to ${usd(metered)}${allowed > 0 ? `; with the ${usd(allowed)} allowance that is the ${usd(total)} in the header` : ', the figure in the header'}.</p>
${anyAllowance || allowed > 0 ? ALLOWANCE_NOTE : ''}
</main>
</body>
</html>
`
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const studyDir = resolve(args.str('dir', '.data/study')!)
  const out = resolve(args.str('out', 'internal_docs/20261108_ai_sculptor/study')!)
  const stray = args.unknown()
  if (stray.length) throw new Error(`unknown flag${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}`)
  mkdirSync(out, { recursive: true })
  const all = loadRuns(studyDir)
  const images = new Images(out)
  writeFileSync(join(out, 'report.html'), build(all, images, studyDir))
  images.sweep()
  console.log(`bench:report: ${all.length} run${all.length === 1 ? '' : 's'} from ${studyDir} → ${join(out, 'report.html')} (${images.used.size} images)`)
}

try {
  main()
} catch (err) {
  console.error(`bench:report: ${(err as Error).message}`)
  process.exit(2)
}
