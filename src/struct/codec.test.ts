import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { runInNewContext } from 'node:vm'
import {
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
  StructCodecError,
} from './index'
import { legacyStructDigest, structDigest } from './ids'
import { sha256HexSync } from './sha256'
import { buildStructEpub } from './epub'
import { renderPublicationXhtml } from './xhtml'

const hash = 'a'.repeat(64)
const assetBytesHash = sha256HexSync(new Uint8Array([0, 255, 128]))

function evidence() {
  return {
    confidence: 1,
    pages: [1],
    boxes: [
      {
        page: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ],
    sourceIds: ['source-node'],
    signals: ['fixture'],
  }
}

function digestInput(document: any) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    ...(document.receipt.modelConsultations
      ? { modelConsultations: document.receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  }
}

function seal<T extends Record<string, any>>(document: T): T {
  document.receipt.generatedSha256 =
    document.schemaVersion === '0.1.0'
      ? legacyStructDigest(digestInput(document))
      : structDigest(digestInput(document))
  return document
}

function validDocument() {
  const sharedEvidence = evidence()
  return seal({
    schemaVersion: '0.1.0',
    source: {
      format: 'docx',
      fileName: 'fixture.docx',
      sha256: hash,
      byteLength: 3,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Fixture',
      subtitle: '',
      authors: ['Author'],
      abstract: 'Abstract',
      language: 'en',
      baseDirection: 'ltr',
      publicationDate: '2026-08-20',
      artifactModifiedAt: '2026-08-20T00:00:00Z',
      updated: '2026-08-20',
      affiliations: ['Example University'],
      authorAffiliations: [{ author: 'Author', label: '1' }],
      authorNotes: [
        {
          id: 'author-note-1',
          author: 'Author',
          label: '1',
          target: 'block-1',
        },
      ],
    },
    blocks: [
      {
        id: 'block-1',
        kind: 'paragraph',
        text: 'Hello',
        label: 'Body',
        page: 1,
        order: 0,
        column: 'single',
        inline: [
          {
            start: 0,
            end: 5,
            href: '#block-1',
            annotationId: 'annotation-1',
            relationshipId: 'relationship-1',
            targetIds: ['block-1'],
            bold: true,
            italic: false,
            verticalAlign: 'superscript',
            compactMathAtom: false,
            semanticRole: 'cross-reference',
          },
        ],
        evidence: sharedEvidence,
        sourceObservationAnchorIds: ['anchor-1'],
        table: {
          rows: 1,
          columns: 1,
          cells: [
            {
              id: 'cell-1',
              text: 'Cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence: sharedEvidence,
            },
          ],
          semantic: 'verified',
        },
        furniture: {
          classification: 'repeated-text',
          band: 'top',
          pages: [1],
          boxes: [],
          evidence: ['fixture-furniture'],
          normalizedText: 'Header',
          sequence: [1],
          sourceRunIndexes: [0],
        },
        furnitureReview: {
          reason: 'single-occurrence-margin',
          band: 'right',
          pages: [1],
          boxes: [],
          evidence: ['fixture-review'],
        },
        fallbackAssetIds: ['asset-1'],
        attributes: { level: 1, bibliographyEntry: false, objectType: 'body' },
      },
    ],
    assets: [
      {
        id: 'asset-1',
        kind: 'figure',
        href: 'assets/asset-1.bin',
        mediaType: 'application/octet-stream',
        sha256: assetBytesHash,
        width: 10,
        height: 10,
        bytes: 'AP+A',
        sourceObjectIds: ['source-asset'],
        evidence: sharedEvidence,
        fallback: 'asset',
      },
    ],
    relationships: [
      {
        id: 'relationship-1',
        kind: 'reading-order',
        from: 'block-1',
        to: ['block-1'],
        label: 'next',
        status: 'matched',
        confidence: 1,
        evidence: sharedEvidence,
        candidates: [
          { target: 'block-1', confidence: 1, evidence: sharedEvidence },
        ],
      },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['block-1'],
        columns: [{ id: 'column-1', side: 'single', blockIds: ['block-1'] }],
      },
    ],
    diagnostics: [
      {
        id: 'diagnostic-1',
        severity: 'info',
        category: 'source',
        title: 'Fixture',
        message: 'Fixture diagnostic',
        action: 'Continue',
        pages: [1],
        sourceIds: ['source-node'],
      },
    ],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'No recovery required',
      issues: [
        {
          category: 'source',
          title: 'None',
          count: 0,
          pages: [],
          action: 'None',
        },
      ],
      userAction: 'None',
    },
    receipt: {
      schemaVersion: '0.1.0',
      sourceSha256: hash,
      blockCount: 1,
      assetCount: 1,
      relationshipCount: 1,
      diagnosticCount: 1,
      textCharacterCount: 5,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 1,
        accountedSourceAnnotationCount: 1,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 1,
        accountedSourceRelationshipCount: 1,
        sourceDiagnosticCount: 1,
        accountedSourceDiagnosticCount: 1,
        sourceTextCharacterCount: 5,
        structBlockCount: 1,
        structAssetCount: 1,
        structRelationshipCount: 1,
        structDiagnosticCount: 1,
        structTextCharacterCount: 5,
        sourceFurnitureBlockCount: 0,
        accountedFurnitureBlockCount: 0,
        sourceFurnitureTextCharacterCount: 0,
        structFurnitureBlockCount: 0,
        structFurnitureTextCharacterCount: 0,
        furnitureContaminationCount: 0,
      },
      generatedSha256: hash,
    },
  })
}

