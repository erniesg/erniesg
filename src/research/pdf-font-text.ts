// Computer Modern's cmex10 font uses TeX character slots rather than Unicode.
// Some PDFs omit a usable ToUnicode map, so PDF.js exposes those slot values as
// C0 controls or misleading ASCII. Decode the fixed cmex10 encoding before the
// text enters reading-order, semantic, or EPUB reconstruction.
const CMEX10_UNICODE_BY_SLOT = new Map<number, string>([
  [0x00, '('],
  [0x01, ')'],
  [0x02, '['],
  [0x03, ']'],
  [0x04, '⌊'],
  [0x05, '⌋'],
  [0x06, '⌈'],
  [0x07, '⌉'],
  [0x08, '{'],
  [0x09, '}'],
  [0x0a, '⟨'],
  [0x0b, '⟩'],
  [0x0c, '∣'],
  [0x0d, '∥'],
  [0x0e, '/'],
  [0x0f, '\\'],
  [0x10, '('],
  [0x11, ')'],
  [0x12, '('],
  [0x13, ')'],
  [0x14, '['],
  [0x15, ']'],
  [0x16, '⌊'],
  [0x17, '⌋'],
  [0x18, '⌈'],
  [0x19, '⌉'],
  [0x1a, '{'],
  [0x1b, '}'],
  [0x1c, '⟨'],
  [0x1d, '⟩'],
  [0x1e, '/'],
  [0x1f, '\\'],
  [0x20, '('],
  [0x21, ')'],
  [0x22, '['],
  [0x23, ']'],
  [0x24, '⌊'],
  [0x25, '⌋'],
  [0x26, '⌈'],
  [0x27, '⌉'],
  [0x28, '{'],
  [0x29, '}'],
  [0x2a, '⟨'],
  [0x2b, '⟩'],
  [0x2c, '/'],
  [0x2d, '\\'],
  [0x2e, '/'],
  [0x2f, '\\'],
  [0x30, '⎛'],
  [0x31, '⎞'],
  [0x32, '⎡'],
  [0x33, '⎤'],
  [0x34, '⎣'],
  [0x35, '⎦'],
  [0x36, '⎢'],
  [0x37, '⎥'],
  [0x38, '⎧'],
  [0x39, '⎫'],
  [0x3a, '⎩'],
  [0x3b, '⎭'],
  [0x3c, '⎨'],
  [0x3d, '⎬'],
  [0x3e, '⎪'],
  [0x3f, '⏐'],
  [0x40, '⎝'],
  [0x41, '⎠'],
  [0x42, '⎜'],
  [0x43, '⎟'],
  [0x44, '⟨'],
  [0x45, '⟩'],
  [0x46, '⨆'],
  [0x47, '⨆'],
  [0x48, '∮'],
  [0x49, '∮'],
  [0x4a, '⨀'],
  [0x4b, '⨀'],
  [0x4c, '⨁'],
  [0x4d, '⨁'],
  [0x4e, '⨂'],
  [0x4f, '⨂'],
  [0x50, '∑'],
  [0x51, '∏'],
  [0x52, '∫'],
  [0x53, '⋃'],
  [0x54, '⋂'],
  [0x55, '⨄'],
  [0x56, '⋀'],
  [0x57, '⋁'],
  [0x58, '∑'],
  [0x59, '∏'],
  [0x5a, '∫'],
  [0x5b, '⋃'],
  [0x5c, '⋂'],
  [0x5d, '⨄'],
  [0x5e, '⋀'],
  [0x5f, '⋁'],
  [0x60, '∐'],
  [0x61, '∐'],
  [0x62, '\u0302'],
  [0x63, '\u0302'],
  [0x64, '\u0302'],
  [0x65, '\u0303'],
  [0x66, '\u0303'],
  [0x67, '\u0303'],
  [0x68, '['],
  [0x69, ']'],
  [0x6a, '⌊'],
  [0x6b, '⌋'],
  [0x6c, '⌈'],
  [0x6d, '⌉'],
  [0x6e, '{'],
  [0x6f, '}'],
  [0x70, '√'],
  [0x71, '√'],
  [0x72, '√'],
  [0x73, '√'],
  [0x74, '⎷'],
  // TeX uses private slots for radical extenders and assembled-brace hooks.
  // Map them to the closest publishable Unicode pieces instead of leaking the
  // misleading ASCII slot letters into reconstructed equations.
  [0x75, '‾'],
  [0x76, '‾'],
  [0x77, '‖'],
  [0x78, '↑'],
  [0x79, '↓'],
  [0x7a, '⎩'],
  [0x7b, '⎭'],
  [0x7c, '⎧'],
  [0x7d, '⎫'],
  [0x7e, '⇑'],
  [0x7f, '⇓'],
])

const MAX_FONT_DEPENDENCIES_PER_PAGE = 64
const PDF_FONT_DEPENDENCY_TIMEOUT_MS = 10_000

const TEX_PREFIX_ACCENTS = new Map<string, string>([
  ['¨', '\u0308'],
  ['´', '\u0301'],
  ['¸', '\u0327'],
  ['ˆ', '\u0302'],
  ['ˇ', '\u030c'],
  ['˘', '\u0306'],
  ['˙', '\u0307'],
  ['˚', '\u030a'],
  ['˝', '\u030b'],
  ['˜', '\u0303'],
  ['¯', '\u0304'],
])

