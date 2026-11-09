// What the model is shown. The history is append-only between rebuilds, so the provider's
// cached prefix stays valid; a rebuild throws the history away and starts again from one user
// message made of the commission, the reference sheet, the notebook, the pass record and a
// fresh look. A resume after a reload is the same rebuild.

import { describeCall } from './toolSchemas.ts'
import type { BudgetLevel, Commission, Message, Notebook, PassRecord, PassTool, RunConfig, RunState } from './types.ts'

type UserMessage = Extract<Message, { role: 'user' }>
type UserPart = Exclude<UserMessage['content'], string>[number]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Hand-rolled because Buffer is Node-only and btoa wants a binary string.
export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  let s = ''
  const whole = bytes.length - bytes.length % 3
  for (let i = 0; i < whole; i += 3) {
    const t = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    s += B64[t >> 18]! + B64[(t >> 12) & 63]! + B64[(t >> 6) & 63]! + B64[t & 63]!
    if (s.length >= 8192) {
      chunks.push(s)
      s = ''
    }
  }
  const rest = bytes.length - whole
  if (rest === 1) {
    const t = bytes[whole]! << 16
    s += B64[t >> 18]! + B64[(t >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const t = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8)
    s += B64[t >> 18]! + B64[(t >> 12) & 63]! + B64[(t >> 6) & 63]! + '='
  }
  chunks.push(s)
  return chunks.join('')
}

// A Studio may hand over WebP or JPEG instead of PNG (a 1,200 px contact sheet is about 500 kB
// as PNG and under 100 kB as WebP, and every look is uploaded again on every turn). Providers
// check the bytes against the declared type, so the type is read from the bytes.
export function imageMediaType(base64: string): string {
  if (base64.startsWith('UklGR')) return 'image/webp'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  return 'image/png'
}

// Images travel as base64 so a context can be posted to /api/brain as JSON.
export function imagePart(base64: string): UserPart {
  return { type: 'file', mediaType: imageMediaType(base64), data: { type: 'data', data: base64 } }
}

const text = (t: string): UserPart => ({ type: 'text', text: t })

export function formatNumbers(numbers: Record<string, number> | undefined): string {
  if (!numbers) return ''
  const parts = Object.entries(numbers).map(([k, v]) => `${k} ${Math.round(v * 100) / 100}`)
  return parts.length ? `Numbers: ${parts.join(', ')}.` : ''
}

const usd = (v: number) => `$${v.toFixed(2)}`

// Appended to the last result of every turn, so the model always knows where it stands.
export function budgetStatus(state: RunState, config: RunConfig): string {
  return `[${state.turns} of ${config.maxTurns} turns used, ${usd(state.costUsd)} of ${usd(config.maxUsd)} spent]`
}

export function budgetWarning(level: BudgetLevel, state: RunState, config: RunConfig): string {
  const left = config.maxTurns - state.turns
  const where = `${state.turns} of ${config.maxTurns} turns used and ${usd(state.costUsd)} of ${usd(config.maxUsd)} spent`
  switch (level) {
    case 'ok': return ''
    case 'warn75': return `BUDGET WARNING: three quarters of your budget is gone (${where}). Bring the piece toward a finish: complete the stage you are in, drop anything you cannot bring to a clean end, and keep enough turns back to refine and to call finish.`
    case 'warn90': return `BUDGET WARNING: nine tenths of your budget is gone (${where}${left > 0 ? `; at most ${left} turns left` : ''}). Open no new work. Tidy what is there, take one last look if you need it, and call finish.`
    case 'last': return `FINAL TURN: your budget is spent after this reply (${where}). Call finish now, with a title and a statement. Anything else you send will be the last cut, and the piece will end without a title.`
  }
}

export const NUDGE_NO_CALL = 'That reply called no tool, so nothing happened and a turn was spent. Every reply must call a tool: look to see the stone, a carving tool to work it, note to record your plan, or finish to end the commission.'

export function lookReminder(passes: number): string {
  return `You have made ${passes} passes since you last looked. Look before you cut again.`
}

