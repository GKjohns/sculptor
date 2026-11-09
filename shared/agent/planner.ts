// A planner split: one model takes the opening turns, where the piece is designed (the plan,
// the sketch, the form and the first rough-out), and another carves the rest. The planner's
// messages stay in the conversation for the executor to read, minus any reasoning parts, which
// a provider only accepts back from the model that wrote them.

import type { Brain, BrainTurn, Message } from './types.ts'

export interface PlannedBrainOptions {
  planner: Brain
  executor: Brain
  // How many turns from the start the planner takes. The default covers the opening look, the
  // plan with its form, and the first rough-out.
  planTurns?: number
}

export const DEFAULT_PLAN_TURNS = 3

function withoutReasoning(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return m
    const content = m.content.filter(part => part.type !== 'reasoning')
    return content.length === m.content.length ? m : { ...m, content }
  })
}

export function plannedBrain(opts: PlannedBrainOptions): Brain & { planTurns: number, turnsTaken: () => { planner: number, executor: number } } {
  const planTurns = Math.max(0, opts.planTurns ?? DEFAULT_PLAN_TURNS)
  let planner = 0
  let executor = 0
  return {
    planTurns,
    turnsTaken: () => ({ planner, executor }),
    async turn(input, onText): Promise<BrainTurn> {
      if (planner < planTurns) {
        planner++
        const r = await opts.planner.turn(input, onText)
        return { ...r, append: withoutReasoning(r.append) }
      }
      executor++
      return opts.executor.turn(input, onText)
    }
  }
}
