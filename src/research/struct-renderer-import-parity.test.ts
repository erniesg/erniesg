import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
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
import { buildAstroStructDocument } from '../struct-adapters/from-markdown'
import { decodeReconstruction } from '../../tests/fixtures/struct-adapter-parity/observe'
import bothModeCases from '../../tests/fixtures/struct-both-mode-parity/cases.json'
import {
  compareCommonDomain,
  comparePublications,
  externalLinks,
  internalTargets,
  publicationView,
  unitSignature,
  type PublicationComparison,
  type PublicationView,
} from '../../tests/fixtures/struct-both-mode-parity/view'
import { reconstructDocx } from './docx-import'
import {
  buildEpub as renderResearchEpub,
  renderPublicationXhtml as renderResearchPublicationXhtml,
} from './epub'
import type { DocxReconstruction } from './import-types'
import { papers } from './papers'
import { researchPaperSchema } from './schema'

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
 * RE-MEASURED 2026-10-21 at the pinned Struct artifact
 * `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` (the pin the app now installs).
 * The pinned package renderer now publishes the DECLARED list contract (an
 * ordered container with the nested bullet list inside the parent item) and
 * publishes an ATTACHED caption exactly once, inside the host's
 * `<figcaption>`. The stale local copy is unchanged: it still has no list
 * branch and still publishes the caption block again as a paragraph. The
 * PACKAGE digests therefore moved for the two diverging fixtures, and the
 * LOCAL digests moved only where the receipt digest is embedded in the
 * archive (the EPUB `package.opf` and `struct.json`). The local XHTML
 * digests did not move: the local renderer resolves the figure's caption
 * from the caption block, so the host's own copy of the caption text
 * dropping out of the host block's text left the local bytes identical.
 * The measurements below are the ones this pin produces; they are pinned
 * exactly, so a further move fails loudly.
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
        package: 'c4408a26f78577f7da86206ab7ff56ec0d18f883dd03f2d4cb7ff41e447dcc94',
      },
      'adapter-parity/ordinary-pdf': {
        local: '4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2',
        package: '4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2',
      },
      'adapter-parity/source-preserved-pdf': {
        local: 'eba808794a97517df241e6dff1d289bd19c2584a84b5dabcf58b61896f87c444',
        package: 'ea1838aa372cfb6c80b274c6163532861c759bcb69c88e16011768214854a8eb',
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
        local: '05d10b8eb8fae0273217fa7d6c4b24310724536b468c2188536bd70c49953ff8',
        package: 'dabd7d18488eb11313bb8cfd6970a9c702160bd91426f73288ca8182736963ac',
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

    // The stale LOCAL copy still has no list branch: it renders each list item
    // as a `<p>`. The pinned package renderer publishes the declared list
    // contract: an ordered container with the nested bullet list inside the
    // parent item. The package's `<li>` therefore carries the nested `<ul>`,
    // so the item's text is not closed by `</li>` any more.
    expect(local).toContain(
      '<p id="struct-block-d594f834a24be295c09a8b7f" data-struct-id="struct-block-d594f834a24be295c09a8b7f">Ordered parent item</p>',
    )
    expect(local).not.toContain('<li ')
    expect(packaged).toContain(
      '<li id="struct-block-d594f834a24be295c09a8b7f" data-struct-id="struct-block-d594f834a24be295c09a8b7f">Ordered parent item',
    )
    expect(packaged).toContain('<ol>')
    expect(packaged).toContain('<ul>')
    expect(packaged).toContain(
      '<li id="struct-block-3994ae358137604a1b9c8820" data-struct-id="struct-block-3994ae358137604a1b9c8820">Nested bullet item</li>',
    )
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
      'cb5e77f46cf713dc9f8380524c217ca322cec66ee59e8ede66a7e7012dd4b813',
    )
    expect(packaged.sha256).toBe(
      '50cf76aba5947a105c2a05c72271319e163f12f4df11debf8af1492178e488f5',
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

/**
 * E-04 EG-13 both-mode parity: ONE publication, rendered through the legacy
 * `ResearchPaper` overload and through the public `StructDocument` overload
 * of `src/research/epub.ts`.
 *
 * The blocks above prove that each mode is byte-stable and that the two
 * modes are DISTINCT. They never prove that the two modes publish the SAME
 * content. This block closes that gap with the repository's own fixtures:
 *
 *  - `text-heading-inline-code`: one authored publication, projected into the
 *    app-owned MDX ingress (the Struct side) and into the legacy
 *    `ResearchPaper` model (the legacy side);
 *  - the frozen structured-manuscript DOCX: reconstructed ONCE and published
 *    through BOTH overloads, so neither side is hand-authored.
 *
 * What is compared is the publication itself: the canonical text in reading
 * order, the inline marks that carry that text, the published asset set with
 * its alt text, the external links with their meaning, the internal
 * references RESOLVED TO THEIR TARGET, the caption placement and the nested
 * list structure. The legacy ids (`fn-docx-1`) and the Struct ids
 * (`struct-block-...`) are presentational aliases of the same anchor, so the
 * correspondence is asserted on the resolved target, never on the id string.
 * Whole-archive bytes, CSS and the two document envelopes are deliberately
 * NOT compared.
 *
 * THE COMMON SUPPORTED SEMANTIC DOMAIN (re-measured 2026-10-21).
 *
 * The comparison is scoped to the semantic domain BOTH models can express,
 * and over that domain the two overloads must AGREE: the same content, the
 * same block identities and ordering, the same text, the same asset
 * bindings, the same caption placement and the same nested list structure.
 *
 * Exactly ONE construct is outside that domain: the inline-code mark. The
 * deprecated legacy `ResearchPaper` inline-run model (`src/research/schema.ts`)
 * has NO field for an inline-code mark, so the legacy overload cannot publish
 * the element at all - it degrades the mark to plain text inside the same
 * text run. The deprecated legacy types are NOT widened to force a false
 * equality: the mark is excluded from the common domain
 * (`compareCommonDomain`), and the additive Struct capability is evidenced
 * separately and truthfully, as a scoped model boundary, with the exact
 * difference recorded.
 *
 * Every difference the comparison still reports is CLASSIFIED with a reason.
 * A difference inside the common domain is a defect and must be empty; the
 * only difference the comparison may report is the classified inline-code
 * model boundary.
 *
 * SCOPE. The cases are a pilot, not a proof over every accepted input. The
 * exact coverage and the measured state are recorded in
 * `docs/struct-migration-status/e-04-dated-record-20261020.md`.
 */

type BothModeCase = {
  id: string
  contentKind: string
  note: string
  mdx: string
  legacyPaper: Record<string, unknown>
}

const bothModePilot = bothModeCases.cases[0] as unknown as BothModeCase

const BOTH_MODE_TIMEOUT = { timeout: 30_000 }

/**
 * The two rendered views of one publication, one per overload.
 */
type BothModeViews = {
  legacy: PublicationView
  struct: PublicationView
}

/**
 * Publish one authored pilot case through both overloads.
 *
 * The Struct side is produced by the app-owned MDX ingress
 * (`src/struct-adapters/from-markdown.ts`), the same ingress the production
 * Astro path uses. The legacy side is the legacy `ResearchPaper` model,
 * validated by the app-owned `researchPaperSchema`. No production canonical
 * converter is involved and no production module is edited.
 */
async function renderBothModePilotViews(
  pilot: BothModeCase,
): Promise<BothModeViews> {
  const collection = await mkdtemp(resolve(tmpdir(), 'both-mode-parity-'))
  const entry = resolve(collection, 'pilot')
  await mkdir(entry, { recursive: true })
  await writeFile(resolve(entry, 'index.mdx'), pilot.mdx)
  const conversion = await buildAstroStructDocument({
    entryId: 'pilot',
    contentRoot: collection,
  })
  const legacy = publicationView(
    renderResearchPublicationXhtml(
      researchPaperSchema.parse(pilot.legacyPaper),
    ),
  )
  const struct = publicationView(
    renderResearchPublicationXhtml(conversion.document),
  )
  return { legacy, struct }
}

/**
 * The full comparison of one publication through the two overloads: every
 * difference is reported, including the ones outside the common domain.
 */
async function renderBothModePilot(
  pilot: BothModeCase,
): Promise<PublicationComparison> {
  const { legacy, struct } = await renderBothModePilotViews(pilot)
  return comparePublications(legacy, struct)
}

let manuscriptReconstruction: Promise<DocxReconstruction> | undefined

/**
 * The repository's own frozen structured-manuscript DOCX, reconstructed once.
 */
function structuredManuscriptReconstruction() {
  manuscriptReconstruction ??= (async () => {
    const bytes = await readFile(
      new URL(
        '../../tests/fixtures/docx/structured-manuscript.docx',
        import.meta.url,
      ),
    )
    return reconstructDocx(
      new File([bytes], 'structured-manuscript.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    )
  })()
  return manuscriptReconstruction
}

/**
 * Publish the frozen structured manuscript through BOTH overloads.
 *
 * The legacy side is the importer's own `ResearchPaper` with the importer's
 * own reconstruction; the Struct side is the app-owned adapter's
 * `StructDocument` for the SAME reconstruction. Neither side is authored by
 * this test.
 */
async function renderBothModeManuscriptViews(
  reconstruction?: DocxReconstruction,
): Promise<BothModeViews> {
  const source = reconstruction ?? (await structuredManuscriptReconstruction())
  return {
    legacy: publicationView(
      renderResearchPublicationXhtml(source.paper, { reconstruction: source }),
    ),
    struct: publicationView(
      renderResearchPublicationXhtml(buildStructDocument(source)),
    ),
  }
}

/**
 * The full comparison of the frozen manuscript through the two overloads.
 */
async function renderBothModeManuscript(
  reconstruction?: DocxReconstruction,
): Promise<PublicationComparison> {
  const { legacy, struct } = await renderBothModeManuscriptViews(reconstruction)
  return comparePublications(legacy, struct)
}

describe('E-04 both-mode parity: the same publication through both epub.ts overloads', () => {
  it(
    'agrees with the legacy overload on the canonical text and the reading order',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModePilot(bothModePilot)

      expect(comparison.legacy.units.map(unitSignature)).toEqual([
        'heading:Deterministic heading',
        'paragraph:Call build() with main to continue, then read the reference.',
      ])
      expect(comparison.struct.units.map(unitSignature)).toEqual(
        comparison.legacy.units.map(unitSignature),
      )
      expect(comparison.unitsEqual).toBe(true)
      expect(comparison.struct.title).toBe(comparison.legacy.title)
      expect(comparison.struct.authors).toEqual(comparison.legacy.authors)
    },
  )

  it(
    'agrees with the legacy overload on the link meaning',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModePilot(bothModePilot)

      expect(externalLinks(comparison.legacy)).toEqual([
        {
          href: 'https://example.com/reference',
          text: 'the reference',
          internal: false,
        },
      ])
      expect(externalLinks(comparison.struct)).toEqual(
        externalLinks(comparison.legacy),
      )
      expect(comparison.externalLinksEqual).toBe(true)
    },
  )

  it(
    'evidences the additive inline-code capability the legacy model cannot carry',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModePilot(bothModePilot)

      // The pinned Struct `StructInline` carries an optional `code` flag, so
      // the Struct overload publishes `<code>main</code>`. The legacy
      // `ResearchPaper` inline-run model (src/research/schema.ts) has NO
      // field for an inline-code mark, so the legacy overload cannot publish
      // the element at all: it degrades the mark to plain text inside the
      // same text run. That is an ADDITIVE Struct capability and a scoped
      // model boundary of the deprecated legacy model, recorded here and
      // excluded from the common domain - NOT a silent mismatch and NOT a
      // reason to widen the deprecated legacy types.
      expect(comparison.markupDifferences).toEqual([
        { index: 1, legacy: ['strong', 'a'], struct: ['strong', 'code', 'a'] },
      ])
      expect(
        comparison.legacy.units.flatMap((unit) => unit.markup),
      ).not.toContain('code')
      expect(comparison.struct.units[1]?.markup).toContain('code')
      // The text itself is identical: the legacy side degrades the MARK, not
      // the content.
      expect(comparison.legacy.units[1]?.text).toBe(
        comparison.struct.units[1]?.text,
      )
    },
  )

  it(
    'agrees with the legacy overload on the published asset set and its alt text',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModeManuscript()

      expect(comparison.legacy.assets.length).toBeGreaterThan(0)
      expect(comparison.legacy.assets).toEqual([
        {
          src: 'assets/asset-img-b0007-rId4-431ced6916a2.png',
          alt: 'Figure 1. A source-preserved synthetic image.',
        },
      ])
      expect(comparison.struct.assets).toEqual(comparison.legacy.assets)
      expect(comparison.assetsEqual).toBe(true)
    },
  )

  it(
    'agrees with the legacy overload on the external link meaning',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModeManuscript()

      expect(externalLinks(comparison.legacy)).toEqual([
        {
          href: 'https://example.com/source',
          text: 'linked text',
          internal: false,
        },
      ])
      expect(externalLinks(comparison.struct)).toEqual(
        externalLinks(comparison.legacy),
      )
      expect(comparison.externalLinksEqual).toBe(true)
    },
  )

  it(
    'agrees with the legacy overload on the table reading order',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModeManuscript()
      const legacyCells = comparison.legacy.units.filter(
        (unit) => unit.kind === 'table-cell',
      )
      const structCells = comparison.struct.units.filter(
        (unit) => unit.kind === 'table-cell',
      )

      expect(legacyCells.map((cell) => cell.text)).toEqual([
        'Language',
        'Greeting',
        'English',
        'Hello',
        '中文',
        '你好',
      ])
      expect(structCells.map((cell) => cell.text)).toEqual(
        legacyCells.map((cell) => cell.text),
      )
    },
  )

  it(
    'agrees with the legacy overload on the reference targets',
    BOTH_MODE_TIMEOUT,
    async () => {
      const comparison = await renderBothModeManuscript()

      // The legacy reference points at `#fn-docx-1` and the Struct reference
      // points at `#struct-block-...`: those ids are presentational aliases of
      // the same anchor, so the correspondence is asserted on the resolved
      // target text, not on the id string.
      expect(internalTargets(comparison.legacy).length).toBeGreaterThan(0)
      expect(
        internalTargets(comparison.struct).map((target) => target.text),
      ).toEqual(internalTargets(comparison.legacy).map((target) => target.text))
      expect(
        internalTargets(comparison.struct).map((target) => target.target),
      ).toEqual(
        internalTargets(comparison.legacy).map((target) => target.target),
      )
      expect(comparison.internalTargetsEqual).toBe(true)
    },
  )
})

