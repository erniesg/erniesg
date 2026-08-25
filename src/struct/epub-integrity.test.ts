import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  MAX_STRUCT_ASSETS,
  MAX_STRUCT_ASSET_BYTES_TOTAL,
  StructCodecError,
} from './codec/parsers'
import { buildStructEpub } from './epub'
import { legacyStructDigest, structDigest } from './ids'
import { sha256HexSync } from './sha256'
import type { StructDocument } from './types'

function refreshReceipt(document: StructDocument) {
  document.receipt.documentId = document.documentId
  document.receipt.sourceSha256 = document.source.sha256
  document.receipt.blockCount = document.blocks.length
  document.receipt.assetCount = document.assets.length
  document.receipt.relationshipCount = document.relationships.length
  document.receipt.diagnosticCount = document.diagnostics.length
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    ...(receipt.modelConsultations
      ? { modelConsultations: receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return document
}

function documentWithHref(href: string): StructDocument {
  const evidence = {
    confidence: 1,
    pages: [1],
    boxes: [],
    sourceIds: ['fixture-source'],
  }
  return refreshReceipt({
    schemaVersion: '0.2.0',
    documentId: 'epub-integrity-document',
    source: {
      format: 'unknown',
      fileName: 'epub-integrity.fixture',
      sha256: 'a'.repeat(64),
      byteLength: 1,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'EPUB integrity fixture',
      subtitle: '',
      authors: [],
      abstract: '',
      updated: '1970-01-01',
    },
    blocks: [
      {
        id: 'source',
        kind: 'paragraph',
        text: 'link',
        page: 1,
        order: 0,
        column: 'single',
        inline: [{ start: 0, end: 4, href }],
        evidence,
      },
      {
        id: 'target',
        kind: 'heading',
        text: 'Target',
        page: 1,
        order: 1,
        column: 'single',
        inline: [],
        evidence,
        attributes: { level: 2 },
      },
    ],
    assets: [],
    relationships: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['source', 'target'],
        columns: [
          {
            id: 'page-1',
            side: 'single',
            blockIds: ['source', 'target'],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'Ready',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'epub-integrity-document',
      sourceSha256: 'a'.repeat(64),
      blockCount: 2,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 10,
      conservation: {
        sourceNodeCount: 2,
        accountedSourceNodeCount: 2,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 1,
        accountedSourceAnnotationCount: 1,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 10,
        structBlockCount: 2,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 10,
      },
      generatedSha256: 'b'.repeat(64),
    },
  })
}

function documentWithGenericReceipt(): StructDocument {
  const document = documentWithHref('')
  document.receipt.modelConsultations = {
    schemaVersion: '1.0.0',
    documentId: document.documentId!,
    sourceSha256: document.source.sha256,
    consultations: [],
    decisions: [],
    metrics: {
      totalDecisionCount: 0,
      totalConsultationCount: 0,
      consultationRate: 0,
      byDecisionClass: {},
    },
  }
  return refreshReceipt(document)
}

describe('source-neutral consultation receipts', () => {
  it('packages a structurally closed receipt for a non-PDF source', async () => {
    const document = documentWithGenericReceipt()
    expect(document.source.format).toBe('unknown')
    await expect(buildStructEpub(document)).resolves.toBeDefined()
  })

  it.each([
    ['unknown top-level fields', (receipt: any) => (receipt.extra = true)],
    [
      'credential-shaped values',
      (receipt: any) =>
        receipt.consultations.push({
          providerId: ['sk', 'proj-FAKEFAKEFAKEFAKE'].join('-'),
        }),
    ],
    [
      'accessor values',
      (receipt: any) =>
        Object.defineProperty(receipt.metrics, 'unsafe', {
          enumerable: true,
          get: () => 1,
        }),
    ],
  ])('rejects %s at the generic receipt boundary', async (_label, mutate) => {
    const document = documentWithGenericReceipt()
    mutate(document.receipt.modelConsultations)
    await expect(buildStructEpub(document)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('rejects an identity-mismatched generic receipt', async () => {
    const document = documentWithGenericReceipt()
    document.receipt.modelConsultations!.documentId = 'another-document'
    await expect(buildStructEpub(document)).rejects.toThrow(
      'MODEL_CONSULTATION_DOCUMENT_MISMATCH',
    )
  })

  it.each(['consultations', 'decisions'] as const)(
    'rejects a resealed non-PDF receipt with a scalar %s member before EPUB packaging',
    async (field) => {
      const document = documentWithGenericReceipt()
      ;(document.receipt.modelConsultations as any)[field] = [null]
      refreshReceipt(document)

      await expect(buildStructEpub(document)).rejects.toThrow(
        'INVALID_MODEL_CONSULTATION_RECEIPT',
      )
    },
  )
})

function legacyDocumentWithHref(href: string, locale?: string): StructDocument {
  const current = documentWithHref(href)
  if (locale) {
    current.blocks[0]!.evidence.boxes = [
      { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, rotation: 0 },
    ]
  }
  const {
    documentId: _documentId,
    receipt: currentReceipt,
    ...documentFields
  } = current
  const { documentId: _receiptDocumentId, ...legacyReceipt } = currentReceipt
  const legacy: StructDocument = {
    ...documentFields,
    schemaVersion: '0.1.0',
    receipt: { ...legacyReceipt, schemaVersion: '0.1.0' },
  }
  const { receipt, ...withoutReceipt } = legacy
  receipt.generatedSha256 = legacyStructDigest(
    {
      ...withoutReceipt,
      conservation: receipt.conservation,
      assets: legacy.assets.map(({ bytes: _bytes, ...asset }) => asset),
    },
    locale,
  )
  return legacy
}

describe('STRUCT EPUB href integrity', () => {
  it('reopens an exact profiled stylesheet and immutable profile receipt', async () => {
    const profile = {
      id: 'mobile',
      version: '1.1.0',
      fileName: 'publication-mobile.epub',
      pageProgressionDirection: 'ltr' as const,
      renditionFlow: 'scrolled-continuous' as const,
      configurationSha256: 'c'.repeat(64),
      css: 'body { font-size: 15px; }',
    }
    const epub = await buildStructEpub(documentWithHref('#target'), {
      profile,
    })
    const files = unzipSync(epub.bytes)

    expect(epub.fileName).toBe(profile.fileName)
    expect(epub.profile).toMatchObject({
      id: profile.id,
      version: profile.version,
      configurationSha256: profile.configurationSha256,
    })
    expect(strFromU8(files['EPUB/styles.css']!)).toBe(profile.css)
    expect(JSON.parse(strFromU8(files['EPUB/profile.json']!))).toEqual(
      epub.profile,
    )
    expect(strFromU8(files['EPUB/package.opf']!)).toContain(
      '<meta property="rendition:flow">scrolled-continuous</meta>',
    )
  })

  it('rejects a profile asset id collision while preserving unprofiled packaging', async () => {
    const document = documentWithHref('#target')
    const bytes = new Uint8Array([1, 2, 3])
    document.assets.push({
      id: 'profile',
      kind: 'figure',
      href: 'assets/profile.bin',
      mediaType: 'application/octet-stream',
      sha256: sha256HexSync(bytes),
      width: 1,
      height: 1,
      bytes,
      sourceObjectIds: ['profile-source'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['profile-source'],
      },
      fallback: 'asset',
    })
    refreshReceipt(document)
    await expect(buildStructEpub(document)).rejects.toThrow(
      /duplicate|reserved|asset id/i,
    )
    await expect(
      buildStructEpub(document, {
        profile: {
          id: 'mobile',
          version: '1.0.0',
          fileName: 'publication-mobile.epub',
          pageProgressionDirection: 'ltr',
          renditionFlow: 'paginated',
          configurationSha256: 'c'.repeat(64),
          css: 'body {}',
        },
      }),
    ).rejects.toThrow(/duplicate|reserved|asset id/i)
  })

  it('revalidates an asset snapshot at the EPUB boundary and reopens unchanged bytes', async () => {
    const document = documentWithHref('#target')
    const bytes = new Uint8Array([1, 2, 3])
    document.assets.push({
      id: 'binary',
      kind: 'figure',
      href: 'assets/binary.bin',
      mediaType: 'application/octet-stream',
      sha256: sha256HexSync(bytes),
      width: 1,
      height: 1,
      bytes,
      sourceObjectIds: ['binary-source'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['binary-source'],
      },
      fallback: 'asset',
    })
    refreshReceipt(document)
    const epub = await buildStructEpub(document)
    expect(unzipSync(epub.bytes)['EPUB/assets/binary.bin']).toEqual(bytes)
    document.assets[0]!.bytes![0] = 9
    await expect(buildStructEpub(document)).rejects.toThrow(
      /bytes|SHA-256|digest/i,
    )
  })

  it('rejects a self-authored or malformed profile before packaging', async () => {
    await expect(
      buildStructEpub(documentWithHref('#target'), {
        profile: {
          id: '../mobile',
          version: '1.1.0',
          fileName: 'publication-mobile.epub',
          pageProgressionDirection: 'ltr',
          renditionFlow: 'scrolled-continuous',
          configurationSha256: 'c'.repeat(64),
          css: 'body {}',
        },
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')
  })

  it.each([
    ['same-document fragment', '#target'],
    ['packaged XHTML fragment', 'content.xhtml#target'],
    ['packaged document', 'nav.xhtml'],
    ['HTTP URL', 'http://example.test/reference'],
    ['HTTPS URL', 'https://example.test/reference?q=one&part=two'],
    ['email URL', 'mailto:reader@example.test'],
  ])('permits a valid %s', async (_label, href) => {
    await expect(
      buildStructEpub(documentWithHref(href)),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('accepts serialized legacy 0.1.0 documents without document bindings', async () => {
    await expect(
      buildStructEpub(legacyDocumentWithHref('#target')),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('accepts a legacy digest created under a different ICU collation', async () => {
    const lithuanian = legacyDocumentWithHref('#target', 'lt')
    const english = legacyDocumentWithHref('#target', 'en')
    expect(lithuanian.receipt.generatedSha256).not.toBe(
      english.receipt.generatedSha256,
    )
    await expect(buildStructEpub(lithuanian)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('requires document bindings on current 0.2.0 documents', async () => {
    const document = documentWithHref('#target')
    delete document.documentId
    delete document.receipt.documentId

    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      'STRUCT_RECEIPT_BINDING_MISMATCH',
    )
  })

  it('rejects partial or invalid document bindings', async () => {
    const invalidBindings: Array<[string, (document: StructDocument) => void]> =
      [
        [
          'document only',
          (document) => {
            delete document.receipt.documentId
          },
        ],
        [
          'receipt only',
          (document) => {
            delete document.documentId
          },
        ],
        [
          'empty',
          (document) => {
            document.documentId = ''
            document.receipt.documentId = ''
          },
        ],
        [
          'null',
          (document) => {
            Object.assign(document, { documentId: null })
            Object.assign(document.receipt, { documentId: null })
          },
        ],
        [
          'mismatched',
          (document) => {
            document.receipt.documentId = 'another-document'
          },
        ],
      ]
    for (const [label, mutate] of invalidBindings) {
      const document = documentWithHref('#target')
      mutate(document)
      await expect(
        buildStructEpub(document),
        `${label} bindings must fail closed`,
      ).rejects.toThrow('STRUCT_RECEIPT_BINDING_MISMATCH')
    }
  })

  it('rejects matching unsupported STRUCT versions', async () => {
    const document = documentWithHref('#target')
    Object.assign(document, { schemaVersion: '9.9.9' })
    Object.assign(document.receipt, { schemaVersion: '9.9.9' })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      'STRUCT_RECEIPT_BINDING_MISMATCH',
    )
  })

  it('packages the hidden-link rule used by expanded semantic groups', async () => {
    const epub = await buildStructEpub(documentWithHref('#target'))
    const files = unzipSync(epub.bytes)
    expect(strFromU8(files['EPUB/styles.css'])).toContain(
      '.additional-semantic-reference',
    )
  })

  it.each([
    ['missing fragment', '#missing'],
    ['missing packaged document', 'missing.xhtml'],
    ['missing fragment in a packaged document', 'content.xhtml#missing'],
  ])('rejects a %s', async (_label, href) => {
    await expect(buildStructEpub(documentWithHref(href))).rejects.toThrow(
      /dangling internal reference/i,
    )
  })

  it.each([
    ['trailing slash', 'supplement.xhtml/', 'supplement.xhtml'],
    [
      'empty path segment',
      'chapters//supplement.xhtml',
      'chapters/supplement.xhtml',
    ],
  ])(
    'does not alias a %s href to a different packaged document',
    async (_label, href, packagedHref) => {
      const document = documentWithHref(href)
      const supplementBytes = new TextEncoder().encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Different exact path</p></body></html>',
      )
      document.assets.push({
        id: `supplement-${document.assets.length}`,
        kind: 'figure',
        href: packagedHref,
        mediaType: 'application/xhtml+xml',
        sha256: sha256HexSync(supplementBytes),
        width: 1,
        height: 1,
        bytes: supplementBytes,
        sourceObjectIds: ['fixture-supplement'],
        evidence: {
          confidence: 1,
          pages: [1],
          boxes: [],
          sourceIds: ['fixture-supplement'],
        },
        fallback: 'asset',
      })

      await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
        /dangling internal reference/i,
      )
    },
  )

  it.each([
    ['script URL', 'javascript:alert(1)'],
    ['embedded data URL', 'data:text/html,unsafe'],
    ['protocol-relative URL', '//example.test/reference'],
  ])('rejects an unsafe %s', async (_label, href) => {
    await expect(buildStructEpub(documentWithHref(href))).rejects.toThrow(
      /unsafe href/i,
    )
  })

  it('rejects reserved asset href collisions before packaging', async () => {
    const document = documentWithHref('#target')
    const assetBytes = new Uint8Array([0])
    document.assets.push({
      id: 'replacement-content',
      kind: 'figure',
      href: 'content.xhtml',
      mediaType: 'image/png',
      sha256: sha256HexSync(assetBytes),
      width: 1,
      height: 1,
      bytes: assetBytes,
      sourceObjectIds: ['fixture-asset'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-asset'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /reserved/i,
    )
  })

  it('rejects malformed packaged XHTML assets', async () => {
    const document = documentWithHref('#target')
    const assetBytes = new TextEncoder().encode(
      '<html><body><a href="#missing"></body>',
    )
    document.assets.push({
      id: 'supplement',
      kind: 'figure',
      href: 'supplement.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: sha256HexSync(assetBytes),
      width: 1,
      height: 1,
      bytes: assetBytes,
      sourceObjectIds: ['fixture-supplement'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-supplement'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /well-formed XHTML/i,
    )
  })

  it('rejects dangling namespaced hrefs in packaged XHTML assets', async () => {
    const document = documentWithHref('#target')
    const assetBytes = new TextEncoder().encode(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><body><a xlink:href="#missing">Missing</a></body></html>',
    )
    document.assets.push({
      id: 'namespaced-supplement',
      kind: 'figure',
      href: 'namespaced-supplement.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: sha256HexSync(assetBytes),
      width: 1,
      height: 1,
      bytes: assetBytes,
      sourceObjectIds: ['fixture-namespaced-supplement'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-namespaced-supplement'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /dangling internal reference/i,
    )
  })

  it('rejects a resealed receipt with a pending consultation before packaging', async () => {
    const document = documentWithGenericReceipt()
    document.receipt.modelConsultations!.consultations.push({
      status: 'pending',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      'EPUB_PENDING_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('redacts source directory components from the packaged artifact', async () => {
    const document = documentWithHref('#target')
    document.source.fileName = '/private/intake/fixture.pdf'
    const epub = await buildStructEpub(refreshReceipt(document))
    const artifact = strFromU8(unzipSync(epub.bytes)['EPUB/struct.json']!)

    expect(artifact).toContain('fixture.pdf')
    expect(artifact).not.toContain('/private/intake')
  })

  it.each([
    [
      'language',
      (document: StructDocument) => (document.metadata.language = 'en_US'),
    ],
    [
      'timestamp',
      (document: StructDocument) =>
        (document.metadata.artifactModifiedAt = '1970-01-01 00:00:00Z'),
    ],
    [
      'negative zero',
      (document: StructDocument) =>
        (document.blocks[0]!.evidence.confidence = -0),
    ],
  ])(
    'applies strict codec validation to direct builder input (%s)',
    async (_label, mutate) => {
      const document = documentWithHref('#target')
      mutate(document)
      await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow()
    },
  )

  it('accepts direct builder input with BCP-47 extensions and year 0001 dates', async () => {
    const document = documentWithHref('#target')
    document.metadata.language = 'en-US-u-ca-gregory'
    document.metadata.publicationDate = '0001-01-01'
    document.metadata.updated = '0001-12-31'

    await expect(
      buildStructEpub(refreshReceipt(document)),
    ).resolves.toBeDefined()
  })

  it('rejects an oversized direct asset list before reading an asset', async () => {
    const document = documentWithHref('#target')
    let assetReads = 0
    document.assets = new Proxy(new Array(MAX_STRUCT_ASSETS + 1), {
      get(target, property, receiver) {
        if (property !== 'length') assetReads += 1
        return Reflect.get(target, property, receiver)
      },
    }) as StructDocument['assets']

    await expect(buildStructEpub(document)).rejects.toThrow(
      'STRUCT_EPUB_ASSET_RESOURCE_LIMIT',
    )
    expect(assetReads).toBe(0)
  })

  it('rejects oversized direct asset bytes before inspecting asset scalars', async () => {
    const document = documentWithHref('#target')
    document.assets = [
      new Proxy(
        {
          bytes: new Proxy(new Uint8Array(), {
            get(target, property, receiver) {
              if (property === 'byteLength')
                return MAX_STRUCT_ASSET_BYTES_TOTAL + 1
              return Reflect.get(target, property, receiver)
            },
          }),
        },
        {
          get(target, property, receiver) {
            if (property === 'mediaType')
              throw new Error('asset scalar was inspected')
            return Reflect.get(target, property, receiver)
          },
        },
      ) as StructDocument['assets'][number],
    ]

    await expect(buildStructEpub(document)).rejects.toThrow(
      'STRUCT_EPUB_ASSET_RESOURCE_LIMIT',
    )
  })

  it('rejects a custom asset iterator without invoking it', async () => {
    const document = documentWithHref('#target')
    let iteratorCalls = 0
    Object.defineProperty(document.assets, Symbol.iterator, {
      configurable: true,
      value() {
        iteratorCalls += 1
        throw new Error('asset iterator invoked')
      },
    })

    await expect(buildStructEpub(document)).rejects.toThrow()
    expect(iteratorCalls).toBe(0)
  })

  it('rejects spoofed asset bytes without invoking their iterator', async () => {
    const document = documentWithHref('#target')
    let iteratorCalls = 0
    const bytes = {
      byteLength: 1,
      [Symbol.iterator]() {
        iteratorCalls += 1
        return [1][Symbol.iterator]()
      },
    }
    document.assets.push({
      id: 'spoofed-bytes',
      kind: 'figure',
      href: 'assets/spoofed.bin',
      mediaType: 'application/octet-stream',
      sha256: sha256HexSync(new Uint8Array([1])),
      width: 1,
      height: 1,
      bytes: bytes as unknown as Uint8Array,
      sourceObjectIds: ['spoofed-source'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['spoofed-source'],
      },
      fallback: 'asset',
    })
    refreshReceipt(document)

    await expect(buildStructEpub(document)).rejects.toThrow(/asset|bytes/i)
    expect(iteratorCalls).toBe(0)
  })

  it('rejects oversized direct table dimensions before reading render payloads', async () => {
    const document = documentWithHref('#target')
    const table = {
      rows: 100_001,
      columns: 1,
      cells: [],
      semantic: 'verified' as const,
    }
    document.blocks[0]!.kind = 'table'
    document.blocks[0]!.inline = []
    document.blocks[0]!.table = table
    refreshReceipt(document)

    let payloadReads = 0
    table.cells = new Proxy([], {
      get() {
        payloadReads += 1
        throw new Error('oversized table render payload was read')
      },
      ownKeys() {
        payloadReads += 1
        throw new Error('oversized table render payload was read')
      },
    })

    try {
      await buildStructEpub(document)
      throw new Error('expected table bounds failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('TABLE_BOUNDS')
    }
    expect(payloadReads).toBe(0)
  })

  it('rejects over-area direct table cells before reading cell payloads', async () => {
    const document = documentWithHref('#target')
    const cells = [{}, {}]
    const table = {
      rows: 1,
      columns: 1,
      cells,
      semantic: 'verified' as const,
    }
    document.blocks[0]!.kind = 'table'
    document.blocks[0]!.inline = []
    document.blocks[0]!.table = table as any
    refreshReceipt(document)

    let payloadReads = 0
    table.cells = cells.map(
      (cell) =>
        new Proxy(cell, {
          get() {
            payloadReads += 1
            throw new Error('over-area table cell payload was read')
          },
          ownKeys() {
            payloadReads += 1
            throw new Error('over-area table cell payload was read')
          },
        }),
    )

    try {
      await buildStructEpub(document)
      throw new Error('expected table bounds failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('TABLE_BOUNDS')
    }
    expect(payloadReads).toBe(0)
  })

  it.each([
    [
      'calendar-normalized timestamp',
      (document: StructDocument) =>
        (document.metadata.artifactModifiedAt = '2026-02-30T00:00:00Z'),
    ],
    [
      'duplicate BCP-47 extension singleton',
      (document: StructDocument) =>
        (document.metadata.language = 'en-a-foo-a-bar'),
    ],
    [
      'duplicate BCP-47 variant',
      (document: StructDocument) =>
        (document.metadata.language = 'de-1901-1901'),
    ],
    [
      'MIME wildcard',
      (document: StructDocument) => {
        document.assets = [
          {
            id: 'asset-1',
            kind: 'figure',
            href: 'asset.png',
            mediaType: '*/*',
            sha256: sha256HexSync(new Uint8Array([1])),
            width: 1,
            height: 1,
            bytes: new Uint8Array([1]),
            sourceObjectIds: [],
            evidence: { confidence: 1, pages: [1], boxes: [], sourceIds: [] },
            fallback: 'asset',
          },
        ]
      },
    ],
  ])('rejects invalid direct builder %s', async (_label, mutate) => {
    const document = documentWithHref('#target')
    mutate(document)

    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow()
  })

  it('accepts grandfathered and standard direct builder language tags', async () => {
    for (const language of [
      'i-klingon',
      'de-1901',
      'sl-rozaj-biske-1994',
      'en-US-u-ca-gregory',
    ]) {
      const document = documentWithHref('#target')
      document.metadata.language = language

      await expect(
        buildStructEpub(refreshReceipt(document)),
      ).resolves.toBeDefined()
    }
  })
})
