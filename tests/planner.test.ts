/**
 * The planner split: the planner takes the opening turns, its reasoning is stripped before the
 * executor sees the conversation, and the executor takes every turn after.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PLAN_TURNS, plannedBrain } from '../shared/agent/planner.ts'
import type { Brain, BrainTurn, Message } from '../shared/agent/types.ts'

const usage = { input: 1, output: 1 }
function fake(name: string, log: string[]): Brain {
  return {
    async turn(input, onText): Promise<BrainTurn> {
      log.push(`${name}:${input.messages.length}`)
      onText(name)
      const append: Message[] = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: name }] }]
      return { calls: [{ id: `${name}-${log.length}`, name: 'note', args: {} }], append, usage, costUsd: 0.01 }
    }
  }
}

test('the planner takes the first turns and the executor the rest; planner reasoning does not travel', async () => {
  const log: string[] = []
  const brain = plannedBrain({ planner: fake('p', log), executor: fake('e', log) })
  assert.equal(brain.planTurns, DEFAULT_PLAN_TURNS)
  const said: string[] = []
  const messages: Message[] = []
  for (let i = 0; i < 5; i++) {
    const r = await brain.turn({ instructions: '', messages }, t => said.push(t))
    messages.push(...r.append)
  }
  assert.deepEqual(log, ['p:0', 'p:1', 'p:2', 'e:3', 'e:4'])
  assert.deepEqual(said, ['p', 'p', 'p', 'e', 'e'])
  assert.deepEqual(brain.turnsTaken(), { planner: 3, executor: 2 })
  // The planner's three messages carry no reasoning; the executor's do.
  const parts = messages.map(m => typeof m.content === 'string' ? [] : m.content.map(p => p.type))
  assert.deepEqual(parts.slice(0, 3), [['text'], ['text'], ['text']])
  assert.deepEqual(parts[3], ['reasoning', 'text'])
})

test('planTurns 0 is the executor alone', async () => {
  const log: string[] = []
  const brain = plannedBrain({ planner: fake('p', log), executor: fake('e', log), planTurns: 0 })
  await brain.turn({ instructions: '', messages: [] }, () => {})
  assert.deepEqual(log, ['e:0'])
})
