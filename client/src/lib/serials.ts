/**
 * Parses serial lists such as "1-20, 25, 30-32" into sorted unique numbers.
 * Throws a readable error for bad input.
 */
export function parseSerialList(input: string, max: number, limit = 500): number[] {
  const out = new Set<number>()
  const parts = input
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('Enter at least one serial number, e.g. 1-20, 25')

  for (const part of parts) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (a < 1 || b < a) throw new Error(`Bad range "${part}"`)
      if (b > max) throw new Error(`Serial ${b} is outside this batch (1-${max})`)
      if (b - a + 1 + out.size > limit) throw new Error(`At most ${limit} serials per transaction`)
      for (let n = a; n <= b; n++) out.add(n)
    } else if (/^\d+$/.test(part)) {
      const n = Number(part)
      if (n < 1 || n > max) throw new Error(`Serial ${n} is outside this batch (1-${max})`)
      out.add(n)
    } else {
      throw new Error(`"${part}" is not a serial number or range`)
    }
    if (out.size > limit) throw new Error(`At most ${limit} serials per transaction`)
  }
  return [...out].sort((x, y) => x - y)
}