/**
 * A difference the comparison reports, with the scope it belongs to and the
 * reason it exists. A difference inside the common domain is a defect; a
 * model-boundary difference is a recorded, scoped limit of the deprecated
 * legacy model.
 */
type ClassifiedDifference = {
  scope: 'common-domain' | 'model-boundary'
  reason: string
  difference: unknown
}

const INLINE_CODE_BOUNDARY_REASON =
  'the deprecated legacy ResearchPaper inline-run model has no inline-code field, so the legacy overload degrades the mark to plain text; the inline-code mark is outside the common supported semantic domain'

/**
 * The inline marks the deprecated legacy `ResearchPaper` model cannot carry.
 * They are the marks the common supported semantic domain excludes, and they
 * are a property of the MODEL, not of one comparison instance.
 */
const LEGACY_MODEL_EXCLUDED_MARKS = ['code']

/**
 * Is this inline-mark difference exactly the excluded model boundary?
 */
function isOnlyExcludedMarks(
  difference: { legacy: string[]; struct: string[] },
  excluded: string[],
) {
  if (excluded.length === 0) return false
  if (difference.legacy.some((mark) => excluded.includes(mark))) return false
  const projected = difference.struct.filter((mark) => !excluded.includes(mark))
  return projected.join(',') === difference.legacy.join(',')
}

