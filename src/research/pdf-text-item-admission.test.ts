import { describe, expect, it } from 'vitest'
import { pdfTextItemSemanticAdmission } from './pdf'

describe('PDF text-item semantic admission', () => {
  it('withholds an unattested extension-font whitespace item that decodes to a semantic delimiter', () => {
    expect(
      pdfTextItemSemanticAdmission({
        rawText: ' ',
        decodedText: '(',
        fontName: 'Synthetic-CMEX10',
        paintProven: false,
      }),
    ).toEqual({
      text: ' ',
      renderVisibleText: '\ufffd',
      status: 'unresolved-extension-glyph',
    })
  })

  it.each([
    {
      name: 'paint-attested extension delimiter',
      input: {
        rawText: '\u0000',
        decodedText: '(',
        fontName: 'Synthetic-CMEX10',
        paintProven: true,
      },
      expected: '(',
    },
    {
      name: 'unattested ordinary Roman text',
      input: {
        rawText: 'ordinary',
        decodedText: 'ordinary',
        fontName: 'Synthetic-CMR12',
        paintProven: false,
      },
      expected: 'ordinary',
    },
    {
      name: 'ordinary whitespace',
      input: {
        rawText: ' ',
        decodedText: ' ',
        fontName: 'Synthetic-CMR12',
        paintProven: false,
      },
      expected: ' ',
    },
  ])('preserves $name', ({ input, expected }) => {
    expect(pdfTextItemSemanticAdmission(input)).toEqual({
      text: expected,
      renderVisibleText: expected,
      status: 'admitted',
    })
  })
})
