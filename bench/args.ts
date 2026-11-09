// Flag parsing shared by the bench's commands: --key value, --key=value and bare --switches.

export interface Args {
  has: (key: string) => boolean
  str: (key: string, fallback?: string) => string | undefined
  num: (key: string, fallback: number) => number
  oneOf: <T extends string>(key: string, allowed: readonly T[], fallback: T) => T
  // Flags that were given but that nothing asked about: almost always a typo.
  unknown: () => string[]
}

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"; flags look like --subject pawn`)
    const eq = a.indexOf('=')
    if (eq > 0) {
      values.set(a.slice(2, eq), a.slice(eq + 1))
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
      values.set(a.slice(2), argv[++i]!)
    } else {
      values.set(a.slice(2), true)
    }
  }
  const seen = new Set<string>()
  const get = (key: string) => {
    seen.add(key)
    return values.get(key)
  }
  return {
    has: key => get(key) !== undefined,
    str: (key, fallback) => {
      const v = get(key)
      if (v === true) throw new Error(`--${key} needs a value`)
      return v ?? fallback
    },
    num: (key, fallback) => {
      const v = get(key)
      if (v === undefined) return fallback
      const n = Number(v)
      if (v === true || !Number.isFinite(n)) throw new Error(`--${key} needs a number`)
      return n
    },
    oneOf: (key, allowed, fallback) => {
      const v = get(key)
      if (v === undefined) return fallback
      if (v === true || !(allowed as readonly string[]).includes(v)) throw new Error(`--${key} must be one of ${allowed.join(', ')}`)
      return v as typeof allowed[number]
    },
    unknown: () => [...values.keys()].filter(k => !seen.has(k)).map(k => `--${k}`)
  }
}
