import { describe, expect, it } from 'vitest'
import {
  normalizePdfFontText,
  normalizePdfTextSequence,
  pdfFontStyle,
  pdfOperatorListDependencyIds,
  pdfFontTextRequiresStructuralReconstruction,
  resolvePdfFontMetadata,
  safePdfFontName,
} from './pdf-font-text'

describe('PDF font text normalization', () => {
  it('reorders TeX accent prefixes onto their following source letters', () => {
    expect(normalizePdfTextSequence('Itˆo–L´evy')).toBe('Itô–Lévy')
    expect(normalizePdfTextSequence('Yacine A¨ıt')).toBe('Yacine Aït')
    expect(normalizePdfTextSequence('Jean-Fran¸cois B´egin')).toBe(
      'Jean-François Bégin',
    )
    expect(normalizePdfTextSequence('xˆ + y')).toBe('xˆ + y')
  })

  it('decodes Computer Modern extension glyph codes into semantic Unicode', () => {
    const normalize = (text: string) =>
      normalizePdfFontText(text, 'ABCDEF+CMEX10')

    expect([normalize('\u0000'), normalize('\u0001')]).toEqual(['(', ')'])
    expect([normalize('\u0010'), normalize('\u0011')]).toEqual(['(', ')'])
    expect([normalize('\u001a'), normalize('\u001b')]).toEqual(['{', '}'])
    expect(normalize('\u001e')).toBe('/')
    expect([normalize('Z'), normalize('X')]).toEqual(['∫', '∑'])
    expect(normalize('b')).toBe('\u0302')
    expect(normalize('!')).toBe(')')
    expect([normalize('u'), normalize('v')]).toEqual(['‾', '‾'])
    expect([
      normalize('z'),
      normalize('{'),
      normalize('|'),
      normalize('}'),
    ]).toEqual(['⎩', '⎭', '⎧', '⎫'])
  })

  it('does not reinterpret control characters from an unrelated font', () => {
    expect(normalizePdfFontText('\u0000x\u0001', 'ABCDEF+BodySerif')).toBe(
      '\u0000x\u0001',
    )
  })

  it('classifies subset-prefixed Computer Modern and Latin Modern emphasis', () => {
    expect(pdfFontStyle({ fontName: 'QNPGDC+CMBX12', text: '70.281' })).toEqual(
      {
        bold: true,
        italic: false,
      },
    )
    expect(
      pdfFontStyle({ fontName: 'ABCDEF+CMBXTI10', text: 'Result' }),
    ).toEqual({
      bold: true,
      italic: true,
    })
    expect(pdfFontStyle({ fontName: 'YKELUW+CMMI10', text: 's' })).toEqual({
      bold: false,
      italic: true,
    })
    expect(
      pdfFontStyle({ fontName: 'ABCDEF+LMBXTI10', text: 'Result' }),
    ).toEqual({
      bold: true,
      italic: true,
    })
    expect(pdfFontStyle({ fontName: 'ABCDEF+LMMI10', text: 'σ' })).toEqual({
      bold: false,
      italic: true,
    })
    expect(
      pdfFontStyle({
        fontName: 'ABCDEF+LMRoman10-BoldItalic',
        text: 'Result',
      }),
    ).toEqual({ bold: true, italic: true })
  })

  it('does not infer emphasis from regular roman, symbol, or extension faces', () => {
    for (const fontName of [
      'ABCDEF+CMR12',
      'ABCDEF+CMSY10',
      'ABCDEF+CMEX10',
      'ABCDEF+LMRoman10-Regular',
      'NimbusRomNo9L-Regu',
    ]) {
      expect(pdfFontStyle({ fontName, text: 'Text' })).toEqual({
        bold: false,
        italic: false,
      })
    }
    expect(pdfFontStyle({ fontName: 'ABCDEF+CMMI12', text: '.' })).toEqual({
      bold: false,
      italic: false,
    })
    expect(pdfFontStyle({ fontName: 'ABCDEF+CMMI12', text: '10' })).toEqual({
      bold: false,
      italic: false,
    })
    expect(
      pdfFontStyle({
        fontName: 'ABCDEF+CMBXTI10',
        text: 'Result',
        bold: false,
        italic: false,
      }),
    ).toEqual({ bold: false, italic: false })
  })

  it('decodes every XML-forbidden CMEX control slot into publishable text', () => {
    const forbiddenSlots = [
      ...Array.from({ length: 32 }, (_, slot) => slot),
      0x7f,
    ]
    const normalized = forbiddenSlots
      .map((slot) =>
        normalizePdfFontText(String.fromCodePoint(slot), 'ABCDEF+CMEX10'),
      )
      .join('')

    expect(normalized).not.toMatch(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u,
    )
  })

  it('waits for callback-backed operator-list font dependencies', async () => {
    const requested: string[] = []
    const metadata = await resolvePdfFontMetadata({
      commonObjects: {
        get(id, callback) {
          requested.push(id)
          if (!callback) {
            throw new Error(`Requesting object that isn't resolved yet ${id}`)
          }
          queueMicrotask(() =>
            callback({ name: 'ABCDEF+CMEX10', bold: false, italic: false }),
          )
        },
        has() {
          return false
        },
      },
      fontIds: ['g_d0_f19'],
      dependencyIds: ['g_d0_f19'],
      timeoutMs: 100,
    })

    expect(requested).toEqual(['g_d0_f19'])
    expect(metadata.get('g_d0_f19')).toEqual({
      name: 'ABCDEF+CMEX10',
      bold: false,
      italic: false,
    })
  })

  it('takes font provenance only from completed operator-list dependencies', () => {
    expect(
      pdfOperatorListDependencyIds({
        fnArray: [1, 37, 1, 1],
        argsArray: [
          ['g_d0_f19'],
          ['g_d0_f19', 9.96],
          ['img_p0_1'],
          ['g_d0_f2', 'g_d0_f1'],
        ],
        dependencyOp: 1,
      }),
    ).toEqual(['g_d0_f1', 'g_d0_f19', 'g_d0_f2', 'img_p0_1'])
  })

  it('fails a page closed before registering an unbounded font set', async () => {
    let requests = 0
    const fontIds = Array.from({ length: 65 }, (_, index) => `g_d0_f${index}`)
    const metadata = await resolvePdfFontMetadata({
      commonObjects: {
        get() {
          requests += 1
          return { name: 'BodySerif' }
        },
      },
      fontIds,
      dependencyIds: fontIds,
      timeoutMs: 100,
    })

    expect(metadata.size).toBe(0)
    expect(requests).toBe(0)
  })

  it('keeps local path segments out of resolved font provenance', () => {
    expect(
      safePdfFontName('/Users/example/Library/Fonts/ABCDEF+CMEX10', 'g_d0_f19'),
    ).toBe('ABCDEF+CMEX10')
    expect(
      safePdfFontName('C:\\Users\\example\\ABCDEF+CMEX10', 'g_d0_f19'),
    ).toBe('ABCDEF+CMEX10')
  })

  it('marks CMEX assembly pieces as unresolved semantic transcripts', () => {
    const normalize = (text: string) =>
      normalizePdfFontText(text, 'ABCDEF+CMEX10')

    for (const slot of ['0', '1', 'b', 'e', 't', 'u', 'v']) {
      expect(
        pdfFontTextRequiresStructuralReconstruction(
          normalize(slot),
          'ABCDEF+CMEX10',
        ),
      ).toBe(true)
    }
    expect(
      pdfFontTextRequiresStructuralReconstruction('∑', 'ABCDEF+CMEX10'),
    ).toBe(false)
    expect(pdfFontTextRequiresStructuralReconstruction('⎛', 'BodySerif')).toBe(
      false,
    )
  })
})