describe('STRUCT runtime codec', () => {
  it('decodes a strict 0.1.0 document and restores JSON-safe asset bytes', () => {
    const decoded = decodeStructDocument(validDocument())

    expect(decoded.schemaVersion).toBe('0.1.0')
    expect(decoded.assets[0]?.bytes).toEqual(new Uint8Array([0, 255, 128]))
    expect(decoded.assets[0]?.bytes).not.toBe(
      (validDocument().assets[0] as { bytes: unknown }).bytes,
    )
    expect(decoded.blocks[0]?.attributes).toEqual({
      level: 1,
      bibliographyEntry: false,
      objectType: 'body',
    })
  })

  it('encodes asset bytes as canonical JSON-safe base64 and round-trips them', () => {
    const fixture = validDocument()
    const document = decodeStructDocument(fixture)
    const encoded = encodeStructDocument(document)

    expect(encoded.assets[0]).toMatchObject({ bytes: 'AP+A' })
    expect(encoded.receipt.generatedSha256).toBe(
      fixture.receipt.generatedSha256,
    )
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
    expect(decodeStructDocument(encoded).assets[0]?.bytes).toEqual(
      new Uint8Array([0, 255, 128]),
    )
  })

  it('preserves JSON text whitespace without coercion', () => {
    const value = validDocument() as any
    value.metadata.abstract = 'Abstract\nwith\twhitespace'
    value.blocks[0].text = 'Hello\n'
    value.receipt.textCharacterCount = 6
    value.receipt.conservation.sourceTextCharacterCount = 6
    value.receipt.conservation.structTextCharacterCount = 6
    seal(value)

    const decoded = decodeStructDocument(value)

    expect(decoded.metadata.abstract).toBe('Abstract\nwith\twhitespace')
    expect(decoded.blocks[0]?.text).toBe('Hello\n')
  })

  it.each([
    ['document', (value: any) => (value.extra = true)],
    ['source', (value: any) => (value.source.extra = true)],
    ['metadata', (value: any) => (value.metadata.extra = true)],
    [
      'author affiliation',
      (value: any) => (value.metadata.authorAffiliations[0].extra = true),
    ],
    [
      'author note',
      (value: any) => (value.metadata.authorNotes[0].extra = true),
    ],
    ['block', (value: any) => (value.blocks[0].extra = true)],
    ['inline', (value: any) => (value.blocks[0].inline[0].extra = true)],
    ['evidence', (value: any) => (value.blocks[0].evidence.extra = true)],
    ['box', (value: any) => (value.blocks[0].evidence.boxes[0].extra = true)],
    ['table', (value: any) => (value.blocks[0].table.extra = true)],
    [
      'table cell',
      (value: any) => (value.blocks[0].table.cells[0].extra = true),
    ],
    ['furniture', (value: any) => (value.blocks[0].furniture.extra = true)],
    [
      'furniture review',
      (value: any) => (value.blocks[0].furnitureReview.extra = true),
    ],
    ['asset', (value: any) => (value.assets[0].extra = true)],
    ['relationship', (value: any) => (value.relationships[0].extra = true)],
    [
      'relationship candidate',
      (value: any) => (value.relationships[0].candidates[0].extra = true),
    ],
    ['page', (value: any) => (value.pages[0].extra = true)],
    ['page column', (value: any) => (value.pages[0].columns[0].extra = true)],
    ['diagnostic', (value: any) => (value.diagnostics[0].extra = true)],
    ['recovery', (value: any) => (value.recovery.extra = true)],
    ['recovery issue', (value: any) => (value.recovery.issues[0].extra = true)],
    ['receipt', (value: any) => (value.receipt.extra = true)],
    ['conservation', (value: any) => (value.receipt.conservation.extra = true)],
  ])('rejects an unknown field at the %s object layer', (_layer, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/unknown field/i)
  })

  it.each([
    ['schemaVersion', (value: any) => (value.schemaVersion = 1)],
    ['source', (value: any) => (value.source = 'source')],
    ['blocks', (value: any) => (value.blocks = {})],
    ['block kind', (value: any) => (value.blocks[0].kind = 1)],
    ['inline start', (value: any) => (value.blocks[0].inline[0].start = '0')],
    ['asset bytes', (value: any) => (value.assets[0].bytes = ['0'])],
    ['recovery status', (value: any) => (value.recovery.status = false)],
  ])('rejects a wrong primitive for %s', (_field, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow()
  })

  it('rejects non-finite numeric values without coercion', () => {
    const value = validDocument()
    value.blocks[0].evidence.confidence = Number.NaN
    expect(() => decodeStructDocument(value)).toThrow(/finite/i)
  })

  it('rejects inline ranges outside their owning text', () => {
    const value = validDocument()
    value.blocks[0].inline[0].end = 6
    expect(() => decodeStructDocument(value)).toThrow(/text length/i)
  })

  it.each([
    [
      'duplicate block id',
      (value: any) => value.blocks.push({ ...value.blocks[0] }),
    ],
    [
      'duplicate relationship target',
      (value: any) => (value.relationships[0].to = ['block-1', 'block-1']),
    ],
    [
      'duplicate inline target',
      (value: any) =>
        (value.blocks[0].inline[0].targetIds = ['block-1', 'block-1']),
    ],
    [
      'duplicate author note id',
      (value: any) =>
        value.metadata.authorNotes.push({
          ...value.metadata.authorNotes[0],
        }),
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate/i)
  })

  it.each([
    ['block id', (value: any) => (value.blocks[0].id = '../block')],
    ['asset id', (value: any) => (value.assets[0].id = 'asset id')],
    ['document id', (value: any) => (value.documentId = ' document')],
  ])('rejects a non-canonical %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/identifier|id/i)
  })

  it('rejects malformed bytes and preserves no binary object representation', () => {
    const value = validDocument()
    for (const bytes of ['not-base64', 'AB==']) {
      value.assets[0].bytes = bytes
      expect(() => decodeStructDocument(value)).toThrow(/base64/i)
    }

    const jsonValue = JSON.parse(JSON.stringify(validDocument()))
    jsonValue.assets[0].bytes = [0, 255, 128]
    expect(decodeStructDocument(jsonValue).assets[0]?.bytes).toEqual(
      new Uint8Array([0, 255, 128]),
    )
    jsonValue.assets[0].bytes = { 0: 0, 1: 255, 2: 128 }
    expect(() => decodeStructDocument(jsonValue)).toThrow()
  })

  it('rejects Uint8Array values with enumerable own string properties', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, 'extra', {
      value: 'must not be discarded',
      enumerable: true,
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects Uint8Array values with own symbol properties', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, Symbol('extra'), {
      value: 'must not be discarded',
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects Uint8Array subclasses rather than discarding their prototype state', () => {
    const value = validDocument()
    class SubclassedBytes extends Uint8Array {}
    value.assets[0].bytes = new SubclassedBytes([0, 255, 128]) as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects a spoofed Uint8Array brand after a mutating toStringTag getter', () => {
    const value = validDocument()
    const bytes = new Int8Array([0, -1, -128])
    Object.setPrototypeOf(bytes, Uint8Array.prototype)
    Object.defineProperty(bytes, Symbol.toStringTag, {
      configurable: true,
      get() {
        delete (bytes as any)[Symbol.toStringTag]
        return 'Uint8Array'
      },
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects a self-deleting toStringTag accessor on a real Uint8Array', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, Symbol.toStringTag, {
      configurable: true,
      get() {
        delete (bytes as any)[Symbol.toStringTag]
        return 'Uint8Array'
      },
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects an own length accessor without invoking or mutating through it', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    const before = [...bytes]
    let getterCalls = 0
    Object.defineProperty(bytes, 'length', {
      configurable: true,
      get() {
        getterCalls += 1
        bytes[0] = 17
        return before.length
      },
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(getterCalls).toBe(0)
    expect([...bytes]).toEqual(before)
    expect(Object.getOwnPropertyDescriptor(bytes, 'length')?.get).toBeTypeOf(
      'function',
    )
  })

  it('rejects non-index bytes before touching a proxy prototype', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, 'extra', { value: true })
    const traps = { get: 0, ownKeys: 0, descriptor: 0 }
    const prototype = new Proxy(Uint8Array.prototype, {
      get(target, property, receiver) {
        traps.get += 1
        return Reflect.get(target, property, receiver)
      },
      ownKeys(target) {
        traps.ownKeys += 1
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.descriptor += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    Object.setPrototypeOf(bytes, prototype)
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(traps).toEqual({ get: 0, ownKeys: 0, descriptor: 0 })
  })

  it('rejects proxy prototypes before reflective traps can mutate the input', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    const before = [...bytes]
    const traps = { ownKeys: 0, descriptor: 0, constructorGet: 0 }
    const constructor = new Proxy(Uint8Array, {
      get(target, property, receiver) {
        if (property === 'prototype') {
          traps.constructorGet += 1
          bytes[0] = 17
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const prototype = new Proxy(Uint8Array.prototype, {
      ownKeys(target) {
        traps.ownKeys += 1
        bytes[0] = 17
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.descriptor += 1
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        return property === 'constructor' && descriptor !== undefined
          ? { ...descriptor, value: constructor }
          : descriptor
      },
    })
    Object.setPrototypeOf(bytes, prototype)
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(traps).toEqual({ ownKeys: 0, descriptor: 0, constructorGet: 0 })
    expect([...bytes]).toEqual(before)
  })

  it('rejects cross-realm Uint8Array values in favor of JSON-safe byte forms', () => {
    const value = validDocument()
    value.assets[0].bytes = runInNewContext(
      'new Uint8Array([0, 255, 128])',
    ) as any

    expect(() => decodeStructDocument(value)).toThrow(
      /canonical Uint8Array|asset|bytes/i,
    )
  })

  it('verifies present asset bytes against the declared SHA-256 and permits absent bytes', () => {
    const tampered = validDocument()
    tampered.assets[0].bytes = 'AP+B'
    expect(() => decodeStructDocument(tampered)).toThrow(/asset|bytes|sha256/i)

    const absent = validDocument()
    delete (absent.assets[0] as any).bytes
    expect(() => decodeStructDocument(absent)).not.toThrow()
  })

  it('keeps a supported 0.1.0 document unchanged through migration', () => {
    const migrated = migrateStructDocument(validDocument())
    expect(migrated.schemaVersion).toBe('0.1.0')
    expect(migrated).not.toHaveProperty('documentId')
    expect(migrated.receipt).not.toHaveProperty('documentId')
  })

  it('canonically decodes the declared current 0.2.0 binding without migration', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    seal(value)

    expect(migrateStructDocument(value)).toMatchObject({
      schemaVersion: '0.2.0',
      documentId: 'fixture-document',
      receipt: { schemaVersion: '0.2.0', documentId: 'fixture-document' },
    })
  })

  it('strictly decodes the optional model consultation receipt on 0.2.0', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    seal(value)

    const decoded = decodeStructDocument(value)
    expect(decoded.receipt.modelConsultations).toMatchObject({
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
    })

    value.receipt.modelConsultations.extra = true
    expect(() => decodeStructDocument(value)).toThrow()
  })

  it.each(['0.3.0', '9.9.9', '', null, 1])(
    'fails closed on unknown schema version %s',
    (schemaVersion) => {
      const value = validDocument()
      value.schemaVersion = schemaVersion as never
      expect(() => migrateStructDocument(value)).toThrow(/schema version/i)
    },
  )

  it('contains cyclic and bigint schema versions as StructCodecError', () => {
    const cyclic = validDocument() as any
    const version: any = {}
    version.self = version
    cyclic.schemaVersion = version
    expect(() => decodeStructDocument(cyclic)).toThrow(StructCodecError)

    const bigint = validDocument() as any
    bigint.schemaVersion = 1n
    expect(() => decodeStructDocument(bigint)).toThrow(StructCodecError)
  })

  it('verifies the canonical generated digest for both supported versions', () => {
    expect(() => decodeStructDocument(validDocument())).not.toThrow()

    const legacy = validDocument()
    legacy.receipt.generatedSha256 = hash
    expect(() => decodeStructDocument(legacy)).toThrow(/digest|sha256/i)

    const current = validDocument() as any
    current.schemaVersion = '0.2.0'
    current.documentId = 'fixture-document'
    current.receipt.schemaVersion = '0.2.0'
    current.receipt.documentId = 'fixture-document'
    seal(current)
    expect(() => decodeStructDocument(current)).not.toThrow()
    current.receipt.generatedSha256 = hash
    expect(() => decodeStructDocument(current)).toThrow(/digest|sha256/i)
  })

  it.each([
    [
      'relationship from',
      (value: any) => (value.relationships[0].from = 'missing'),
    ],
    [
      'relationship to',
      (value: any) => (value.relationships[0].to = ['missing']),
    ],
    ['page block', (value: any) => (value.pages[0].blocks = ['missing'])],
    [
      'page column block',
      (value: any) => (value.pages[0].columns[0].blockIds = ['missing']),
    ],
    [
      'fallback asset',
      (value: any) => (value.blocks[0].fallbackAssetIds = ['missing']),
    ],
    [
      'inline target',
      (value: any) => (value.blocks[0].inline[0].targetIds = ['missing']),
    ],
    [
      'author note target',
      (value: any) => (value.metadata.authorNotes[0].target = 'missing'),
    ],
  ])('rejects a dangling %s reference', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(
      /reference|target|dangling/i,
    )
  })

  it.each([
    ['asset and block', (value: any) => (value.assets[0].id = 'block-1')],
    [
      'diagnostic and block',
      (value: any) => (value.diagnostics[0].id = 'block-1'),
    ],
    [
      'relationship and block',
      (value: any) => (value.relationships[0].id = 'block-1'),
    ],
  ])('rejects cross-category duplicate ids (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it.each([
    [
      'author notes within the namespace',
      (value: any) =>
        value.metadata.authorNotes.push({
          ...value.metadata.authorNotes[0],
        }),
    ],
    [
      'source observation anchors within the namespace',
      (value: any) =>
        (value.blocks[0].sourceObservationAnchorIds = ['anchor-1', 'anchor-1']),
    ],
    [
      'author note and block',
      (value: any) => (value.metadata.authorNotes[0].id = 'block-1'),
    ],
    [
      'author note and source observation anchor',
      (value: any) => (value.metadata.authorNotes[0].id = 'anchor-1'),
    ],
    [
      'source observation anchor and block',
      (value: any) =>
        (value.blocks[0].sourceObservationAnchorIds = ['block-1']),
    ],
    [
      'source observation anchors across blocks',
      (value: any) => {
        value.blocks.push({
          ...value.blocks[0],
          id: 'block-2',
          order: 1,
          page: null,
          text: '',
          inline: [],
          sourceObservationAnchorIds: ['anchor-1'],
        })
        value.receipt.blockCount = value.blocks.length
        value.receipt.conservation.structBlockCount = value.blocks.length
      },
    ],
  ])('rejects semantic ids reused across namespaces (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/DUPLICATE_IDENTIFIER/i)
  })

  it('rejects emitted XHTML ids that collide after stable normalization', () => {
    const value = validDocument()
    value.metadata.authorNotes![0].id = '1'
    value.blocks[0].sourceObservationAnchorIds = ['n-1']
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value as any)).toThrow(
      /duplicate|identifier/i,
    )
  })

  it('rejects a normalized relationship id colliding with a block id', () => {
    const value = validDocument() as any
    value.blocks[0].id = 'n-1'
    value.metadata.authorNotes[0].target = 'n-1'
    value.blocks[0].inline[0].href = '#n-1'
    value.blocks[0].inline[0].targetIds = ['n-1']
    value.blocks[0].inline[0].relationshipId = '1'
    value.relationships[0].id = '1'
    value.relationships[0].from = 'n-1'
    value.relationships[0].to = ['n-1']
    value.relationships[0].candidates[0].target = 'n-1'
    value.pages[0].blocks = ['n-1']
    value.pages[0].columns[0].blockIds = ['n-1']
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value)).toThrow(/duplicate|identifier/i)
  })

  it('emits a relationship id only once when used in two blocks', async () => {
    const value = validDocument() as any
    const second = { ...value.blocks[0], id: 'block-2', order: 1, page: null }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    delete second.sourceObservationAnchorIds
    second.inline = [{ ...value.blocks[0].inline[0] }]
    value.blocks.push(second)
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 10
    value.receipt.conservation.structTextCharacterCount = 10
    value.receipt.textCharacterCount = 10
    value.blocks[0].text = 'Hello'
    value.blocks[1].text = 'World'
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml.match(/<a id="relationship-1"/g)).toHaveLength(1)
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('rejects a composed table-cell id colliding with a block id', () => {
    const value = validDocument() as any
    value.blocks[0].id = 'table'
    value.blocks[0].kind = 'table'
    value.blocks[0].table.cells[0].id = 'cell'
    value.metadata.authorNotes[0].target = 'table'
    value.blocks[0].inline[0].href = '#table'
    value.blocks[0].inline[0].targetIds = ['table']
    value.relationships[0].from = 'table'
    value.relationships[0].to = ['table']
    value.relationships[0].candidates[0].target = 'table'
    value.pages[0].blocks = ['table']
    value.pages[0].columns[0].blockIds = ['table']
    const second = {
      ...value.blocks[0],
      id: 'table-cell',
      order: 1,
      page: null,
    }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    delete second.sourceObservationAnchorIds
    second.inline = []
    second.text = ''
    value.blocks.push(second)
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value)).toThrow(/duplicate|identifier/i)
  })

  it.each([
    ['asset id', ['asset-1'], 'assets/asset-1.bin'],
    [
      'external URL',
      ['https://example.test/reference'],
      'https://example.test/reference',
    ],
  ])(
    'renders a relationship %s using its target kind',
    async (_label, targets, expectedHref) => {
      const value = validDocument() as any
      value.relationships[0].to = targets
      seal(value)
      const decoded = decodeStructDocument(value)
      expect(renderPublicationXhtml(decoded)).toContain(
        `href="${expectedHref}"`,
      )
      await expect(buildStructEpub(decoded)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    },
  )

  it('rejects later-position source anchors through decode and migration', () => {
    const value = validDocument() as any
    value.blocks[0].sourceObservationAnchorIds = ['anchor-1', 'n-1']
    value.metadata.authorNotes[0].id = '1'
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => migrateStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it('maps later-position anchors from every block into migration validation', () => {
    const value = validDocument() as any
    delete value.blocks[0].sourceObservationAnchorIds
    const second = { ...value.blocks[0], id: 'block-2', order: 1, page: null }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    second.inline = []
    second.text = ''
    second.sourceObservationAnchorIds = ['anchor-1', 'n-1']
    value.blocks.push(second)
    value.metadata.authorNotes[0].id = '1'
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    seal(value)
    expect(() => migrateStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it('rejects a forbidden XML 1.0 string before digest sealing', () => {
    const value = validDocument() as any
    value.metadata.title = 'bad-\uD800'
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/string|unicode|xml/i)
  })

  it('preserves valid Unicode through decode, XHTML, and EPUB reopen', async () => {
    const value = validDocument() as any
    value.metadata.title = 'Valid 🌟 — текст'
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('Valid 🌟 — текст')
    const epub = await buildStructEpub(decoded)
    expect(strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)).toContain(
      'Valid 🌟 — текст',
    )
  })

  it.each([
    [
      'box width',
      (value: any) => (value.blocks[0].evidence.boxes[0].width = -1),
    ],
    ['asset width', (value: any) => (value.assets[0].width = -1)],
    ['page height', (value: any) => (value.pages[0].height = -1)],
    [
      'box rotation',
      (value: any) => (value.blocks[0].evidence.boxes[0].rotation = 0.5),
    ],
    ['page rotation', (value: any) => (value.pages[0].rotation = 360)],
  ])(
    'rejects invalid nonnegative dimension or rotation (%s)',
    (_label, mutate) => {
      const value = validDocument()
      mutate(value)
      expect(() => decodeStructDocument(value)).toThrow(
        /number|rotation|range/i,
      )
    },
  )

  it.each([
    ['box page', (value: any) => (value.blocks[0].evidence.boxes[0].page = 0)],
    ['evidence page', (value: any) => (value.blocks[0].evidence.pages[0] = 0)],
    ['block page', (value: any) => (value.blocks[0].page = 0)],
    ['page layout page', (value: any) => (value.pages[0].page = 0)],
    ['diagnostic page', (value: any) => (value.diagnostics[0].pages[0] = 0)],
    [
      'recovery issue page',
      (value: any) => (value.recovery.issues[0].pages = [0]),
    ],
    [
      'furniture page',
      (value: any) => (value.blocks[0].furniture.pages[0] = 0),
    ],
  ])('rejects a non-positive %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/page|number|range/i)
  })

  it.each([
    [
      'box width',
      (value: any) => (value.blocks[0].evidence.boxes[0].width = 0),
    ],
    [
      'box height',
      (value: any) => (value.blocks[0].evidence.boxes[0].height = 0),
    ],
    ['asset width', (value: any) => (value.assets[0].width = 0)],
    ['asset height', (value: any) => (value.assets[0].height = 0)],
    ['page width', (value: any) => (value.pages[0].width = 0)],
    ['page height', (value: any) => (value.pages[0].height = 0)],
  ])('rejects non-positive materialized geometry (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/positive|range|number/i)
  })

  it.each([
    [
      'missing page layout for block',
      (value: any) => {
        value.blocks[0].page = null
        value.pages = []
      },
    ],
    ['page block membership', (value: any) => (value.pages[0].blocks = [])],
    [
      'column membership',
      (value: any) => (value.pages[0].columns[0].blockIds = []),
    ],
    [
      'evidence page membership',
      (value: any) => {
        value.blocks[0].page = null
        value.blocks[0].evidence.pages = []
      },
    ],
    [
      'evidence box page agreement',
      (value: any) => (value.blocks[0].evidence.pages = []),
    ],
  ])('rejects incoherent page topology (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(
      /page|membership|evidence/i,
    )
  })

  it.each(['single', null] as const)(
    'accepts a %s block column mapped to a single page column',
    (column) => {
      const value = validDocument()
      const mutable = value as any
      mutable.blocks[0].column = column
      seal(value)
      expect(() => decodeStructDocument(value)).not.toThrow()
    },
  )

  it('accepts one single and one left column on a page', () => {
    const value = validDocument()
    value.pages[0].columns.push({
      id: 'column-2',
      side: 'left',
      blockIds: [],
    })
    seal(value)
    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it.each([
    [
      'single block in left column',
      (value: any) => (value.pages[0].columns[0].side = 'left'),
    ],
    [
      'left block in single column',
      (value: any) => (value.blocks[0].column = 'left'),
    ],
    [
      'duplicate single column side',
      (value: any) =>
        value.pages[0].columns.push({
          id: 'column-2',
          side: 'single',
          blockIds: [],
        }),
    ],
    [
      'duplicate left column side',
      (value: any) =>
        value.pages[0].columns.push(
          { id: 'column-2', side: 'left', blockIds: [] },
          { id: 'column-3', side: 'left', blockIds: [] },
        ),
    ],
  ])('rejects incoherent column semantics (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/column|page/i)
  })

  it('requires a paged block to list its page in block evidence', () => {
    const value = validDocument()
    value.blocks[0].evidence.pages = []
    value.blocks[0].evidence.boxes = []
    expect(() => decodeStructDocument(value)).toThrow(/page|evidence/i)
  })

  it.each([
    ['row bound', (value: any) => (value.blocks[0].table.cells[0].row = 1)],
    [
      'column bound',
      (value: any) => (value.blocks[0].table.cells[0].column = 1),
    ],
    [
      'row span bound',
      (value: any) => (value.blocks[0].table.cells[0].rowSpan = 2),
    ],
    [
      'column span bound',
      (value: any) => (value.blocks[0].table.cells[0].columnSpan = 2),
    ],
  ])('rejects table cell outside table bounds (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/table|bound|span/i)
  })

  it.each([
    [
      'direct cell intersection',
      (value: any) => {
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
        })
      },
    ],
    [
      'row span intersection',
      (value: any) => {
        value.blocks[0].table.rows = 2
        value.blocks[0].table.cells[0].rowSpan = 2
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
          row: 1,
          rowSpan: 1,
        })
      },
    ],
    [
      'column span intersection',
      (value: any) => {
        value.blocks[0].table.columns = 2
        value.blocks[0].table.cells[0].columnSpan = 2
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
          column: 1,
          columnSpan: 1,
        })
      },
    ],
  ])('rejects table %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/table|occup|overlap/i)
  })

  it.each([
    'content.xhtml',
    'assets/figure.bin?query',
    'assets/figure.bin#part',
    'assets/a b.bin',
  ])('rejects a non-canonical EPUB asset path %s', (href) => {
    const value = validDocument()
    value.assets[0].href = href
    expect(() => decodeStructDocument(value)).toThrow(/href|path/i)
  })

  it('rejects incoherent conservation receipts and page bindings', () => {
    const accounted = validDocument()
    accounted.receipt.conservation.accountedSourceAssetCount = 2
    expect(() => decodeStructDocument(accounted)).toThrow(
      /conservation|source/i,
    )

    const furniture = validDocument()
    furniture.blocks[0].kind = 'furniture'
    expect(() => decodeStructDocument(furniture)).toThrow(
      /furniture|conservation/i,
    )

    const pages = validDocument()
    pages.source.pageCount = 0
    expect(() => decodeStructDocument(pages)).toThrow(/page/i)
  })

  it('contains hostile descriptors, revoked proxies, and model receipt cycles as StructCodecError', () => {
    const accessor = validDocument()
    Object.defineProperty(accessor.blocks[0], 'hostile', {
      enumerable: true,
      get() {
        throw new Error('getter executed')
      },
    })
    expect(() => decodeStructDocument(accessor)).toThrow(StructCodecError)

    const proxied = validDocument() as any
    const revoked = Proxy.revocable(proxied.blocks, {})
    revoked.revoke()
    proxied.blocks = revoked.proxy
    expect(() => decodeStructDocument(proxied)).toThrow(StructCodecError)

    const hostileBytes = validDocument() as any
    const bytes = Proxy.revocable(new Uint8Array([0, 255, 128]), {})
    bytes.revoke()
    hostileBytes.assets[0].bytes = bytes.proxy
    expect(() => decodeStructDocument(hostileBytes)).toThrow(StructCodecError)

    const cycle = validDocument() as any
    cycle.schemaVersion = '0.2.0'
    cycle.documentId = 'fixture-document'
    cycle.receipt.schemaVersion = '0.2.0'
    cycle.receipt.documentId = 'fixture-document'
    cycle.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    cycle.receipt.modelConsultations.inputs = cycle.receipt.modelConsultations
    expect(() => decodeStructDocument(cycle)).toThrow(StructCodecError)
  })

  it('binds model consultation receipts to the enclosing document and source', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'other-document',
      sourceSha256: 'b'.repeat(64),
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    expect(() => decodeStructDocument(value)).toThrow(/model|document|source/i)
  })
})