export function passLine(n: number, turn: number, tool: PassTool, args: Record<string, unknown>, summary: string, strikes: number): string {
  const why = typeof args.why === 'string' ? ` — "${args.why}"` : ''
  const did = summary.length > 160 ? `${summary.slice(0, 157)}...` : summary
  return `${n}. turn ${turn}: ${describeCall(tool, args)}${why} → ${did} (${strikes} strikes)`
}

function notebookText(nb: Notebook): string {
  if (!nb.text) return 'NOTEBOOK\nEmpty. Write your plan with note before the first cut.'
  return `NOTEBOOK (written on turn ${nb.turn})\nStage: ${nb.stage}\n${nb.text}`
}

function recordText(passes: PassRecord[]): string {
  if (!passes.length) return 'PASSES SO FAR\nNone. The block is untouched.'
  return `PASSES SO FAR (${passes.length})\n${passes.map(p => p.line).join('\n')}`
}

// The parts that never change during a commission. They open every rebuilt context, byte for
// byte, so the instructions and these stay inside the cached prefix across rebuilds too.
export function headParts(commission: Commission, referenceB64: string | null): UserPart[] {
  const parts: UserPart[] = [text(`COMMISSION\n${commission.prompt}`)]
  if (referenceB64) parts.push(text('REFERENCE SHEET (top left front, top right left, bottom left back, bottom right right)'), imagePart(referenceB64))
  return parts
}

export interface ContextInput {
  commission: Commission
  referenceB64: string | null
  state: RunState
  config: RunConfig
  level: BudgetLevel
  // The fresh look taken for this rebuild; images already base64.
  look: { summary: string, numbers?: Record<string, number>, images: string[] }
  reason: 'start' | 'resume' | 'interval'
}

// One user message: commission, reference sheet, notebook, pass record, budget, fresh look.
export function buildContext(c: ContextInput): Message[] {
  const warning = budgetWarning(c.level, c.state, c.config)
  const body = [
    notebookText(c.state.notebook),
    recordText(c.state.passes),
    `BUDGET\n${budgetStatus(c.state, c.config)}${warning ? `\n${warning}` : ''}`,
    `THE STONE NOW\n${[c.look.summary, formatNumbers(c.look.numbers)].filter(Boolean).join('\n')}`
  ].join('\n\n')
  const closing = c.reason === 'start'
    ? 'Begin. Plan the piece, write the plan with note, then start roughing out.'
    : 'Your earlier messages have been cleared. The notebook and the pass record above are what you know of the work so far; the image is the stone as it stands. Carry on from where the notebook leaves off.'
  return [{
    role: 'user',
    content: [...headParts(c.commission, c.referenceB64), text(body), ...c.look.images.map(imagePart), text(closing)]
  }]
}

export interface CallResult {
  id: string
  name: string
  ok: boolean
  // Everything the model reads about this call: summary, numbers, or the error.
  text: string
}

export interface LookSheet {
  id: string
  label: string
  images: string[]
}

// The messages that answer one turn's calls: the results, then (as a user message, because not
// every provider accepts images inside a tool result) the contact sheets and any notices.
export function resultMessages(results: CallResult[], sheets: LookSheet[], notices: string[], mode: RunConfig['toolResults']): Message[] {
  const out: Message[] = []
  const parts: UserPart[] = []
  if (results.length && mode === 'native') {
    out.push({
      role: 'tool',
      content: results.map(r => ({
        type: 'tool-result' as const,
        toolCallId: r.id,
        toolName: r.name,
        output: { type: r.ok ? 'text' as const : 'error-text' as const, value: r.text }
      }))
    })
  } else if (results.length) {
    parts.push(text(`RESULTS\n${results.map(r => `${r.name}${r.ok ? '' : ' (ERROR)'}: ${r.text}`).join('\n')}`))
  }
  for (const s of sheets) parts.push(text(s.label), ...s.images.map(imagePart))
  if (notices.length) parts.push(text(notices.join('\n\n')))
  if (parts.length) out.push({ role: 'user', content: parts })
  return out
}
