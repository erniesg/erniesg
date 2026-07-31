import { describe, expect, it } from 'vitest'
import {
  createPdfDisplayOperationsFilterAttestation,
  MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT,
  pdfTextLedgerSha256,
  pdfTextPaintOperatorLedgerSha256,
  provePdfDisplayTextOperationFilter,
  provePdfTextPaintRunProvenance,
  safePdfTextOperationFilter,
} from './pdf-text-paint'

const SHOW_TEXT = 44
const SHOW_SPACED_TEXT = 45
const MOVE_TEXT = 40
const SET_TEXT_MATRIX = 42
const TRANSFORM = 12
const SET_GSTATE = 9
const SET_FONT = 37
const SET_TEXT_RENDERING_MODE = 38
const SAVE = 10
const RESTORE = 11
const BEGIN_TEXT = 31
const END_TEXT = 32

function glyphs(text: string) {
  return [[...text].map((unicode) => ({ unicode }))]
}

function denseDisplayFilterProof(nonOwnedPaintCount: number) {
  const fnArray = [BEGIN_TEXT]
  const argsArray: unknown[] = [[]]
  let ledgerText = ''
  for (let index = 0; index < nonOwnedPaintCount; index += 1) {
    if (index > 0) {
      fnArray.push(MOVE_TEXT)
      argsArray.push([0, 10])
    }
    fnArray.push(SHOW_TEXT)
    argsArray.push(glyphs(index === 0 ? 'c' : 'u'))
    ledgerText += index === 0 ? 'c' : 'u'
  }
  fnArray.push(MOVE_TEXT, SHOW_TEXT, END_TEXT)
  argsArray.push([0, 10], glyphs('x'), [])
  ledgerText += 'x'
  return provePdfDisplayTextOperationFilter({
    operatorList: { fnArray, argsArray },
    sourceTextLedgerSha256: pdfTextLedgerSha256(ledgerText),
    ownedTextLedgerSpans: [
      { start: nonOwnedPaintCount, end: nonOwnedPaintCount + 1 },
    ],
    excludedTextLedgerSpans: [{ start: 0, end: 1 }],
    showTextOperation: SHOW_TEXT,
    textPaintOperations: new Set([SHOW_TEXT, SHOW_SPACED_TEXT]),
    textStateOperations: new Set([
      BEGIN_TEXT,
      END_TEXT,
      MOVE_TEXT,
      SHOW_TEXT,
    ]),
    setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
    textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
    beginTextOperation: BEGIN_TEXT,
    endTextOperation: END_TEXT,
    saveOperation: SAVE,
    restoreOperation: RESTORE,
  })
}

function prove(
  items: readonly string[],
  operations: readonly { fn: number; args: unknown }[],
) {
  return provePdfTextPaintRunProvenance({
    textContentItems: items.map((str) => ({ str })),
    operatorList: {
      fnArray: operations.map(({ fn }) => fn),
      argsArray: operations.map(({ args }) => args),
    },
    showTextOperation: SHOW_TEXT,
    textPaintOperations: new Set([SHOW_TEXT, SHOW_SPACED_TEXT]),
    textStateOperations: new Set([
      SET_GSTATE,
      TRANSFORM,
      MOVE_TEXT,
      SET_TEXT_MATRIX,
      SHOW_TEXT,
    ]),
  })
}

