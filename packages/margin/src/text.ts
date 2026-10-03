/**
 * The first `count` characters of `text`, counted in code points, so a
 * character stored as two UTF-16 units is never split. A split leaves a lone
 * surrogate that an anchor's offsets cannot land on, which orphans it.
 */
export function prefixByCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('')
}
