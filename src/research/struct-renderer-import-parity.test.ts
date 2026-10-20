import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { StructDocument } from '@erniesg/struct/document'
import {
  assertStructEpubArchiveByteLength as packageAssertStructEpubArchiveByteLength,
  buildStructEpub as packageBuildStructEpub,
} from '@erniesg/struct/renderers/epub'
import {
  renderPublicationXhtml as packageRenderPublicationXhtml,
  type StructXhtmlOptions,
} from '@erniesg/struct/renderers/xhtml'
import { structDigest } from '@erniesg/struct/identity'
import {
  assertStructEpubArchiveByteLength as localAssertStructEpubArchiveByteLength,
  buildStructEpub as localBuildStructEpub,
} from '../struct/epub'
import { renderPublicationXhtml as localRenderPublicationXhtml } from '../struct/xhtml'
import { buildStructDocument } from '../struct-adapters'
import { decodeReconstruction } from '../../tests/fixtures/struct-adapter-parity/observe'
import { reconstructDocx } from './docx-import'
import {
  buildEpub as renderResearchEpub,
  renderPublicationXhtml as renderResearchPublicationXhtml,
} from './epub'
import { papers } from './papers'

/**
 * E-04 dual-render parity evidence for the portable renderer import cut.
 *
 * The local compatibility copies (`src/struct/xhtml.ts`, `src/struct/epub.ts`,
 * `src/struct/emitted-ids.ts`) and the pinned public package renderers
 * (`@erniesg/struct/renderers/xhtml`, `@erniesg/struct/renderers/epub`) are
 * compared against each other on the real StructDocument fixtures that already
 * exist in this repository. Nothing here regenerates a frozen golden, an
 * expected value, a fixture, a profile or a snapshot: the digests below are
 * measurements of the two renderers, and the frozen parity snapshot
 * (`tests/fixtures/struct-adapter-parity/expected.json`) is left untouched.
 *
 * RULING (E-04 coordinator record): the pinned package renderers are the
 * APPROVED AUTHORITY for the StructDocument render path, so the production
 * import switch in `src/research/epub.ts` and
 * `src/research/reconstruction-materialization.ts` PROCEEDS and adopts the
 * package's output. The two renderers DISAGREE on two of the three real
 * fixtures; those disagreements are INTENTIONAL, RECORDED output changes, not
 * defects to paper over, and the local copies stay physically unchanged until
 * E-07 deletes them.
 *
 * MEASURED DIVERGENCE (base commit 9003ea7657ef73cbad271e6a82eab5f27f649e91):
 *
 *  1. List rendering. The package renderer groups consecutive `list-item`
 *     blocks into `<ul>`/`<ol>` with `<li>` children; the local copy has no
 *     list branch at all and renders each list item as a `<p>`.
 *  2. Furniture separators. The package renderer drops `furniture` blocks
 *     before joining; the local copy keeps the join separator, so it emits a
 *     blank line where a furniture block was skipped.
 *  3. Default renderer styles. The package `DEFAULT_STYLES` adds
 *     `figure.equation` and `ol, ul` rules that the local copy does not have,
 *     so `embedStyles` output differs even for a fixture whose blocks agree.
 *  4. Ingress validation. The package renderer normalizes and validates the
 *     document before rendering (schema version, receipt digest, reference and
 *     URL resolution, duplicate identifiers, conservation counts); the local
 *     XHTML renderer validates none of that and the local EPUB builder checks
 *     the receipt digest before the reference rules.
 *
 * The digests below pin that measurement so the divergence is visible, not
 * silent, and so the cut can be re-adjudicated against a recorded baseline.
 * Every diverging fixture asserts the EXACT digest of BOTH renderers, so the
 * test fails if either side moves; the one fixture whose two renderers agree
 * is asserted byte-equal.
 *
 * The comparison imports of the stale local copies live in THIS FILE ONLY: no
 * production module under `src/` may import `src/struct/**` for the render
 * path any more.
 */

/** The frozen adapter-parity reconstruction fixtures, decoded verbatim. */
const ADAPTER_PARITY_RECONSTRUCTIONS = {
  'ordinary-pdf': 'ordinary-pdf.json',
  'source-preserved-pdf': 'source-preserved-pdf.json',
} as const

const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

function firstDifferenceOffset(left: string, right: string) {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1)
    if (left[index] !== right[index]) return index
  return left.length === right.length ? -1 : limit
}