/**
 * TeX-encoded Computer Modern PDFs commonly expose an accent slot before its
 * base letter in content-stream order (`Itˆo`, `L´evy`, `A¨ıt`). That is
 * neither authored reading order nor valid Unicode combining order. Repair
 * only the bounded modifier-letter repertoire; ordinary apostrophes,
 * backticks, and mathematical postfix hats remain untouched.
 */
export function normalizePdfTextSequence(text: string) {
  return text
    .replace(
      /([¨¯´¸ˆˇ˘˙˚˜˝])(\p{L})/gu,
      (_match, accent: string, rawBase: string) => {
        const base = rawBase === 'ı' ? 'i' : rawBase === 'ȷ' ? 'j' : rawBase
        return `${base}${TEX_PREFIX_ACCENTS.get(accent) ?? accent}`
      },
    )
    .normalize('NFC')
}

export type PdfFontMetadata = {
  name: string
  bold?: boolean
  italic?: boolean
}

type PdfCommonObjects = {
  get(id: string, callback?: (value: unknown) => void): unknown
  has?(id: string): boolean
}

type ResolvePdfFontMetadataOptions = {
  commonObjects: PdfCommonObjects
  fontIds: Iterable<string>
  dependencyIds: Iterable<string>
  signal?: AbortSignal
  timeoutMs?: number
}

export function pdfOperatorListDependencyIds({
  fnArray,
  argsArray,
  dependencyOp,
}: {
  fnArray: readonly number[]
  argsArray: readonly unknown[]
  dependencyOp: number
}) {
  const dependencies = new Set<string>()
  for (const [index, operation] of fnArray.entries()) {
    if (operation !== dependencyOp) continue
    const args = argsArray[index]
    if (!Array.isArray(args)) continue
    for (const value of args) {
      if (typeof value === 'string') dependencies.add(value)
    }
  }
  return [...dependencies].sort()
}

export function safePdfFontName(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback
  const leaf = value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .split(/[\\/]/u)
    .at(-1)
    ?.trim()
  return leaf && leaf.length <= 160 ? leaf : fallback
}

function asPdfFontMetadata(value: unknown, fallbackName: string) {
  if (!value || typeof value !== 'object') return null
  const candidate = value as {
    name?: unknown
    bold?: unknown
    italic?: unknown
  }
  const name = safePdfFontName(candidate.name, fallbackName)
  return {
    name,
    ...(typeof candidate.bold === 'boolean' ? { bold: candidate.bold } : {}),
    ...(typeof candidate.italic === 'boolean'
      ? { italic: candidate.italic }
      : {}),
  } satisfies PdfFontMetadata
}

/**
 * Resolves the finite set of font objects declared by a completed PDF.js
 * operator list. Browser font loading may finish after `getOperatorList()`, so
 * a synchronous `commonObjs.get()` is not authoritative. The callback path is
 * bounded by both dependency cardinality and one page-level deadline; if any
 * dependency is absent, the page falls back to PDF.js's opaque font ids rather
 * than publishing a timing-dependent partial provenance map.
 */
export async function resolvePdfFontMetadata({
  commonObjects,
  fontIds,
  dependencyIds,
  signal,
  timeoutMs = PDF_FONT_DEPENDENCY_TIMEOUT_MS,
}: ResolvePdfFontMetadataOptions) {
  const requestedIds = [...new Set(fontIds)].sort()
  const dependencies = new Set(dependencyIds)
  if (
    requestedIds.length > MAX_FONT_DEPENDENCIES_PER_PAGE ||
    requestedIds.some((id) => !dependencies.has(id))
  ) {
    return new Map<string, PdfFontMetadata>()
  }

  const resolved = await Promise.all(
    requestedIds.map(
      (id) =>
        new Promise<readonly [string, PdfFontMetadata | null]>((resolve) => {
          let settled = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          const finish = (value: unknown) => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
            resolve([id, asPdfFontMetadata(value, id)] as const)
          }
          const abort = () => finish(null)
          if (signal?.aborted) {
            finish(null)
            return
          }
          signal?.addEventListener('abort', abort, { once: true })
          timeout = setTimeout(() => finish(null), timeoutMs)
          try {
            if (commonObjects.has?.(id)) {
              finish(commonObjects.get(id))
              return
            }
            if (!commonObjects.has) {
              try {
                finish(commonObjects.get(id))
                return
              } catch {
                // PDF.js explicitly requires its callback form while an object
                // is pending; register it below.
              }
            }
            commonObjects.get(id, finish)
          } catch {
            finish(null)
          }
        }),
    ),
  )
  if (resolved.some(([, metadata]) => !metadata)) {
    return new Map<string, PdfFontMetadata>()
  }
  return new Map(resolved as ReadonlyArray<readonly [string, PdfFontMetadata]>)
}

export function pdfFontTextRequiresStructuralReconstruction(
  text: string,
  fontName: string,
) {
  return (
    /CMEX\d*/iu.test(fontName) &&
    /[\u0302\u0303\u203e\u239b-\u23b3\u23b7]/u.test(text)
  )
}

export function normalizePdfFontText(text: string, fontName: string) {
  if (!/CMEX\d*/iu.test(fontName)) return text
  return [...text]
    .map((character) => {
      const slot = character.codePointAt(0)
      return slot === undefined
        ? character
        : (CMEX10_UNICODE_BY_SLOT.get(slot) ?? character)
    })
    .join('')
}