describe('PDF text-paint run provenance', () => {
  it('keeps the operator ledger stable across fresh PDF.js document resource namespaces', () => {
    const ledger = (fontResourceId: string) =>
      pdfTextPaintOperatorLedgerSha256({
        operatorList: {
          fnArray: [BEGIN_TEXT, SET_TEXT_MATRIX, SET_FONT, SHOW_TEXT, END_TEXT],
          argsArray: [
            [],
            [1, 0, 0, 1, 72, 720],
            [fontResourceId, 12],
            glyphs('stable'),
            [],
          ],
        },
        textStateOperations: new Set([
          BEGIN_TEXT,
          END_TEXT,
          SET_TEXT_MATRIX,
          SET_FONT,
          SHOW_TEXT,
        ]),
      })

    expect(ledger('g_d0_f1')).toBe(ledger('g_d73_f1'))
  })

  it('preserves PDF-looking visible glyph text in the operator ledger', () => {
    const ledger = (unicode: string) =>
      pdfTextPaintOperatorLedgerSha256({
        operatorList: {
          fnArray: [SHOW_TEXT],
          argsArray: [[[{ unicode }]]],
        },
        textStateOperations: new Set([SHOW_TEXT]),
      })

    expect(ledger('g_d0_f1')).not.toBe(ledger('g_d73_f1'))
  })

  it('keeps the operator ledger stable when canonically tied object keys are shuffled', () => {
    const ledger = (entries: readonly (readonly [string, number])[]) =>
      pdfTextPaintOperatorLedgerSha256({
        operatorList: {
          fnArray: [SET_GSTATE],
          argsArray: [Object.fromEntries(entries)],
        },
        textStateOperations: new Set([SET_GSTATE]),
      })
    const composed = 'é'
    const decomposed = 'e\u0301'

    expect(
      ledger([
        [composed, 1],
        [decomposed, 2],
      ]),
    ).toBe(
      ledger([
        [decomposed, 2],
        [composed, 1],
      ]),
    )
  })

  it('maps merged and split text items to plural overlapping showText operations', () => {
    const result = prove(
      ['Multiply ', 'by 2:'],
      [
        { fn: MOVE_TEXT, args: [1, 2] },
        { fn: SHOW_TEXT, args: glyphs('Multi') },
        { fn: SHOW_TEXT, args: glyphs('plyby') },
        { fn: SHOW_TEXT, args: glyphs('2:') },
      ],
    )

    expect(result.get(0)?.operationIndexes).toEqual([1, 2])
    expect(result.get(1)?.operationIndexes).toEqual([2, 3])
    expect(result.get(0)?.filterableOperationIndexes).toEqual([1])
    expect(result.get(1)?.filterableOperationIndexes).toEqual([3])
    expect(result.get(0)?.operatorLedgerSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.get(1)?.operatorLedgerSha256).toBe(
      result.get(0)?.operatorLedgerSha256,
    )
  })

  it('does not expose an operation shared with a source item that may later be discarded', () => {
    const result = prove(
      ['visible', 'rotated-artifact'],
      [{ fn: SHOW_TEXT, args: glyphs('visiblerotated-artifact') }],
    )

    expect(result.get(0)?.operationIndexes).toEqual([0])
    expect(result.get(0)?.filterableOperationIndexes).toEqual([])
    expect(result.get(1)?.operationIndexes).toEqual([0])
    expect(result.get(1)?.filterableOperationIndexes).toEqual([])
  })

  it.each([
    {
      name: 'ledger text mismatch',
      items: ['Multiply by 2:'],
      operations: [{ fn: SHOW_TEXT, args: glyphs('Multiply by 3:') }],
    },
    {
      name: 'unsupported text-paint variant',
      items: ['Multiply by 2:'],
      operations: [{ fn: SHOW_SPACED_TEXT, args: glyphs('Multiply by 2:') }],
    },
    {
      name: 'malformed glyph ledger',
      items: ['Multiply by 2:'],
      operations: [{ fn: SHOW_TEXT, args: [[{ width: 5 }]] }],
    },
  ])('fails closed on $name', ({ items, operations }) => {
    expect(prove(items, operations).size).toBe(0)
  })

  it('changes the ledger digest when text-position state changes', () => {
    const first = prove(
      ['x'],
      [
        { fn: SET_TEXT_MATRIX, args: [1, 0, 0, 1, 10, 10] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )
    const second = prove(
      ['x'],
      [
        { fn: SET_TEXT_MATRIX, args: [1, 0, 0, 1, 11, 10] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )

    expect(first.get(0)?.operatorLedgerSha256).not.toBe(
      second.get(0)?.operatorLedgerSha256,
    )
  })

  it('changes the ledger digest when CTM state changes', () => {
    const first = prove(
      ['x'],
      [
        { fn: TRANSFORM, args: [1, 0, 0, 1, 10, 10] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )
    const second = prove(
      ['x'],
      [
        { fn: TRANSFORM, args: [1, 0, 0, 1, 11, 10] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )
    expect(first.get(0)?.operatorLedgerSha256).not.toBe(
      second.get(0)?.operatorLedgerSha256,
    )
  })

  it('changes the ledger digest when extended graphics state changes', () => {
    const first = prove(
      ['x'],
      [
        { fn: SET_GSTATE, args: [['g_state_alpha']] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )
    const second = prove(
      ['x'],
      [
        { fn: SET_GSTATE, args: [['g_state_beta']] },
        { fn: SHOW_TEXT, args: glyphs('x') },
      ],
    )

    expect(first.get(0)?.operatorLedgerSha256).not.toBe(
      second.get(0)?.operatorLedgerSha256,
    )
  })

  it('requires a text-position reset before the next retained paint', () => {
    const operatorList = {
      fnArray: [BEGIN_TEXT, SHOW_TEXT, MOVE_TEXT, SHOW_TEXT, END_TEXT],
      argsArray: [[], glyphs('cue'), [1, 2], glyphs('equation'), []],
    }
    expect(
      safePdfTextOperationFilter({
        operatorList,
        excludedOperationIndexes: [1],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(true)
    expect(
      safePdfTextOperationFilter({
        operatorList: {
          ...operatorList,
          fnArray: [BEGIN_TEXT, SHOW_TEXT, SHOW_TEXT, END_TEXT],
          argsArray: [[], glyphs('cue'), glyphs('equation'), []],
        },
        excludedOperationIndexes: [1],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(false)
  })

  it('rejects text clipping mode', () => {
    expect(
      safePdfTextOperationFilter({
        operatorList: {
          fnArray: [BEGIN_TEXT, SET_TEXT_RENDERING_MODE, SHOW_TEXT, END_TEXT],
          argsArray: [[], [4], glyphs('cue'), []],
        },
        excludedOperationIndexes: [2],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(false)
  })

  it('requires beginText after endText before treating the next paint as reset', () => {
    const check = (fnArray: number[], argsArray: unknown[]) =>
      safePdfTextOperationFilter({
        operatorList: { fnArray, argsArray },
        excludedOperationIndexes: [1],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      })
    expect(
      check(
        [BEGIN_TEXT, SHOW_TEXT, END_TEXT, SHOW_TEXT],
        [[], glyphs('cue'), [], glyphs('retained')],
      ),
    ).toBe(false)
    expect(
      check(
        [BEGIN_TEXT, SHOW_TEXT, END_TEXT, BEGIN_TEXT, SHOW_TEXT, END_TEXT],
        [[], glyphs('cue'), [], [], glyphs('retained'), []],
      ),
    ).toBe(true)
  })

  it('tracks clipping text mode through balanced graphics-state save and restore', () => {
    expect(
      safePdfTextOperationFilter({
        operatorList: {
          fnArray: [
            BEGIN_TEXT,
            SET_TEXT_RENDERING_MODE,
            SAVE,
            SET_TEXT_RENDERING_MODE,
            RESTORE,
            SHOW_TEXT,
            END_TEXT,
          ],
          argsArray: [[], [4], [], [0], [], glyphs('cue'), []],
        },
        excludedOperationIndexes: [5],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(false)
    expect(
      safePdfTextOperationFilter({
        operatorList: {
          fnArray: [BEGIN_TEXT, SAVE, SHOW_TEXT, END_TEXT],
          argsArray: [[], [], glyphs('cue'), []],
        },
        excludedOperationIndexes: [2],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(false)
  })

  it('rejects endText without a matching beginText', () => {
    expect(
      safePdfTextOperationFilter({
        operatorList: {
          fnArray: [END_TEXT, BEGIN_TEXT, SHOW_TEXT, END_TEXT],
          argsArray: [[], [], glyphs('cue'), []],
        },
        excludedOperationIndexes: [2],
        showTextOperation: SHOW_TEXT,
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBe(false)
  })
})

describe('PDF DISPLAY operationsFilter attestation', () => {
  it('accepts the observed dense-page negative control but rejects proofs above the bounded operation-index contract', () => {
    expect(
      denseDisplayFilterProof(644)?.ownedOnlyExcludedOperationIndexes,
    ).toHaveLength(644)
    expect(
      denseDisplayFilterProof(MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT + 1),
    ).toBeNull()
  })

  it('cannot prove a selected paint operation whose whitespace normalization erases glyphs', () => {
    expect(
      provePdfDisplayTextOperationFilter({
        operatorList: {
          fnArray: [BEGIN_TEXT, SHOW_TEXT, MOVE_TEXT, SHOW_TEXT, END_TEXT],
          argsArray: [[], glyphs('cue '), [0, 10], glyphs('x'), []],
        },
        sourceTextLedgerSha256: pdfTextLedgerSha256('cuex'),
        ownedTextLedgerSpans: [{ start: 3, end: 4 }],
        excludedTextLedgerSpans: [{ start: 0, end: 3 }],
        showTextOperation: SHOW_TEXT,
        textPaintOperations: new Set([SHOW_TEXT, SHOW_SPACED_TEXT]),
        textStateOperations: new Set([
          BEGIN_TEXT,
          END_TEXT,
          MOVE_TEXT,
          SHOW_TEXT,
        ]),
        setTextRenderingModeOperation: SET_TEXT_RENDERING_MODE,
        textPositionResetOperations: new Set([MOVE_TEXT, SET_TEXT_MATRIX]),
        beginTextOperation: BEGIN_TEXT,
        endTextOperation: END_TEXT,
        saveOperation: SAVE,
        restoreOperation: RESTORE,
      }),
    ).toBeNull()
  })

  it('accepts monotone complete coverage with stable repeated indexes', () => {
    const operatorList = {
      fnArray: [BEGIN_TEXT, SHOW_TEXT, END_TEXT],
      argsArray: [[], glyphs('cue'), []],
    }
    const attestation = createPdfDisplayOperationsFilterAttestation({
      operatorList,
      excludedOperationIndexes: [1],
    })!

    expect(
      [0, 1, 1, 2].map((index) => attestation.operationsFilter(index)),
    ).toEqual([true, false, false, true])
    expect(attestation.hasCompleteExactCoverage()).toBe(true)
  })

  it('fails closed when callback coverage skips or reverses an index', () => {
    const operatorList = {
      fnArray: [BEGIN_TEXT, SHOW_TEXT, END_TEXT],
      argsArray: [[], glyphs('cue'), []],
    }
    const skipped = createPdfDisplayOperationsFilterAttestation({
      operatorList,
      excludedOperationIndexes: [1],
    })!
    skipped.operationsFilter(0)
    skipped.operationsFilter(2)
    expect(skipped.hasCompleteExactCoverage()).toBe(false)

    const reversed = createPdfDisplayOperationsFilterAttestation({
      operatorList,
      excludedOperationIndexes: [1],
    })!
    reversed.operationsFilter(0)
    reversed.operationsFilter(1)
    reversed.operationsFilter(0)
    expect(reversed.hasCompleteExactCoverage()).toBe(false)
  })

  it('fails closed when repeated operation arguments differ from the captured DISPLAY stream', () => {
    const args = glyphs('cue')
    const operatorList = {
      fnArray: [BEGIN_TEXT, SHOW_TEXT, END_TEXT],
      argsArray: [[], args, []] as unknown[],
    }
    const attestation = createPdfDisplayOperationsFilterAttestation({
      operatorList,
      excludedOperationIndexes: [1],
    })!
    attestation.operationsFilter(0)
    attestation.operationsFilter(1)
    ;(args[0][0] as { unicode: string }).unicode = 'x'
    attestation.operationsFilter(1)
    attestation.operationsFilter(2)

    expect(attestation.hasCompleteExactCoverage()).toBe(false)
  })
})
