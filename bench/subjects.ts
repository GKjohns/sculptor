// The study's three subjects, worded the way a person would type a commission, and the fixed
// list of twelve labels the judge chooses from: the subjects plus nine things a carved lump is
// plausibly mistaken for.

export type SubjectId = 'pawn' | 'cat' | 'bust'

export interface Subject {
  id: SubjectId
  // What the judge has to pick for the run to count as recognised.
  label: string
  commission: string
}

export const SUBJECTS: Record<SubjectId, Subject> = {
  pawn: {
    id: 'pawn',
    label: 'chess pawn',
    commission: 'A chess pawn, as tall as the block allows: a round head on a collar, a body that flares down to a wide stepped base.'
  },
  cat: {
    id: 'cat',
    label: 'cat lying down',
    commission: 'A cat in a loaf: lying upright with its paws tucked under its chest, head up and facing forward, ears pricked, tail wrapped along its side.'
  },
  bust: {
    id: 'bust',
    label: 'human head and shoulders (bust)',
    commission: 'A portrait bust of a person: head, neck and shoulders, facing forward, on a plain base.'
  }
}

export const SUBJECT_IDS = Object.keys(SUBJECTS) as SubjectId[]

// Distractors are compact, base-standing shapes of the kind these three fail into: a pawn that
// lost its collar is a bowling pin or a bottle, a cat with no ears is an egg or a sitting dog,
// a bust with no features is a mushroom or a vase.
export const JUDGE_LABELS: string[] = [
  SUBJECTS.pawn.label,
  SUBJECTS.cat.label,
  SUBJECTS.bust.label,
  'egg',
  'bowling pin',
  'bottle',
  'owl',
  'mushroom',
  'vase',
  'human foot',
  'sitting dog',
  'rabbit'
]

// A judge model now and then lets a piece of its JSON wrapper slip inside the string it is
// writing ("...or bust.}"). The answer still parses, so the stray bracket or quote arrives as
// part of the sentence. Closers with no opener to match are dropped from the end.
export function tidySentence(text: string): string {
  let out = text.trim()
  const count = (ch: string) => out.split(ch).length - 1
  for (;;) {
    const last = out[out.length - 1]
    const stray = (last === '}' && count('}') > count('{'))
      || (last === ']' && count(']') > count('['))
      || (last === '"' && count('"') % 2 === 1)
    if (!stray) return out
    out = out.slice(0, -1).trimEnd()
  }
}
