export type Ember = {
  x: number
  y: number
  radius: number
  speed: number
  drift: number
  life: number
  phase: number
}

export function normalizeFragment(value: string) {
  const fragment = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  return fragment ? fragment.slice(0, 240) : 'silence'
}

function hashFragment(fragment: string) {
  let hash = 2166136261
  for (const character of fragment) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: number) {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967295
  }
}

export function createEmberField(fragment: string, count = 72): Ember[] {
  const random = seededRandom(hashFragment(normalizeFragment(fragment)))

  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    radius: 0.8 + random() * 2.4,
    speed: 0.2 + random() * 1.2,
    drift: (random() - 0.5) * 0.8,
    life: 0.45 + random() * 0.55,
    phase: random() * Math.PI * 2,
  }))
}