async function outcome(run: () => unknown | Promise<unknown>) {
  try {
    await run()
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The frozen structured-manuscript DOCX is the app's canonical Struct source:
 * headings, paragraphs, a nested list, a figure asset, a semantic table, a
 * caption, a footnote and an endnote.
 */
async function structuredManuscriptDocument(): Promise<StructDocument> {
  const bytes = await readFile(
    new URL(
      '../../tests/fixtures/docx/structured-manuscript.docx',
      import.meta.url,
    ),
  )
  const reconstruction = await reconstructDocx(
    new File([bytes], 'structured-manuscript.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  )
  return buildStructDocument(reconstruction)
}

async function adapterParityDocument(
  name: keyof typeof ADAPTER_PARITY_RECONSTRUCTIONS,
): Promise<StructDocument> {
  const text = await readFile(
    new URL(
      `../../tests/fixtures/struct-adapter-parity/reconstructions/${ADAPTER_PARITY_RECONSTRUCTIONS[name]}`,
      import.meta.url,
    ),
    'utf8',
  )
  return buildStructDocument(decodeReconstruction(text))
}

type StructFixture = { name: string; document: StructDocument }

async function structFixtures(): Promise<StructFixture[]> {
  return [
    {
      name: 'structured-manuscript-docx',
      document: await structuredManuscriptDocument(),
    },
    {
      name: 'adapter-parity/ordinary-pdf',
      document: await adapterParityDocument('ordinary-pdf'),
    },
    {
      name: 'adapter-parity/source-preserved-pdf',
      document: await adapterParityDocument('source-preserved-pdf'),
    },
  ]
}

/** Reseal a mutated document so a receipt-digest rule is not what fails. */
function reseal(document: StructDocument): StructDocument {
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

describe('E-04 dual-render parity: StructDocument mode', () => {
  it('records the measured XHTML digest of both renderers per real fixture', async () => {
    const measured: Record<string, { local: string; package: string }> = {}
    for (const fixture of await structFixtures()) {
      const local = localRenderPublicationXhtml(fixture.document)
      const packaged = packageRenderPublicationXhtml(fixture.document)
      measured[fixture.name] = {
        local: sha256(local),
        package: sha256(packaged),
      }
    }

    expect(measured).toEqual({
      'structured-manuscript-docx': {
        local: 'cf4eef0eb1edbddca464b1bcd7d1daac59a1b0715cc8e69c64c9a20270f2cd95',
        package: 'a74427183599f3dc213465c5adac4451994603dbe4057962aefc5b2f0c198b28',
      },
      'adapter-parity/ordinary-pdf': {
        local: '4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2',
        package: '4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2',
      },
      'adapter-parity/source-preserved-pdf': {
        local: 'eba808794a97517df241e6dff1d289bd19c2584a84b5dabcf58b61896f87c444',
        package: '0106902dab681da128171ab2937f4ac9a6bfbd8c2418e135a0de25b6c48411be',
      },
    })
  })

  it('records the measured EPUB digest of both renderers per real fixture', async () => {
    const measured: Record<string, { local: string; package: string }> = {}
    for (const fixture of await structFixtures()) {
      const local = await outcome(() => localBuildStructEpub(fixture.document))
      const packaged = await outcome(() =>
        packageBuildStructEpub(fixture.document),
      )
      measured[fixture.name] = {
        local:
          local === 'accepted'
            ? sha256(
                (await localBuildStructEpub(fixture.document)).bytes,
              )
            : local,
        package:
          packaged === 'accepted'
            ? sha256(
                (await packageBuildStructEpub(fixture.document)).bytes,
              )
            : packaged,
      }
    }

    expect(measured).toEqual({
      'structured-manuscript-docx': {
        local: 'f859d1ad1fadc8c897cc3a294a09845fdae5d5360fede37d2a40c16a81386c72',
        package: 'ee11cb70bf0300a69f1ec4621c8d6d53cfc4f18dc9791a504f08f24b9afcf3c9',
      },
      'adapter-parity/ordinary-pdf': {
        local: '1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335',
        package: '1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335',
      },
      'adapter-parity/source-preserved-pdf': {
        local: 'STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED',
        package: 'STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED',
      },
    })
  })

  it('records which real fixtures the two renderers agree on', async () => {
    const agreeing: string[] = []
    const diverging: string[] = []
    for (const fixture of await structFixtures()) {
      const local = localRenderPublicationXhtml(fixture.document)
      const packaged = packageRenderPublicationXhtml(fixture.document)
      if (local === packaged) agreeing.push(fixture.name)
      else diverging.push(fixture.name)
    }

    expect(agreeing).toEqual(['adapter-parity/ordinary-pdf'])
    expect(diverging).toEqual([
      'structured-manuscript-docx',
      'adapter-parity/source-preserved-pdf',
    ])
  })

  it('asserts byte equality of the two XHTML renderers on the agreeing fixture', async () => {
    const document = await adapterParityDocument('ordinary-pdf')
    const local = localRenderPublicationXhtml(document)
    const packaged = packageRenderPublicationXhtml(document)

    expect(local).toBe(packaged)
    expect(sha256(local)).toBe(
      '4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2',
    )
  })

  it('asserts byte inequality of the two XHTML renderers on every diverging fixture', async () => {
    const document = await structuredManuscriptDocument()
    expect(
      localRenderPublicationXhtml(document),
    ).not.toBe(packageRenderPublicationXhtml(document))

    const preserved = await adapterParityDocument('source-preserved-pdf')
    expect(localRenderPublicationXhtml(preserved)).not.toBe(
      packageRenderPublicationXhtml(preserved),
    )
  })

  it('asserts byte equality of the two EPUB builders on the agreeing fixture', async () => {
    const document = await adapterParityDocument('ordinary-pdf')
    const local = await localBuildStructEpub(document)
    const packaged = await packageBuildStructEpub(document)

    expect(bytesEqual(local.bytes, packaged.bytes)).toBe(true)
    expect(local.sha256).toBe(packaged.sha256)
    expect(local.sha256).toBe(
      '1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335',
    )
  })

  it('characterises the list-rendering divergence on the list-bearing fixture', async () => {
    const document = await structuredManuscriptDocument()
    const local = localRenderPublicationXhtml(document)
    const packaged = packageRenderPublicationXhtml(document)

    expect(local).toContain(
      '<p id="struct-block-d594f834a24be295c09a8b7f" data-struct-id="struct-block-d594f834a24be295c09a8b7f">Ordered parent item</p>',
    )
    expect(local).not.toContain('<li ')
    expect(packaged).toContain(
      '<li id="struct-block-d594f834a24be295c09a8b7f" data-struct-id="struct-block-d594f834a24be295c09a8b7f">Ordered parent item</li>',
    )
    expect(packaged).toContain('<ul>')
    expect(firstDifferenceOffset(local, packaged)).toBe(1786)
  })

  it('characterises the furniture-separator divergence on the furniture-bearing fixture', async () => {
    const document = await adapterParityDocument('source-preserved-pdf')
    const local = localRenderPublicationXhtml(document)
    const packaged = packageRenderPublicationXhtml(document)

    expect(local).toContain('</header>\n  \n  <h1')
    expect(packaged).toContain('</header>\n  <h1')
    expect(firstDifferenceOffset(local, packaged)).toBe(495)
  })

  it('characterises the default renderer styles divergence', async () => {
    const document = await adapterParityDocument('ordinary-pdf')
    const options: StructXhtmlOptions = { embedStyles: true }
    const local = localRenderPublicationXhtml(document, options)
    const packaged = packageRenderPublicationXhtml(document, options)

    expect(local).not.toContain('ol, ul { margin: 0 0 1rem 1.5rem; padding: 0; }')
    expect(packaged).toContain('ol, ul { margin: 0 0 1rem 1.5rem; padding: 0; }')
    expect(packaged).toContain('figure.equation { text-align: center; }')
    expect(local).not.toContain('figure.equation { text-align: center; }')
  })

  it('keeps the profiled EPUB bytes characterised for both renderers', async () => {
    const document = await structuredManuscriptDocument()
    const profile = {
      id: 'mobile',
      version: '1.1.0',
      fileName: 'publication-mobile.epub',
      pageProgressionDirection: 'ltr' as const,
      renditionFlow: 'scrolled-continuous' as const,
      configurationSha256: 'c'.repeat(64),
      css: 'body { font-size: 15px; }',
    }

    const local = await localBuildStructEpub(document, { profile })
    const packaged = await packageBuildStructEpub(document, { profile })

    expect(sha256(local.bytes)).toBe(local.sha256)
    expect(sha256(packaged.bytes)).toBe(packaged.sha256)
    expect(local.sha256).toBe(
      'c401019b44229f3d24e12987d0d386289e0a2ce42ae0d0c44f9504ca222b056c',
    )
    expect(packaged.sha256).toBe(
      '6dc2547c5f60c459cfc4bb04a319c3b928ae84a4cb4a1984133d27523f4b0499',
    )
    expect(bytesEqual(local.bytes, packaged.bytes)).toBe(false)
    expect(packaged.entries).toEqual(local.entries)
    expect(packaged.profile).toEqual(local.profile)
  })
})

describe('E-04 dual-render parity: production Struct branch', () => {
  it('routes the app Struct branch through the pinned package renderer', async () => {
    const document = await structuredManuscriptDocument()
    const produced = renderResearchPublicationXhtml(document)
    const local = localRenderPublicationXhtml(document)
    const packaged = packageRenderPublicationXhtml(document)

    // After the E-04 cut the app's renderer entry point IS the pinned package
    // renderer, so the app adopts the package's approved output. The stale
    // local copy stays on disk until E-07 and is no longer the reference.
    expect(produced).toBe(packaged)
    expect(produced).not.toBe(local)
  })

  it('routes the app Struct EPUB branch through the pinned package builder', async () => {
    const document = await structuredManuscriptDocument()
    const produced = await renderResearchEpub(document)
    const local = await localBuildStructEpub(document)
    const packaged = await packageBuildStructEpub(document)

    expect(produced.sha256).toBe(packaged.sha256)
    expect(produced.sha256).not.toBe(local.sha256)
    expect(bytesEqual(produced.bytes, packaged.bytes)).toBe(true)
  })

  it('keeps the byte-identical fixture identical through the app and the local copy', async () => {
    const document = await adapterParityDocument('ordinary-pdf')
    const produced = renderResearchPublicationXhtml(document)
    const local = localRenderPublicationXhtml(document)
    const packaged = packageRenderPublicationXhtml(document)

    expect(produced).toBe(packaged)
    expect(produced).toBe(local)
  })
})

describe('E-04 dual-render parity: legacy ResearchPaper mode', () => {
  it('keeps the app-owned legacy XHTML renderer byte-stable', () => {
    const measured = papers.map((paper) => ({
      id: paper.id,
      sha256: sha256(renderResearchPublicationXhtml(paper)),
    }))

    expect(measured).toEqual([
      {
        id: 'if-letters-home-could-sing',
        sha256: 'e27cd5d11ad1b261c98b664075943ed5908171389e8a18507ba5a257b5080186',
      },
      {
        id: 'semantic-responsive-typesetting',
        sha256: '53b61cb6754b79d83813c8f1529e3b93d01ce1a739c068834c4f70314a272982',
      },
    ])
  })

  it('keeps the app-owned legacy EPUB builder byte-stable', async () => {
    const measured: Array<{ id: string; sha256: string }> = []
    for (const paper of papers) {
      const first = await renderResearchEpub(paper)
      const second = await renderResearchEpub(paper)
      expect(second.sha256).toBe(first.sha256)
      expect(sha256(first.bytes)).toBe(first.sha256)
      measured.push({ id: paper.id, sha256: first.sha256 })
    }

    expect(measured).toEqual([
      {
        id: 'if-letters-home-could-sing',
        sha256: '5570d5f036f1a516d1b9c687cd2037ff012740026d7d67223a04553c72f2e78c',
      },
      {
        id: 'semantic-responsive-typesetting',
        sha256: '2cccbba04904cf4e5d3ddf4dab9badc9379522fb8db0f768b2f3a6354c8c4846',
      },
    ])
  })

  it('keeps the legacy and Struct dispatch modes distinct and both reachable', async () => {
    const document = await structuredManuscriptDocument()
    const paper = papers[0]!
    const structContent = renderResearchPublicationXhtml(document)
    const legacyContent = renderResearchPublicationXhtml(paper)

    expect(structContent).not.toBe(legacyContent)
    expect(structContent).toContain('data-struct-id=')
    expect(legacyContent).not.toContain('data-struct-id=')
  })
})

describe('E-04 dual-render parity: failure and limit matrix', () => {
  it('records the measured acceptance matrix per renderer', async () => {
    const document = await structuredManuscriptDocument()
    const cases: Array<{ name: string; document: StructDocument }> = []

    const invalidVersion = structuredClone(document)
    Object.assign(invalidVersion, { schemaVersion: '9.9.9' })
    Object.assign(invalidVersion.receipt, { schemaVersion: '9.9.9' })
    cases.push({ name: 'invalid-version', document: invalidVersion })

    const invalidReceipt = structuredClone(document)
    invalidReceipt.receipt.generatedSha256 = 'b'.repeat(64)
    cases.push({ name: 'invalid-receipt-digest', document: invalidReceipt })

    const missingTarget = structuredClone(document)
    const target = missingTarget.blocks.find((block) => block.inline.length > 0)!
    target.inline[0] = { ...target.inline[0]!, href: '#struct-missing-target' }
    cases.push({
      name: 'missing-target',
      document: reseal(missingTarget),
    })

    const unsafeHref = structuredClone(document)
    const unsafe = unsafeHref.blocks.find((block) => block.inline.length > 0)!
    unsafe.inline[0] = { ...unsafe.inline[0]!, href: 'javascript:alert(1)' }
    cases.push({
      name: 'unsafe-href',
      document: reseal(unsafeHref),
    })

    const duplicateId = structuredClone(document)
    duplicateId.blocks[1] = {
      ...duplicateId.blocks[1]!,
      id: duplicateId.blocks[0]!.id,
    }
    cases.push({ name: 'duplicate-id', document: reseal(duplicateId) })

    const measured: Record<string, { local: string; package: string }> = {}
    for (const entry of cases) {
      measured[entry.name] = {
        local: await outcome(() => localBuildStructEpub(entry.document)),
        package: await outcome(() => packageBuildStructEpub(entry.document)),
      }
    }

    expect(measured).toEqual({
      'invalid-version': {
        local: 'STRUCT_RECEIPT_BINDING_MISMATCH',
        package: 'STRUCT_RECEIPT_BINDING_MISMATCH',
      },
      'invalid-receipt-digest': {
        local: 'STRUCT_RECEIPT_DIGEST_MISMATCH',
        package: 'STRUCT_RECEIPT_DIGEST_MISMATCH',
      },
      'missing-target': {
        local:
          'STRUCT EPUB content.xhtml has dangling internal reference #struct-missing-target',
        package: 'STRUCT EPUB has a dangling internal reference',
      },
      'unsafe-href': {
        local:
          'STRUCT EPUB content.xhtml has unsafe href scheme in javascript:alert(1)',
        package: 'STRUCT EPUB has an unsafe href',
      },
      'duplicate-id': {
        local: 'STRUCT XHTML duplicate id struct-block-62c52718d4ab91f1214c89a0',
        package:
          'STRUCT_CODEC_DUPLICATE_IDENTIFIER at $.blocks: duplicate block id struct-block-62c52718d4ab91f1214c89a0',
      },
    })
  })

  it('records the measured XHTML acceptance matrix per renderer', async () => {
    const document = await structuredManuscriptDocument()
    const invalidVersion = structuredClone(document)
    Object.assign(invalidVersion, { schemaVersion: '9.9.9' })
    Object.assign(invalidVersion.receipt, { schemaVersion: '9.9.9' })
    const invalidReceipt = structuredClone(document)
    invalidReceipt.receipt.generatedSha256 = 'b'.repeat(64)
    const missingTarget = structuredClone(document)
    const target = missingTarget.blocks.find((block) => block.inline.length > 0)!
    target.inline[0] = { ...target.inline[0]!, href: '#struct-missing-target' }
    reseal(missingTarget)

    const measured = {
      'invalid-version': {
        local: await outcome(() =>
          localRenderPublicationXhtml(invalidVersion),
        ),
        package: await outcome(() =>
          packageRenderPublicationXhtml(invalidVersion),
        ),
      },
      'invalid-receipt-digest': {
        local: await outcome(() =>
          localRenderPublicationXhtml(invalidReceipt),
        ),
        package: await outcome(() =>
          packageRenderPublicationXhtml(invalidReceipt),
        ),
      },
      'missing-target': {
        local: await outcome(() =>
          localRenderPublicationXhtml(missingTarget),
        ),
        package: await outcome(() =>
          packageRenderPublicationXhtml(missingTarget),
        ),
      },
    }

    expect(measured).toEqual({
      'invalid-version': {
        local: 'accepted',
        package:
          'STRUCT_CODEC_SCHEMA_VERSION at $.schemaVersion: unsupported schema version "9.9.9"',
      },
      'invalid-receipt-digest': {
        local: 'accepted',
        package:
          'STRUCT_CODEC_DIGEST at $.receipt.generatedSha256: generatedSha256 does not match the canonical 0.2.0 digest',
      },
      'missing-target': {
        local: 'accepted',
        package:
          'STRUCT_CODEC_REFERENCE at $.blocks[0].inline[0].href: dangling local reference #struct-missing-target',
      },
    })
  })

  it('records the conservation-count divergence the package renderer rejects', async () => {
    const document = structuredClone(await structuredManuscriptDocument())
    const altered = document.receipt.textCharacterCount - 1
    document.receipt.textCharacterCount = altered
    document.receipt.conservation.sourceTextCharacterCount = altered
    document.receipt.conservation.structTextCharacterCount = altered
    reseal(document)

    const local = await outcome(() => localBuildStructEpub(document))
    const packaged = await outcome(() => packageBuildStructEpub(document))

    expect(local).toBe('accepted')
    expect(packaged).toBe(
      'STRUCT_CODEC_COUNT at $.receipt.textCharacterCount: receipt text count must match block text',
    )
  })

  it('enforces the archive byte ceiling identically in both renderers', async () => {
    const document = await structuredManuscriptDocument()
    const local = await localBuildStructEpub(document)
    const packaged = await packageBuildStructEpub(document)

    expect(() =>
      localAssertStructEpubArchiveByteLength(
        local.bytes,
        local.bytes.byteLength,
      ),
    ).not.toThrow()
    expect(() =>
      packageAssertStructEpubArchiveByteLength(
        packaged.bytes,
        packaged.bytes.byteLength,
      ),
    ).not.toThrow()
    expect(() =>
      localAssertStructEpubArchiveByteLength(
        local.bytes,
        local.bytes.byteLength - 1,
      ),
    ).toThrow('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
    expect(() =>
      packageAssertStructEpubArchiveByteLength(
        packaged.bytes,
        packaged.bytes.byteLength - 1,
      ),
    ).toThrow('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
  })
})

describe('E-04 dual-render parity: local copies stay test-local until E-07', () => {
  it('keeps the stale local renderer copies out of every production module', async () => {
    const sourceRoot = new URL('../', import.meta.url)

    async function productionModules(directory: URL): Promise<URL[]> {
      const entries = await readdir(directory, { withFileTypes: true })
      const nested = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            productionModules(new URL(`${entry.name}/`, directory)),
          ),
      )
      return [
        ...nested.flat(),
        ...entries
          .filter(
            (entry) =>
              entry.isFile() &&
              /\.(?:[cm]?[jt]sx?|astro)$/.test(entry.name) &&
              !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
          )
          .map((entry) => new URL(entry.name, directory)),
      ]
    }

    const violations: string[] = []
    for (const file of await productionModules(sourceRoot)) {
      // The compatibility copies themselves are the stale reference and are
      // deleted only at E-07; their own internal wiring is not a violation.
      if (file.pathname.includes('/src/struct/')) continue
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/gu,
      )) {
        const specifier = match[1]!
        if (
          /(?:^|\/)struct\/(?:xhtml|epub)$/u.test(specifier) &&
          !specifier.startsWith('@erniesg/struct/')
        ) {
          violations.push(`${file.pathname}: stale local renderer import ${specifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the two switched production files on the pinned package subpaths', async () => {
    const switched: Array<{ file: string; subpaths: string[] }> = [
      {
        file: 'src/research/epub.ts',
        subpaths: [
          '@erniesg/struct/renderers/xhtml',
          '@erniesg/struct/renderers/epub',
        ],
      },
      {
        file: 'src/research/reconstruction-materialization.ts',
        subpaths: ['@erniesg/struct/renderers/epub'],
      },
    ]

    for (const { file, subpaths } of switched) {
      const source = await readFile(
        new URL(file, new URL('../../', import.meta.url)),
        'utf8',
      )
      for (const subpath of subpaths) {
        expect(source).toContain(`from '${subpath}'`)
      }
      expect(source).not.toMatch(
        /from\s+['"][^'"]*\.\.\/struct\/(?:xhtml|epub)['"]/u,
      )
    }
  })
})