/**
 * Classify every difference the comparison reports.
 */
function classifyDifferences(
  comparison: PublicationComparison,
  commonDomainMarks: string[] = LEGACY_MODEL_EXCLUDED_MARKS,
): ClassifiedDifference[] {
  const ledger: ClassifiedDifference[] = []
  for (const difference of comparison.unitDifferences) {
    ledger.push({
      scope: 'common-domain',
      reason:
        'the two modes publish different block content, block identities or block order',
      difference,
    })
  }
  for (const difference of comparison.markupDifferences) {
    const boundary = isOnlyExcludedMarks(difference, commonDomainMarks)
    ledger.push({
      scope: boundary ? 'model-boundary' : 'common-domain',
      reason: boundary
        ? INLINE_CODE_BOUNDARY_REASON
        : 'the two modes carry different inline marks for the same published text',
      difference,
    })
  }
  for (const difference of comparison.assetDifferences) {
    ledger.push({
      scope: 'common-domain',
      reason: 'the two modes publish a different asset set or a different alt text',
      difference,
    })
  }
  for (const difference of comparison.externalLinkDifferences) {
    ledger.push({
      scope: 'common-domain',
      reason: 'the two modes publish a different external link or a different link text',
      difference,
    })
  }
  for (const difference of comparison.internalTargetDifferences) {
    ledger.push({
      scope: 'common-domain',
      reason:
        'the two modes resolve an internal reference to a different target',
      difference,
    })
  }
  return ledger
}

describe('E-04 both-mode parity: the common supported semantic domain', () => {
  it(
    'agrees with the legacy overload on the frozen manuscript over the whole comparison',
    BOTH_MODE_TIMEOUT,
    async () => {
      const { legacy, struct } = await renderBothModeManuscriptViews()
      // The frozen manuscript carries no inline code, so the common domain
      // excludes nothing that this publication uses: the FULL comparison, with
      // no exclusion at all, must be clean.
      const comparison = comparePublications(legacy, struct)

      expect(comparison.excludedMarks).toEqual([])
      expect(comparison.unitsEqual).toBe(true)
      expect(comparison.unitDifferences).toEqual([])
      expect(comparison.markupDifferences).toEqual([])
      expect(comparison.assetsEqual).toBe(true)
      expect(comparison.assetDifferences).toEqual([])
      expect(comparison.externalLinksEqual).toBe(true)
      expect(comparison.externalLinkDifferences).toEqual([])
      expect(comparison.internalTargetsEqual).toBe(true)
      expect(comparison.internalTargetDifferences).toEqual([])
      expect(classifyDifferences(comparison)).toEqual([])
    },
  )

  it(
    'publishes the same block identities, order and text in both modes',
    BOTH_MODE_TIMEOUT,
    async () => {
      const { legacy, struct } = await renderBothModeManuscriptViews()

      expect(struct.units.length).toBe(legacy.units.length)
      expect(struct.units.map((unit) => unit.kind)).toEqual(
        legacy.units.map((unit) => unit.kind),
      )
      expect(struct.units.map(unitSignature)).toEqual(
        legacy.units.map(unitSignature),
      )
      // Every unit of the legacy mode resolves to the text of the unit at the
      // same position in the Struct mode, and the other way round: the two
      // modes publish the same content in the same order.
      for (const [index, unit] of legacy.units.entries()) {
        expect(struct.units[index]?.text, `unit ${index}`).toBe(unit.text)
      }
    },
  )

  it(
    'publishes the caption exactly once, inside the host figcaption, in both modes',
    BOTH_MODE_TIMEOUT,
    async () => {
      const source = await structuredManuscriptReconstruction()
      const legacyXhtml = renderResearchPublicationXhtml(source.paper, {
        reconstruction: source,
      })
      const structXhtml = renderResearchPublicationXhtml(
        buildStructDocument(source),
      )
      const { legacy, struct } = await renderBothModeManuscriptViews(source)

      // The pinned package renderer resolves an attached caption only through
      // the document's declared caption relationship and publishes it exactly
      // once, inside the host's `<figcaption>`. The caption block is not
      // published again as a paragraph: there is no `class="caption"` element
      // and no extra caption unit.
      expect(structXhtml.match(/<figcaption/g)?.length).toBe(2)
      expect(structXhtml).not.toContain('class="caption"')
      expect(legacyXhtml.match(/<figcaption/g)?.length).toBe(2)
      expect(legacy.units.filter((unit) => unit.kind === 'caption')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: 'figcaption',
            text: 'Figure 1. A source-preserved synthetic image.',
          }),
          expect.objectContaining({
            tag: 'figcaption',
            text: 'Table 1. A semantic comparison.',
          }),
        ]),
      )
      // The SAME caption units, in the SAME place, in the same order.
      expect(
        struct.units
          .filter((unit) => unit.kind === 'caption')
          .map((unit) => [unit.tag, unit.text]),
      ).toEqual(
        legacy.units
          .filter((unit) => unit.kind === 'caption')
          .map((unit) => [unit.tag, unit.text]),
      )
      expect(
        struct.units.filter((unit) => unit.kind === 'caption'),
      ).toHaveLength(2)
    },
  )

  it(
    'preserves the ordered and nested list structure in both modes',
    BOTH_MODE_TIMEOUT,
    async () => {
      const { legacy, struct } = await renderBothModeManuscriptViews()
      const shape = (unit: {
        text: string
        listTag: string | null
        listDepth: number
      }) => [unit.text, unit.listTag, unit.listDepth]

      // The legacy overload publishes an ordered list with a nested bullet
      // list. The Struct overload now publishes the same structure: the app
      // ingress declares `listLevel`/`listOrdered` and the pinned renderer
      // publishes the declared nesting and ordering.
      expect(
        legacy.units.filter((unit) => unit.kind === 'list-item').map(shape),
      ).toEqual([
        ['Ordered parent item', 'ol', 1],
        ['Nested bullet item', 'ul', 2],
      ])
      expect(
        struct.units.filter((unit) => unit.kind === 'list-item').map(shape),
      ).toEqual([
        ['Ordered parent item', 'ol', 1],
        ['Nested bullet item', 'ul', 2],
      ])
    },
  )

  it(
    'agrees over the common domain on the pilot case, with the inline-code mark excluded',
    BOTH_MODE_TIMEOUT,
    async () => {
      const { legacy, struct } = await renderBothModePilotViews(bothModePilot)
      const comparison = compareCommonDomain(legacy, struct)

      expect(comparison.excludedMarks).toEqual(['code'])
      expect(comparison.unitsEqual).toBe(true)
      expect(comparison.unitDifferences).toEqual([])
      expect(comparison.markupDifferences).toEqual([])
      expect(comparison.assetsEqual).toBe(true)
      expect(comparison.externalLinksEqual).toBe(true)
      expect(comparison.internalTargetsEqual).toBe(true)
      expect(classifyDifferences(comparison)).toEqual([])
    },
  )

  it(
    'classifies every difference the comparison still reports',
    BOTH_MODE_TIMEOUT,
    async () => {
      const { legacy, struct } = await renderBothModePilotViews(bothModePilot)
      const full = comparePublications(legacy, struct)
      const ledger = classifyDifferences(full)

      // Exactly one difference is reported, and it is classified: the
      // inline-code mark, which is outside the common domain because the
      // deprecated legacy model has no field for it.
      expect(ledger).toEqual([
        {
          scope: 'model-boundary',
          reason: INLINE_CODE_BOUNDARY_REASON,
          difference: {
            index: 1,
            legacy: ['strong', 'a'],
            struct: ['strong', 'code', 'a'],
          },
        },
      ])
      // Nothing inside the common domain is outstanding.
      expect(ledger.filter((entry) => entry.scope === 'common-domain')).toEqual(
        [],
      )
    },
  )
})

describe('E-04 both-mode parity: the comparator is not vacuous', () => {
  it(
    'trips on a text difference between the paired views',
    BOTH_MODE_TIMEOUT,
    async () => {
      const mutated = structuredClone(bothModePilot) as BothModeCase
      const nodes = mutated.legacyPaper['nodes'] as Array<
        Record<string, unknown>
      >
      nodes[1]!['text'] =
        'Call build() with main to continue, then read the reference!'

      const comparison = await renderBothModePilot(mutated)

      expect(comparison.unitsEqual).toBe(false)
      expect(comparison.unitDifferences).toEqual([
        {
          index: 1,
          legacy:
            'paragraph:Call build() with main to continue, then read the reference!',
          struct:
            'paragraph:Call build() with main to continue, then read the reference.',
        },
      ])
    },
  )

  it(
    'trips on a link difference between the paired views',
    BOTH_MODE_TIMEOUT,
    async () => {
      const mutated = structuredClone(bothModePilot) as BothModeCase
      const nodes = mutated.legacyPaper['nodes'] as Array<
        Record<string, unknown>
      >
      const runs = nodes[1]!['inlineRuns'] as Array<Record<string, unknown>>
      runs[2]!['href'] = 'https://example.com/other'

      const comparison = await renderBothModePilot(mutated)

      expect(comparison.externalLinksEqual).toBe(false)
      expect(comparison.externalLinkDifferences).toEqual([
        {
          index: 0,
          legacy: 'https://example.com/other|the reference',
          struct: 'https://example.com/reference|the reference',
        },
      ])
    },
  )

  it(
    'trips on an asset difference between the paired views',
    BOTH_MODE_TIMEOUT,
    async () => {
      const reconstruction = structuredClone(
        await structuredManuscriptReconstruction(),
      )
      const visual = reconstruction.visualRelationships.find(
        (relationship) => relationship.canonicalNodeId !== null,
      )
      expect(visual).toBeDefined()
      visual!.altText = 'A mutated alt text.'

      const comparison = await renderBothModeManuscript(reconstruction)

      expect(comparison.assetsEqual).toBe(false)
      expect(comparison.assetDifferences).toEqual([
        {
          index: 0,
          legacy:
            'assets/asset-img-b0007-rId4-431ced6916a2.png|A mutated alt text.',
          struct:
            'assets/asset-img-b0007-rId4-431ced6916a2.png|Figure 1. A source-preserved synthetic image.',
        },
      ])
    },
  )
})
